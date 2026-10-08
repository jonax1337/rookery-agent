/**
 * `rookery tasks ...` - the company board on the command line.
 *
 * Tasks are how work is tracked before and after it runs; assignments are the
 * runs themselves. The assistant keeps the same board from inside a turn
 * through its own tools, so nothing here is a parallel store - it is the
 * operator's window on the same records.
 *
 * Only `plan` and `run` start a provider process: planning asks a cheap model
 * who should do the work, running hands the subtasks to the agents in
 * dependency order and streams what they produce.
 */

import { describePlan, renderBoard } from '@rookery/core';
import type { Assistant, Task, TaskStatus } from '@rookery/core';
import {
  EventRenderer,
  heading,
  keyValue,
  listHeader,
  relativeTime,
  shorten,
  shortId,
  taskLine,
} from '../ui/render.js';
import { Spinner } from '../ui/spinner.js';
import { glyph, theme } from '../ui/theme.js';
import {
  ACTIVE_TASK_STATUSES,
  CliError,
  EXIT_INTERRUPTED,
  agentSlugOf,
  parseTaskPriority,
  parseTaskStatuses,
  printInterrupted,
  printJson,
  resolveAgent,
  resolveProject,
  resolveTask,
  withAssistant,
  withInterruptSignal,
} from './shared.js';

const out = process.stdout;

/** How much of a task title the run spinner shows. */
const SPINNER_TITLE_WIDTH = 40;
/** How much of a task title a done/cancelled confirmation shows. */
const CONFIRMATION_TITLE_WIDTH = 56;

/* --------------------------------- board -------------------------------- */

export interface TasksBoardOptions {
  /** Comma-separated statuses, e.g. `open,running`. */
  status?: string;
  /** Include done and cancelled tasks. */
  all?: boolean;
  json?: boolean;
}

/** `rookery tasks` - the board, exactly as the assistant reads it. */
export async function tasksBoardCommand(options: TasksBoardOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const wanted = parseTaskStatuses(options.status);
    // An explicit --status always wins; --all widens the default to everything.
    const status = wanted ?? (options.all ? undefined : [...ACTIVE_TASK_STATUSES]);
    const tasks = assistant.store.org.listTasks(organization.id, status ? { status } : {});

    if (options.json) {
      printJson(
        tasks.map((task) => ({
          ...task,
          children: assistant.store.org.listTasks(organization.id, { parentId: task.id }),
        })),
      );
      return 0;
    }

    if (!tasks.length) {
      out.write(
        theme.dim(
          status
            ? 'Nothing on the board with that status. `rookery tasks --all` shows everything.'
            : 'The board is empty. Add something with `rookery tasks add "<title>"`.',
        ) + '\n',
      );
      return 0;
    }

    out.write(listHeader('Board', tasks.length));
    out.write(renderBoard(tasks, assistant.org.snapshot(organization.id), assistant.store.org) + '\n');
    out.write(
      '\n' + theme.dim('rookery tasks show <id>  ' + glyph.dot + '  plan <id>  ' + glyph.dot + '  run <id>') + '\n\n',
    );
    return 0;
  });
}

/* ---------------------------------- add --------------------------------- */

export interface TaskAddOptions {
  description?: string;
  /** Project name or id the task belongs to. */
  project?: string;
  priority?: string;
  /** Agent slug, name or id to put the task on. */
  assignee?: string;
  json?: boolean;
}

/** `rookery tasks add <title...>` - put one piece of work on the board. */
export async function taskAddCommand(
  titleParts: string[],
  options: TaskAddOptions = {},
): Promise<number> {
  const title = titleParts.join(' ').trim();
  if (!title) throw new CliError('A task needs a title, e.g. `rookery tasks add "Rewrite the docs"`.');

  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const project = resolveProject(assistant, options.project);

    const assignee = options.assignee ? resolveAgent(assistant, options.assignee) : null;

    const task = assistant.store.org.createTask({
      orgId: organization.id,
      title,
      // A task with no body is still a task; the title is the whole brief.
      description: options.description?.trim() || title,
      projectId: project?.id,
      priority: parseTaskPriority(options.priority),
      assigneeId: assignee?.id,
      createdBy: 'user',
    });

    if (options.json) {
      printJson(task);
      return 0;
    }

    out.write(theme.green(glyph.ok + ' Task ' + shortId(task.id) + '  ' + task.title) + '\n');
    out.write(
      theme.dim(
        '  ' + task.status + '  ' + glyph.dot + '  ' + task.priority +
          '  ' + glyph.dot + '  ' + (assignee ? assignee.slug : 'unassigned') +
          (project ? '  ' + glyph.dot + '  ' + project.name : ''),
      ) + '\n',
    );
    out.write(theme.dim('  rookery tasks plan ' + shortId(task.id)) + '\n');
    return 0;
  });
}

/* ---------------------------------- show -------------------------------- */

export interface TaskShowOptions {
  json?: boolean;
}

const STATUS_PAINT: Partial<Record<TaskStatus, (text: string) => string>> = {
  done: theme.green,
  failed: theme.red,
  running: theme.yellow,
  blocked: theme.cyan,
  cancelled: theme.dim,
};

function paintStatus(status: TaskStatus): string {
  return (STATUS_PAINT[status] ?? theme.frost)(status);
}

/** `rookery tasks show <id>` - one task in full, subtasks and result included. */
export async function taskShowCommand(ref: string, options: TaskShowOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const task = resolveTask(assistant, ref);
    const children = assistant.store.org.listTasks(organization.id, { parentId: task.id });

    if (options.json) {
      printJson({ ...task, children });
      return 0;
    }

    const agentSlug = agentSlugOf(assistant);
    const slug = (id: string | undefined): string => (id ? agentSlug(id) : 'unassigned');
    const project = task.projectId ? assistant.store.org.getProject(task.projectId) : null;

    out.write('\n' + heading(task.title) + '\n');
    out.write(keyValue('id', task.id) + '\n');
    out.write(keyValue('status', paintStatus(task.status) + theme.dim('  ' + task.priority)) + '\n');
    out.write(keyValue('assignee', slug(task.assigneeId)) + '\n');
    if (project) out.write(keyValue('project', project.name) + '\n');
    out.write(
      keyValue(
        'updated',
        relativeTime(task.updatedAt) + theme.dim('  created ' + relativeTime(task.createdAt)),
      ) + '\n',
    );
    if (task.assignmentId) out.write(keyValue('run', shortId(task.assignmentId)) + '\n');

    if (task.description && task.description !== task.title) {
      out.write('\n' + task.description.trimEnd() + '\n');
    }
    if (task.planNote) out.write('\n' + theme.dim(glyph.status + ' ' + task.planNote) + '\n');

    if (children.length) {
      out.write(listHeader('Subtasks', children.length));
      for (const child of children) out.write(taskLine(child, slug(child.assigneeId)) + '\n');
    }

    if (task.result) out.write('\n' + heading('Result') + '\n\n' + task.result.trimEnd() + '\n');
    if (task.error) out.write('\n' + theme.red(glyph.fail + ' ' + task.error) + '\n');
    out.write('\n');
    return 0;
  });
}

/* ---------------------------------- plan -------------------------------- */

export interface TaskPlanOptions {
  /** Guidance for the planner, e.g. "keep it to one agent". */
  hint?: string;
  json?: boolean;
}

/** `rookery tasks plan <id>` - decide who does it, and whether it splits. */
export async function taskPlanCommand(ref: string, options: TaskPlanOptions = {}): Promise<number> {
  return withAssistant(async (assistant) => {
    const organization = assistant.org.activeOrganization();
    const task = resolveTask(assistant, ref);
    if (task.status === 'running') {
      throw new CliError('The task is running; wait for it to finish before re-planning it.');
    }

    const spinner = options.json ? null : new Spinner('planning');
    spinner?.start();
    let plan;
    try {
      plan = await assistant.planTask(task.id, options.hint?.trim() || undefined);
    } finally {
      spinner?.stop();
    }

    const children = assistant.store.org.listTasks(organization.id, { parentId: task.id });

    if (options.json) {
      printJson({ plan, children });
      return 0;
    }

    out.write('\n' + describePlan(plan, children) + '\n');
    out.write('\n' + theme.dim('rookery tasks run ' + shortId(task.id)) + '\n\n');
    return 0;
  });
}

/* ----------------------------------- run -------------------------------- */

export interface TaskRunOptions {
  json?: boolean;
  verbose?: boolean;
}

/**
 * `rookery tasks run <id>` - execute the board entry and print what came back.
 * Ctrl+C aborts the run and signals the provider children with it.
 */
export async function taskRunCommand(ref: string, options: TaskRunOptions = {}): Promise<number> {
  return withInterruptSignal((signal) =>
    withAssistant(async (assistant) => {
      const task = resolveTask(assistant, ref);
      if (task.status === 'running') throw new CliError('That task is already running.');

      const json = options.json ?? false;
      const renderer = new EventRenderer({
        json,
        verbose: options.verbose ?? false,
        spinner: json ? null : new Spinner(shorten(task.title, SPINNER_TITLE_WIDTH)),
        agentSlug: agentSlugOf(assistant),
      });

      const { failed } = await renderer.consume(assistant.runTask({ taskId: task.id, signal }), signal);

      // `runTask` ends with a `done` carrying the combined result; the renderer
      // only collected it, because a task's result is not streamed prose.
      const report = renderer.finish().trim();
      if (!json && report) out.write('\n' + report + '\n');

      if (signal.aborted) {
        if (!json) printInterrupted();
        return EXIT_INTERRUPTED;
      }
      return failed ? 1 : 0;
    }),
  );
}

/* ------------------------------ done / cancel ---------------------------- */

export interface TaskDoneOptions {
  /** What came out of it, when it was not an agent that wrote the result. */
  result?: string;
}

/** `rookery tasks done <id>` - close a task by hand. */
export async function taskDoneCommand(ref: string, options: TaskDoneOptions = {}): Promise<number> {
  return withAssistant(async (assistant) => {
    const task = resolveTask(assistant, ref);
    const result = options.result?.trim();

    if (!(await moveByHand(assistant, task, { to: 'done', ...(result ? { result } : {}) }))) return 1;
    out.write(
      theme.green(glyph.ok + ' Task ' + shortId(task.id) + ' done  ') +
        theme.dim(shorten(task.title, CONFIRMATION_TITLE_WIDTH)) + '\n',
    );
    return 0;
  });
}

/** `rookery tasks cancel <id>` - take a task off the board without doing it. */
export async function taskCancelCommand(ref: string): Promise<number> {
  return withAssistant(async (assistant) => {
    const task = resolveTask(assistant, ref);

    if (!(await moveByHand(assistant, task, { to: 'cancelled' }))) return 1;
    out.write(
      theme.yellow(glyph.warn + ' Task ' + shortId(task.id) + ' cancelled  ') +
        theme.dim(shorten(task.title, CONFIRMATION_TITLE_WIDTH)) + '\n',
    );
    return 0;
  });
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Move a task to a new status from the terminal; false (after saying why)
 * when the move was refused. It goes through the one status writer, so
 * closing a task here reaches its activity, whoever is owed the news and any
 * open browser.
 */
async function moveByHand(
  assistant: Assistant,
  task: Task,
  move: { to: 'done' | 'cancelled'; result?: string },
): Promise<boolean> {
  refuseWhileRunning(task);

  const moved = await assistant.org.setTaskStatus({ task, by: 'user', ...move });
  if (!moved.ok) out.write(theme.red(glyph.fail + ' ' + moved.reason) + '\n');
  return moved.ok;
}

/**
 * A running task has an assignment behind it and a provider process behind
 * that. Flipping the row underneath them would leave the run writing into a
 * status nobody asked for, so it is refused rather than raced.
 */
function refuseWhileRunning(task: Task): void {
  if (task.status === 'running') {
    throw new CliError('Task ' + shortId(task.id) + ' is running; interrupt the run before changing it.');
  }
}
