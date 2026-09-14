import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The ChatGPT session the `codex` CLI logged in with.
 *
 * `codex login` writes `~/.codex/auth.json`; a ChatGPT-plan login leaves
 * `OPENAI_API_KEY` null there and keeps OAuth tokens instead, so those tokens
 * are the only credential that exists. We read them, refresh them when they
 * are about to expire, and write the new ones back the way the CLI itself
 * does - so both can share one session and neither invalidates the other.
 *
 * Only the initial login needs the CLI. Everything after that happens here.
 */

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** The Codex CLI's own OAuth client, from codex-rs/login/src/auth/manager.rs. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Refresh this long before the token actually expires, as the CLI does. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function authPath(): string {
  return join(codexHome(), 'auth.json');
}

/**
 * The `exp` claim of a JWT, in milliseconds. Undefined when the token is not
 * a JWT or carries no expiry - the caller then refreshes rather than guessing
 * that it is still good.
 */
function expiryOf(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class CodexSession {
  /** In flight refresh, so parallel turns never refresh the same token twice. */
  #refreshing: Promise<CodexCredentials> | undefined;

  #read(): AuthFile {
    try {
      return JSON.parse(readFileSync(authPath(), 'utf8')) as AuthFile;
    } catch {
      throw new Error(
        'No ChatGPT session found at ' + authPath() + '. Run `codex login` once to create it.',
      );
    }
  }

  /** Whether a session exists at all, for a status probe that must not throw. */
  exists(): boolean {
    try {
      const tokens = this.#read().tokens;
      return Boolean(tokens?.access_token && tokens.account_id);
    } catch {
      return false;
    }
  }

  /** A usable access token, refreshed first when it is at or near expiry. */
  async credentials(): Promise<CodexCredentials> {
    const file = this.#read();
    const tokens = file.tokens;
    if (!tokens?.access_token || !tokens.account_id) {
      throw new Error('The ChatGPT session in ' + authPath() + ' is incomplete. Run `codex login` again.');
    }

    const expiry = expiryOf(tokens.access_token);
    if (expiry !== undefined && expiry - REFRESH_WINDOW_MS > Date.now()) {
      return { accessToken: tokens.access_token, accountId: tokens.account_id };
    }
    return this.refresh();
  }

  /** Exchange the refresh token for a new access token and persist the result. */
  refresh(): Promise<CodexCredentials> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<CodexCredentials> {
    const file = this.#read();
    const refreshToken = file.tokens?.refresh_token;
    const accountId = file.tokens?.account_id;
    if (!refreshToken || !accountId) {
      throw new Error('The ChatGPT session has no refresh token. Run `codex login` again.');
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(
        'Refreshing the ChatGPT session failed (' + response.status + '). Run `codex login` again.',
      );
    }

    const body = (await response.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };
    if (!body.access_token) {
      throw new Error('The token endpoint returned no access token. Run `codex login` again.');
    }

    // Write back the way the CLI does: only the fields that came back, so a
    // response without a rotated refresh token keeps the existing one, and the
    // CLI keeps working against the same file.
    const next: AuthFile = {
      ...file,
      tokens: {
        ...file.tokens,
        ...(body.id_token ? { id_token: body.id_token } : {}),
        access_token: body.access_token,
        ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
    };
    writeFileSync(authPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');

    return { accessToken: body.access_token, accountId };
  }
}

export const sharedCodexSession = new CodexSession();
