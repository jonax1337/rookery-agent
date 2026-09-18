import { PlusIcon, RadioTowerIcon, SendIcon } from "@/components/icons";
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router';

import { toast } from 'sonner';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RemovableChip } from '@/components/common/removable-chip';
import { FormFieldsSkeleton } from '@/components/forms/form-kit';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useGateway } from '@/hooks/useGateways';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_HINT, PERMISSION_LABEL } from '@/lib/format';
import { gatewayStateLook } from '@/lib/gateways';
import { formatDateTime } from '@/lib/stats';
import type {
  GatewayStatus,
  PermissionLevel,
  TelegramGatewayConfig,
  TelegramPushConfig,
  TranscribeEngine,
} from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';
import type { IconComponent } from "@/components/icons";

/**
 * The Telegram gateway's own settings.
 *
 * The page mirrors two templates rather than inventing a third: the frame,
 * the status badge and the `MetaList` come from `ToolDetailPage`; the draft,
 * "Speichern" and the deep-compared dirty flag come straight from
 * `SettingsPage`, because this is the same kind of write - a `PATCH
 * /api/config` deep merge, not a record of its own with a `PUT`. There is no
 * `useDraft` here for exactly that reason: that hook's dirty flag is "was
 * anything touched", and this page needs "does the draft still match the
 * server", the same distinction `SettingsPage` already made.
 *
 * `GatewayId` only ever names `telegram` today, but the route stays
 * `/gateways/:id` so a second gateway needs a new `id` here and nothing else
 * upstream.
 */

const FORM_ID = 'gateway-telegram';

const PERMISSION_LEVELS: PermissionLevel[] = ['chat', 'read', 'write', 'full'];

/** Whose mail reaches the phone, narrowest first. */
const MAIL_FROM_LEVELS: TelegramPushConfig['mailFrom'][] = ['assistant', 'leads', 'all'];

const MAIL_FROM_LABEL: Record<TelegramPushConfig['mailFrom'], string> = {
  assistant: 'Assistant only',
  leads: 'Assistant and leads',
  all: 'Everyone',
};

const MAIL_FROM_HINT: Record<TelegramPushConfig['mailFrom'], string> = {
  assistant: 'Agents reach you through the assistant, who decides what is worth saying.',
  leads: 'Anyone leading a team or with agents reporting to them — a Head of without a team counts.',
  all: 'Every mail that lands in your mailbox, including agent to agent copies.',
};

/** Where a voice message becomes text, free first. */
const TRANSCRIBE_ENGINES: TranscribeEngine[] = ['auto', 'local', 'openai', 'elevenlabs', 'off'];

const TRANSCRIBE_LABEL: Record<TranscribeEngine, string> = {
  auto: 'Automatic',
  local: 'On this machine',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  off: 'Off',
};

const TRANSCRIBE_HINT: Record<TranscribeEngine, string> = {
  auto: 'A speech key from the voice page when there is one, the local model otherwise. Always has somewhere to go.',
  local: 'Whisper, running here. No key, nothing leaves the machine; the model is downloaded once, about 130 MB.',
  openai: 'gpt-4o-mini-transcribe. Needs the OpenAI key from the voice page.',
  elevenlabs: 'Scribe v1. Needs the ElevenLabs key from the voice page.',
  off: 'Voice messages arrive as a file and are not listened to.',
};

function makeDraft(config: TelegramGatewayConfig): TelegramGatewayConfig {
  return { ...config, push: { ...config.push } };
}

/** Where the running channel got its token, in words. */
const TOKEN_SOURCE_LABEL: Record<GatewayStatus['tokenSource'], string> = {
  config: 'Saved here',
  env: 'Environment variable TELEGRAM_BOT_TOKEN',
  none: 'None yet',
};

/**
 * The empty-state icon as an animate-ui version. `EmptyState` takes a
 * `IconComponent` and renders it without props, so the animated icon sits in a
 * forwardRef shell that carries its `animateOnView` trigger along.
 */
const EmptyRadioTowerIcon = forwardRef<SVGSVGElement>(function EmptyRadioTowerIcon() {
  return <RadioTowerIcon />;
});

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { gateway, loading, error, refresh, test } = useGateway(id);
  const { config, save } = useConfig();

  const [draft, setDraft] = useState<TelegramGatewayConfig | null>(
    config ? makeDraft(config.gateways.telegram) : null,
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [newId, setNewId] = useState('');
  const [newIdError, setNewIdError] = useState<string | null>(null);

  // Same guard as SettingsPage: a socket-driven refetch must not overwrite a
  // half-finished edit, so `touched` is read synchronously and cannot be state.
  const touched = useRef(false);
  useEffect(() => {
    if (config && !touched.current) setDraft(makeDraft(config.gateways.telegram));
  }, [config]);

  const update = useCallback((make: (current: TelegramGatewayConfig) => TelegramGatewayConfig) => {
    touched.current = true;
    setDraft((current) => (current ? make(current) : current));
  }, []);

  const set = useCallback(
    (patch: Partial<TelegramGatewayConfig>) => update((current) => ({ ...current, ...patch })),
    [update],
  );
  const setPush = useCallback(
    (patch: Partial<TelegramPushConfig>) =>
      update((current) => ({ ...current, push: { ...current.push, ...patch } })),
    [update],
  );

  const dirty = draft !== null && config !== null && !deepEqual(draft, config.gateways.telegram);

  const discard = useCallback(() => {
    touched.current = false;
    setDraft(config ? makeDraft(config.gateways.telegram) : null);
  }, [config]);

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const submit = useCallback(async (): Promise<void> => {
    const pending = draftRef.current;
    if (!pending) return;
    setSaving(true);
    try {
      // The whole gateways object goes out, but PATCH merges deeply - the
      // config's other channels (once there are any) survive untouched.
      if (!(await save({ gateways: { telegram: pending } }))) return;
      if (draftRef.current === pending) touched.current = false;
      await refresh();
    } catch (caught) {
      reportFailure('Save', caught);
    } finally {
      setSaving(false);
    }
  }, [refresh, save]);

  const runTest = useCallback(async (): Promise<void> => {
    setTesting(true);
    try {
      // A channel that cannot send (not running, no recipient) answers 400,
      // which surfaces here as a thrown `ApiError` - there is no `ok: false`.
      const result = await test('telegram');
      toast('Test message sent', { description: 'Sent to ' + result.recipient + '.' });
    } catch (caught) {
      reportFailure('Test message', caught);
    } finally {
      setTesting(false);
    }
  }, [test]);

  const addAllowedId = useCallback((): void => {
    const trimmed = newId.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setNewIdError('Enter a positive whole-number Telegram ID.');
      return;
    }
    if (draft?.allowedUserIds.includes(parsed)) {
      setNewIdError('This ID is already in the list.');
      return;
    }
    // The first allowed id is what pairing mode was opened for, so it closes
    // itself here rather than waiting to be switched off and forgotten.
    set({ allowedUserIds: [...(draft?.allowedUserIds ?? []), parsed], pairing: false });
    setNewId('');
    setNewIdError(null);
  }, [draft, newId, set]);

  const removeAllowedId = useCallback(
    (value: number): void => {
      if (!draft) return;
      set({
        allowedUserIds: draft.allowedUserIds.filter((entry) => entry !== value),
        push: { ...draft.push, recipients: draft.push.recipients.filter((entry) => entry !== value) },
      });
    },
    [draft, set],
  );

  const toggleRecipient = useCallback(
    (value: number, on: boolean): void => {
      if (!draft) return;
      setPush({
        recipients: on
          ? [...draft.push.recipients, value]
          : draft.push.recipients.filter((entry) => entry !== value),
      });
    },
    [draft, setPush],
  );

  usePageMeta(
    {
      breadcrumb: [{ label: 'Gateways', to: '/gateways' }, { label: gateway?.label ?? 'Gateway' }],
      actions: gateway ? (
        <div className="flex items-center gap-2">
          {dirty ? (
            <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">
              Unsaved changes
            </Badge>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={testing} onClick={() => void runTest()}>
            {testing ? (
              <Spinner aria-label="Sending" />
            ) : (
              <SendIcon data-icon="inline-start" size={24} />
            )}
            Send test message
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
            Discard
          </Button>
          <Button type="submit" form={FORM_ID} size="sm" disabled={!dirty || saving}>
            {saving ? <Spinner aria-label="Saving" /> : null}
            Save
          </Button>
        </div>
      ) : undefined,
    },
    [gateway, dirty, saving, testing, discard, runTest],
  );

  /* -------------------------------- Zustände ------------------------------- */

  if (id !== 'telegram') {
    return (
      <PageBody width="3xl">
        <Fade>
          <EmptyState
            icon={EmptyRadioTowerIcon}
            title="Gateway not found"
            description="The entry was removed or the address is incorrect."
            actionLabel="Back to gateways"
            actionTo="/gateways"
          />
        </Fade>
      </PageBody>
    );
  }

  if (!gateway && loading) {
    return (
      <PageBody width="3xl">
        <Fade>
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent>
              <FormFieldsSkeleton fields={4} />
            </CardContent>
          </Card>
        </Fade>
      </PageBody>
    );
  }

  if (!gateway) {
    return (
      <PageBody width="3xl">
        <Fade>
          {error ? (
            <ServerOffline onRetry={() => void refresh()} />
          ) : (
            <EmptyState
              icon={EmptyRadioTowerIcon}
              title="Gateway not found"
              description="The entry was removed or the address is incorrect."
              actionLabel="Back to gateways"
              actionTo="/gateways"
            />
          )}
        </Fade>
      </PageBody>
    );
  }

  const look = gatewayStateLook(gateway);

  return (
    <PageBody width="3xl">
      <div className="flex flex-col gap-3">
        <Fade>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={look.variant} className="gap-1">
              {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
              {look.label}
            </Badge>
          </div>
        </Fade>
      </div>

      <Fade delay={50}>
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              Save the bot token below to apply it without restarting. It is stored in <code>~/.rookery/config.json</code>, but is never returned to this page. It only reports <em>whether</em> a token is set. Create a bot with{' '}
              <Button asChild variant="link" className="h-auto gap-0 p-0 text-left align-baseline">
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                  @BotFather
                </a>
              </Button>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MetaList
              columns={2}
              items={[
                { label: 'Token configured', value: gateway.configured ? 'Yes' : 'No' },
                { label: 'Source', value: TOKEN_SOURCE_LABEL[gateway.tokenSource] },
                { label: 'Running', value: gateway.running ? 'Yes' : 'No' },
                { label: 'Bot name', value: gateway.botUsername ? '@' + gateway.botUsername : '' },
                { label: 'Last error', value: gateway.lastError },
                {
                  label: 'Last event',
                  value: gateway.lastEventAt ? formatDateTime(gateway.lastEventAt) : '',
                },
              ]}
            />
          </CardContent>
        </Card>
      </Fade>

      <Fade delay={100}>
        {draft === null ? (
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <FormFieldsSkeleton fields={5} />
            </CardContent>
          </Card>
        ) : (
          <FormPage
            formId={FORM_ID}
            showActions={false}
            onSubmit={submit}
            title="Settings"
            description="Save to apply changes immediately."
          >
            <FieldSet>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-enabled">Gateway enabled</FieldLabel>
                  <FieldDescription>
                    When off, the bot stops regardless of how many IDs are allowed.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(on) => set({ enabled: on })}
                />
              </Field>
            </FieldSet>

            <Field>
              <FieldLabel htmlFor="gw-token">Bot token</FieldLabel>
              <Input
                id="gw-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={gateway.tokenSource === 'env'}
                value={draft.token ?? ''}
                placeholder={gateway.configured ? 'Configured — leave empty to keep it' : 'From @BotFather'}
                onChange={(event) => set({ token: event.target.value })}
              />
              <FieldDescription>
                {gateway.tokenSource === 'env' ? (
                  <>
                    Provided by environment variable <code>TELEGRAM_BOT_TOKEN</code> which takes precedence here. Remove the variable and restart the server to edit the token here.
                  </>
                ) : (
                  <>
                    The saved token is never returned. Leave this field empty to keep it, or enter a new value to replace it.
                    {gateway.configured ? (
                      <>
                        {' '}
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto gap-0 p-0 text-left align-baseline hover:text-destructive"
                          onClick={() => set({ token: null })}
                        >
                          Remove token
                        </Button>
                        {draft.token === null ? ' — removed when you save.' : null}
                      </>
                    ) : null}
                  </>
                )}
              </FieldDescription>
            </Field>

            <FieldSet>
              <FieldLegend variant="label">Permissions</FieldLegend>
              <FieldDescription>Permissions for turns from this gateway.</FieldDescription>
              <RadioGroup
                value={draft.permission}
                onValueChange={(value) => set({ permission: value as PermissionLevel })}
              >
                {PERMISSION_LEVELS.map((level) => (
                  <FieldLabel key={level} htmlFor={'gw-permission-' + level}>
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>{PERMISSION_LABEL[level]}</FieldTitle>
                        <FieldDescription>{PERMISSION_HINT[level]}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem value={level} id={'gw-permission-' + level} aria-label={PERMISSION_LABEL[level]} />
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>

            <Field>
              <FieldLabel htmlFor="gw-model">Model</FieldLabel>
              <Input
                id="gw-model"
                value={draft.model ?? ''}
                placeholder="Assistant default"
                onChange={(event) => set({ model: event.target.value })}
              />
              <FieldDescription>Leave empty to use the default model.</FieldDescription>
            </Field>

            <FieldSet>
              <FieldLegend variant="label">In the chat</FieldLegend>
              <FieldDescription>How an answer arrives on the phone.</FieldDescription>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-stream">Write as it is produced</FieldLabel>
                  <FieldDescription>
                    One message, rewritten while the answer is written, instead of a wall of text at the end.
                    Telegram has no streaming of its own, so this is an edit every second and a half — switch it
                    off on a slow line or a rate-limited account.
                  </FieldDescription>
                </FieldContent>
                <Switch id="gw-stream" checked={draft.stream} onCheckedChange={(on) => set({ stream: on })} />
              </Field>

            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Files and speech</FieldLegend>
              <FieldDescription>
                What arrives from the phone besides text. Files are saved in the workspace under{' '}
                <code>inbox/telegram/</code>, where a turn can open them, and swept after 30 days.
              </FieldDescription>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-media">Accept attachments</FieldLabel>
                  <FieldDescription>
                    Photos, voice messages, documents. When off, they are dropped and only logged.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-media"
                  checked={draft.media}
                  onCheckedChange={(on) => set({ media: on })}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="gw-max-attachment">Largest attachment</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="gw-max-attachment"
                    inputMode="numeric"
                    disabled={!draft.media}
                    value={String(draft.maxAttachmentMb)}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) set({ maxAttachmentMb: parsed });
                      else if (event.target.value === '') set({ maxAttachmentMb: 1 });
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>MB</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  Telegram hands a bot at most 20 MB, so that is the ceiling here too.
                </FieldDescription>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">Voice messages</FieldLegend>
                <FieldDescription>Which engine turns a recording into words.</FieldDescription>
                <RadioGroup
                  value={draft.transcribe}
                  onValueChange={(value) => set({ transcribe: value as TranscribeEngine })}
                >
                  {TRANSCRIBE_ENGINES.map((engine) => (
                    <FieldLabel key={engine} htmlFor={'gw-transcribe-' + engine}>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>{TRANSCRIBE_LABEL[engine]}</FieldTitle>
                          <FieldDescription>{TRANSCRIBE_HINT[engine]}</FieldDescription>
                        </FieldContent>
                        <RadioGroupItem
                          value={engine}
                          id={'gw-transcribe-' + engine}
                          disabled={!draft.media}
                          aria-label={TRANSCRIBE_LABEL[engine]}
                        />
                      </Field>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>

              {draft.transcribe === 'auto' || draft.transcribe === 'local' ? (
                <Field>
                  <FieldLabel htmlFor="gw-transcribe-model">Local model</FieldLabel>
                  <Input
                    id="gw-transcribe-model"
                    spellCheck={false}
                    value={draft.transcribeModel}
                    placeholder="onnx-community/whisper-base"
                    onChange={(event) => set({ transcribeModel: event.target.value })}
                  />
                  <FieldDescription>
                    <code>whisper-base</code> is the balance that holds on a laptop.{' '}
                    <code>onnx-community/whisper-small</code> hears more and takes about four times as long. The
                    model is downloaded once into <code>models/</code> in the Rookery home, and ffmpeg has to be
                    installed for the audio to be decoded.
                  </FieldDescription>
                </Field>
              ) : null}
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Allowed controller IDs</FieldLegend>
              <FieldDescription>
                An empty list allows no control access. To find your own ID, enable the gateway and pairing, save, then send <code>/id</code> to the bot in a private chat.
              </FieldDescription>
              {draft.allowedUserIds.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {draft.allowedUserIds.map((value) => (
                    <RemovableChip
                      key={value}
                      label={value}
                      removeLabel={'Remove ' + value}
                      onRemove={() => removeAllowedId(value)}
                      className="font-mono tabular-nums"
                    />
                  ))}
                </div>
              ) : null}
              <Field data-invalid={newIdError ? true : undefined}>
                <InputGroup>
                  <InputGroupInput
                    id="gw-new-id"
                    aria-label="Controller user ID"
                    inputMode="numeric"
                    placeholder="Telegram ID, e.g. 123456789"
                    value={newId}
                    onChange={(event) => {
                      setNewId(event.target.value);
                      setNewIdError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addAllowedId();
                      }
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton onClick={addAllowedId}>
                      <PlusIcon data-icon="inline-start" />
                      Add
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {newIdError ? <p className="text-sm text-destructive">{newIdError}</p> : null}
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-pairing">Pairing</FieldLabel>
                  <FieldDescription>
                    Allows an enabled gateway to run with an empty allowlist so <code>/id</code> can reply. Only <code>/id</code> replies with the sender ID; all other messages are rejected. Adding the first allowed ID turns pairing off.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-pairing"
                  checked={draft.pairing}
                  onCheckedChange={(on) => set({ pairing: on })}
                />
              </Field>
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Push</FieldLegend>
              <FieldDescription>
                Notifications the assistant sends outside an active conversation.
              </FieldDescription>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-enabled">Push enabled</FieldLabel>
                  <FieldDescription>When off, all notification types below are disabled.</FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-push-enabled"
                  checked={draft.push.enabled}
                  onCheckedChange={(on) => setPush({ enabled: on })}
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-mail">Mail</FieldLabel>
                  <FieldDescription>
                    Mail addressed to you, To or Cc. Who it is worth a push for is set below.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-push-mail"
                  checked={draft.push.mail}
                  onCheckedChange={(on) => setPush({ mail: on })}
                />
              </Field>
              <RadioGroup
                value={draft.push.mailFrom}
                onValueChange={(value) => setPush({ mailFrom: value as TelegramPushConfig['mailFrom'] })}
              >
                {MAIL_FROM_LEVELS.map((level) => (
                  <FieldLabel key={level} htmlFor={'gw-push-mail-from-' + level}>
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldTitle>{MAIL_FROM_LABEL[level]}</FieldTitle>
                        <FieldDescription>{MAIL_FROM_HINT[level]}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem
                        value={level}
                        id={'gw-push-mail-from-' + level}
                        aria-label={MAIL_FROM_LABEL[level]}
                        disabled={!draft.push.mail}
                      />
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-assignments">Runs</FieldLabel>
                  <FieldDescription>
                    One message per finished run. Off by default: the company reports in mail.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-push-assignments"
                  checked={draft.push.assignments}
                  onCheckedChange={(on) => setPush({ assignments: on })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-cron">Schedules</FieldLabel>
                </FieldContent>
                <Switch
                  id="gw-push-cron"
                  checked={draft.push.cron}
                  onCheckedChange={(on) => setPush({ cron: on })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-sleep">Sleep</FieldLabel>
                </FieldContent>
                <Switch
                  id="gw-push-sleep"
                  checked={draft.push.sleep}
                  onCheckedChange={(on) => setPush({ sleep: on })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-activity">Activity</FieldLabel>
                  <FieldDescription>
                    What the app shows as a toast, as it happens: a memory stored, a skill written, an agent or
                    project saved. Collected for a few seconds and sent as one message.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-push-activity"
                  checked={draft.push.activity}
                  onCheckedChange={(on) => setPush({ activity: on })}
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-tools">Tool calls</FieldLabel>
                  <FieldDescription>
                    Every tool the assistant reaches for, one short line each — <code>Read · package.json</code>.
                    Loud by nature, and never held for later: during quiet hours these are dropped rather than
                    delivered in the morning.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="gw-push-tools"
                  checked={draft.push.tools}
                  onCheckedChange={(on) => setPush({ tools: on })}
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="gw-push-tasks">Tasks</FieldLabel>
                </FieldContent>
                <Switch
                  id="gw-push-tasks"
                  checked={draft.push.tasks}
                  onCheckedChange={(on) => setPush({ tasks: on })}
                />
              </Field>

              <div className="grid gap-4 @md/main:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="gw-quiet-from">Quiet hours from</FieldLabel>
                  <Input
                    id="gw-quiet-from"
                    type="time"
                    value={draft.push.quietFrom}
                    onChange={(event) => setPush({ quietFrom: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="gw-quiet-until">Quiet hours until</FieldLabel>
                  <Input
                    id="gw-quiet-until"
                    type="time"
                    value={draft.push.quietUntil}
                    onChange={(event) => setPush({ quietUntil: event.target.value })}
                  />
                </Field>
              </div>
              <FieldDescription>Leave both empty to disable quiet hours.</FieldDescription>

              <NumberField
                id="gw-max-per-hour"
                label="Hourly limit"
                value={draft.push.maxPerHour}
                min={1}
                max={1000}
                suffix="messages"
                onChange={(value) => setPush({ maxPerHour: value })}
              />

              <Field>
                <FieldLabel>Recipients</FieldLabel>
                <FieldDescription>
                  Choose from the allowed IDs. Leave empty to use the first allowed ID.
                </FieldDescription>
                {draft.allowedUserIds.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {draft.allowedUserIds.map((value) => (
                      <Label
                        key={value}
                        htmlFor={'gw-recipient-' + value}
                        className="flex items-center gap-2 font-mono font-normal tabular-nums"
                      >
                        <Checkbox
                          id={'gw-recipient-' + value}
                          checked={draft.push.recipients.includes(value)}
                          onCheckedChange={(checked) => toggleRecipient(value, checked === true)}
                        />
                        {value}
                      </Label>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Add an allowed ID above before selecting a recipient.
                  </p>
                )}
              </Field>
            </FieldSet>
          </FormPage>
        )}
      </Fade>

      <Fade delay={150}>
        <p className="text-xs text-muted-foreground">
          View all gateways under{' '}
          <Button
            asChild
            variant="link"
            className="h-auto gap-0 p-0 text-left align-baseline text-xs"
          >
            <NavLink to="/gateways">Gateways</NavLink>
          </Button>
          .
        </p>
      </Fade>
    </PageBody>
  );
}

/* --------------------------------- helpers -------------------------------- */

/** Same shallow recursive compare as `SettingsPage` - the two never share it. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  suffix,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  description?: string;
  onChange(value: number): void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? String(value);
  const parsed = Number(shown);
  const invalid = shown.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max;

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          value={shown}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setRaw(next);
            const number = Number(next);
            if (next.trim() !== '' && Number.isInteger(number) && number >= min && number <= max) {
              onChange(number);
            }
          }}
          onBlur={() => setRaw(null)}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>
        {invalid ? 'Enter a whole number between ' + min + ' and ' + max + '.' : null}
      </FieldError>
    </Field>
  );
}
