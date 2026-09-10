import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SKILL_SOURCES,
  customToolId,
  importSkillFromGitHub,
  saveConfig,
  skillSlug,
  toolServerStates,
  withToolServer,
  withoutToolServer,
} from '@rookery/core';
import type { RookeryConfig, ToolServerState } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { customToolServerSchema, importSkillSchema, parseOrThrow, patchToolServerSchema, skillSchema } from '../schemas.js';

type IdParams = { Params: { id: string } };
type NameParams = { Params: { name: string } };

/** The state as the browser sees it: recipe metadata, never env values. */
function publicTool(state: ToolServerState): Record<string, unknown> {
  const { entry, ...rest } = state;
  return {
    ...rest,
    optionDefs: entry?.options ?? [],
    envDefs: entry?.env ?? [],
    prepare: entry?.prepare ? { label: entry.prepare.label } : undefined,
  };
}

/** Run a preparation command to completion; the tail of its output comes back. */
function runPrepare(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'cmd' : command, win ? ['/c', command, ...args] : args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-6000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

/**
 * The tool hub and the skills folder.
 *
 * Writes go through saveConfig and into the live config object the runtime
 * and the server share, so a switch flipped here reaches the next turn.
 */
export async function registerToolRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const apply = (tools: RookeryConfig['tools']): void => {
    Object.assign(context.config, saveConfig({ tools }, context.config.home));
    context.assistant.emit('changed', { kind: 'tools', id: 'tools' });
  };
  const notFound = (reply: FastifyReply, message: string): { error: string; message: string } => {
    reply.code(404);
    return { error: 'Not Found', message };
  };

  app.get('/api/tools', async () => toolServerStates(context.config).map(publicTool));

  app.patch('/api/tools/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const state = toolServerStates(context.config).find((entry) => entry.id === request.params.id);
    if (!state) return notFound(reply, 'No tool server ' + request.params.id);
    const patch = parseOrThrow(patchToolServerSchema, request.body ?? {});
    apply(withToolServer(context.config, state.id, patch));
    const updated = toolServerStates(context.config).find((entry) => entry.id === state.id);
    return updated ? publicTool(updated) : notFound(reply, 'Gone');
  });

  app.post('/api/tools/custom', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(customToolServerSchema, request.body ?? {});
    let id = customToolId(input.name);
    const taken = new Set(toolServerStates(context.config).map((entry) => entry.id));
    for (let n = 2; taken.has(id); n += 1) id = customToolId(input.name) + '-' + n;
    // Zod fills the defaults at runtime; the input type still allows them to be absent.
    apply(
      withToolServer(context.config, id, {
        enabled: true,
        audience: input.audience ?? 'assistant',
        env: input.env ?? {},
        custom: { name: input.name, command: input.command, args: input.args ?? [], hint: input.hint ?? '' },
      }),
    );
    reply.code(201);
    const created = toolServerStates(context.config).find((entry) => entry.id === id);
    return created ? publicTool(created) : { id };
  });

  app.delete('/api/tools/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const state = toolServerStates(context.config).find((entry) => entry.id === request.params.id);
    if (!state) return notFound(reply, 'No tool server ' + request.params.id);
    apply(withoutToolServer(context.config, state.id));
    return { ok: true };
  });

  /** The one-off preparation of a catalogue entry, e.g. a browser download. */
  app.post('/api/tools/:id/prepare', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const state = toolServerStates(context.config).find((entry) => entry.id === request.params.id);
    if (!state?.entry?.prepare) return notFound(reply, 'Nothing to prepare for ' + request.params.id);
    context.log.info('Preparing tool server', { id: state.id });
    return runPrepare(state.entry.prepare.command, state.entry.prepare.args);
  });

  /* --------------------------------- skills --------------------------------- */

  app.get('/api/skills', async () => context.assistant.skills.list());

  /** The hand-picked shelf of public skills. */
  app.get('/api/skills/catalog', async () => SKILL_SOURCES);

  /** Fetch a skill folder from GitHub; a collection answers with candidates instead. */
  app.post('/api/skills/import', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(importSkillSchema, request.body ?? {});
    context.log.info('Importing skill', { source: input.source });
    const result = await importSkillFromGitHub(context.assistant.skills, input.source);
    if ('skill' in result) {
      context.assistant.emit('changed', { kind: 'skill', id: result.skill.name });
      reply.code(201);
    }
    return result;
  });

  app.get('/api/skills/:name', async (request: FastifyRequest<NameParams>, reply: FastifyReply) => {
    const skill = context.assistant.skills.get(request.params.name);
    return skill ?? notFound(reply, 'No skill ' + request.params.name);
  });

  app.put('/api/skills/:name', async (request: FastifyRequest<NameParams>) => {
    const input = parseOrThrow(skillSchema, request.body ?? {});
    const skill = context.assistant.skills.save({ name: skillSlug(request.params.name), ...input });
    context.assistant.emit('changed', { kind: 'skill', id: skill.name });
    return skill;
  });

  app.delete('/api/skills/:name', async (request: FastifyRequest<NameParams>, reply: FastifyReply) => {
    if (!context.assistant.skills.remove(request.params.name)) return notFound(reply, 'No skill ' + request.params.name);
    context.assistant.emit('changed', { kind: 'skill', id: request.params.name });
    return { ok: true };
  });
}
