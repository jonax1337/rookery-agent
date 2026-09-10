#!/usr/bin/env node
/**
 * The stdio MCP server for computer control.
 *
 * Unlike the rookery bridge it does the work itself: it runs on the same
 * machine as the user, and there is nothing in the Rookery process it would
 * need. It speaks the same sliver of MCP (initialize, tools/list, tools/call,
 * ping) and keeps one PowerShell alive for the length of the turn.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseKeySequence } from './keys.js';
import { PowerShellSession, psQuote } from './powershell.js';
import { COMPUTER_SERVER_NAME, COMPUTER_TOOLS } from './tools.js';

const PROTOCOL_FALLBACK = '2025-06-18';
const MAX_WIDTH = Math.max(320, Number(process.env.ROOKERY_COMPUTER_MAX_WIDTH) || 1280);
const RUN_DIR = process.env.ROOKERY_COMPUTER_DIR ? join(process.env.ROOKERY_COMPUTER_DIR, 'run') : '';

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
}

const shell = new PowerShellSession();

/* --------------------------------- mapping -------------------------------- */

/** Screenshot pixels to real screen pixels: the last shot's scale, or the current one. */
let view: { scale: number; left: number; top: number } | null = null;

async function mapping(): Promise<{ scale: number; left: number; top: number }> {
  if (view) return view;
  const info = await shell.run<ScreenInfo>('Rk-ScreenInfo');
  view = { scale: Math.min(1, MAX_WIDTH / info.width), left: info.left, top: info.top };
  return view;
}

async function toScreen(x: unknown, y: unknown): Promise<[number, number]> {
  const m = await mapping();
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('x and y must be numbers.');
  return [Math.round(m.left + px / m.scale), Math.round(m.top + py / m.scale)];
}

const text = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === 'string' ? (args[key] as string) : '';
const num = (args: Record<string, unknown>, key: string, fallback: number): number => {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
};

/* ---------------------------------- tools --------------------------------- */

async function call(name: string, args: Record<string, unknown>): Promise<Content[]> {
  switch (name) {
    case 'screenshot': {
      if (RUN_DIR) mkdirSync(RUN_DIR, { recursive: true });
      const path = RUN_DIR ? join(RUN_DIR, 'last-screenshot.png') : '';
      const shot = await shell.run<Shot>('Rk-Screenshot ' + MAX_WIDTH + ' ' + psQuote(path), 60_000);
      view = { scale: shot.scale, left: shot.left, top: shot.top };
      return [
        { type: 'image', data: shot.png, mimeType: 'image/png' },
        {
          type: 'text',
          text:
            'Screenshot ' + shot.width + 'x' + shot.height + ' px' +
            (shot.scale < 1 ? ' (screen scaled by ' + shot.scale.toFixed(3) + ')' : '') +
            '. Pointer at ' + shot.cursorX + ',' + shot.cursorY + '.' +
            (path ? ' Saved as ' + path + '.' : ''),
        },
      ];
    }
    case 'screen_info': {
      const info = await shell.run<ScreenInfo>('Rk-ScreenInfo');
      const m = await mapping();
      return [
        {
          type: 'text',
          text:
            'Screenshot size ' + Math.round(info.width * m.scale) + 'x' + Math.round(info.height * m.scale) +
            ' px, scale ' + m.scale.toFixed(3) + ' of ' + info.width + 'x' + info.height + ' real pixels.\n' +
            info.screens
              .map((s) => '- ' + s.name + (s.primary ? ' (primary)' : '') + ': ' + s.width + 'x' + s.height + ' at ' + s.x + ',' + s.y)
              .join('\n'),
        },
      ];
    }
    case 'click': {
      const [x, y] = await toScreen(args.x, args.y);
      const button = ['left', 'right', 'middle'].includes(text(args, 'button')) ? text(args, 'button') : 'left';
      const count = num(args, 'count', 1) >= 2 ? 2 : 1;
      await shell.run('Rk-Click ' + x + ' ' + y + ' ' + psQuote(button) + ' ' + count);
      return [{ type: 'text', text: (count === 2 ? 'Double-clicked' : 'Clicked') + ' ' + button + ' at ' + args.x + ',' + args.y + '.' }];
    }
    case 'move_mouse': {
      const [x, y] = await toScreen(args.x, args.y);
      await shell.run('Rk-Move ' + x + ' ' + y);
      return [{ type: 'text', text: 'Pointer at ' + args.x + ',' + args.y + '.' }];
    }
    case 'drag': {
      const [x1, y1] = await toScreen(args.fromX, args.fromY);
      const [x2, y2] = await toScreen(args.toX, args.toY);
      await shell.run('Rk-Drag ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2);
      return [{ type: 'text', text: 'Dragged from ' + args.fromX + ',' + args.fromY + ' to ' + args.toX + ',' + args.toY + '.' }];
    }
    case 'scroll': {
      const [x, y] = await toScreen(args.x, args.y);
      const direction = ['up', 'down', 'left', 'right'].includes(text(args, 'direction')) ? text(args, 'direction') : 'down';
      const amount = Math.min(20, Math.max(1, Math.round(num(args, 'amount', 3))));
      await shell.run('Rk-Scroll ' + x + ' ' + y + ' ' + psQuote(direction) + ' ' + amount);
      return [{ type: 'text', text: 'Scrolled ' + direction + ' by ' + amount + '.' }];
    }
    case 'type_text': {
      const value = text(args, 'text');
      if (!value) throw new Error('Nothing to type.');
      await shell.run('Rk-Type ' + psQuote(value), 120_000);
      return [{ type: 'text', text: 'Typed ' + value.length + ' characters.' }];
    }
    case 'press_keys': {
      const combos = parseKeySequence(text(args, 'keys'));
      if (!combos.length) throw new Error('Which keys?');
      const literal = '@(' + combos.map((combo) => ',@(' + combo.join(',') + ')').join(';') + ')';
      await shell.run('Rk-Keys ' + literal);
      return [{ type: 'text', text: 'Pressed ' + text(args, 'keys') + '.' }];
    }
    case 'list_windows': {
      const rows = await shell.run<{ title: string; process: string; active: boolean; x: number; y: number; width: number; height: number }[]>('Rk-Windows');
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [{ type: 'text', text: 'No windows.' }];
      return [
        {
          type: 'text',
          text: list
            .map((w) => '- ' + (w.active ? '[active] ' : '') + w.title + ' (' + w.process + ') ' + w.width + 'x' + w.height + ' at ' + w.x + ',' + w.y)
            .join('\n'),
        },
      ];
    }
    case 'focus_window': {
      const needle = text(args, 'title');
      if (!needle) throw new Error('Which window?');
      const result = await shell.run<{ ok: boolean; title: string }>('Rk-Focus ' + psQuote(needle));
      return [{ type: 'text', text: (result.ok ? 'Focused ' : 'Tried to focus ') + '"' + result.title + '".' }];
    }
    case 'open': {
      const target = text(args, 'target');
      if (!target) throw new Error('What should be opened?');
      await shell.run('Rk-Open ' + psQuote(target));
      return [{ type: 'text', text: 'Opened ' + target + '.' }];
    }
    case 'clipboard': {
      if (text(args, 'action') === 'set') {
        await shell.run('Rk-ClipSet ' + psQuote(text(args, 'text')));
        return [{ type: 'text', text: 'Clipboard set (' + text(args, 'text').length + ' characters).' }];
      }
      const result = await shell.run<{ text: string }>('Rk-ClipGet');
      return [{ type: 'text', text: result.text ? result.text.slice(0, 20_000) : '(clipboard is empty)' }];
    }
    case 'wait': {
      const ms = Math.min(30_000, Math.max(0, Math.round(num(args, 'ms', 1000))));
      await new Promise((resolve) => setTimeout(resolve, ms));
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
        try {
          send({ id, result: { content: await call(name, args), isError: false } });
        } catch (error) {
          send({ id, result: { content: [{ type: 'text', text: (error as Error).message }], isError: true } });
        }
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
  } catch {
    return;
  }
  void handle(message);
});
input.on('close', () => {
  shell.close();
  process.exit(0);
});
