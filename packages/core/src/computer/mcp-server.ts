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
import { setTimeout as delay } from 'node:timers/promises';
import { describeAct, describeControl, describeSnapshot, type ActResult, type FoundControl, type Snapshot, type View } from './accessibility.js';
import { parseKeySequence } from './keys.js';
import { PowerShellSession, psQuote } from './powershell.js';
import { COMPUTER_SERVER_NAME, COMPUTER_TOOLS } from './tools.js';
import {
  describeScreen, describeSettle, describeWindow, findText, pickMatch,
  type ScreenText, type SettleResult, type TextMatch, type WindowInfo,
} from './screen-text.js';
import { clipStrokes, fitViewBox, multiply, svgStrokes, svgViewBox, type Matrix, type Stroke } from './sketch.js';
import { batchObservation, validateComputerCall, type ComputerCall } from './validation.js';

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
  active: WindowInfo;
}

interface Found {
  controls: FoundControl[];
  screen: { left: number; top: number; width: number };
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

/**
 * The view: what the last desktop capture showed, and how its pixels map to
 * the screen. Every coordinate the model sends or reads refers to it. A
 * zoomed screenshot narrows it to a region; read_screen and a plain
 * screenshot widen it back to the whole desktop. Whether the screen still
 * looks like that is the worker's business: its guard compares the window in
 * front with what it saw at the end of its own last action or observation.
 */
let view: { scale: number; left: number; top: number; width: number; height: number } | null = null;

function toScreen(x: number, y: number): [number, number] {
  if (!view) throw new Error('Take a desktop screenshot or read_screen before using coordinates. Window screenshots use different coordinates.');
  if (x >= view.width || y >= view.height) throw new Error('Coordinates are outside the last desktop screenshot (' + view.width + 'x' + view.height + ').');
  return [Math.round(view.left + x / view.scale), Math.round(view.top + y / view.scale)];
}

/** A physical point as the model would write it: in pixels of the current view. */
function toView(x: number, y: number): string {
  if (!view) return x + ',' + y + ' (screen pixels)';
  return Math.round((x - view.left) * view.scale) + ',' + Math.round((y - view.top) * view.scale);
}

/** How a worker report in physical pixels is printed: through the view, or the whole desktop when there is none. */
function mapping(screen: { left: number; top: number; width: number }): View {
  return view ?? { left: screen.left, top: screen.top, scale: Math.min(1, MAX_WIDTH / screen.width) };
}

/** The screen's text lines in the current view, for error messages: the same coordinates the other listings use. */
function visible(screen: ScreenText, limit = 40): string {
  const map = mapping(screen);
  return describeScreen(screen, map.scale, limit, map);
}

/** Observations the worker has not made since it was last restarted after a timeout. */
let restartsSeen = 0;

/** Physical actions currently dispatched to the worker. */
let inputInFlight = 0;

/**
 * A worker killed mid-action (stop, timeout, end of turn) cannot run its own
 * cleanup, so a drag's button or a shortcut's modifier would stay down for the
 * user. A fresh worker lets go of whatever is still held.
 */
async function releaseHeld(timeoutMs = 10_000): Promise<void> {
  await shell.run('Rk-Release', timeoutMs).catch(() => undefined);
}

/** Serialize physical input across Rookery processes; the worker's guard refuses a changed desktop. */
async function physical(expression: string, timeoutMs = 30_000): Promise<void> {
  inputInFlight++;
  try {
    await shell.run('$mutex = New-Object System.Threading.Mutex($false, "Local\\RookeryComputerInput"); ' +
      '$locked = $false; try { try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }; ' +
      'if (-not $locked) { throw "Another Rookery session is using desktop input." }; Rk-Guard; ' + expression +
      ' } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }', timeoutMs);
  } catch (error) {
    if (!shell.running && !closing) await releaseHeld();
    if (shell.restarts > restartsSeen && /before physical input/.test((error as Error).message)) {
      throw new Error('The worker was restarted after a timed-out action, so it has not seen the screen since. Take a fresh screenshot or read_screen before continuing.');
    }
    throw error;
  } finally {
    inputInFlight--;
  }
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
  if (!view) throw new Error('Take a desktop screenshot before drawing.');
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
 * The screen's text, without touching the view: for clicking by text and
 * waiting. Before an action, the guard runs first when there is a baseline,
 * so a window the user switched to is refused rather than read and clicked;
 * with no baseline yet (a turn's first call), the reading establishes one.
 */
async function ocr(guarded = false): Promise<ScreenText> {
  return shell.run<ScreenText>((guarded ? 'if ($null -ne $script:rkForeground) { Rk-Guard }; ' : '') + 'Rk-ReadScreen ' + (stopped ? '$false' : '$true'), 20_000);
}

/**
 * Recognise the screen's text. Like a screenshot, it becomes the view that
 * physical input maps through, so its coordinates can be clicked directly.
 */
async function readScreen(): Promise<{ screen: ScreenText; scale: number }> {
  const screen = await ocr();
  const scale = Math.min(1, MAX_WIDTH / screen.width);
  view = { scale, left: screen.left, top: screen.top, width: Math.round(screen.width * scale), height: Math.round(screen.height * scale) };
  restartsSeen = shell.restarts;
  return { screen, scale };
}

/** A match's centre in physical pixels. */
function centre(match: TextMatch): [number, number] {
  return [Math.round(match.x + match.width / 2), Math.round(match.y + match.height / 2)];
}

/** One line per text match: where it is in the current view, and what the screen says there. */
function listMatches(matches: TextMatch[]): string {
  return matches.map((m, i) => (i + 1) + '. ' + toView(...centre(m)) + ' "' + m.text + '"' + (m.approximate ? ' (approximate)' : '') + (m.foreground ? '' : ' (outside the active window)')).join('\n');
}

/** Controls named exactly like the phrase in one window, with refs act accepts. */
async function findControls(window: number, name: string): Promise<Found> {
  return shell.run<Found>('Rk-FindControls ' + window + ' ' + psQuote(name), 20_000);
}

function listControls(found: Found, from = 0): string {
  const map = mapping(found.screen);
  return found.controls.map((control, i) => (from + i + 1) + '. ' + describeControl(control, map)).join('\n');
}

/** Wait, but not past a stop. */
async function pause(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopped) throw new Error('Computer use stopped.');
    await delay(Math.min(50, until - Date.now()));
  }
}

/**
 * What a physical action returns: the screen once it has stopped changing,
 * so the model sees the result without a second round trip, and never a
 * half-drawn frame from a fixed sleep. With nothing to observe, a short
 * settle still runs: it records what the action left in front, so a dialog
 * the action opened is not mistaken for the user switching windows, and it
 * tells the model when nothing visibly happened.
 */
async function settled(observe: 'screenshot' | 'text' | 'none'): Promise<Content[]> {
  const result = await shell.run<SettleResult>(observe === 'none' ? 'Rk-Settle 40 600 80' : 'Rk-Settle', 5_000);
  const note: Content = { type: 'text', text: describeSettle(result) };
  if (observe === 'none') return [note];
  const seen = await perform(validateComputerCall(observe === 'text' ? 'read_screen' : 'screenshot', {}, BACKGROUND));
  return [note, ...seen];
}

async function call(command: ComputerCall): Promise<Content[]> {
  const content = await perform(command);
  // A batch observes once at its own end; background-only mode has nothing on the desktop to settle.
  if (command.name === 'batch' || BACKGROUND) return content;
  // An automation action can open a dialog a moment later; the settle records it as the model's own doing.
  const observe = command.name === 'act' ? 'none' : 'observe' in command.args ? command.args.observe : null;
  if (observe === null) return content;
  try {
    return [...content, ...(await settled(observe))];
  } catch (error) {
    // The input was sent; losing its result would invite a second, duplicate action.
    return [...content, { type: 'text', text: 'The action was sent, but observing afterwards failed: ' + (error as Error).message + ' Take a screenshot before continuing.' }];
  }
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
      const result = await shell.run<Snapshot>('Rk-Snapshot ' + args.window + ' ' + args.maxNodes + ' ' + args.depth + ' ' + (stopped ? '$false' : '$true'), 15_000);
      return [{ type: 'text', text: describeSnapshot(result, mapping(result.screen)) }];
    }
    case 'act': {
      // The desktop view stays: physical input re-checks foreground and bounds before it moves.
      const result = await shell.run<ActResult>('Rk-Act ' + psQuote(args.ref) + ' ' + psQuote(args.action) + ' ' + psQuote(args.value ?? ''), 15_000);
      if (BACKGROUND && result.focusChanged) {
        stopped = true;
        shell.close();
        throw new Error(describeAct(result) + ' Background-only mode stopped all further actions; inspect the result before retrying in a new turn.');
      }
      return [{ type: 'text', text: describeAct(result) }];
    }
    case 'batch': {
      // Steps run blind; each still settles briefly, and the batch observes once at its end.
      const actions = args.actions.map((step) => {
        const action = validateComputerCall(step.tool, step.arguments, BACKGROUND);
        if ('observe' in action.args) action.args.observe = 'none';
        return action;
      });
      const done: string[] = [];
      for (const action of actions) {
        const started = performance.now();
        try {
          const content = await call(action);
          const said = content.map((part) => (part.type === 'text' ? part.text : '')).join(' ').trim();
          done.push((done.length + 1) + '. ' + action.name + ': ' + said + ' (' + Math.round(performance.now() - started) + ' ms)');
        } catch (error) {
          const step = done.length + 1;
          const skipped = actions.length - step;
          throw new Error('Step ' + step + ' of ' + actions.length + ' (' + action.name + ') failed: ' + (error as Error).message +
            (done.length ? '\nCompleted before it:\n' + done.join('\n') : '') +
            (skipped ? '\nSkipped: step' + (skipped > 1 ? 's ' + (step + 1) + '-' + actions.length : ' ' + actions.length) + '.' : '') +
            '\nNothing was rolled back.');
        }
      }
      const report: Content = { type: 'text', text: done.join('\n') };
      const observe = args.observe ?? batchObservation(args.window, BACKGROUND);
      if (observe === 'none') return [report];
      const tool = observe === 'text' ? 'read_screen' : observe;
      try {
        return [report, ...(await call(validateComputerCall(tool, args.window && tool !== 'read_screen' ? { window: args.window } : {}, BACKGROUND)))];
      } catch (error) {
        throw new Error(done.join('\n') + '\nAll steps completed; the final ' + observe + ' failed: ' + (error as Error).message);
      }
    }
    case 'screenshot': {
      if (RUN_DIR) mkdirSync(RUN_DIR, { recursive: true });
      const path = RUN_DIR ? join(RUN_DIR, 'computer-' + process.pid + '.jpg') : '';
      let region = '$null';
      const previous = view;
      if (args.region) {
        if (!previous) throw new Error('A region is measured in pixels of the last desktop screenshot; take one first.');
        const r = args.region;
        if (r.x + r.width > previous.width || r.y + r.height > previous.height) throw new Error('The region reaches outside the last desktop screenshot (' + previous.width + 'x' + previous.height + ').');
        region = '@(' + [
          Math.round(previous.left + r.x / previous.scale), Math.round(previous.top + r.y / previous.scale),
          Math.max(1, Math.round(r.width / previous.scale)), Math.max(1, Math.round(r.height / previous.scale)),
        ].join(',') + ')';
      }
      const shot = await shell.run<Shot>('Rk-Screenshot ' + MAX_WIDTH + ' ' + psQuote(path) + ' ' + (args.window ?? 0) + ' ' + (stopped ? '$false' : '$true') + ' ' + region + ' ' + (args.screen ?? 0), 15_000);
      if (!args.window) {
        view = { scale: shot.scale, left: shot.left, top: shot.top, width: shot.width, height: shot.height };
        restartsSeen = shell.restarts;
      }
      const pointer = shot.cursorX >= 0 && shot.cursorY >= 0 && shot.cursorX < shot.width && shot.cursorY < shot.height
        ? 'Pointer at ' + shot.cursorX + ',' + shot.cursorY + '.'
        : 'Pointer outside this view.';
      let what: string;
      if (args.window) what = 'Window capture (app-dependent); virtual cursor marks the last UIA target. Observe with snapshot if blank.';
      else if (args.region) {
        const zoom = shot.scale / previous!.scale;
        what = 'Zoomed ' + zoom.toFixed(1) + 'x into the region ' + args.region.x + ',' + args.region.y + ' ' + args.region.width + 'x' + args.region.height +
          ' of the previous screenshot. Coordinates now refer to this image until the next desktop screenshot or read_screen. ' + pointer;
      } else if (args.screen) what = 'Display ' + args.screen + ' only; coordinates now refer to this image. ' + pointer;
      else what = pointer;
      return [
        { type: 'image', data: shot.jpeg, mimeType: 'image/jpeg' },
        {
          type: 'text',
          text:
            'Screenshot ' + shot.width + 'x' + shot.height + ' px' +
            (shot.scale < 1 ? ' (screen scaled by ' + shot.scale.toFixed(3) + ')' : '') + '. ' + what +
            (args.window ? '' : ' Active window: ' + describeWindow(shot.active) + '.') +
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
              .map((s, i) => '- screen ' + (i + 1) + ': ' + s.name + (s.primary ? ' (primary)' : '') + ': ' + s.width + 'x' + s.height + ' at ' + s.x + ',' + s.y)
              .join('\n') + '\nObserver: ' + JSON.stringify(info.observer),
        },
      ];
    }
    case 'read_screen': {
      const { screen, scale } = await readScreen();
      return [{ type: 'text', text: 'Screen text (OCR), centre x,y in screenshot pixels. Active window: ' + describeWindow(screen.active) + '.\n' + describeScreen(screen, scale) }];
    }
    case 'find_text': {
      const lines: string[] = [];
      let screen: ScreenText | null = null;
      if (!BACKGROUND) {
        ({ screen } = await readScreen());
        const matches = findText(screen, args.text);
        if (matches.length) lines.push(listMatches(matches));
      }
      // Controls by accessible name: the given window, else the active one when OCR saw nothing.
      const window = args.window ?? (lines.length ? 0 : screen?.foreground ?? 0);
      if (window) {
        const found = await findControls(window, args.text);
        if (found.controls.length) lines.push((lines.length ? 'Controls named ' : 'No visible text, but controls named ') + JSON.stringify(args.text) + ':\n' + listControls(found));
      }
      if (!lines.length) {
        return [{ type: 'text', text: 'No text or control named "' + args.text + '"' + (window ? ' in window ' + window : '') + '.' + (screen ? ' Visible text:\n' + visible(screen) : '') }];
      }
      return [{ type: 'text', text: lines.join('\n') }];
    }
    case 'wait_for': {
      const started = Date.now();
      const what = JSON.stringify(args.text);
      let screen: ScreenText | null = null;
      for (;;) {
        let where = '';
        if (args.window) {
          const found = await findControls(args.window, args.text);
          if (found.controls.length) where = listControls(found);
        } else {
          ({ screen } = await readScreen());
          const matches = findText(screen, args.text);
          if (matches.length) where = listMatches(matches);
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        if (Boolean(where) !== args.gone) {
          return [{ type: 'text', text: what + (args.gone ? ' is gone' : ' is on screen') + ' after ' + seconds + ' s.' + (where ? '\n' + where : '') }];
        }
        if (Date.now() - started >= args.timeoutSec * 1000) {
          throw new Error('Timed out after ' + args.timeoutSec + ' s: ' + what + (args.gone ? ' is still on screen.' : ' did not appear.') +
            (screen ? '\nVisible text:\n' + visible(screen) : ''));
        }
        await pause(400);
      }
    }
    case 'hand_over': {
      const timeout = args.timeoutSec * 1000;
      const result = await shell.run<{ outcome: string; waitedMs: number }>('Rk-HandOver ' + psQuote(args.reason) + ' ' + timeout, timeout + 15_000);
      const outcome: Content = { type: 'text', text: result.outcome + ' Waited ' + Math.round(result.waitedMs / 1000) + ' s.' };
      // Background-only mode may not capture the desktop; the model snapshots its window instead.
      return BACKGROUND ? [outcome] : [outcome, ...(await settled('screenshot'))];
    }
    case 'click': {
      const { button, count } = args;
      const clicked = (what: string): Content[] => [{ type: 'text', text: (count === 2 ? 'Double-clicked ' : 'Clicked ') + (button === 'left' ? '' : 'with the ' + button + ' button ') + what + '.' }];
      let sx: number, sy: number, what: string;
      if (args.text !== undefined) {
        // The view stays as it is: the point comes from what is on screen now, not from the model's coordinates.
        const screen = await ocr(true);
        const matches = findText(screen, args.text);
        let picked = pickMatch(matches, args.text, args.index);
        if (typeof picked === 'string' && !matches.length && args.index === undefined && screen.foreground) {
          // Icon buttons and menu items have names without visible text.
          const found = await findControls(screen.foreground, args.text);
          const control = found.controls[0];
          if (found.controls.length === 1 && control) {
            const [x, y, width, height] = control.bounds;
            [sx, sy] = [Math.round(x + width / 2), Math.round(y + height / 2)];
            await physical('Rk-Click ' + sx + ' ' + sy + ' ' + psQuote(button) + ' ' + count);
            return clicked(control.role + ' "' + control.name + '" at ' + toView(sx, sy));
          }
          if (found.controls.length > 1) picked = found.controls.length + ' controls are named "' + args.text + '" and none shows the text; click one of their centres:\n' + listControls(found);
        }
        if (typeof picked === 'string') {
          throw new Error(picked + '\n' + (matches.length ? listMatches(matches) : 'Visible text:\n' + visible(screen)));
        }
        [sx, sy] = centre(picked);
        what = '"' + picked.text + '" at ' + toView(sx, sy) + (picked.foreground ? '' : ' (outside the active window)');
      } else {
        [sx, sy] = toScreen(args.x!, args.y!);
        what = args.x + ',' + args.y;
      }
      await physical('Rk-Click ' + sx + ' ' + sy + ' ' + psQuote(button) + ' ' + count);
      return clicked(what);
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
      const rows = await shell.run<{ handle: number; title: string; process: string; active: boolean; minimized: boolean; x: number; y: number; width: number; height: number }[]>('Rk-Windows');
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [{ type: 'text', text: 'No windows.' }];
      return [
        {
          type: 'text',
          text: list
            .map((w) => '- window=' + w.handle + ' ' + (w.active ? '[active] ' : '') + JSON.stringify(w.title) + ' (' + w.process + ') ' +
              (w.minimized ? 'minimized' : w.width + 'x' + w.height + ' at ' + w.x + ',' + w.y))
            .join('\n'),
        },
      ];
    }
    case 'focus_window': {
      view = null;
      const result = await shell.run<WindowInfo>('Rk-Focus ' + psQuote(args.title ?? '') + ' ' + (args.window ?? 0));
      return [{ type: 'text', text: 'Focused ' + describeWindow(result) + '.' }];
    }
    case 'open': {
      view = null;
      const result = await shell.run<{ changed: boolean; active: WindowInfo; behind: WindowInfo | null; waitedMs: number }>('Rk-Open ' + psQuote(args.target), 15_000);
      if (!result.changed) {
        // Nothing to type into yet: say so as an error, so the model does not send input to whatever is in front.
        throw new Error('Opened ' + args.target + ', but no window came to the front within 3 s' +
          (result.behind ? ': ' + describeWindow(result.behind) + ' stayed behind ' : '; the active window is still ') + describeWindow(result.active) +
          '. Nothing was typed. Use focus_window with the handle, or wait_for, then take a screenshot.');
      }
      return [{ type: 'text', text: 'Opened ' + args.target + '. Active window is now ' + describeWindow(result.active) + '.' }];
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
      await pause(args.ms);
      return [{ type: 'text', text: 'Waited ' + args.ms + ' ms.' }];
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
            serverInfo: { name: COMPUTER_SERVER_NAME, version: '0.2.0' },
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
          let failure: string | undefined;
          try {
            const content = await call(validateComputerCall(name, args, BACKGROUND));
            content.push({ type: 'text', text: JSON.stringify({ durationMs: Math.round(performance.now() - started), mode: BACKGROUND ? 'background' : 'desktop' }) });
            send({ id, result: { content, isError: false } });
          } catch (error) {
            failure = (error as Error).message;
            send({ id, result: { content: [{ type: 'text', text: failure }], isError: true } });
          } finally {
            pending.delete(id);
            if (RUN_DIR) {
              // The audit says which tool, how long, and why it failed; never what was typed or seen.
              const steps = name === 'batch' && Array.isArray(args.actions) ? args.actions.length : undefined;
              try {
                mkdirSync(RUN_DIR, { recursive: true });
                appendFileSync(join(RUN_DIR, 'computer-audit.jsonl'), JSON.stringify({
                  at: new Date().toISOString(), session: process.pid, tool: name, ...(steps === undefined ? {} : { steps }),
                  durationMs: Math.round(performance.now() - started), isError: failure !== undefined,
                  ...(failure === undefined ? {} : { error: failure.split('\n')[0]!.replace(/"[^"]*"/g, '"…"').slice(0, 200) }),
                }) + '\n');
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
/**
 * The turn is over when the CLI closes our stdin. The cursor fades out
 * first, bounded so a stuck action cannot hold the exit, and a drag or
 * shortcut cut off mid-way lets go of what it held; a hard kill skips this,
 * and the worker then ends itself with this process instead.
 */
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  if (shell.running) {
    await Promise.race([
      shell.run('Rk-CursorDismiss; @{}', 2000).catch(() => undefined),
      delay(700),
    ]);
  }
  const held = inputInFlight > 0;
  shell.close();
  if (held) await releaseHeld(3000);
  shell.close();
  process.exit(0);
}
input.on('close', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
