import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec, ProviderId, RookeryConfig, ToolServerAudience } from '../types.js';
import { computerEngine, computerPromptBlock, computerServerSpec, zavoraServerPath } from '../computer/tools.js';
import { BROWSER_DEBUG_PORT, ensureBrowser } from './browser.js';

/**
 * The catalogue of MCP servers Rookery knows how to run.
 *
 * An entry is a recipe, not a running thing: how to start the server, which
 * options and keys it takes, and what to tell the model about it. The user's
 * choices (on or off, for whom, which options) live in the config under
 * `tools.servers`; `hub.ts` marries the two. Servers not in the catalogue
 * are custom entries with their own command.
 */

export interface CatalogOption {
  key: string;
  label: string;
  hint?: string;
  type: 'select' | 'text';
  choices?: { value: string; label: string }[];
  default: string;
}

export interface CatalogEnv {
  name: string;
  label: string;
  hint?: string;
  required: boolean;
  secret: boolean;
}

export interface SpecContext {
  config: RookeryConfig;
  options: Record<string, string>;
  env: Record<string, string>;
  provider?: ProviderId;
}

export interface ToolCatalogEntry {
  id: string;
  /** UI name, German like every user-facing string. */
  name: string;
  description: string;
  homepage: string;
  /** Ships with Rookery, or is fetched by npx on first use. */
  install: 'bundled' | 'on-demand';
  defaultAudience: ToolServerAudience;
  options: CatalogOption[];
  env: CatalogEnv[];
  /** A one-off preparation step, e.g. a browser download. */
  prepare?: { label: string; command: string; args: string[] };
  /** Runs before every turn that gets this server, e.g. to start a shared browser. */
  ensure?(context: SpecContext): Promise<void>;
  /** The process to start; null when something required is missing. */
  spec(context: SpecContext): McpServerSpec | null;
  /** The paragraph the model gets about these tools. */
  hint(options: Record<string, string>): string;
  /** Whether the server can run on this machine right now. */
  installed(): boolean;
}

/** `npx` on Windows is a .cmd shim; a spawned server has to go through cmd. */
export function npxSpec(name: string, args: string[], env: Record<string, string> = {}): McpServerSpec {
  const win = process.platform === 'win32';
  return {
    name,
    command: win ? 'cmd' : 'npx',
    args: win ? ['/c', 'npx', '-y', ...args] : ['-y', ...args],
    env,
  };
}

/** The bundled Playwright MCP entry script, or null when the package is missing. */
export function playwrightCliPath(): string | null {
  try {
    const manifest = fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'));
    const cli = join(dirname(manifest), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** A bundled Node script when it is there, npx otherwise: no registry round trip per turn. */
function bundledOrNpx(name: string, script: string | null, pkg: string, args: string[], env: Record<string, string> = {}): McpServerSpec {
  if (script) return { name, command: process.execPath, args: [script, ...args], env };
  return npxSpec(name, [pkg, ...args], env);
}

const withKeys = (env: Record<string, string>, names: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of names) {
    const value = env[key] || process.env[key];
    if (value) out[key] = value;
  }
  return out;
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    id: 'computer',
    name: 'Computer-Steuerung',
    description:
      'Bildschirm sehen, Maus und Tastatur bedienen, Bedienelemente über den Accessibility-Baum lesen. ' +
      'Für alles, was ausserhalb des Browsers passiert.',
    homepage: 'https://github.com/zavora-ai/computer-use-mcp',
    install: 'bundled',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'profile',
        label: 'Befugnis',
        hint: 'Sehen und bedienen reicht für fast alles; Skripte und Administration greifen tiefer ins System.',
        type: 'select',
        choices: [
          { value: 'core', label: 'Sehen und bedienen' },
          { value: 'ax', label: 'Sehen, bedienen, Bedienelemente lesen (empfohlen)' },
          { value: 'scripting', label: 'dazu PowerShell-Skripte und Dateien' },
          { value: 'windows-admin', label: 'dazu Prozesse, Registry, Benachrichtigungen' },
          { value: 'full', label: 'alles' },
        ],
        default: 'ax',
      },
    ],
    env: [],
    spec: ({ config, options, provider }) => computerServerSpec(config, provider, options.profile),
    hint: () => computerPromptBlock(computerEngine()),
    installed: () => process.platform === 'win32' || zavoraServerPath() !== null,
  },
  {
    id: 'playwright',
    name: 'Browser (Playwright)',
    description:
      'Ein echter Browser, gesteuert über den Accessibility-Baum der Seite: navigieren, lesen, Formulare ' +
      'ausfüllen, klicken. Für Webseiten genauer und billiger als die Computer-Steuerung.',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    install: 'bundled',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'browser',
        label: 'Browser',
        hint: 'Edge und Chrome nutzen die installierte Version. Chromium wird von Playwright heruntergeladen.',
        type: 'select',
        choices: [
          { value: 'msedge', label: 'Microsoft Edge' },
          { value: 'chrome', label: 'Google Chrome' },
          { value: 'chromium', label: 'Chromium (Playwright)' },
        ],
        default: 'msedge',
      },
      {
        key: 'persistent',
        label: 'Fenster',
        hint: 'Offen: Rookery startet Edge oder Chrome einmal mit eigenem Profil und jeder Turn hängt sich daran; Tabs und Logins bleiben. Frisch: pro Turn ein neuer Browser, der danach schliesst.',
        type: 'select',
        choices: [
          { value: 'yes', label: 'Bleibt zwischen den Turns offen' },
          { value: 'no', label: 'Frisch pro Turn' },
        ],
        default: 'yes',
      },
      {
        key: 'headless',
        label: 'Sichtbarkeit (nur „frisch pro Turn“)',
        type: 'select',
        choices: [
          { value: 'no', label: 'Fenster sichtbar' },
          { value: 'yes', label: 'Unsichtbar (headless)' },
        ],
        default: 'no',
      },
    ],
    env: [],
    prepare: {
      label: 'Chromium herunterladen (nur für Browser = Chromium nötig)',
      command: 'npx',
      args: ['-y', 'playwright', 'install', 'chromium'],
    },
    ensure: async ({ config, options }) => {
      const kind = options.browser === 'chrome' ? 'chrome' : options.browser === 'msedge' ? 'msedge' : null;
      if (options.persistent === 'no' || !kind) return;
      await ensureBrowser(kind, join(config.home, 'browser-profile'));
    },
    spec: ({ options }) => {
      const kind = options.browser || 'msedge';
      const shared = options.persistent !== 'no' && kind !== 'chromium';
      return bundledOrNpx('playwright', playwrightCliPath(), '@playwright/mcp', [
        ...(shared
          ? ['--cdp-endpoint', 'http://127.0.0.1:' + BROWSER_DEBUG_PORT]
          : ['--browser', kind, ...(options.headless === 'yes' ? ['--headless'] : [])]),
      ]);
    },
    hint: (options) =>
      [
        'You have a real browser through the playwright tools. Use browser_navigate to go somewhere,',
        'browser_snapshot to read the page as an accessibility tree (prefer it over screenshots), and',
        'browser_click, browser_type, browser_fill_form and browser_select_option with the element refs',
        'from the snapshot. browser_take_screenshot only when layout matters. For anything on a web page',
        'use these before the computer tools; the computer tools are for everything outside the browser.',
        options.persistent !== 'no'
          ? 'The browser window stays open between turns: reuse the tab that is there, and never call browser_close unless the user asks.'
          : '',
        'Never submit a purchase, a message or a form with consequences without asking once.',
      ]
        .filter(Boolean)
        .join(' '),
    installed: () => true,
  },
  {
    id: 'filesystem',
    name: 'Dateisystem',
    description: 'Dateien in freigegebenen Verzeichnissen lesen, schreiben, suchen und verschieben.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    install: 'on-demand',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'roots',
        label: 'Verzeichnisse',
        hint: 'Absolute Pfade, durch Semikolon getrennt. Leer heisst: der Rookery-Arbeitsraum.',
        type: 'text',
        default: '',
      },
    ],
    env: [],
    spec: ({ config, options }) => {
      const roots = (options.roots || '')
        .split(';')
        .map((root) => root.trim())
        .filter(Boolean);
      return npxSpec('filesystem', ['@modelcontextprotocol/server-filesystem', ...(roots.length ? roots : [config.workspace])]);
    },
    hint: (options) =>
      'The filesystem tools reach these directories and nothing else: ' +
      (options.roots || 'the Rookery workspace') +
      '. Read before you write, and say what you changed.',
    installed: () => true,
  },
  {
    id: 'context7',
    name: 'Context7 (Bibliotheks-Doku)',
    description: 'Aktuelle Dokumentation und Codebeispiele zu Bibliotheken und Frameworks nachschlagen.',
    homepage: 'https://github.com/upstash/context7',
    install: 'on-demand',
    defaultAudience: 'both',
    options: [],
    env: [
      {
        name: 'CONTEXT7_API_KEY',
        label: 'API-Key',
        hint: 'Optional; ohne Key gilt ein niedrigeres Limit.',
        required: false,
        secret: true,
      },
    ],
    spec: ({ env }) => npxSpec('context7', ['@upstash/context7-mcp'], withKeys(env, ['CONTEXT7_API_KEY'])),
    hint: () =>
      'For questions about a library, framework or API, look the current documentation up with the ' +
      'context7 tools (resolve-library-id, then query-docs) instead of answering from memory.',
    installed: () => true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, Issues und Pull Requests auf GitHub lesen und bearbeiten.',
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
    install: 'on-demand',
    defaultAudience: 'both',
    options: [],
    env: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal Access Token',
        hint: 'Ein Token mit repo-Rechten. Ohne Token bleibt der Server aus.',
        required: true,
        secret: true,
      },
    ],
    spec: ({ env }) => {
      const keys = withKeys(env, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
      if (!keys.GITHUB_PERSONAL_ACCESS_TOKEN) return null;
      return npxSpec('github', ['@modelcontextprotocol/server-github'], keys);
    },
    hint: () =>
      'The github tools work with repositories, issues and pull requests on GitHub. Read before you ' +
      'change anything, and ask once before creating or closing something visible to other people.',
    installed: () => true,
  },
];

export function catalogEntry(id: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG.find((entry) => entry.id === id);
}
