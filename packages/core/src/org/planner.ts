import type { Project, RookeryConfig, Task } from '../types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { smallModelFor } from '../memory/extractor.js';
import { clip, shorten } from '../util/queue.js';
import type { OrgSnapshot } from './prompts.js';

/**
 * Task planning: who does a task, and whether it should be split.
 *
 * A cheap model reads the org chart - every agent with its title and
 * standing instructions - together with the task and decides between one
 * assignee and a split into subtasks with dependencies. The decision is
 * grounded in the actual staff: an unknown agent in the answer is mapped to
 * the closest real one rather than failing the plan.
 */

export interface PlannedSubtask {
  title: string;
  description: string;
  /** Agent slug. */
  agent: string;
  /** Indices into the subtask list that must finish first. */
  dependsOn: number[];
}

export interface TaskPlan {
  mode: 'single' | 'split';
  /** Why the planner decided this, one or two sentences. */
  reason: string;
  /** Agent slug for `single`. */
  assignee?: string;
  /** Subtasks for `split`, in a valid dependency order. */
  subtasks: PlannedSubtask[];
}

export const PLAN_MARKER = 'ROOKERY TASK PLANNER';
const MAX_SUBTASKS = 6;

const PLAN_PROMPT = `${PLAN_MARKER}

You are the planning desk of a small company of AI agents. Decide how ONE task gets done.

Options:
- single: one agent does the whole task. Choose this whenever the task is one coherent piece of
  work, or when splitting would only create coordination overhead.
- split: two to ${MAX_SUBTASKS} subtasks, each done by one agent in its own process. Choose this only when
  the task has clearly separable parts (different areas, files, questions, deliverables), or
  when a later part genuinely needs an earlier part's result. Independent subtasks run at the
  same time, so a split is worth it when parts are independent.

Rules:
- Pick agents by ROLE: match each part to the agent whose title and instructions fit best.
  Prefer an agent explicitly assigned by the user or the assistant when one is named.
- Only use agent slugs from the staff list. Never invent people.
- Every subtask description must be SELF-CONTAINED. Agents are separate processes and see
  nothing but their own description: restate the goal, constraints, files and definition of done.
- dependsOn lists the 0-based indices of subtasks that must finish first. Keep it empty unless a
  part is impossible without another's output.
- Do not add a final "combine the results" subtask; the assistant does that.
- Write titles and descriptions in the SAME LANGUAGE as the task.

Reply with ONE JSON object only, no prose, no code fence:
{"mode":"single","reason":"…","assignee":"slug"}
or
{"mode":"split","reason":"…","subtasks":[{"title":"…","description":"…","agent":"slug","dependsOn":[]}]}`;

export interface PlanTaskInput {
  registry: ProviderRegistry;
  config: RookeryConfig;
  snapshot: OrgSnapshot;
  task: Task;
  project?: Project;
  /** Guidance from whoever asked for the plan. */
  hint?: string;
  signal?: AbortSignal;
}

/**
 * Ask the planner. Never throws: when the model is unavailable or answers
 * nonsense, the plan degrades to `single` with the best available agent.
 */
export async function planTask(input: PlanTaskInput): Promise<TaskPlan> {
  const slugs = input.snapshot.agents.map((agent) => agent.slug);
  const preferred =
    input.task.assigneeId && input.snapshot.agents.find((agent) => agent.id === input.task.assigneeId)?.slug;
  const fallback = (reason: string): TaskPlan => ({
    mode: 'single',
    reason,
    assignee: preferred ?? slugs[0],
    subtasks: [],
  });

  if (!slugs.length) return { mode: 'single', reason: 'Nobody is hired yet.', subtasks: [] };

  const providerId = await input.registry.resolveUsable(input.config.defaultProvider);
  if (!providerId) return fallback('No provider is logged in to plan with.');

  const staff = input.snapshot.agents
    .map((agent) => '- ' + agent.slug + ': ' + agent.name + ', ' + agent.title + '. ' + shorten(agent.instructions, 240))
    .join('\n');
  const prompt =
    PLAN_PROMPT +
    '\n\nSTAFF:\n' + staff +
    (input.project ? '\n\nPROJECT: ' + input.project.name + (input.project.description ? ' — ' + input.project.description : '') : '') +
    (preferred ? '\n\nPREFERRED ASSIGNEE: ' + preferred : '') +
    (input.hint ? '\n\nGUIDANCE FROM THE ASSISTANT:\n' + clip(input.hint, 1500) : '') +
    '\n\nTASK: ' + input.task.title + '\n' + clip(input.task.description, 6000);

  let raw = '';
  try {
    for await (const event of input.registry.get(providerId).run({
      prompt,
      model: smallModelFor(providerId),
      permission: 'chat',
      cwd: input.config.workspace,
      signal: input.signal,
    })) {
      if (event.type === 'text') raw += event.delta;
      else if (event.type === 'done') raw = event.text || raw;
      else if (event.type === 'error' && event.fatal) return fallback('The planning turn failed: ' + event.message);
    }
  } catch (error) {
    return fallback('The planning turn failed: ' + (error as Error).message);
  }

  const parsed = parseTaskPlan(raw);
  if (!parsed) return fallback('The planner did not return a usable plan.');
  return normaliseTaskPlan(parsed, slugs, preferred);
}

/** Pull the plan object out of a reply that may be wrapped in prose or a fence. */
export function parseTaskPlan(raw: string): TaskPlan | null {
  const text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const mode = record.mode === 'split' ? 'split' : 'single';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const assignee = typeof record.assignee === 'string' ? record.assignee.trim().toLowerCase() : undefined;
  const subtasks: PlannedSubtask[] = [];
  if (Array.isArray(record.subtasks)) {
    for (const entry of record.subtasks) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      if (!description) continue;
      subtasks.push({
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : shorten(description, 60),
        description,
        agent: typeof item.agent === 'string' ? item.agent.trim().toLowerCase() : '',
        dependsOn: Array.isArray(item.dependsOn)
          ? item.dependsOn.filter((dep): dep is number => Number.isInteger(dep) && dep >= 0)
          : [],
      });
    }
  }
  return { mode, reason, assignee, subtasks };
}

/**
 * Make a raw plan executable: real slugs only, a sensible subtask count,
 * dependency edges that point at earlier subtasks. A split with fewer than
 * two usable parts collapses back to a single assignment.
 */
export function normaliseTaskPlan(plan: TaskPlan, slugs: string[], preferred?: string): TaskPlan {
  const known = new Set(slugs);
  const pick = (slug: string | undefined): string => (slug && known.has(slug) ? slug : (preferred ?? slugs[0] ?? ''));

  if (plan.mode === 'split') {
    const subtasks = plan.subtasks.slice(0, MAX_SUBTASKS).map((subtask) => ({ ...subtask, agent: pick(subtask.agent) }));
    for (const [index, subtask] of subtasks.entries()) {
      subtask.dependsOn = [...new Set(subtask.dependsOn)].filter((dep) => dep < index);
    }
    if (subtasks.length >= 2) return { mode: 'split', reason: plan.reason || 'Split by the planner.', subtasks };
  }

  return {
    mode: 'single',
    reason: plan.reason || 'One agent does the whole task.',
    assignee: pick(plan.assignee ?? plan.subtasks[0]?.agent),
    subtasks: [],
  };
}

/**
 * Group tasks into waves by their `dependsOn` ids. Everything in one wave is
 * independent of everything else in it. A cycle cannot be ordered, so its
 * members are released together rather than deadlocking.
 */
export function buildTaskWaves(tasks: Task[]): Task[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const finished = new Set<string>();
  const waves: Task[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((task) =>
      task.dependsOn.every((dep) => finished.has(dep) || !remaining.has(dep)),
    );
    if (!ready.length) {
      waves.push([...remaining.values()]);
      break;
    }
    waves.push(ready);
    for (const task of ready) {
      remaining.delete(task.id);
      finished.add(task.id);
    }
  }
  return waves;
}
