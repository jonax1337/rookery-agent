import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import {
  NO_PROJECT,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PERMISSION_LEVELS,
} from '@/lib/format';
import { reportFailure } from '@/lib/errors';
import { NOTIFICATION_KIND_LABEL } from '@/lib/notifications';
import type { CronEvent, RookerySocket, SleepEvent } from '@/lib/socket';
import type {
  ChatPayload,
  EffortLevel,
  MemoryRecord,
  Notification,
  PermissionLevel,
  ProviderId,
  ProviderStatus,
  PublicConfig,
} from '@/lib/types';
import { useAllSessions, type AllSessionsState } from '@/hooks/useAllSessions';
import { useChat, type ChatState } from '@/hooks/useChat';
import { useCron, type CronState } from '@/hooks/useCron';
import { useMemories, useMemoryGraph, useSleep } from '@/hooks/useMemories';
import { useOrg, type OrgState } from '@/hooks/useOrg';
import { useSessions, type SessionsState } from '@/hooks/useSessions';
import { useLearnedMemories, useSocket } from '@/hooks/useSocket';
import { useSpeech, type SpeechState } from '@/hooks/useSpeech';
import { useTasks, type TasksState } from '@/hooks/useTasks';
import { useRookeryRuntime } from '@/runtime/useRookeryRuntime';
import { ControlMenuButton } from '@/components/common/control-menu-button';
import { ModelMenu } from '@/components/model-menu';
import { ComposerSlotsProvider } from '@/components/assistant-ui/composer-slots';
import { ContextIndicator, type ContextUsage } from '@/components/context-indicator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Everything the app knows, in one place.
 *
 * This used to be the body of `App.tsx`: one component that opened the
 * socket, loaded the config, owned the session list, the transcript, the
 * company, the tasks, the schedules and the memory - and then threaded all of
 * it back down as props through a route table. The routes are a table again
 * because the state moved up here.
 *
 * The one rule that matters: `useSocket()` is called exactly once, here.
 * A second call opens a second WebSocket, and the two would race for every
 * turn. Pages never call it; they take what they need from the hooks below.
 */

/** Radix' radio groups have no empty value, so "the provider's own default" needs a sentinel. */
const DEFAULT = '__default__';

const CHAT_PATH = '/c/';
export const chatPath = (id: string | null): string => (id ? CHAT_PATH + id : '/');
/** The hands-free screen keeps its own URL and its own frame. */
const VOICE_PATH = '/voice';

/**
 * The memories a running turn recalled, as the memory list can act on them:
 * which rows to emphasise, and the turn a "was the point / was ballast" click
 * writes its label against (concept 4.2b, S6). `turnId` is `null` until the
 * `'memory'` event carries one - the highlight still renders, a feedback
 * click just has nothing to post.
 */
export interface Highlighted {
  ids: Set<string>;
  turnId: string | null;
}

/** Pure reduction, kept outside the component so it is a name, not an inline closure. */
export function highlightFromRecall(items: MemoryRecord[], turnId: string | null): Highlighted {
  return { ids: new Set(items.map((memory) => memory.id)), turnId };
}

/** The turn parameters the composer sets and every send reads. */
export interface TurnSettings {
  provider: ProviderId;
  /** Undefined means "whatever the provider picks". */
  model: string | undefined;
  effort: EffortLevel | undefined;
  permission: PermissionLevel;
  /** The project the conversation is filed under, or undefined. */
  projectId: string | undefined;
  /**
   * Whether provider, model, effort and permission are the person's own yet.
   * Until the config has loaded they are placeholders ("read" on "claude"),
   * and a caller that sends them would override the saved defaults.
   */
  ready: boolean;
  setPermission(level: PermissionLevel): void;
  /** Provider and model change together, so a name never outlives its provider. */
  chooseModel(provider: ProviderId, model: string | undefined): void;
  chooseProject(projectId: string | null): void;
  /** What a spoken utterance sends. */
  buildVoicePayload(text: string): ChatPayload;
}

interface RookeryValue {
  socket: RookerySocket;
  /** Socket open *and* the REST API reachable. */
  connected: boolean;
  offline: boolean;
  reload(): Promise<void>;

  config: PublicConfig | null;
  providers: ProviderStatus[];
  assistantName: string;
  saveConfig(patch: Partial<PublicConfig>): Promise<boolean>;

  chat: ChatState;
  /** What the model had in front of it on the newest answer of this thread. */
  context: ContextUsage | null;
  /** The memories this turn recalled, for highlighting in the list and for feedback. */
  highlighted: Highlighted;
  openConversation(id: string): void;
  newConversation(): void;

  sessions: SessionsState;
  /**
   * Every conversation there is - assistant and agents, chat and voice,
   * archive included. Held once here because three places wanted it: the
   * rail's badge, the conversations page and the command palette. Two
   * instances meant two 500-row requests on every socket event, and a
   * deletion on one of them left the other showing the dead row.
   */
  allSessions: AllSessionsState;
  org: OrgState;
  tasks: TasksState;
  cron: CronState;
  memories: ReturnType<typeof useMemories>;
  memoryGraph: ReturnType<typeof useMemoryGraph>;
  sleep: ReturnType<typeof useSleep>;
  speech: SpeechState;
  notifications: NotificationState;

  turn: TurnSettings;
  runtime: ReturnType<typeof useRookeryRuntime>;
}

const RookeryContext = createContext<RookeryValue | null>(null);

export function RookeryProvider({ children }: { children: ReactNode }) {
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [offline, setOffline] = useState(false);

  const [provider, setProvider] = useState<ProviderId>('claude');
  const [model, setModel] = useState<string>(DEFAULT);
  const [effort, setEffort] = useState<string>(DEFAULT);
  const [permission, setPermission] = useState<PermissionLevel>('read');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);

  const sessions = useSessions(setOffline);
  // The archive is a facet of `/chats`, so the one shared list has to carry
  // the archived rows; every consumer filters what it does not want.
  const allSessions = useAllSessions(socket, { includeArchived: true });

  // Read through a ref so the callback below stays stable across navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // A brand-new chat gets its session id from the server's first event: it
  // becomes the active thread, goes into the URL so a reload keeps it, and
  // the list refetches at once because the server has created it by then.
  // The hands-free screen keeps its own URL; it returns to the chat on exit.
  // `POST /api/sessions` sends no socket event, so the shared list has to be
  // told by hand - otherwise the rail's badge and `/chats` keep the count
  // they had before this conversation existed.
  const refreshAllSessions = allSessions.refresh;
  const onSession = useCallback(
    (id: string) => {
      sessions.setActiveId(id);
      void sessions.refresh();
      void refreshAllSessions();
      if (pathnameRef.current !== VOICE_PATH) void navigate(chatPath(id), { replace: true });
    },
    [navigate, refreshAllSessions, sessions],
  );
  // The list carries `updatedAt` and the message count, both of which the
  // turn just changed.
  const onSettled = useCallback(() => {
    void sessions.refresh();
    void refreshAllSessions();
  }, [refreshAllSessions, sessions]);

  const chat = useChat(socket, sessions.activeId, onSession, onSettled);
  const memories = useMemories();
  const memoryGraph = useMemoryGraph();
  // A finished night rewrites the bank, so both views reload when one ends.
  const refreshAfterSleep = useCallback(() => {
    void memories.refresh();
    void memoryGraph.refresh();
  }, [memories, memoryGraph]);
  const sleep = useSleep(socket, refreshAfterSleep);
  const org = useOrg(socket);
  const tasks = useTasks(socket);
  const cron = useCron(socket);
  const speech = useSpeech(config?.voice);

  /* --------------------------- initial load --------------------------- */

  // The pickers start from the saved defaults once. A later reload - the
  // socket coming back up after a blip - must not undo what the person has
  // picked since, nor swap the provider of the thread they are in.
  const defaultsAppliedRef = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [nextConfig, nextProviders] = await Promise.all([api.getConfig(), api.providers()]);
      setConfig(nextConfig);
      setProviders(nextProviders);
      if (!defaultsAppliedRef.current) {
        defaultsAppliedRef.current = true;
        setProvider(nextConfig.defaultProvider);
        setModel(nextConfig.defaultModel || DEFAULT);
        setEffort(nextConfig.defaultEffort || DEFAULT);
        setPermission(nextConfig.defaultPermission);
      }
      setOffline(false);
    } catch (error) {
      setOffline(true);
      if (!(error instanceof ApiError)) throw error;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The socket coming back up is the signal that the server restarted.
  useEffect(() => {
    if (connected) void reload();
  }, [connected, reload]);

  const saveConfig = useCallback(async (patch: Partial<PublicConfig>): Promise<boolean> => {
    try {
      setConfig(await api.updateConfig(patch));
      toast('Settings saved');
      return true;
    } catch (caught) {
      reportFailure('Save', caught);
      return false;
    }
  }, []);

  /* ------------------------------ project ----------------------------- */

  // Read through a ref: this must react to the active thread changing, not to
  // the session list refreshing, or a picker change would be undone at once.
  const sessionsRef = useRef(sessions.sessions);
  sessionsRef.current = sessions.sessions;

  useEffect(() => {
    if (!sessions.activeId) {
      setProjectId(NO_PROJECT);
      return;
    }
    const active = sessionsRef.current.find((session) => session.id === sessions.activeId);
    setProjectId(active?.projectId ?? NO_PROJECT);
    // A conversation keeps its provider and model; the pickers follow it so
    // the next turn does not silently switch mid-thread.
    if (active) {
      setProvider(active.provider);
      setModel(active.model || DEFAULT);
    }
  }, [sessions.activeId]);

  const activeModel = model === DEFAULT ? undefined : model;
  const activeEffort = activeEffortOf(effort);
  const activeProjectId = projectId === NO_PROJECT ? undefined : projectId;

  const chooseModel = useCallback((nextProvider: ProviderId, nextModel: string | undefined) => {
    setProvider(nextProvider);
    setModel(nextModel ?? DEFAULT);
  }, []);

  const chooseProject = useCallback(
    (value: string | null) => {
      const next = value ?? NO_PROJECT;
      setProjectId(next);
      const active = sessions.activeId;
      if (!active) return;
      void api
        .patchSession(active, { projectId: next === NO_PROJECT ? null : next })
        .then(() => void sessions.refresh())
        .catch((caught) => reportFailure('Setting the project', caught));
    },
    [sessions],
  );

  /* ------------------------------ context ----------------------------- */

  // The persisted usage covers a reloaded transcript as well as a live turn.
  const context = useMemo<ContextUsage | null>(() => {
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const usage = chat.messages[index]?.usage;
      if (chat.messages[index]?.role === 'assistant' && usage?.contextTokens !== undefined) {
        return {
          tokens: usage.contextTokens,
          ...(usage.contextWindow !== undefined ? { window: usage.contextWindow } : {}),
        };
      }
    }
    return null;
  }, [chat.messages]);

  /* ------------------------------ memory ------------------------------ */

  const onLearned = useCallback(
    (stored: MemoryRecord[]) => {
      toast(stored.length + (stored.length === 1 ? ' memory' : ' memories') + ' learned', {
        description: stored[0]?.content,
      });
      void memories.refresh();
    },
    [memories],
  );
  useLearnedMemories(socket, onLearned);

  /* ---------------------------- notifications ---------------------------- */

  // App-wide delivery for what Rookery stores for the user: a schedule
  // result, an agent's question, a finished card. Subscribing here means a
  // toast fires no matter which page is open, and the rail's badge stays
  // correct without anyone visiting `/inbox` first.
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnread = useCallback(async (): Promise<void> => {
    try {
      const { count } = await api.unreadNotificationCount();
      setUnreadCount(count);
    } catch {
      // The badge is a convenience; a failed refetch just keeps the last known count.
    }
  }, []);

  // Refetch on reconnect too: notifications stored while the socket was down
  // sent their frames to nobody.
  useEffect(() => {
    if (connected) void refreshUnread();
  }, [connected, refreshUnread]);

  // Schedule runs that already got their notification toast, so the plain
  // "Schedule finished" toast below does not say the same thing twice.
  const notifiedRunsRef = useRef(new Set<string>());

  useEffect(
    () =>
      socket.onNotification((notification: Notification) => {
        if (notification.cronRunId) notifiedRunsRef.current.add(notification.cronRunId);
        void refreshUnread();
        // No toast while the user is already looking at the inbox - the list
        // there refetches on the same event and shows it right away.
        if (pathnameRef.current === '/inbox') return;
        toast(notification.title || NOTIFICATION_KIND_LABEL[notification.kind], {
          description: NOTIFICATION_KIND_LABEL[notification.kind],
          action: {
            label: 'Open',
            onClick: () => void navigate('/inbox?id=' + encodeURIComponent(notification.id)),
          },
        });
      }),
    [socket, refreshUnread, navigate],
  );

  useEffect(
    () =>
      socket.onChanged((change) => {
        if (change.kind === 'notifications') void refreshUnread();
      }),
    [socket, refreshUnread],
  );

  useEffect(
    () =>
      socket.onCron((event: CronEvent) => {
        if (event.deleted || !event.run || event.run.status === 'running') return;
        const run = event.run;
        const ok = run.status === 'done';
        // A run that reports stores a `schedule` notification, which toasts on
        // its own. Wait a moment for it; only a run that stayed silent (or
        // whose notification never came) gets this plain toast.
        window.setTimeout(() => {
          if (notifiedRunsRef.current.has(run.id)) return;
          toast(ok ? 'Schedule finished: ' + event.job.name : 'Schedule failed: ' + event.job.name, {
            ...(ok ? {} : { description: run.error }),
          });
        }, 2000);
      }),
    [socket],
  );

  useEffect(
    () =>
      socket.onSleep((event: SleepEvent) => {
        if (event.phase !== 'finished') return;
        const ok = event.run.status === 'done';
        toast(ok ? 'Night finished' : 'Night failed', {
          description: ok ? event.run.report : event.run.error,
        });
      }),
    [socket],
  );

  const notifications = useMemo<NotificationState>(
    () => ({ unreadCount, refresh: refreshUnread }),
    [unreadCount, refreshUnread],
  );

  const highlighted = useMemo(
    () => highlightFromRecall(chat.recalled, chat.recalledTurnId),
    [chat.recalled, chat.recalledTurnId],
  );

  /* ------------------------------- voice ------------------------------ */

  /** The turn parameters as the socket wants them, for one piece of text. */
  const buildPayload = useCallback(
    (text: string): ChatPayload => ({
      text,
      provider,
      permission,
      ...(activeModel ? { model: activeModel } : {}),
      ...(activeEffort ? { effort: activeEffort } : {}),
      ...(activeProjectId ? { projectId: activeProjectId } : {}),
    }),
    [activeEffort, activeModel, activeProjectId, permission, provider],
  );

  /**
   * Hands-free always talks to the assistant itself, never to an agent, and
   * runs at low effort unless an effort is pinned: a spoken answer is forty
   * words, and a second of thinking is audible in a way it never is on screen.
   */
  const buildVoicePayload = useCallback(
    (text: string): ChatPayload => ({
      ...buildPayload(text),
      effort: activeEffort ?? 'low',
      voice: true,
    }),
    [activeEffort, buildPayload],
  );

  /* ------------------------------ runtime ----------------------------- */

  const goToChat = useCallback((id: string | null) => navigate(chatPath(id)), [navigate]);

  const runtime = useRookeryRuntime({
    chat,
    sessions,
    provider,
    model: activeModel,
    effort: activeEffort,
    permission,
    projectId: activeProjectId,
    lang: config?.voice.lang ?? 'en-GB',
    onThreadSwitch: goToChat,
  });

  const switchToThread = runtime.threads.switchToThread;
  const switchToNewThread = runtime.threads.switchToNewThread;
  const openConversation = useCallback((id: string) => void switchToThread(id), [switchToThread]);
  const newConversation = useCallback(() => void switchToNewThread(), [switchToNewThread]);

  /* ------------------------- conversation in URL ---------------------- */

  // The URL is what survives a reload: `/c/<id>` opens that conversation
  // when it is not the active one already.
  const chatMatch = useMatch(CHAT_PATH + ':sessionId');
  const urlSessionId = chatMatch?.params.sessionId ?? null;
  useEffect(() => {
    if (!urlSessionId || urlSessionId === sessions.activeId || chat.busy) return;
    void switchToThread(urlSessionId);
    // Only the URL may trigger this; a switch started elsewhere updates the
    // URL itself and must not re-run the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSessionId]);

  /* ------------------------------- errors ----------------------------- */

  // A failed turn used to push an Alert above the page, which moved the whole
  // layout down. It is a transient event, so it belongs in a toast - with the
  // one thing the reader actually wants, which is to try again.
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    const message = chat.error;
    if (!message || reportedRef.current === message) return;
    reportedRef.current = message;
    const last = [...chatRef.current.messages].reverse().find((entry) => entry.role === 'user');
    toast.error(message, {
      ...(last
        ? {
            action: {
              label: 'Send again',
              onClick: () => chatRef.current.send(buildPayload(last.content)),
            },
          }
        : {}),
    });
  }, [chat.error, buildPayload]);
  useEffect(() => {
    if (!chat.error) reportedRef.current = null;
  }, [chat.error]);

  /* ------------------------------- value ------------------------------ */

  const turn = useMemo<TurnSettings>(
    () => ({
      provider,
      model: activeModel,
      effort: activeEffort,
      permission,
      projectId: activeProjectId,
      ready: config !== null,
      setPermission,
      chooseModel,
      chooseProject,
      buildVoicePayload,
    }),
    [
      activeEffort,
      activeModel,
      activeProjectId,
      buildVoicePayload,
      chooseModel,
      chooseProject,
      config,
      permission,
      provider,
    ],
  );

  const value = useMemo<RookeryValue>(
    () => ({
      socket,
      connected: connected && !offline,
      offline,
      reload,
      config,
      providers,
      assistantName: config?.assistantName ?? 'Rookery',
      saveConfig,
      chat,
      context,
      highlighted,
      openConversation,
      newConversation,
      sessions,
      allSessions,
      org,
      tasks,
      cron,
      memories,
      memoryGraph,
      sleep,
      speech,
      notifications,
      turn,
      runtime,
    }),
    [
      allSessions,
      chat,
      config,
      connected,
      context,
      cron,
      highlighted,
      memories,
      memoryGraph,
      newConversation,
      notifications,
      offline,
      openConversation,
      org,
      providers,
      reload,
      runtime,
      saveConfig,
      sessions,
      sleep,
      socket,
      speech,
      tasks,
      turn,
    ],
  );

  return (
    <RookeryContext.Provider value={value}>
      {/* The raw picker state the composer menus bind to lives here too, so
          the menus can stay pure radio groups. */}
      <RawTurnContext.Provider
        value={{ projectId, setProjectId: chooseProject, effort, setEffort }}
      >
        {children}
      </RawTurnContext.Provider>
    </RookeryContext.Provider>
  );
}

/** The sentinel-carrying picker state; only the composer menus need it. */
interface RawTurn {
  projectId: string;
  setProjectId(value: string): void;
  effort: string;
  setEffort(value: string): void;
}
const RawTurnContext = createContext<RawTurn | null>(null);

function activeEffortOf(value: string): EffortLevel | undefined {
  return value === DEFAULT ? undefined : (value as EffortLevel);
}

/* ------------------------------- access -------------------------------- */

function useRookery(): RookeryValue {
  const value = useContext(RookeryContext);
  if (!value) throw new Error('Rookery hooks must be used within a RookeryProvider');
  return value;
}

export interface ConnectionState {
  socket: RookerySocket;
  connected: boolean;
  offline: boolean;
  /** Re-reads config and providers, e.g. behind a "Try again" button. */
  reload(): Promise<void>;
}

export function useConnection(): ConnectionState {
  const { socket, connected, offline, reload } = useRookery();
  return useMemo(
    () => ({ socket, connected, offline, reload }),
    [connected, offline, reload, socket],
  );
}

export interface ConfigState {
  config: PublicConfig | null;
  providers: ProviderStatus[];
  assistantName: string;
  save(patch: Partial<PublicConfig>): Promise<boolean>;
}

export function useConfig(): ConfigState {
  const { config, providers, assistantName, saveConfig } = useRookery();
  return useMemo(
    () => ({ config, providers, assistantName, save: saveConfig }),
    [assistantName, config, providers, saveConfig],
  );
}

export interface ChatSessionState {
  chat: ChatState;
  context: ContextUsage | null;
  highlighted: Highlighted;
  turn: TurnSettings;
  openConversation(id: string): void;
  newConversation(): void;
}

export function useChatSession(): ChatSessionState {
  const { chat, context, highlighted, turn, openConversation, newConversation } = useRookery();
  return useMemo(
    () => ({ chat, context, highlighted, turn, openConversation, newConversation }),
    [chat, context, highlighted, turn, openConversation, newConversation],
  );
}

export function useSessionsState(): SessionsState {
  return useRookery().sessions;
}

/**
 * Every conversation there is, from the one instance the app holds.
 *
 * Use this wherever a view needs more than the chat hub's own slice - the
 * rail's badge, the conversations page, the command palette, the header of an
 * open conversation that may be older than the hub's fifty rows.
 */
export function useAllSessionsState(): AllSessionsState {
  return useRookery().allSessions;
}

export function useOrgState(): OrgState {
  return useRookery().org;
}

export function useTasksState(): TasksState {
  return useRookery().tasks;
}

export function useCronState(): CronState {
  return useRookery().cron;
}

export interface MemoryState {
  memories: ReturnType<typeof useMemories>;
  graph: ReturnType<typeof useMemoryGraph>;
  sleep: ReturnType<typeof useSleep>;
  /** Memories the running turn recalled, and the turn to post feedback against. */
  highlighted: Highlighted;
}

export function useMemoryState(): MemoryState {
  const { memories, memoryGraph, sleep, highlighted } = useRookery();
  return useMemo(
    () => ({ memories, graph: memoryGraph, sleep, highlighted }),
    [highlighted, memories, memoryGraph, sleep],
  );
}

export function useSpeechState(): SpeechState {
  return useRookery().speech;
}

/**
 * Unread notifications, as a badge count.
 *
 * Fetched from the server rather than counted from frames, because a fresh
 * load starts at zero and would under-count what piled up before the tab
 * opened. `refresh()` re-reads it; `InboxPage` calls it after marking rows
 * read, and every `notification` frame and `changed: notifications` does too.
 */
export interface NotificationState {
  unreadCount: number;
  refresh(): Promise<void>;
}

export function useNotificationState(): NotificationState {
  return useRookery().notifications;
}

/* ------------------------------ sub-trees ------------------------------ */

/**
 * assistant-ui's runtime, fed from the state above. Separate from
 * `RookeryProvider` only because the provider tree in `main.tsx` reads better
 * when each layer names what it adds.
 */
export function RookeryRuntimeProvider({ children }: { children: ReactNode }) {
  const { runtime } = useRookery();
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/**
 * The four turn controls that live inside the stock composer.
 *
 * They stay in the composer on purpose: project, access, model and effort are
 * parameters of the *next* message, not of the page, so they belong where the
 * message is written. Only the trigger changed - five hand-copied pills became
 * one `ControlMenuButton`.
 */
export function RookeryComposerSlots({ children }: { children: ReactNode }) {
  const { context, org, providers, turn } = useRookery();
  const raw = useContext(RawTurnContext);
  if (!raw) throw new Error('RookeryComposerSlots must be used within a RookeryProvider');

  const projectLabel =
    org.projects.find((project) => project.id === turn.projectId)?.name ?? 'No project';

  const left = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ControlMenuButton className="h-8 px-2" label="Project" value={projectLabel} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={raw.projectId} onValueChange={raw.setProjectId}>
          <DropdownMenuRadioItem value={NO_PROJECT}>No project</DropdownMenuRadioItem>
          {org.projects
            .filter((project) => !project.archived)
            .map((project) => (
              <DropdownMenuRadioItem key={project.id} value={project.id}>
                {project.name}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const right = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ControlMenuButton className="h-8 px-2" label="Access" value={PERMISSION_LABEL[turn.permission]} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Access</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={turn.permission}
            onValueChange={(value) => turn.setPermission(value as PermissionLevel)}
          >
            {PERMISSION_LEVELS.map((level) => (
              <DropdownMenuRadioItem
                key={level}
                value={level}
                className="flex-col items-start gap-0.5"
              >
                <span>{PERMISSION_LABEL[level]}</span>
                <span className="text-xs text-muted-foreground">{PERMISSION_HINT[level]}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <ModelMenu
        provider={turn.provider}
        model={turn.model}
        providers={providers}
        onSelect={turn.chooseModel}
        effort={turn.effort}
        onEffortSelect={(value) => raw.setEffort(value ?? DEFAULT)}
      />


      {/*
        How full the model's head is belongs to the turn being composed, so it
        sits with the other turn controls rather than in the app header. It
        carries no quota any more - that lives on the dashboard and in the
        avatar menu, which is where someone goes to look at a subscription.
      */}
      <ContextIndicator context={context} />
    </>
  );

  return (
    <ComposerSlotsProvider left={left} right={right}>
      {children}
    </ComposerSlotsProvider>
  );
}
