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
import type { Task, TaskStatus } from '@rookery/core';
import { EventRenderer, heading, keyValue, relativeTime, shorten, shortId, taskLine } from '../ui/render.js';
import { Spinner } from '../ui/spinner.js';
import { glyph, theme } from '../ui/theme.js';
import {
  ACTIVE_TASK_STATUSES,
  CliError,
  parseTaskPriority,
  parseTaskStatuses,
  resolveProject,
  resolveTask,
  withAssistant,
} from './shared.js';

const out = process.stdout;

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
      out.write(
        JSON.stringify(
          tasks.map((task) => ({
            ...task,
            children: assistant.store.org.listTasks(organization.id, { parentId: task.id }),
          })),
          null,
          2,
        ) + '\n',
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

    out.write('\n' + heading('Board') + theme.dim('  (' + tasks.length + ')') + '\n\n');
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

    const assignee = options.assignee
      ? assistant.store.org.findAgent(organization.id, options.assignee)
      : null;
    if (options.assignee && !assignee) {
      throw new CliError('No agent "' + options.assignee + '". Run `rookery org agents` to see who works here.');
    }

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
      out.write(JSON.stringify(task, null, 2) + '\n');
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

/** `rookery tasks show <id>` - one task in full, subtasks and result included. */
export async function taskShowCommand(ref: string, options: TaskShowOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const organization = assistant.org.activeOrganization();
    const task = resolveTask(assistant, ref);
    const children = assistant.store.org.listTasks(organization.id, { parentId: task.id });

    if (options.json) {
      out.write(JSON.stringify({ ...task, children }, null, 2) + '\n');
      return 0;
    }

    const slug = (id: string | undefined): string =>
      id ? (assistant.store.org.getAgent(id)?.slug ?? shortId(id)) : 'unassigned';
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
    if (task.assignmentId) out.write(keyValue('assignment', shortId(task.assignmentId)) + '\n');

    if (task.description && task.description !== task.title) {
      out.write('\n' + task.description.trimEnd() + '\n');
    }
    if (task.planNote) out.write('\n' + theme.dim(glyph.status + ' ' + task.planNote) + '\n');

    if (children.length) {
      out.write('\n' + heading('Subtasks') + theme.dim('  (' + children.length + ')') + '\n\n');
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
      out.write(JSON.stringify({ plan, children }, null, 2) + '\n');
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
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);

  try {
    return await withAssistant(async (assistant) => {
      const task = resolveTask(assistant, ref);
      if (task.status === 'running') throw new CliError('That task is already running.');

      const json = options.json ?? false;
      const spinner = json ? null : new Spinner(shorten(task.title, 40));
      const renderer = new EventRenderer({
        json,
        verbose: options.verbose ?? false,
        spinner,
        agentSlug: (id) => assistant.store.org.getAgent(id)?.slug ?? shortId(id),
      });

      let failed = false;
      spinner?.start();
      try {
        for await (const event of assistant.runTask({ taskId: task.id, signal: controller.signal })) {
          if (event.type === 'error') {
            // A killed provider reports its own death; the user pressed Ctrl+C
            // and does not need to be told about it twice.
            if (controller.signal.aborted) continue;
            if (event.fatal) failed = true;
          }
          renderer.handle(event);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          failed = true;
          renderer.handle({ type: 'error', message: (error as Error).message, fatal: true });
        }
      } finally {
        spinner?.stop();
      }

      // `runTask` ends with a `done` carrying the combined result; the renderer
      // only collected it, because a task's result is not streamed prose.
      const report = renderer.finish().trim();
      if (!json && report) out.write('\n' + report + '\n');

      if (controller.signal.aborted) {
        if (!json) process.stderr.write(theme.dim(glyph.warn + ' interrupted') + '\n');
        return 130;
      }
      return failed ? 1 : 0;
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

/* ------------------------------ done / cancel ---------------------------- */

export interface TaskDoneOptions {
  /** What came out of it, when it was not an agent that wrote the result. */
  result?: string;
}

/** `rookery tasks done <id>` - close a task by hand. */
export async function taskDoneCommand(ref: string, options: TaskDoneOptions = {}): Promise<number> {
  return withAssistant((assistant) => {
    const task = resolveTask(assistant, ref);
    refuseWhileRunning(task);

    const result = options.result?.trim();
    assistant.store.org.updateTask(task.id, {
      status: 'done',
      finishedAt: Date.now(),
      ...(result ? { result } : {}),
    });

    out.write(theme.green(glyph.ok + ' Task ' + shortId(task.id) + ' done  ') + theme.dim(shorten(task.title, 56)) + '\n');
    return 0;
  });
}

/** `rookery tasks cancel <id>` - take a task off the board without doing it. */
export async function taskCancelCommand(ref: string): Promise<number> {
  return withAssistant((assistant) => {
    const task = resolveTask(assistant, ref);
    refuseWhileRunning(task);

    assistant.store.org.updateTask(task.id, { status: 'cancelled', finishedAt: Date.now() });

    out.write(theme.yellow(glyph.warn + ' Task ' + shortId(task.id) + ' cancelled  ') + theme.dim(shorten(task.title, 56)) + '\n');
    return 0;
  });
}

/* -------------------------------- helpers -------------------------------- */

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

function paintStatus(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return theme.green(status);
    case 'failed':
      return theme.red(status);
    case 'running':
      return theme.yellow(status);
    case 'blocked':
      return theme.cyan(status);
    case 'cancelled':
      return theme.dim(status);
    default:
      return theme.ivory(status);
  }
}
