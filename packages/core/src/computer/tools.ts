import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec, ProviderId, RookeryConfig } from '../types.js';
import { COMPUTER_PROFILES } from '../types.js';

/**
 * Computer control: the assistant sees the screen and works the mouse and
 * keyboard of the machine it runs on.
 *
 * The tools live in their own MCP server (`computer`), next to `rookery`, so
 * a provider process gets them only when the user switched them on. Three
 * engines can stand behind that name:
 *
 *   zavora   `@zavora-ai/computer-use-mcp`: screenshots plus the Windows
 *            accessibility tree, so the model clicks controls by label
 *            instead of hunting pixels. Kept as an explicit alternative.
 *   builtin  Rookery's persistent Windows worker: UI Automation, targeted
 *            edit messages, screenshots and physical input. The Windows default.
 *   custom   a custom server configured in the tool hub.
 */

export const COMPUTER_SERVER_NAME = 'computer';

export type ComputerEngine = 'zavora' | 'builtin';

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const num = (description: string): Record<string, unknown> => ({ type: 'number', description });

export interface ComputerToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const UI_ACTIONS = ['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll_up', 'scroll_down'] as const;
const windowProperty = { type: 'integer', minimum: 1, description: 'Exact window handle returned by list_windows.' };

/** The built-in server's tools, before observe is attached. The zavora engine publishes its own list. */
const TOOLS: ComputerToolDefinition[] = [
  {
    name: 'screenshot',
    description:
      'Capture the desktop including its real cursor, or an unfocused window with a virtual cursor at ' +
      'the last automation target. Only desktop screenshot coordinates can be used for physical input. ' +
      'Window capture is app-dependent; use snapshot if pixels are blank or the window is minimized.',
    inputSchema: { type: 'object', properties: { window: windowProperty }, additionalProperties: false },
  },
  {
    name: 'snapshot',
    description: 'Read a window accessibility tree without focusing it. Returns fresh element refs and supported actions. Password values are omitted; refs expire on the next snapshot.',
    inputSchema: { type: 'object', properties: { window: windowProperty, maxNodes: { type: 'integer', minimum: 1, maximum: 300 }, depth: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['window'], additionalProperties: false },
  },
  {
    name: 'act',
    description: 'Act on a fresh snapshot ref via UI Automation (or a targeted native message for standard text fields), without physical input. The persistent Rookery cursor marks visible targets; covered windows keep their marker in screenshots. App providers may activate their own window; focusChanged reports this and background-only mode stops. Unsupported actions fail. Read a fresh snapshot to verify.',
    inputSchema: { type: 'object', properties: { ref: str('Fresh element ref.'), action: { type: 'string', enum: [...UI_ACTIONS] }, value: str('Required for set_value; empty clears the field.') }, required: ['ref', 'action'], additionalProperties: false },
  },
  {
    name: 'batch',
    description: 'Run up to 12 already-grounded actions sequentially in one call; stop on the first failure. All arguments are checked before starting. Observe once at the end. Do not batch across unknown UI states or irreversible confirmation steps.',
    inputSchema: { type: 'object', properties: {
      actions: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { tool: { type: 'string', enum: ['act', 'click', 'move_mouse', 'drag', 'draw', 'scroll', 'type_text', 'press_keys', 'wait'] }, arguments: { type: 'object' } }, required: ['tool', 'arguments'], additionalProperties: false } },
      observe: { type: 'string', enum: ['snapshot', 'screenshot', 'none'], description: 'Default snapshot when window is supplied, otherwise screenshot.' },
      window: windowProperty,
    }, required: ['actions'], additionalProperties: false },
  },
  {
    name: 'stop',
    description: 'Immediately cancel current and queued actions and disable further actions for this MCP session. Observations remain available. A new turn creates a fresh session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'screen_info',
    description: 'Screen size, coordinate scale, monitors and observer visibility/status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_screen',
    description:
      'The whole screen as text (OCR): each line with its centre x,y in screenshot pixels, top to bottom. ' +
      'Much cheaper than a screenshot and enough to click by coordinates; use a screenshot for layout, ' +
      'icons and images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_text',
    description: 'Where a word or phrase is on screen (OCR, case-insensitive, tolerant of small OCR errors): centres in screenshot pixels, active window first.',
    inputSchema: { type: 'object', properties: { text: str('The word or phrase as it appears on screen.') }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'hand_over',
    description:
      'Let the user do what software must not: approve a UAC prompt, confirm Windows Hello or a PIN, solve ' +
      'a CAPTCHA, sign in. The cursor shows "Your turn" with the reason and a sound plays; the call returns ' +
      'when a secure prompt closes, or when the user has acted and then been idle for 4 s, with a fresh ' +
      'screenshot. Never try to answer such prompts yourself.',
    inputSchema: {
      type: 'object',
      properties: { reason: str('Short, for the user: "Please approve the installer".'), timeoutSec: num('How long to wait, 5 to 600. Default 180.') },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click at a point, or on text: text finds it on screen by OCR and clicks its centre, no screenshot ' +
      'coordinates needed ("Speichern", "Sign in"). If the text is on screen more than once, the error lists ' +
      'the places; pass index. Double-click with count 2; right-click with button "right".',
    inputSchema: {
      type: 'object',
      properties: {
        x: num('Horizontal position in screenshot pixels.'),
        y: num('Vertical position in screenshot pixels.'),
        text: str('Instead of x and y: the visible text to click.'),
        index: num('Which match when the text appears several times (1 = first as listed).'),
        button: str('left, right or middle. Default left.'),
        count: num('1 or 2. Default 1.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'move_mouse',
    description: 'Move the pointer without clicking, for hover menus and tooltips.',
    inputSchema: {
      type: 'object',
      properties: { x: num('Screenshot pixels.'), y: num('Screenshot pixels.') },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'drag',
    description: 'Press the left button at one point, move straight to another, release.',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: num('Start, screenshot pixels.'),
        fromY: num('Start, screenshot pixels.'),
        toX: num('End, screenshot pixels.'),
        toY: num('End, screenshot pixels.'),
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
      additionalProperties: false,
    },
  },
  {
    name: 'draw',
    description:
      'Paint with the mouse in Paint, whiteboards or any canvas; the pen colour and brush are whatever ' +
      'the app has selected. Best: pass svg, line art the pen traces smoothly into area (the canvas ' +
      'rectangle in screenshot pixels). Supported: path (all commands incl. arcs and curves), circle, ' +
      'ellipse, rect (rx for rounded), line, polyline, polygon, g, and transform. Every shape is ' +
      'outlined unless stroke="none"; colours, gradients and text are ignored, so draw one colour per ' +
      'call. With hatch, filled shapes (fill not "none") are shaded with parallel strokes. Everything ' +
      'is clipped to area, so nothing touches the toolbar. strokes takes raw [x, y] point lists instead. ' +
      'The call returns the finished canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        svg: str('An <svg> document with a viewBox; it is scaled into area keeping its aspect ratio, centred.'),
        area: {
          type: 'object', description: 'The drawing rectangle in screenshot pixels; required with svg, and clips strokes too.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'], additionalProperties: false,
        },
        hatch: {
          type: 'object', description: 'Shade filled shapes. spacing in screenshot pixels (default 6), angle in degrees (default 45), cross for cross-hatching.',
          properties: { spacing: { type: 'number' }, angle: { type: 'number' }, cross: { type: 'boolean' } },
          additionalProperties: false,
        },
        strokes: {
          type: 'array', minItems: 1, maxItems: 100,
          description: 'Raw strokes, each a list of [x, y] points in screenshot pixels; a single point is a dot.',
          items: { type: 'array', minItems: 1, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } } },
        },
        button: str('left (primary colour in Paint) or right (secondary colour). Default left.'),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the wheel over a point.',
    inputSchema: {
      type: 'object',
      properties: {
        x: num('Screenshot pixels.'),
        y: num('Screenshot pixels.'),
        direction: str('up, down, left or right. Default down.'),
        amount: num('Wheel notches, 1 to 20. Default 3.'),
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into whatever has focus, as keystrokes, umlauts and all. For more than a few ' +
      'lines use clipboard set and press_keys ctrl+v.',
    inputSchema: {
      type: 'object',
      properties: { text: str('The text to type.') },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_keys',
    description:
      'Press a shortcut or a sequence of them: "ctrl+l", "alt+tab", "win+r", "enter", or several ' +
      'separated by spaces, "ctrl+a backspace". Names: ctrl, alt, shift, win, enter, tab, esc, ' +
      'backspace, delete, space, arrows, home, end, pageup, pagedown, f1 to f12, letters, digits.',
    inputSchema: {
      type: 'object',
      properties: { keys: str('The combo or sequence.') },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_windows',
    description: 'Open windows with title, program and position, the active one first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the front by a part of its title or its program name.',
    inputSchema: {
      type: 'object',
      properties: { title: str('Part of the window title, or the program name, case-insensitive.') },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'open',
    description:
      'Start a program, open a file or a URL, the way the Start menu or a double-click would: ' +
      '"notepad", "https://example.com", "C:/Users/me/report.docx", "ms-settings:".',
    inputSchema: {
      type: 'object',
      properties: { target: str('Program name, path or URL.') },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'clipboard',
    description: 'Read the clipboard, or put text on it (then press_keys ctrl+v to paste).',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('get or set.'),
        text: str('The text to put on the clipboard, for set.'),
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Pause, for a program or page that is still loading.',
    inputSchema: {
      type: 'object',
      properties: { ms: num('Milliseconds, up to 30000. Default 1000.') },
      additionalProperties: false,
    },
  },
];

/** Physical actions return the screen once it has settled, so the model needs no second call to look. */
const OBSERVED = ['click', 'move_mouse', 'drag', 'draw', 'scroll', 'type_text', 'press_keys', 'focus_window', 'open'];
const observeProperty = {
  type: 'string',
  enum: ['screenshot', 'text', 'none'],
  description: 'What the call returns once the screen stops changing: a screenshot (default), the screen text (read_screen, cheaper), or nothing when the next step is already known.',
};

export const COMPUTER_TOOLS: ComputerToolDefinition[] = TOOLS.map((tool) => OBSERVED.includes(tool.name)
  ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), observe: observeProperty } } }
  : tool);

/* --------------------------------- engines -------------------------------- */

const ZAVORA_PACKAGE = '@zavora-ai/computer-use-mcp';

/**
 * The zavora server's entry script, or null when the package is not
 * installed. The package publishes ESM-only export conditions, so a plain
 * `require.resolve` fails; the ESM resolver is asked first, and a walk up
 * the node_modules chain from this file covers hosts without it.
 */
export function zavoraServerPath(): string | null {
  try {
    const resolved = import.meta.resolve(ZAVORA_PACKAGE + '/server');
    if (resolved.startsWith('file:')) {
      const path = fileURLToPath(resolved);
      if (existsSync(path)) return path;
    }
  } catch {
    // fall through to the manual walk
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'node_modules', ZAVORA_PACKAGE, 'dist', 'server.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Rookery owns the Windows engine; retain the bundled alternative on other hosts. */
export function computerEngine(requested?: string): ComputerEngine {
  if (requested === 'builtin' || requested === 'zavora') return requested;
  return process.platform === 'win32' || !zavoraServerPath() ? 'builtin' : 'zavora';
}

/**
 * The MCP server for this turn. `provider` picks the screenshot sizing the
 * model likes; `profile` is the zavora authority level.
 */
export function computerServerSpec(config: RookeryConfig, provider?: ProviderId, profile = 'ax', engine?: string, mode = 'desktop'): McpServerSpec {
  if (!['desktop', 'background'].includes(mode)) throw new Error('Unknown computer interaction mode: ' + mode);
  if (computerEngine(engine) === 'zavora') {
    const script = zavoraServerPath();
    if (!script) throw new Error('The Zavora engine is not installed. Select Rookery native on Windows.');
    return {
      name: COMPUTER_SERVER_NAME,
      command: process.execPath,
      args: [script],
      env: {
        COMPUTER_USE_PROFILE: (COMPUTER_PROFILES as readonly string[]).includes(profile) ? profile : 'ax',
        COMPUTER_USE_PROVIDER: provider === 'codex' ? 'openai' : 'anthropic',
        COMPUTER_USE_AUDIT_LOG: join(config.home, 'run', 'computer-audit.jsonl'),
      },
    };
  }
  return {
    name: COMPUTER_SERVER_NAME,
    command: process.execPath,
    args: [computerScriptPath()],
    env: {
      ROOKERY_COMPUTER_MAX_WIDTH: '1280',
      ROOKERY_COMPUTER_DIR: config.home,
      ROOKERY_COMPUTER_MODE: mode === 'background' ? 'background' : 'desktop',
    },
  };
}

export function computerScriptPath(): string {
  return fileURLToPath(new URL('./mcp-server.js', import.meta.url));
}

/** The prompt paragraph that comes with the tools. Method, not enthusiasm. */
export function computerPromptBlock(engine: ComputerEngine = 'builtin'): string {
  const shared = [
    'Before anything the user could not undo - deleting, sending, paying, closing unsaved work -',
    'stop and ask with one question. When the user says stop, stop at once. In a written turn do',
    'not narrate each click; say what you did once it is done, and what you saw when it did not',
    'work. In a spoken turn follow the think-aloud rule of the spoken register instead.',
  ];
  if (engine === 'zavora') {
    return [
      'You can see and operate this computer through the computer tools. Work the way the tools',
      'themselves advise: get_ui_tree, find_element and get_focused_element to read the interface,',
      'click_element, press_button, set_value and fill_form to operate it by label, and only then',
      'screenshot plus left_click, type and key by coordinates. open_application, activate_app and',
      'list_windows bring the right program to the front; physical input needs its target in front,',
      'so pass target_app when you click or type. get_tool_guide tells you the best route for an',
      'unfamiliar app. Verify after acting: a fresh screenshot or a fresh ui tree, never an assumption.',
      ...shared,
    ].join(' ');
  }
  return [
    'You can see and operate this computer through Rookery\'s embedded computer tools.',
    'Read use_skill("computer-use") for the method. list_windows returns window handles;',
    'snapshot(window) reads controls without focusing, act(ref, action) uses supported automation',
    'patterns or native edit messages without mouse or keyboard injection. App providers can still',
    'change focus themselves; results report focusChanged. There is no physical-input fallback for act.',
    'batch runs up to 12 known actions with one final observation, reducing model round trips.',
    'For physical input: one screenshot to start; every action then returns the screen once it has',
    'settled, so do not take another. Pass observe "text" when words are enough, "none" when the next',
    'step is already known. Coordinates are pixels of the last desktop screenshot (or read_screen), and',
    'its foreground window must still match. Window screenshots are observation only. Prefer click with',
    'text over coordinates, read_screen over screenshots for reading, and keyboard shortcuts over both.',
    'The background-only mode refuses all foreground input. Use Playwright for browser work.',
    'stop cancels current and queued work for this session. Verify results; sending input is not success.',
    'Prefer open and focus_window over hunting for pixels; put very long text on the clipboard and',
    'paste it. UAC prompts, Windows Hello, PINs, sign-ins and CAPTCHAs are the user\'s: call hand_over',
    'with a short reason, never try to answer them. If every action is refused because the pointer sits',
    'in the top-left corner, the user pulled the emergency brake: stop, do not work around it.',
    'An action stopped because "the user moved the mouse" means the user took over: do not retry',
    'until the user hands control back.',
    ...shared,
  ].join(' ');
}
