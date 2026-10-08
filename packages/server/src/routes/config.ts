import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyConfig } from '@rookery/core';
import type { RookeryConfig, TelegramPushConfig } from '@rookery/core';
import { publicConfig, type ServerContext } from '../context.js';
import { errorMessage } from '../errors.js';
import { parseOrThrow, patchConfigSchema } from '../schemas.js';

/**
 * Turn the two ways a client can talk about a write-only secret into the two
 * things the merge understands.
 *
 * A form that renders an empty password field sends an empty string back on
 * every save, because that is what it was handed - GET never returns the real
 * one. Merging that would wipe the token whenever somebody changed the quiet
 * hours. So: empty means "leave it alone" and is dropped from the patch,
 * `null` means "clear it" and becomes the empty string the config stores.
 */
function normaliseSecrets(patch: Record<string, unknown>, config: RookeryConfig): void {
  const telegram = (patch.gateways as { telegram?: { token?: string | null } } | undefined)?.telegram;
  if (telegram && 'token' in telegram) {
    if (telegram.token === null) telegram.token = '';
    else if (!telegram.token) delete telegram.token;
  }

  // Listeners are a list, and a list in a patch replaces the stored one whole
  // rather than merging into it. "Leave it alone" therefore cannot be done by
  // dropping the field the way it is above - there would be nothing left for
  // it to merge with. The stored password is copied in by id instead: the same
  // promise, kept a different way.
  const listeners = patch.listeners as { imap?: { id?: string; password?: string | null }[] } | undefined;
  if (!listeners?.imap) return;
  const stored = new Map(config.listeners.imap.map((entry) => [entry.id, entry.password]));
  for (const entry of listeners.imap) {
    if (entry.password === null) entry.password = '';
    else if (!entry.password) entry.password = stored.get(entry.id ?? '') ?? '';
  }
}

/**
 * The push switches as they are stored now. An old client still sends the
 * mail switches: they are read the way `upgradePushConfig` reads an old
 * file - `mail` becomes `schedules` (and turns `tasks` on), `mailFrom`
 * becomes `agents` - unless the new key came along too, and are never
 * written back. `questions` cannot be switched off.
 */
function normalisePush(push: Partial<TelegramPushConfig> | undefined): void {
  if (!push) return;
  if (push.mail !== undefined && push.schedules === undefined) {
    push.schedules = push.mail;
    if (push.mail && push.tasks === undefined) push.tasks = true;
  }
  if ((push.mail !== undefined || push.mailFrom !== undefined) && push.agents === undefined) {
    const from = push.mailFrom;
    push.agents = push.mail === false || from === 'assistant' ? 'off' : from === 'all' ? 'all' : from ? 'leads' : undefined;
    if (push.agents === undefined) delete push.agents;
  }
  delete push.mail;
  delete push.mailFrom;
  if (push.questions !== undefined) push.questions = true;
}

/**
 * Config as the browser sees it: never the token, and never the on-disk paths.
 * A PATCH is written through to ~/.rookery/config.json and applied to the live
 * runtime, so changing the assistant's name or the memory budget takes effect
 * on the next turn rather than the next restart.
 */
export async function registerConfigRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  /**
   * A gateway reads its settings live but only notices a change when it is
   * told: without this, switching Telegram on in the UI would do nothing
   * until the next restart, while the page already refetches the status and
   * expects it to have flipped. A channel that refuses to start says so in
   * its own log and its `lastError`, so a failure here must not fail the
   * PATCH the user just made.
   */
  const refreshGateways = (): Promise<unknown> =>
    Promise.all(
      context.gateways.map((gateway) =>
        gateway.refresh().catch((error: unknown) => {
          context.log.warn('Gateway did not follow the config change', {
            gateway: gateway.id,
            error: errorMessage(error),
          });
        }),
      ),
    );

  /**
   * Same story for the listeners: switching a mailbox on in the UI has to
   * open the connection now, not at the next restart, and a mailbox that
   * refuses to connect reports that in its own status rather than failing
   * the save the user just made.
   */
  const refreshListeners = (): Promise<void> =>
    context.listeners.refresh().catch((error: unknown) => {
      context.log.warn('Listeners did not follow the config change', { error: errorMessage(error) });
    });

  app.get('/api/config', async () => publicConfig(context.config));

  app.patch('/api/config', async (request: FastifyRequest) => {
    const patch = parseOrThrow(patchConfigSchema, request.body ?? {});
    normaliseSecrets(patch, context.config);
    normalisePush(patch.gateways?.telegram?.push);
    // applyConfig deep-merges into the file, so a partial `memory`/`voice`
    // object is exactly what it wants; the cast only bridges Zod's
    // deep-partial shape. It updates the config in place, and the server and
    // the Assistant hold the same object, so a turn started after this PATCH
    // sees the new settings without anything being copied across.
    const updated = applyConfig(context.config, patch as Partial<RookeryConfig>);

    // The registry keeps its own copy of the fallback settings for provider
    // resolution, refreshed by `sync` like after a profile change; without
    // this, a threshold change would only take effect after a restart.
    if (patch.providerFallback) {
      context.assistant.providers.sync(updated);
    }

    if (patch.gateways) await refreshGateways();
    if (patch.listeners) await refreshListeners();

    context.log.info('Config updated', { keys: Object.keys(patch) });
    return publicConfig(updated);
  });
}
