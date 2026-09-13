import { z } from 'zod';

/**
 * Request validation.
 *
 * Every schema here mirrors a type from @rookery/core. Zod is the only place
 * that knows how to turn an untrusted JSON body into one of those types, so a
 * route handler can assume its input is already sane.
 */

export const providerIdSchema = z.enum(['claude', 'codex']);
export const permissionSchema = z.enum(['chat', 'read', 'write', 'full']);
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const memoryKindSchema = z.enum(['fact', 'preference', 'project', 'event', 'summary', 'insight']);

/** Body of POST /api/chat and the `payload` of a websocket `chat` frame. */
export const chatInputSchema = z.object({
  text: z.string().min(1, 'text must not be empty'),
  sessionId: z.string().min(1).optional(),
  provider: providerIdSchema.optional(),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
  permission: permissionSchema.optional(),
  projectId: z.string().min(1).optional(),
  voice: z.boolean().optional(),
});

/** Body of POST /api/org/assignments and the `payload` of a websocket `assign` frame. */
export const assignInputSchema = z.object({
  agent: z.string().min(1, 'agent must not be empty'),
  task: z.string().min(1, 'task must not be empty'),
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

export const sessionKindSchema = z.enum(['chat', 'voice']);

export const createSessionSchema = z.object({
  title: z.string().optional(),
  kind: sessionKindSchema.optional(),
  provider: providerIdSchema.optional(),
  model: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export const patchSessionSchema = z.object({
  title: z.string().min(1).optional(),
  projectId: z.string().min(1).nullable().optional(),
  /** Out of the way, not deleted: the transcript stays, the list gets shorter. */
  archived: z.boolean().optional(),
});

export const createMemorySchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
  kind: memoryKindSchema.optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
});

/** Editing one memory from the inspector: pin it, re-word it, wake it up. */
export const patchMemorySchema = z.object({
  content: z.string().min(1).optional(),
  kind: memoryKindSchema.optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
  /** true puts the memory to sleep, false wakes it up. */
  dormant: z.boolean().optional(),
  forgotten: z.boolean().optional(),
});

/* ------------------------------ organisation ------------------------------ */

const nullableText = z.string().nullable().optional();

export const organizationSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  mission: z.string().optional(),
});

export const patchOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  mission: nullableText,
});

export const projectSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  description: z.string().optional(),
  path: z.string().optional(),
});

export const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: nullableText,
  path: nullableText,
  archived: z.boolean().optional(),
});

export const teamSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  purpose: z.string().optional(),
  leadId: z.string().optional(),
});

export const patchTeamSchema = z.object({
  name: z.string().min(1).optional(),
  purpose: nullableText,
  leadId: nullableText,
});

export const agentSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  title: z.string().min(1, 'title must not be empty'),
  instructions: z.string().min(1, 'instructions must not be empty'),
  slug: z.string().optional(),
  teamId: z.string().optional(),
  managerId: z.string().optional(),
  provider: providerIdSchema.optional(),
  model: z.string().optional(),
  permission: permissionSchema.optional(),
});

export const patchAgentSchema = z.object({
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  teamId: nullableText,
  managerId: nullableText,
  provider: providerIdSchema.nullable().optional(),
  model: nullableText,
  permission: permissionSchema.nullable().optional(),
  archived: z.boolean().optional(),
});

export const taskSchema = z.object({
  title: z.string().min(1, 'title must not be empty'),
  description: z.string().min(1, 'description must not be empty'),
  projectId: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assigneeId: z.string().min(1).optional(),
});

export const patchTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  projectId: nullableText,
  assigneeId: nullableText,
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  result: nullableText,
  /** Board drag&drop position within a status column. */
  sortOrder: z.number().optional(),
  /** Confirms `status: 'done'` even though the linked assignment failed. */
  force: z.boolean().optional(),
});

export const planTaskSchema = z.object({
  hint: z.string().optional(),
});

/** POST /api/org/mail */
export const sendMailSchema = z.object({
  to: z.array(z.string().min(1)).min(1, 'to must not be empty'),
  cc: z.array(z.string().min(1)).optional(),
  subject: z.string().min(1, 'subject must not be empty'),
  body: z.string().min(1, 'body must not be empty'),
  inReplyTo: z.string().min(1).optional(),
});

/** POST /api/org/mail/read */
export const markMailReadSchema = z.object({
  ids: z.array(z.string()).min(1, 'ids must not be empty'),
});

/* -------------------------------- schedules -------------------------------- */

export const cronKindSchema = z.enum(['assistant', 'agent', 'script']);

/** POST /api/cron */
export const cronJobSchema = z.object({
  name: z.string().min(1, 'name must not be empty').max(120),
  schedule: z.string().min(1, 'schedule must not be empty').max(120),
  prompt: z.string().min(1, 'prompt must not be empty').max(20_000),
  kind: cronKindSchema.optional(),
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  permission: permissionSchema.optional(),
  enabled: z.boolean().optional(),
  once: z.boolean().optional(),
});

/** PATCH /api/cron/:id */
export const patchCronJobSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  schedule: z.string().min(1).max(120).optional(),
  prompt: z.string().max(20_000).optional(),
  kind: cronKindSchema.optional(),
  agentId: nullableText,
  projectId: nullableText,
  permission: permissionSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  once: z.boolean().optional(),
});

/* --------------------------------- config --------------------------------- */

const memoryConfigSchema = z
  .object({
    enabled: z.boolean(),
    recallLimit: z.number().int().min(0).max(50),
    recallThreshold: z.number().min(0).max(1),
    autoExtract: z.boolean(),
    workingWindow: z.number().int().min(0).max(200),
    contextBudget: z.number().int().min(200).max(200000),
  })
  .partial();

const voiceConfigSchema = z
  .object({
    enabled: z.boolean(),
    wakeWord: z.string(),
    lang: z.string(),
    voiceName: z.string(),
    rate: z.number().min(0.1).max(4),
    pitch: z.number().min(0).max(2),
    speakCleanText: z.boolean(),
    engine: z.enum(['browser', 'edge', 'elevenlabs', 'openai']),
    edgeVoice: z.string().max(80),
    elevenLabsVoiceId: z.string().max(80),
    elevenLabsModel: z.enum(['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_v3']),
    openaiVoice: z.string().max(40),
    jarvisEffect: z.boolean(),
    style: z.enum(['neutral', 'jarvis']),
  })
  .partial();

/** POST /api/tts: one chunk of speech, sentence-sized in practice. */
export const ttsInputSchema = z.object({
  text: z.string().min(1).max(3000),
});

const orgConfigSchema = z
  .object({
    maxConcurrentAssignments: z.number().int().min(1).max(16),
    maxDelegationDepth: z.number().int().min(1).max(6),
    assignmentTimeoutMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
    lazyCoding: z.boolean(),
    activeOrganizationId: z.string().min(1),
  })
  .partial();

/** "22:00", or empty for no quiet hours - never a bare hour or a 24:00. */
const timeOfDaySchema = z
  .string()
  .refine((value) => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), 'HH:MM or empty');

/** Telegram ids: bounded so a pasted list cannot grow the allowlist without limit. */
const telegramIdListSchema = z.array(z.number().int().positive()).max(8);

const telegramPushConfigSchema = z
  .object({
    enabled: z.boolean(),
    assignments: z.boolean(),
    cron: z.boolean(),
    sleep: z.boolean(),
    tasks: z.boolean(),
    quietFrom: timeOfDaySchema,
    quietUntil: timeOfDaySchema,
    maxPerHour: z.number().int().min(1).max(60),
    recipients: telegramIdListSchema,
  })
  .partial();

/**
 * `token` is write-only: a PATCH may set it, GET never returns it. An empty
 * string is therefore not "clear the token" - it is what a form that never
 * touched the field sends back, and treating that as a wipe would drop the
 * channel's credentials on every unrelated save. Clearing is `null`.
 */
const telegramConfigSchema = z
  .object({
    enabled: z.boolean(),
    token: z.string().trim().max(200).nullable(),
    pairing: z.boolean(),
    allowedUserIds: telegramIdListSchema,
    permission: permissionSchema,
    model: z.string(),
    push: telegramPushConfigSchema,
  })
  .partial();

const gatewaysConfigSchema = z
  .object({
    telegram: telegramConfigSchema,
  })
  .partial();

/**
 * PATCH /api/config. Deliberately narrower than RookeryConfig: `home`,
 * `workspace` and `token` are not remotely settable, because any of them
 * would let a client lock itself (or somebody else) out of the running server.
 */
export const patchConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1),
    defaultProvider: providerIdSchema,
    defaultModel: z.string(),
    // An empty string clears the setting back to the provider default.
    defaultEffort: effortSchema.or(z.literal('')),
    defaultPermission: permissionSchema,
    logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    assistantName: z.string().min(1),
    userName: z.string(),
    formalAddress: z.boolean(),
    honorific: z.string().max(40),
    memory: memoryConfigSchema,
    voice: voiceConfigSchema,
    org: orgConfigSchema,
    gateways: gatewaysConfigSchema,
  })
  .partial();

const audienceSchema = z.enum(['assistant', 'agents', 'both']);

/** PATCH /api/tools/:id: flip, retarget, configure. */
export const patchToolServerSchema = z
  .object({
    enabled: z.boolean(),
    audience: audienceSchema,
    options: z.record(z.string().max(2000)),
    env: z.record(z.string().max(4000)),
    /** Project ids this server is limited to; empty means every project. */
    projectIds: z.array(z.string().min(1)).max(500),
  })
  .partial();

/** POST /api/tools/custom: a server of the user's own. */
export const customToolServerSchema = z.object({
  name: z.string().min(1).max(80),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(64).default([]),
  hint: z.string().max(4000).default(''),
  audience: audienceSchema.default('assistant'),
  env: z.record(z.string().max(4000)).default({}),
});

/** POST /api/skills/import */
export const importSkillSchema = z.object({
  source: z.string().min(3).max(500),
});

/** PUT /api/skills/:name */
export const skillSchema = z.object({
  description: z.string().min(1).max(300),
  audience: audienceSchema.default('both'),
  body: z.string().max(200_000),
});

/** Frames a client may send over /ws. */
export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat'), id: z.string().min(1), payload: chatInputSchema }),
  z.object({ type: z.literal('assign'), id: z.string().min(1), payload: assignInputSchema }),
  z.object({ type: z.literal('run_task'), id: z.string().min(1), payload: z.object({ taskId: z.string().min(1) }) }),
  z.object({ type: z.literal('abort'), id: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

/** Flatten a Zod failure into one line a human can act on. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export class BadRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** Parse or throw a 400 that Fastify's error handler renders as JSON. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(formatIssues(result.error));
  return result.data;
}
