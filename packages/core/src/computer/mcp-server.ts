#!/usr/bin/env node
/**
 * The stdio MCP server for computer control.
 *
 * Unlike the rookery bridge it does the work itself: it runs on the same
 * machine as the user, and there is nothing in the Rookery process it would
 * need. It speaks the same sliver of MCP (initialize, tools/list, tools/call,
 * ping) and keeps one PowerShell alive for the length of the turn.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseKeySequence } from './keys.js';
import { PowerShellSession, psQuote } from './powershell.js';
import { COMPUTER_SERVER_NAME, COMPUTER_TOOLS } from './tools.js';
import { describeScreen, findText, pickMatch, type ScreenText, type TextMatch } from './screen-text.js';
import { clipStrokes, fitViewBox, multiply, svgStrokes, svgViewBox, type Matrix, type Stroke } from './sketch.js';
import { validateComputerCall, type ComputerCall } from './validation.js';

const PROTOCOL_FALLBACK = '2025-06-18';
const MAX_WIDTH = Math.min(3840, Math.max(320, Number(process.env.ROOKERY_COMPUTER_MAX_WIDTH) || 1280));
const RUN_DIR = process.env.ROOKERY_COMPUTER_DIR ? join(process.env.ROOKERY_COMPUTER_DIR, 'run') : '';
const BACKGROUND = process.env.ROOKERY_COMPUTER_MODE === 'background';

interface JsonRpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ScreenInfo {
  left: number;
  top: number;
  width: number;
  height: number;
  screens: { name: string; primary: boolean; x: number; y: number; width: number; height: number }[];
  cursor: { x: number; y: number };
  observer: { visible: boolean; overlayHandle?: number; label?: string };
}

interface Shot {
  width: number;
  height: number;
  scale: number;
  left: number;
  top: number;
  cursorX: number;
  cursorY: number;
  jpeg: string;
  foreground: number;
}

const shell = new PowerShellSession();
// Warm the worker and its cursor while the model is still writing its first call;
// the first action then finds everything loaded. A failure here surfaces on that call.
if (process.platform === 'win32') shell.run('Rk-Overlay; @{}').catch(() => undefined);
let stopped = false;
let queue: Promise<unknown> = Promise.resolve();
const pending = new Set<number | string>();
const observations = new Set(['screenshot', 'screen_info', 'list_windows', 'snapshot', 'read_screen', 'find_text', 'stop']);

/* --------------------------------- mapping -------------------------------- */

/** Physical input always uses the most recent desktop screenshot. */
let view: { scale: number; left: number; top: number; width: number; height: number; foreground: number } | null = null;

function toScreen(x: number, y: number): [number, number] {
  if (!view) throw new Error('Take a desktop screenshot before physical input. Window screenshots use different coordinates.');
  if (x >= view.width || y >= view.height) throw new Error('Coordinates are outside the last desktop screenshot.');
  return [Math.round(view.left + x / view.scale), Math.round(view.top + y / view.scale)];
}

/** Refuse stale desktop targets and serialize physical input across Rookery processes. */
async function physical(expression: string, timeoutMs = 30_000): Promise<void> {
  if (!view) throw new Error('Take a desktop screenshot before physical input.');
  const guard = 'if ([RkNative]::SecureDesktop()) { throw $script:rkSecurePrompt }; $b = Rk-Bounds; if ([long][RkNative]::GetForegroundWindow() -ne ' + view.foreground +
    ' -or $b.Left -ne ' + view.left + ' -or $b.Top -ne ' + view.top +
    ' -or $b.Width -ne ' + Math.round(view.width / view.scale) +
    ') { throw "Desktop target changed. Take a fresh screenshot." }; ';
  await shell.run('$mutex = New-Object System.Threading.Mutex($false, "Local\\RookeryComputerInput"); ' +
    '$locked = $false; try { try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }; ' +
    'if (-not $locked) { throw "Another Rookery session is using desktop input." }; ' + guard + expression +
    ' } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }', timeoutMs);
}

type DrawArgs = Extract<ComputerCall, { name: 'draw' }>['args'];
/** After smoothing; the SVG input is bounded by size, not by what it expands to. */
const DRAWN_POINTS = 60_000;
/** Physical pixels one pen-down may cover before it is continued as a new stroke. */
const MAX_STROKE = 2000;

/**
 * The draw tool's strokes in physical pixels, clipped to the area (or the
 * whole screenshot), rounded and packed the way the native Draw reads them:
 * stroke count, then per stroke its point count and x, y pairs.
 */
function planDrawing(args: DrawArgs): { packed: string; strokes: number; points: number; timeoutMs: number } {
  if (!view) throw new Error('Take a desktop screenshot before physical input.');
  const { scale, left, top, width, height } = view;
  const area = args.area ?? { x: 0, y: 0, width: width - 1, height: height - 1 };
  if (area.x + area.width > width || area.y + area.height > height) throw new Error('The area reaches outside the last desktop screenshot.');
  const toPhysical: Matrix = [1 / scale, 0, 0, 1 / scale, left, top];
  const strokes: Stroke[] = (args.strokes ?? []).map((stroke) => stroke.flatMap(([x, y]) => [left + x / scale, top + y / scale]));
  if (args.svg) {
    strokes.push(...svgStrokes(args.svg, {
      transform: multiply(toPhysical, fitViewBox(svgViewBox(args.svg), area)),
      tolerance: 0.35,
      hatch: args.hatch && { spacing: args.hatch.spacing / scale, angle: args.hatch.angle, cross: args.hatch.cross },
    }));
  }
  const clip = { x: left + area.x / scale, y: top + area.y / scale, width: area.width / scale, height: area.height / scale };
  const packed = [0];
  let points = 0;
  let ink = 0;
  const emit = (rounded: number[]): void => {
    packed[0]!++;
    packed.push(rounded.length / 2);
    for (const value of rounded) packed.push(value);
    points += rounded.length / 2;
  };
  for (const stroke of clipStrokes(strokes, clip)) {
    let rounded: number[] = [];
    let length = 0;
    for (let i = 0; i + 1 < stroke.length; i += 2) {
      const x = Math.round(stroke[i]!), y = Math.round(stroke[i + 1]!);
      const n = rounded.length;
      if (n && rounded[n - 2] === x && rounded[n - 1] === y) continue;
      const step = n ? Math.hypot(x - rounded[n - 2]!, y - rounded[n - 1]!) : 0;
      // Some brushes keep only the tail of a very long stroke; continue it as a new one instead.
      if (length + step > MAX_STROKE && n >= 4) {
        emit(rounded);
        rounded = [rounded[n - 2]!, rounded[n - 1]!];
        length = 0;
      }
      ink += step;
      length += step;
      rounded.push(x, y);
    }
    emit(rounded);
  }
  if (!packed[0]) throw new Error('Nothing to draw: every shape has stroke="none" or lies outside the area.');
  if (points > DRAWN_POINTS) throw new Error('Too detailed: ' + points + ' points after smoothing (limit ' + DRAWN_POINTS + '). Split the picture into several draw calls.');
  return {
    packed: Buffer.from(new Int32Array(packed).buffer).toString('base64'),
    strokes: packed[0]!,
    points,
    // Ink runs at about 3.5 px/ms; each stroke adds a hop and two short holds.
    timeoutMs: 30_000 + ink / 2.5 + packed[0]! * 250,
  };
}

/* ---------------------------------- tools --------------------------------- */

/**
 * Recognise the screen's text. Like a screenshot, it becomes the view that
 * physical input maps through, so its coordinates can be clicked directly.
 */
async function readScreen(): Promise<{ screen: ScreenText; scale: number }> {
  const screen = await shell.run<ScreenText>('Rk-ReadScreen', 20_000);
  const scale = Math.min(1, MAX_WIDTH / screen.width);
  view = { scale, left: screen.left, top: screen.top, width: Math.round(screen.width * scale), height: Math.round(screen.height * scale), foreground: screen.foreground };
  return { screen, scale };
}

/** A match's centre in screenshot pixels. */
function centre(match: TextMatch, screen: ScreenText, scale: number): [number, number] {
  return [Math.round((match.x + match.width / 2 - screen.left) * scale), Math.round((match.y + match.height / 2 - screen.top) * scale)];
}

/**
 * What a physical action returns: the screen once it has stopped changing,
 * so the model sees the result without a second round trip, and never a
 * half-drawn frame from a fixed sleep.
 */
async function settled(observe: 'screenshot' | 'text'): Promise<Content[]> {
  const ms = await shell.run<number>('Rk-Settle');
  const seen = await perform(validateComputerCall(observe === 'text' ? 'read_screen' : 'screenshot', {}, BACKGROUND));
  return [{ type: 'text', text: 'Screen settled after ' + ms + ' ms.' }, ...seen];
}

async function call(command: ComputerCall): Promise<Content[]> {
  const content = await perform(command);
  // A batch observes once at its own end.
  const observe = command.name !== 'batch' && 'observe' in command.args ? command.args.observe : 'none';
  return observe === 'none' ? content : [...content, ...(await settled(observe))];
}

async function perform(command: ComputerCall): Promise<Content[]> {
  const { name, args } = command;
  if (stopped && !observations.has(name)) throw new Error('Computer use stopped. Start a new turn to resume.');
  switch (name) {
    case 'stop':
      stopped = true;
      view = null;
      shell.close();
      return [{ type: 'text', text: 'Computer use stopped. Current and queued actions cancelled.' }];
    case 'snapshot': {
      const result = await shell.run('Rk-Snapshot ' + args.window + ' ' + args.maxNodes + ' ' + args.depth + ' ' + (stopped ? '$false' : '$true'), 15_000);
      return [{ type: 'text', text: JSON.stringify(result) }];
    }
    case 'act': {
      view = null;
      const result = await shell.run<{ focusChanged: boolean }>('Rk-Act ' + psQuote(args.ref) + ' ' + psQuote(args.action) + ' ' + psQuote(args.value ?? ''), 15_000);
      if (BACKGROUND && result.focusChanged) {
        stopped = true;
        shell.close();
        throw new Error(JSON.stringify({ ...result, error: 'The app changed foreground through its UI Automation provider. The action was dispatched; remaining actions are stopped. Inspect the result before retrying.' }));
      }
      return [{ type: 'text', text: JSON.stringify(result) }];
    }
    case 'batch': {
      // Steps run blind; the batch observes once at its end.
      const actions = args.actions.map((step) => {
        const action = validateComputerCall(step.tool, step.arguments, BACKGROUND);
        if ('observe' in action.args) action.args.observe = 'none';
        return action;
      });
      const results: { tool: string; durationMs: number; content: Content[] }[] = [];
      for (const action of actions) {
        const started = performance.now();
        try {
          const content = await call(action);
          results.push({ tool: action.name, durationMs: Math.round(performance.now() - started), content });
        } catch (error) {
          throw new Error(JSON.stringify({ completed: results, failedAt: results.length, error: (error as Error).message, remainingSkipped: actions.length - results.length - 1 }));
        }
      }
      const observe = args.observe ?? (args.window ? 'snapshot' : 'screenshot');
      const report: Content = { type: 'text', text: JSON.stringify({ completed: results }) };
      try {
        return [report, ...(observe === 'none' ? [] : await call(validateComputerCall(observe, args.window ? { window: args.window } : {}, BACKGROUND)))];
      } catch (error) {
        throw new Error(JSON.stringify({ completed: results, observationError: (error as Error).message }));
      }
    }
    case 'screenshot': {
      if (RUN_DIR) mkdirSync(RUN_DIR, { recursive: true });
      const path = RUN_DIR ? join(RUN_DIR, 'computer-' + process.pid + '.jpg') : '';
      const shot = await shell.run<Shot>('Rk-Screenshot ' + MAX_WIDTH + ' ' + psQuote(path) + ' ' + (args.window ?? 0) + ' ' + (stopped ? '$false' : '$true'), 15_000);
      view = args.window ? null : { scale: shot.scale, left: shot.left, top: shot.top, width: shot.width, height: shot.height, foreground: shot.foreground };
      return [
        { type: 'image', data: shot.jpeg, mimeType: 'image/jpeg' },
        {
          type: 'text',
          text:
            'Screenshot ' + shot.width + 'x' + shot.height + ' px' +
            (shot.scale < 1 ? ' (screen scaled by ' + shot.scale.toFixed(3) + ')' : '') +
            (args.window ? '. Window capture (app-dependent); virtual cursor marks the last UIA target. Observe with snapshot if blank.' : '. Pointer at ' + shot.cursorX + ',' + shot.cursorY + '.') +
            (path ? ' Saved as ' + path + '.' : ''),
        },
      ];
    }
    case 'screen_info': {
      const info = await shell.run<ScreenInfo>('Rk-ScreenInfo');
      const m = { scale: Math.min(1, MAX_WIDTH / info.width) };
      return [
        {
          type: 'text',
          text:
            'Screenshot size ' + Math.round(info.width * m.scale) + 'x' + Math.round(info.height * m.scale) +
            ' px, scale ' + m.scale.toFixed(3) + ' of ' + info.width + 'x' + info.height + ' real pixels.\n' +
            info.screens
              .map((s) => '- ' + s.name + (s.primary ? ' (primary)' : '') + ': ' + s.width + 'x' + s.height + ' at ' + s.x + ',' + s.y)
              .join('\n') + '\nObserver: ' + JSON.stringify(info.observer),
        },
      ];
    }
    case 'read_screen': {
      const { screen, scale } = await readScreen();
      return [{ type: 'text', text: 'Screen text (OCR), centre x,y in screenshot pixels:\n' + describeScreen(screen, scale) }];
    }
    case 'find_text': {
      const { screen, scale } = await readScreen();
      const matches = findText(screen, args.text);
      if (!matches.length) return [{ type: 'text', text: 'No text "' + args.text + '" on screen. Visible text:\n' + describeScreen(screen, scale, 40) }];
      return [{
        type: 'text',
        text: matches.map((m, i) => {
          const [x, y] = centre(m, screen, scale);
          return (i + 1) + '. ' + x + ',' + y + ' "' + m.text + '"' + (m.approximate ? ' (approximate)' : '') + (m.foreground ? '' : ' (outside the active window)');
        }).join('\n'),
      }];
    }
    case 'hand_over': {
      view = null;
      const timeout = args.timeoutSec * 1000;
      const result = await shell.run<{ outcome: string; waitedMs: number }>('Rk-HandOver ' + psQuote(args.reason) + ' ' + timeout, timeout + 15_000);
      return [{ type: 'text', text: result.outcome + ' Waited ' + Math.round(result.waitedMs / 1000) + ' s.' }, ...(await settled('screenshot'))];
    }
    case 'click': {
      const { button, count } = args;
      let x: number, y: number, what: string;
      if (args.text !== undefined) {
        const { screen, scale } = await readScreen();
        const matches = findText(screen, args.text);
        const picked = pickMatch(matches, args.text, args.index);
        if (typeof picked === 'string') {
          const listed = matches.map((m, i) => (i + 1) + '. ' + centre(m, screen, scale).join(',') + ' "' + m.text + '"').join('\n');
          throw new Error(picked + '\n' + (listed || 'Visible text:\n' + describeScreen(screen, scale, 40)));
        }
        [x, y] = centre(picked, screen, scale);
        what = '"' + picked.text + '" at ' + x + ',' + y;
      } else {
        [x, y] = [args.x!, args.y!];
        what = x + ',' + y;
      }
      const [sx, sy] = toScreen(x, y);
      await physical('Rk-Click ' + sx + ' ' + sy + ' ' + psQuote(button) + ' ' + count);
      return [{ type: 'text', text: (count === 2 ? 'Double-clicked' : 'Clicked') + ' ' + button + ' ' + what + '.' }];
    }
    case 'move_mouse': {
      const [x, y] = toScreen(args.x, args.y);
      await physical('Rk-Move ' + x + ' ' + y);
      return [{ type: 'text', text: 'Pointer at ' + args.x + ',' + args.y + '.' }];
    }
    case 'drag': {
      const [x1, y1] = toScreen(args.fromX, args.fromY);
      const [x2, y2] = toScreen(args.toX, args.toY);
      await physical('Rk-Drag ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2);
      return [{ type: 'text', text: 'Dragged from ' + args.fromX + ',' + args.fromY + ' to ' + args.toX + ',' + args.toY + '.' }];
    }
    case 'draw': {
      const plan = planDrawing(args);
      await physical('Rk-Draw ' + psQuote(plan.packed) + ' ' + psQuote(args.button), plan.timeoutMs);
      return [{ type: 'text', text: 'Drew ' + plan.strokes + (plan.strokes === 1 ? ' stroke' : ' strokes') + ' through ' + plan.points + ' points.' }];
    }
    case 'scroll': {
      const [x, y] = toScreen(args.x, args.y);
      const { direction, amount } = args;
      await physical('Rk-Scroll ' + x + ' ' + y + ' ' + psQuote(direction) + ' ' + amount);
      return [{ type: 'text', text: 'Scrolled ' + direction + ' by ' + amount + '.' }];
    }
    case 'type_text': {
      await physical('Rk-Type ' + psQuote(args.text));
      return [{ type: 'text', text: 'Typed ' + args.text.length + ' characters.' }];
    }
    case 'press_keys': {
      const combos = parseKeySequence(args.keys);
      const literal = '@(' + combos.map((combo) => ',@(' + combo.join(',') + ')').join(';') + ')';
      await physical('Rk-Keys ' + literal);
      return [{ type: 'text', text: 'Pressed ' + args.keys + '.' }];
    }
    case 'list_windows': {
      const rows = await shell.run<{ handle: number; title: string; process: string; active: boolean; x: number; y: number; width: number; height: number }[]>('Rk-Windows');
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [{ type: 'text', text: 'No windows.' }];
      return [
        {
          type: 'text',
          text: list
            .map((w) => '- window=' + w.handle + ' ' + (w.active ? '[active] ' : '') + w.title + ' (' + w.process + ') ' + w.width + 'x' + w.height + ' at ' + w.x + ',' + w.y)
            .join('\n'),
        },
      ];
    }
    case 'focus_window': {
      view = null;
      const result = await shell.run<{ ok: boolean; title: string }>('Rk-Focus ' + psQuote(args.title));
      return [{ type: 'text', text: (result.ok ? 'Focused ' : 'Tried to focus ') + '"' + result.title + '".' }];
    }
    case 'open': {
      view = null;
      await shell.run('Rk-Open ' + psQuote(args.target));
      return [{ type: 'text', text: 'Opened ' + args.target + '.' }];
    }
    case 'clipboard': {
      if (args.action === 'set') {
        await shell.run('Rk-ClipSet ' + psQuote(args.text ?? ''));
        return [{ type: 'text', text: 'Clipboard set (' + args.text!.length + ' characters).' }];
      }
      const result = await shell.run<{ text: string }>('Rk-ClipGet');
      return [{ type: 'text', text: result.text ? result.text.slice(0, 20_000) : '(clipboard is empty)' }];
    }
    case 'wait': {
      const { ms } = args;
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (stopped) throw new Error('Computer use stopped.');
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, until - Date.now())));
      }
      return [{ type: 'text', text: 'Waited ' + ms + ' ms.' }];
    }
    default:
      throw new Error('Unknown tool ' + name + '.');
  }
}

/* ------------------------------- MCP server ------------------------------- */

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

async function handle(message: JsonRpc): Promise<void> {
  const { id, method, params } = message;
  if (method === 'notifications/cancelled' && pending.has(params?.requestId as number | string)) {
    await call({ name: 'stop', args: {} });
    return;
  }
  if (id === undefined) return;

  try {
    switch (method) {
      case 'initialize':
        send({
          id,
          result: {
            protocolVersion: (params?.protocolVersion as string | undefined) ?? PROTOCOL_FALLBACK,
            capabilities: { tools: {} },
            serverInfo: { name: COMPUTER_SERVER_NAME, version: '0.1.0' },
          },
        });
        return;
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({ id, result: { tools: COMPUTER_TOOLS } });
        return;
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (process.platform !== 'win32') {
          send({ id, result: { content: [{ type: 'text', text: 'Computer control is available on Windows only.' }], isError: true } });
          return;
        }
        pending.add(id);
        const execute = async (): Promise<void> => {
          const started = performance.now();
          let isError = false;
          try {
            const content = await call(validateComputerCall(name, args, BACKGROUND));
            content.push({ type: 'text', text: JSON.stringify({ durationMs: Math.round(performance.now() - started), mode: BACKGROUND ? 'background' : 'desktop' }) });
            send({ id, result: { content, isError: false } });
          } catch (error) {
            isError = true;
            send({ id, result: { content: [{ type: 'text', text: (error as Error).message }], isError: true } });
          } finally {
            pending.delete(id);
            if (RUN_DIR) {
              try {
                mkdirSync(RUN_DIR, { recursive: true });
                appendFileSync(join(RUN_DIR, 'computer-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), session: process.pid, tool: name, durationMs: Math.round(performance.now() - started), isError }) + '\n');
              } catch { /* Audit storage failure must not retry an already-dispatched action. */ }
            }
          }
        };
        if (name === 'stop') await execute();
        else { const task = queue.then(execute); queue = task.catch(() => undefined); await task; }
        return;
      }
      default:
        send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (error) {
    send({ id, error: { code: -32000, message: (error as Error).message } });
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  } catch {
    return;
  }
  void handle(message);
});
function shutdown(): void {
  shell.close();
  process.exit(0);
}
input.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
