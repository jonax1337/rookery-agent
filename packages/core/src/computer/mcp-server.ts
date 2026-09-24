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
  png: string;
  foreground: number;
}

const shell = new PowerShellSession();
let stopped = false;
let queue: Promise<unknown> = Promise.resolve();
const pending = new Set<number | string>();
const observations = new Set(['screenshot', 'screen_info', 'list_windows', 'snapshot', 'stop']);

/* --------------------------------- mapping -------------------------------- */

/** Physical input always uses the most recent desktop screenshot. */
let view: { scale: number; left: number; top: number; width: number; height: number; foreground: number } | null = null;

function toScreen(x: number, y: number): [number, number] {
  if (!view) throw new Error('Take a desktop screenshot before physical input. Window screenshots use different coordinates.');
  if (x >= view.width || y >= view.height) throw new Error('Coordinates are outside the last desktop screenshot.');
  return [Math.round(view.left + x / view.scale), Math.round(view.top + y / view.scale)];
}

/** Refuse stale desktop targets and serialize physical input across Rookery processes. */
async function physical(expression: string): Promise<void> {
  if (!view) throw new Error('Take a desktop screenshot before physical input.');
  const guard = '$b = Rk-Bounds; if ([long][RkNative]::GetForegroundWindow() -ne ' + view.foreground +
    ' -or $b.Left -ne ' + view.left + ' -or $b.Top -ne ' + view.top +
    ' -or $b.Width -ne ' + Math.round(view.width / view.scale) +
    ') { throw "Desktop target changed. Take a fresh screenshot." }; ';
  await shell.run('$mutex = New-Object System.Threading.Mutex($false, "Local\\RookeryComputerInput"); ' +
    '$locked = $false; try { try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }; ' +
    'if (-not $locked) { throw "Another Rookery session is using desktop input." }; ' + guard + expression +
    ' } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }');
}

/* ---------------------------------- tools --------------------------------- */

async function call(command: ComputerCall): Promise<Content[]> {
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
      const actions = args.actions.map((action) => validateComputerCall(action.tool, action.arguments, BACKGROUND));
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
      const path = RUN_DIR ? join(RUN_DIR, 'computer-' + process.pid + '.png') : '';
      const shot = await shell.run<Shot>('Rk-Screenshot ' + MAX_WIDTH + ' ' + psQuote(path) + ' ' + (args.window ?? 0) + ' ' + (stopped ? '$false' : '$true'), 15_000);
      view = args.window ? null : { scale: shot.scale, left: shot.left, top: shot.top, width: shot.width, height: shot.height, foreground: shot.foreground };
      return [
        { type: 'image', data: shot.png, mimeType: 'image/png' },
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
    case 'click': {
      const [x, y] = toScreen(args.x, args.y);
      const { button, count } = args;
      await physical('Rk-Click ' + x + ' ' + y + ' ' + psQuote(button) + ' ' + count);
      return [{ type: 'text', text: (count === 2 ? 'Double-clicked' : 'Clicked') + ' ' + button + ' at ' + args.x + ',' + args.y + '.' }];
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
