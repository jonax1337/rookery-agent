import { z } from 'zod';
import { UI_ACTIONS } from './tools.js';
import { parseKeySequence } from './keys.js';

const window = z.number().int().positive().safe();
const coordinate = z.number().finite().nonnegative();
const point = { x: coordinate, y: coordinate };
const text = z.string().max(20_000);
const steps = ['act', 'click', 'move_mouse', 'drag', 'draw', 'scroll', 'type_text', 'press_keys', 'wait'] as const;
const DRAW_LIMITS = { strokes: 100, points: 4000 } as const;
/** What a physical action returns once the screen has settled. */
const observe = z.enum(['screenshot', 'text', 'none']).default('screenshot');
const needle = z.string().trim().min(1).max(200);
const schemas = {
  screenshot: z.object({ window: window.optional() }).strict(),
  screen_info: z.object({}).strict(),
  list_windows: z.object({}).strict(),
  stop: z.object({}).strict(),
  snapshot: z.object({ window, maxNodes: z.number().int().min(1).max(300).default(150), depth: z.number().int().min(1).max(12).default(8) }).strict(),
  act: z.object({ ref: z.string().min(1).max(80), action: z.enum(UI_ACTIONS), value: text.optional() }).strict()
    .refine((args) => args.action !== 'set_value' || args.value !== undefined, 'set_value requires value.'),
  click: z.object({
    x: coordinate.optional(), y: coordinate.optional(), text: needle.optional(), index: z.number().int().min(1).max(50).optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(2).default(1), observe,
  }).strict()
    .refine((args) => (args.text === undefined) !== (args.x === undefined && args.y === undefined), 'click needs x and y, or text.')
    .refine((args) => args.text !== undefined || (args.x !== undefined && args.y !== undefined), 'click needs both x and y.')
    .refine((args) => args.index === undefined || args.text !== undefined, 'index picks among text matches; pass text.'),
  move_mouse: z.object({ ...point, observe }).strict(),
  drag: z.object({ fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, observe }).strict(),
  draw: z.object({
    strokes: z.array(z.array(z.tuple([coordinate, coordinate])).min(1).max(DRAW_LIMITS.points)).min(1).max(DRAW_LIMITS.strokes).optional(),
    svg: z.string().min(1).max(200_000).optional(),
    area: z.object({ x: coordinate, y: coordinate, width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
    hatch: z.object({
      spacing: z.number().finite().min(2).max(100).default(6),
      angle: z.number().finite().default(45),
      cross: z.boolean().default(false),
    }).strict().optional(),
    button: z.enum(['left', 'right']).default('left'),
    observe,
  }).strict()
    .refine((args) => args.strokes || args.svg, 'draw needs strokes or svg.')
    .refine((args) => !args.svg || args.area, 'svg needs an area: the canvas rectangle in screenshot pixels.')
    .refine((args) => (args.strokes ?? []).reduce((sum, stroke) => sum + stroke.length, 0) <= DRAW_LIMITS.points, 'draw takes at most ' + DRAW_LIMITS.points + ' points per call; split the picture.'),
  scroll: z.object({ ...point, direction: z.enum(['up', 'down', 'left', 'right']).default('down'), amount: z.number().int().min(1).max(20).default(3), observe }).strict(),
  type_text: z.object({ text: text.min(1), observe }).strict(),
  press_keys: z.object({ keys: z.string().min(1).max(200), observe }).strict(),
  focus_window: z.object({ title: z.string().min(1).max(500).optional(), window: window.optional(), observe }).strict()
    .refine((args) => (args.title === undefined) !== (args.window === undefined), 'focus_window needs title or window.'),
  open: z.object({ target: z.string().min(1).max(2000), observe }).strict(),
  read_screen: z.object({}).strict(),
  find_text: z.object({ text: needle }).strict(),
  hand_over: z.object({ reason: z.string().trim().min(1).max(200), timeoutSec: z.number().int().min(5).max(600).default(180) }).strict(),
  clipboard: z.object({ action: z.enum(['get', 'set']), text: text.optional() }).strict()
    .refine((args) => args.action !== 'set' || args.text !== undefined, 'clipboard set requires text.'),
  wait: z.object({ ms: z.number().int().min(0).max(30_000).default(1000) }).strict(),
  batch: z.object({
    actions: z.array(z.object({ tool: z.enum(steps), arguments: z.record(z.unknown()) }).strict()).min(1).max(12),
    observe: z.enum(['snapshot', 'screenshot', 'none']).optional(), window: window.optional(),
  }).strict().refine((args) => args.observe !== 'snapshot' || args.window !== undefined, 'snapshot observation requires window.'),
};

type ToolName = keyof typeof schemas;
export type ComputerCall = {
  [Name in ToolName]: { name: Name; args: z.infer<(typeof schemas)[Name]> }
}[ToolName];

const foregroundTools = new Set(['click', 'move_mouse', 'drag', 'draw', 'scroll', 'type_text', 'press_keys', 'focus_window', 'open']);

/**
 * What a batch returns when it names no observation: the window it worked on,
 * else the desktop, which background-only mode may not capture.
 */
export function batchObservation(window: number | undefined, background: boolean): 'snapshot' | 'screenshot' | 'none' {
  return window ? 'snapshot' : background ? 'none' : 'screenshot';
}

/** Validate once at the boundary; handlers receive typed arguments with defaults. */
export function validateComputerCall(name: string, args: unknown, background = false): ComputerCall {
  if (!Object.hasOwn(schemas, name)) throw new Error('Unknown tool ' + name + '.');
  const schema = schemas[name as ToolName];
  const result = schema.safeParse(args);
  if (!result.success) throw new Error('Invalid ' + name + ' arguments: ' + result.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '));
  const command = { name, args: result.data } as ComputerCall;
  if (background && (foregroundTools.has(name) || command.name === 'clipboard' && command.args.action === 'set')) {
    throw new Error('Background-only mode refuses physical input, focus changes, launching and clipboard writes. Use snapshot and act, or Playwright.');
  }
  if (background && command.name === 'screenshot' && !command.args.window) throw new Error('Background screenshots require a window handle.');
  if (background && (command.name === 'read_screen' || command.name === 'find_text')) throw new Error('Background-only mode reads windows through snapshot, not the desktop.');
  if (command.name === 'press_keys' && !parseKeySequence(command.args.keys).length) throw new Error('Which keys?');
  if (command.name === 'batch') {
    const { actions, observe, window } = command.args;
    for (const step of actions) {
      const action = validateComputerCall(step.tool, step.arguments, background);
      if (action.name === 'wait' && action.args.ms > 2000) throw new Error('Batch waits are limited to 2000 ms.');
    }
    const observation = observe ?? batchObservation(window, background);
    if (observation !== 'none') validateComputerCall(observation, window ? { window } : {}, background);
  }
  return command;
}
