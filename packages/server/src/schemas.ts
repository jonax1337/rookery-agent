import { z } from 'zod';

/**
 * Request validation.
 *
 * Every schema here mirrors a type from @rookery/core. Zod is the only place
 * that knows how to turn an untrusted JSON body into one of those types, so a
 * route handler can assume its input is already sane.
 */

// Open, not `z.enum(['claude', 'codex'])`: any other id names a configured
// ProviderProfile (see providerProfilePatchSchema below), so the set of
// valid ids is a runtime property of the registry, not a compile-time one.
export const providerIdSchema = z.string().min(1).max(60);
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

export const sessionKindSchema = z.enum(['chat', 'voice', 'mail', 'schedule']);

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

/** POST /api/org/assignments/:id/review - a user rating, upserted per assignment. */
export const assignmentReviewSchema = z.object({
  overall: z.number().int().min(1).max(5),
  quality: z.number().int().min(1).max(5).optional(),
  completeness: z.number().int().min(1).max(5).optional(),
  reliability: z.number().int().min(1).max(5).optional(),
  communication: z.number().int().min(1).max(5).optional(),
  efficiency: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).optional(),
});

/** POST /api/org/agents/:id/replace - stage 4, the user approving a replacement proposal. */
export const replaceAgentSchema = z.object({
  name: z.string().min(1, 'name must not be empty'),
  slug: z.string().optional(),
  title: z.string().min(1, 'title must not be empty'),
  instructions: z.string().min(1, 'instructions must not be empty'),
  /** Overrides the auto-generated handover document. Optional. */
  handover: z.string().optional(),
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
  /** `'task'` turns the mail into a work order: one agent, one task, one thread. */
  mode: z.enum(['mail', 'task']).optional(),
});

/** POST /api/org/mail/read */
export const markMailReadSchema = z.object({
  ids: z.array(z.string()).min(1, 'ids must not be empty'),
  /** `false` puts the rows back to unread - the reading pane's "Mark as unread". */
  read: z.boolean().optional(),
});

/** POST /api/org/mail/archive - moves (or restores) a whole thread. */
export const archiveMailThreadSchema = z.object({
  threadId: z.string().min(1),
  /** `false` is the way back out of the archive folder. */
  archived: z.boolean().optional(),
});

/* -------------------------------- schedules -------------------------------- */

export const cronKindSchema = z.enum(['assistant', 'agent', 'script']);

/** POST /api/cron */
/** Whether the clock fires a schedule, or only an event does. */
const cronTriggerModeSchema = z.enum(['schedule', 'event']);
/**
 * Up to a day of rest between event runs. Zero means every event that a run
 * in flight does not already cover starts one.
 */
const eventCooldownSchema = z.number().int().min(0).max(24 * 60 * 60 * 1000);

export const cronJobSchema = z.object({
  name: z.string().min(1, 'name must not be empty').max(120),
  // An event-only schedule has no expression, so emptiness is not decided
  // here: `CronScheduler.create` knows which modes need one and says so in
  // its own words, which this route already turns into a 400.
  schedule: z.string().max(120),
  prompt: z.string().min(1, 'prompt must not be empty').max(20_000),
  triggerMode: cronTriggerModeSchema.optional(),
  eventCooldownMs: eventCooldownSchema.optional(),
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
  schedule: z.string().max(120).optional(),
  prompt: z.string().max(20_000).optional(),
  triggerMode: cronTriggerModeSchema.optional(),
  eventCooldownMs: eventCooldownSchema.nullable().optional(),
  kind: cronKindSchema.optional(),
  agentId: nullableText,
  projectId: nullableText,
  permission: permissionSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  once: z.boolean().optional(),
});

/* --------------------------------- config --------------------------------- */

const sleepConfigSchema = z
  .object({
    enabled: z.boolean(),
    schedule: z.string().max(120),
    scope: z.enum(['assistant', 'all']),
    nightBudget: z.number().int().min(0).max(500),
    maxMergeCalls: z.number().int().min(0).max(200),
    maxResolveCalls: z.number().int().min(0).max(100),
    maxLinkCalls: z.number().int().min(0).max(100),
    dormantAfterDays: z.number().int().min(7).max(365),
    minStrength: z.number().min(0).max(1),
    insights: z.number().int().min(0).max(10),
    insightWindowDays: z.number().int().min(1).max(90),
    replaySessions: z.number().int().min(0).max(200),
    skills: z.number().int().min(0).max(10),
    skillRevisions: z.number().int().min(0).max(20),
    cycles: z.number().int().min(1).max(5),
    agentThreshold: z.number().int().min(1).max(500),
    model: z.string().max(80),
    insightModel: z.string().max(80),
  })
  .partial();

/**
 * The dream block of the memory config. Every field is clamped to the range
 * its reader assumes. This schema only guards the HTTP PATCH: `rookery
 * config set` bypasses Zod entirely, so each reader clamps again at read
 * time rather than trusting that a value was validated when written.
 *
 * `promote` is not here on purpose - it has no reader in stage 1 (R16).
 */
const dreamConfigSchema = z
  .object({
    enabled: z.boolean(),
    record: z.boolean(),
    // A share of sessions; never above "every session".
    frameRate: z.number().min(0).max(1),
    // The policy space's limit span is 4..16; a frame outside it is not
    // replayable for the span it declares.
    limitMax: z.number().int().min(4).max(16),
    // The night's grid is prescribed as 8..12 fixed placements.
    gridSize: z.number().int().min(8).max(12),
    // A cost weight above 1 would let the cost term outweigh every hit.
    costWeight: z.number().min(0).max(1),
    // Relative document-frequency tolerance: generous, but finite.
    corpusTolerance: z.number().min(0).max(5),
    maxFrameBytes: z.number().int().min(1000).max(2_000_000),
    // Zero is legitimate: it switches the model-free evaluation off.
    maxEvalMs: z.number().int().min(0).max(600_000),
    frameRetainDays: z.number().int().min(1).max(3650),
    retainDays: z.number().int().min(7).max(3650),
    maxCallsPerNight: z.number().int().min(0).max(100),
  })
  .partial();

const memoryConfigSchema = z
  .object({
    enabled: z.boolean(),
    recallLimit: z.number().int().min(0).max(50),
    recallThreshold: z.number().min(0).max(1),
    autoExtract: z.boolean(),
    workingWindow: z.number().int().min(0).max(200),
    contextBudget: z.number().int().min(200).max(200000),
    // Load-bearing line: without it, zod strips the branch and every
    // memory.dream PATCH is silently answered with 200 - the same way
    // memory.gate and memory.graph are not settable over HTTP today.
    dream: dreamConfigSchema,
    sleep: sleepConfigSchema,
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
    mail: z.boolean(),
    mailFrom: z.enum(['assistant', 'leads', 'all']),
    activity: z.boolean(),
    tools: z.boolean(),
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
    media: z.boolean(),
    transcribe: z.enum(['auto', 'local', 'openai', 'elevenlabs', 'off']),
    // A model id, not a path: it names a repository on the model hub, and
    // the shape is checked here so a typo cannot become a fetch of
    // something else entirely.
    transcribeModel: z
      .string()
      .trim()
      .max(120)
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'owner/model'),
    // Telegram hands a bot at most 20 MB, so the ceiling is a real one.
    maxAttachmentMb: z.number().int().min(1).max(20),
    stream: z.boolean(),
    push: telegramPushConfigSchema,
  })
  .partial();

const gatewaysConfigSchema = z
  .object({
    telegram: telegramConfigSchema,
  })
  .partial();

/**
 * One watched mailbox. Every field except the password is required, because
 * the array is sent whole and replaces what was stored - a half-described
 * listener would otherwise overwrite a complete one.
 *
 * `password` follows the write-only rule of every other secret here: absent
 * or empty leaves the stored one alone, `null` clears it.
 *
 * `id` is restricted because it is quoted back on every run this listener
 * fires, as `imap:<id>`.
 */
const imapListenerSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash or underscore'),
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(320),
  password: z.string().max(400).nullable().optional(),
  mailbox: z.string().trim().min(1).max(200),
  jobId: z.string().trim().min(1).max(60),
});

const listenersConfigSchema = z
  .object({
    imap: z.array(imapListenerSchema).max(20),
  })
  .partial();

/**
 * PATCH /api/providers/profiles/:id. `authToken` is write-only, same rule as
 * the Telegram bot token: empty/absent leaves a stored key alone, `null`
 * clears it. The id itself is the route param, not part of the body.
 */
export const providerProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    baseUrl: z.string().trim().max(300),
    authToken: z.string().trim().max(400).nullable(),
    defaultModel: z.string().trim().max(120),
    via: z.enum(['direct', 'router']),
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
    listeners: listenersConfigSchema,
    router: z.object({ enabled: z.boolean(), port: z.number().int().min(1).max(65535) }).partial(),
    // How long an `ask_user` card stays answerable. Capped well under the
    // six-hour MCP tool ceiling the blocked call sits under, and above zero
    // so a saved value can never wedge a turn forever.
    questions: z.object({ timeoutMs: z.number().int().min(30_000).max(60 * 60 * 1000) }).partial(),
    providerFallback: z
      .object({
        enabled: z.boolean(),
        // The wall is 100; under 50 the threshold would dodge almost nothing.
        thresholdPercent: z.number().int().min(50).max(100),
        order: z.array(providerIdSchema).max(20),
      })
      .partial(),
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

/** PATCH /api/external/sources/:id: whether one installation's skills count here. */
export const patchExternalSourceSchema = z.object({ enabled: z.boolean() });

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

/**
 * POST /api/questions/:id/answer - the same payload as the `answer` frame
 * below, for SSE clients and as the REST fallback. The question id is the
 * route param, not part of the body.
 */
export const answerQuestionSchema = z.object({
  selected: z.array(z.number().int().min(0).max(63)).max(64).default([]),
  text: z.string().max(4000).optional(),
});

/** Frames a client may send over /ws. */
export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat'), id: z.string().min(1), payload: chatInputSchema }),
  z.object({ type: z.literal('assign'), id: z.string().min(1), payload: assignInputSchema }),
  z.object({ type: z.literal('run_task'), id: z.string().min(1), payload: z.object({ taskId: z.string().min(1) }) }),
  z.object({ type: z.literal('abort'), id: z.string().min(1) }),
  // Opt-in per socket: the live log of a running assignment is a terminal
  // feed, so its frames go only to the connections watching that run, never
  // as a broadcast. Watching never opens a turn and is not abortable - the
  // `unwatch` frame is the whole lifecycle.
  z.object({ type: z.literal('watch'), assignmentId: z.string().min(1) }),
  z.object({ type: z.literal('unwatch'), assignmentId: z.string().min(1) }),
  // An answer to a question the assistant asked. The id is the question's,
  // not a turn's: the turn waiting on it may have been started on another
  // connection entirely, so this frame carries no request id and gets no
  // stream of its own. `selected` holds indices into the offered options.
  z.object({
    type: z.literal('answer'),
    id: z.string().min(1),
    selected: z.array(z.number().int().min(0).max(63)).max(64).default([]),
    text: z.string().max(4000).optional(),
  }),
  // Rejoin a conversation: whatever turn is running in this session, this
  // socket wants its live tail from here on. The replay of what already
  // happened comes over REST from the journal - this frame is only the
  // subscription, and the `attached` reply says which turn (if any) answered.
  z.object({ type: z.literal('attach'), sessionId: z.string().min(1) }),
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
