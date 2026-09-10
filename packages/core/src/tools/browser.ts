import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A browser that outlives the turn.
 *
 * MCP servers are spawned per turn and die with it, and Playwright MCP takes
 * its browser down when it exits. To keep the window (and its logins and
 * tabs) between turns, Rookery starts Edge or Chrome itself with a remote
 * debugging port and its own profile, and every turn's Playwright attaches
 * to that one browser through CDP instead of launching a fresh one.
 */

export const BROWSER_DEBUG_PORT = 9333;

const WINDOWS_PATHS: Record<'msedge' | 'chrome', string[]> = {
  msedge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
};

const UNIX_NAMES: Record<'msedge' | 'chrome', string[]> = {
  msedge: ['microsoft-edge', 'microsoft-edge-stable', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};

/** The browser binary, or null when it is not installed. */
export function browserExecutable(kind: 'msedge' | 'chrome'): string | null {
  if (process.platform === 'win32') {
    return WINDOWS_PATHS[kind].find((path) => existsSync(path)) ?? null;
  }
  return UNIX_NAMES[kind].find((name) => (name.startsWith('/') ? existsSync(name) : true)) ?? null;
}

/** Whether a browser answers on the debugging port. */
export async function browserAlive(port = BROWSER_DEBUG_PORT): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure the shared browser is running; start it when it is not. Returns
 * false when the browser is not installed or did not come up in time.
 */
export async function ensureBrowser(kind: 'msedge' | 'chrome', profileDir: string, port = BROWSER_DEBUG_PORT): Promise<boolean> {
  if (await browserAlive(port)) return true;
  const executable = browserExecutable(kind);
  if (!executable) return false;
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    executable,
    [
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await browserAlive(port)) return true;
  }
  return false;
}
