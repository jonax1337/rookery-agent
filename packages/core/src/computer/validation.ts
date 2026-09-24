import { z } from 'zod';
import { UI_ACTIONS } from './tools.js';
import { parseKeySequence } from './keys.js';

const window = z.number().int().positive().safe();
const coordinate = z.number().finite().nonnegative();
const point = { x: coordinate, y: coordinate };
const text = z.string().max(20_000);
const steps = ['act', 'click', 'move_mouse', 'drag', 'scroll', 'type_text', 'press_keys', 'wait'] as const;
const schemas = {
  screenshot: z.object({ window: window.optional() }).strict(),
  screen_info: z.object({}).strict(),
  list_windows: z.object({}).strict(),
  stop: z.object({}).strict(),
  snapshot: z.object({ window, maxNodes: z.number().int().min(1).max(300).default(150), depth: z.number().int().min(1).max(12).default(8) }).strict(),
  act: z.object({ ref: z.string().min(1).max(80), action: z.enum(UI_ACTIONS), value: text.optional() }).strict()
    .refine((args) => args.action !== 'set_value' || args.value !== undefined, 'set_value requires value.'),
  click: z.object({ ...point, button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(2).default(1) }).strict(),
  move_mouse: z.object(point).strict(),
  drag: z.object({ fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate }).strict(),
  scroll: z.object({ ...point, direction: z.enum(['up', 'down', 'left', 'right']).default('down'), amount: z.number().int().min(1).max(20).default(3) }).strict(),
  type_text: z.object({ text: text.min(1) }).strict(),
  press_keys: z.object({ keys: z.string().min(1).max(200) }).strict(),
  focus_window: z.object({ title: z.string().min(1).max(500) }).strict(),
  open: z.object({ target: z.string().min(1).max(2000) }).strict(),
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

const foregroundTools = new Set(['click', 'move_mouse', 'drag', 'scroll', 'type_text', 'press_keys', 'focus_window', 'open']);

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
  if (command.name === 'press_keys' && !parseKeySequence(command.args.keys).length) throw new Error('Which keys?');
  if (command.name === 'batch') {
    const { actions, observe, window } = command.args;
    for (const step of actions) {
      const action = validateComputerCall(step.tool, step.arguments, background);
      if (action.name === 'wait' && action.args.ms > 2000) throw new Error('Batch waits are limited to 2000 ms.');
    }
    const observation = observe ?? (window ? 'snapshot' : 'screenshot');
    if (observation !== 'none') validateComputerCall(observation, window ? { window } : {}, background);
  }
  return command;
}
