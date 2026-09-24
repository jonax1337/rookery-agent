import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec, ProviderId, RookeryConfig, ToolServerAudience } from '../types.js';
import { computerEngine, computerPromptBlock, computerServerSpec, zavoraServerPath } from '../computer/tools.js';

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
  /** UI name, English like every user-facing string. */
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
  /** The process to start; null when something required is missing. */
  spec(context: SpecContext): McpServerSpec | null;
  /** The paragraph the model gets about these tools. */
  hint(options: Record<string, string>): string;
  /** Whether the server can run on this machine right now. */
  installed(options?: Record<string, string>): boolean;
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
    name: 'Computer control',
    description:
      'Rookery\'s embedded Windows computer control: visible cursor, fast action batches and background ' +
      'interaction through supported accessibility controls. Use Playwright for websites.',
    homepage: 'https://github.com/jonax1337/rookery-agent',
    install: 'bundled',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'engine', label: 'Engine', type: 'select',
        choices: [{ value: 'builtin', label: 'Rookery native (Windows)' }, { value: 'zavora', label: 'Zavora (legacy)' }],
        default: computerEngine(),
      },
      {
        key: 'mode', label: 'Native interaction mode', type: 'select',
        hint: 'Background only blocks physical input and focus changes. Apps must expose UI Automation actions; some app actions can open or activate their own windows.',
        choices: [{ value: 'desktop', label: 'Desktop and background' }, { value: 'background', label: 'Background only' }],
        default: 'desktop',
      },
      {
        key: 'profile',
        label: 'Legacy engine permissions',
        hint: 'Applies to Zavora only. Rookery native exposes fixed tools, without arbitrary scripts or administration.',
        type: 'select',
        choices: [
          { value: 'core', label: 'View and interact' },
          { value: 'ax', label: 'View, interact and read controls (recommended)' },
          { value: 'scripting', label: 'Add PowerShell scripts and files' },
          { value: 'windows-admin', label: 'Add processes, registry and notifications' },
          { value: 'full', label: 'Everything' },
        ],
        default: 'ax',
      },
    ],
    env: [],
    spec: ({ config, options, provider }) => computerServerSpec(config, provider, options.profile, options.engine, options.mode),
    hint: (options) => computerPromptBlock(computerEngine(options.engine)) +
      (computerEngine(options.engine) === 'builtin' && options.mode === 'background' ? ' Background-only mode is enforced: no physical input, clipboard writes, launching or focus changes.' : ''),
    installed: (options) => computerEngine(options?.engine) === 'builtin' ? process.platform === 'win32' : zavoraServerPath() !== null,
  },
  {
    id: 'playwright',
    name: 'Browser (Playwright)',
    description:
      'A real browser controlled through the page accessibility tree: navigate, read, fill in forms ' +
      'and click. More precise and less costly for websites than computer control.',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    install: 'bundled',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'browser',
        label: 'Browser',
        hint: 'Edge and Chrome use the installed version. Playwright downloads Chromium.',
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
        label: 'Profile',
        hint: 'Saved: the browser keeps its own profile, so logins and cookies survive between turns. Fresh: a clean profile each turn. Either way the window only opens when a browser tool is actually used.',
        type: 'select',
        choices: [
          { value: 'yes', label: 'Keep logins between turns' },
          { value: 'no', label: 'Fresh profile each turn' },
        ],
        default: 'yes',
      },
      {
        key: 'headless',
        label: 'Visibility',
        type: 'select',
        choices: [
          { value: 'no', label: 'Visible window' },
          { value: 'yes', label: 'Hidden (headless)' },
        ],
        default: 'no',
      },
    ],
    env: [],
    prepare: {
      label: 'Download Chromium (only needed when using Chromium)',
      command: 'npx',
      args: ['-y', 'playwright', 'install', 'chromium'],
    },
    // No `ensure`: the browser starts when Playwright first needs it, not at
    // the top of every turn. A conversation that never touches the web never
    // sees a browser window.
    spec: ({ config, options }) => {
      const kind = options.browser || 'msedge';
      return bundledOrNpx('playwright', playwrightCliPath(), '@playwright/mcp', [
        '--browser',
        kind,
        // One profile folder of its own, so logins survive the turn that made them.
        ...(options.persistent !== 'no' ? ['--user-data-dir', join(config.home, 'browser-profile')] : []),
        ...(options.headless === 'yes' ? ['--headless'] : []),
        '--init-page', fileURLToPath(new URL('../computer/browser-init.js', import.meta.url)),
      ]);
    },
    hint: (options) =>
      [
        'You have a real browser through the playwright tools. Use browser_navigate to go somewhere,',
        'browser_snapshot to read the page as an accessibility tree (prefer it over screenshots), and',
        'browser_click, browser_type, browser_fill_form and browser_select_option with the element refs',
        'from the snapshot. browser_take_screenshot only when layout matters. For anything on a web page',
        'use these before the computer tools; the computer tools are for everything outside the browser.',
        'The browser has its own visible pointer overlay and works without desktop focus, including in headless mode.',
        'Use the headless option for background-only browser work; do not use desktop clicks on that browser.',
        options.persistent !== 'no'
          ? 'The browser opens on your first browser call and closes with the turn, but it keeps its profile: logins from earlier turns are still there.'
          : '',
        'Never submit a purchase, a message or a form with consequences without asking once.',
      ]
        .filter(Boolean)
        .join(' '),
    installed: () => true,
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, search and move files in allowed directories.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    install: 'on-demand',
    defaultAudience: 'assistant',
    options: [
      {
        key: 'roots',
        label: 'Directories',
        hint: 'Absolute paths separated by semicolons. Leave empty to use the Rookery workspace.',
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
    name: 'Context7 (library documentation)',
    description: 'Look up current documentation and code examples for libraries and frameworks.',
    homepage: 'https://github.com/upstash/context7',
    install: 'on-demand',
    defaultAudience: 'both',
    options: [],
    env: [
      {
        name: 'CONTEXT7_API_KEY',
        label: 'API key',
        hint: 'Optional; usage limits are lower without a key.',
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
    description: 'Read and edit repositories, issues and pull requests on GitHub.',
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
    install: 'on-demand',
    defaultAudience: 'both',
    options: [],
    env: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal Access Token',
        hint: 'A token with repo permissions. The server stays off without a token.',
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
