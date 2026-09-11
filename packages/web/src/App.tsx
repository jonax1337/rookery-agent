import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { AudioLinesIcon, ChevronDownIcon, CircleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from './lib/api';
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  PERMISSION_HINT,
  PERMISSION_LABEL,
} from './lib/format';
import type {
  ChatPayload,
  EffortLevel,
  MemoryKind,
  MemoryRecord,
  PermissionLevel,
  ProviderId,
  ProviderStatus,
  PublicConfig,
} from './lib/types';
import { useChat } from './hooks/useChat';
import { useMemories, useMemoryGraph, useSleep } from './hooks/useMemories';
import { useOrg } from './hooks/useOrg';
import { useSessions } from './hooks/useSessions';
import { useTasks } from './hooks/useTasks';
import { useCron } from './hooks/useCron';
import { useLearnedMemories, useSocket } from './hooks/useSocket';
import { useSpeech } from './hooks/useSpeech';
import { useRookeryRuntime } from './runtime/useRookeryRuntime';
import { AppSidebar } from '@/components/app-sidebar';
import { ContextIndicator, type ContextUsage } from '@/components/context-indicator';
import { ModelMenu } from '@/components/model-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { ComposerSlotsProvider } from '@/components/assistant-ui/composer-slots';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AgentFormPage } from './pages/AgentFormPage';
import { AssignmentDetailPage } from './pages/AssignmentDetailPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { ChatPage } from './pages/ChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { MemoryPage } from './pages/MemoryPage';
import { ToolsPage } from './pages/ToolsPage';
import { ToolDetailPage } from './pages/ToolDetailPage';
import { ToolFormPage } from './pages/ToolFormPage';
import { SkillsPage } from './pages/SkillsPage';
import { SkillFormPage } from './pages/SkillFormPage';
import { SkillImportPage } from './pages/SkillImportPage';
import { OrgPage } from './pages/OrgPage';
import { ProjectFormPage } from './pages/ProjectFormPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TaskFormPage } from './pages/TaskFormPage';
import { TasksPage } from './pages/TasksPage';
import { TeamFormPage } from './pages/TeamFormPage';
import { CronPage } from './pages/CronPage';
import { CronFormPage } from './pages/CronFormPage';
import { CronDetailPage } from './pages/CronDetailPage';
import { VoicePage } from './pages/VoicePage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';

const PERMISSIONS: PermissionLevel[] = ['chat', 'read', 'write', 'full'];

/** Radix' radio groups have no empty value, so "no project" needs a sentinel. */
const NO_PROJECT = '__none__';
/** Same for "the provider's own default" in the model and effort menus. */
const DEFAULT = '__default__';

/** The conversation a chat URL points at, or null on the blank chat page. */
const CHAT_PATH = '/c/';
const chatPath = (id: string | null): string => (id ? CHAT_PATH + id : '/');
/** The hands-free screen: fullscreen orb, no sidebar, no header. */
const VOICE_PATH = '/voice';

/**
 * Breadcrumb title for a path. Nested routes have to resolve to their section,
 * so this matches by prefix and puts the more specific rules first. Detail
 * pages name the record they show, the way a window title would.
 */
function pageTitle(
  pathname: string,
  lookup: {
    agent(id: string): string | undefined;
    team(id: string): string | undefined;
    task(id: string): string | undefined;
    job(id: string): string | undefined;
  },
): string {
  const named = (prefix: string, fallback: string, find: (id: string) => string | undefined): string => {
    const id = pathname.slice(prefix.length).split('/')[0] ?? '';
    return (id && id !== 'new' && find(id)) || fallback;
  };
  if (pathname.startsWith('/org/agents/')) return named('/org/agents/', 'Agent', lookup.agent);
  if (pathname.startsWith('/org/teams/')) return named('/org/teams/', 'Team', lookup.team);
  if (pathname.startsWith('/org/projects')) return 'Projekt';
  if (pathname.startsWith('/org')) return 'Firma';
  if (pathname === '/tasks') return 'Aufgaben';
  if (pathname.startsWith('/tasks/')) return named('/tasks/', 'Aufgabe', lookup.task);
  if (pathname === '/cron') return 'Zeitpläne';
  if (pathname.startsWith('/cron/')) return named('/cron/', 'Zeitplan', lookup.job);
  if (pathname === '/assignments') return 'Aufträge';
  if (pathname.startsWith('/assignments')) return 'Auftrag';
  if (pathname.startsWith('/dashboard')) return 'Dashboard';
  if (pathname.startsWith('/memory')) return 'Gedächtnis';
  if (pathname === '/tools') return 'Werkzeuge';
  if (pathname.startsWith('/tools')) return 'Werkzeug';
  if (pathname === '/skills') return 'Skills';
  if (pathname.startsWith('/skills')) return 'Skill';
  if (pathname.startsWith('/settings')) return 'Einstellungen';
  if (pathname.startsWith('/voice')) return 'Sprechen';
  return 'Chat';
}

/** Ghost dropdown trigger, the way model pickers sit in assistant-ui composers. */
function ComposerMenuButton({ label, ariaLabel }: { label: string; ariaLabel: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={ariaLabel}
        className="h-7 gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {label}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </Button>
    </DropdownMenuTrigger>
  );
}

export default function App() {
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [offline, setOffline] = useState(false);

  const [provider, setProvider] = useState<ProviderId>('claude');
  // DEFAULT means "whatever the provider picks"; a name pins it for the turn.
  const [model, setModel] = useState<string>(DEFAULT);
  const [effort, setEffort] = useState<string>(DEFAULT);
  const [permission, setPermission] = useState<PermissionLevel>('read');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);

  const sessions = useSessions(setOffline);
  // Read through a ref so the callback below stays stable across navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // A brand-new chat gets its session id from the server's first event: it
  // becomes the active thread, goes into the URL so a reload keeps it, and
  // the list refetches at once because the server has created it by then.
  // The hands-free screen keeps its own URL; it returns to the chat on exit.
  const onSession = useCallback(
    (id: string) => {
      sessions.setActiveId(id);
      void sessions.refresh();
      if (pathnameRef.current !== VOICE_PATH) void navigate(chatPath(id), { replace: true });
    },
    [navigate, sessions],
  );
  // The list carries `updatedAt` and the message count, both of which the
  // turn just changed.
  const onSettled = useCallback(() => void sessions.refresh(), [sessions]);
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

  /** Who the chat hub is writing to. Undefined agent means the assistant. */
  const counterpart = org.agentById(sessions.counterpartId ?? undefined) ?? null;

  /* --------------------------- initial load --------------------------- */

  const loadEverything = useCallback(async (): Promise<void> => {
    try {
      const [nextConfig, nextProviders] = await Promise.all([api.getConfig(), api.providers()]);
      setConfig(nextConfig);
      setProviders(nextProviders);
      setProvider(nextConfig.defaultProvider);
      setModel(nextConfig.defaultModel || DEFAULT);
      setEffort(nextConfig.defaultEffort || DEFAULT);
      setPermission(nextConfig.defaultPermission);
      setOffline(false);
    } catch (error) {
      setOffline(true);
      if (!(error instanceof ApiError)) throw error;
    }
  }, []);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  // The socket coming back up is the signal that the server restarted.
  useEffect(() => {
    if (connected) void loadEverything();
  }, [connected, loadEverything]);

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
  const activeEffort = effort === DEFAULT ? undefined : (effort as EffortLevel);

  // The picker hands over provider and model together, so a model name never
  // outlives the provider it belongs to.
  const chooseModel = useCallback((nextProvider: ProviderId, nextModel: string | undefined) => {
    setProvider(nextProvider);
    setModel(nextModel ?? DEFAULT);
  }, []);

  // What the model had in front of it on the newest answer of this thread;
  // the persisted usage covers a reloaded transcript as well as a live turn.
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

  const chooseProject = useCallback(
    (value: string) => {
      setProjectId(value);
      const active = sessions.activeId;
      if (!active) return;
      void api
        .patchSession(active, { projectId: value === NO_PROJECT ? null : value })
        .then(() => void sessions.refresh())
        .catch(() => toast.error('Projekt konnte nicht gesetzt werden'));
    },
    [sessions],
  );

  const activeProjectId = projectId === NO_PROJECT ? undefined : projectId;
  const projectLabel =
    org.projects.find((project) => project.id === activeProjectId)?.name ?? 'Kein Projekt';

  /* ------------------------------ memory ------------------------------ */

  const onLearned = useCallback(
    (stored: MemoryRecord[]) => {
      toast(stored.length + (stored.length === 1 ? ' Erinnerung' : ' Erinnerungen') + ' gelernt', {
        description: stored[0]?.content,
      });
      void memories.refresh();
    },
    [memories],
  );
  useLearnedMemories(socket, onLearned);

  const highlighted = useMemo(
    () => new Set(chat.recalled.map((memory) => memory.id)),
    [chat.recalled],
  );

  /* ------------------------------- voice ------------------------------ */

  /**
   * What a spoken utterance sends. Hands-free always talks to the assistant
   * itself, never to an agent, and runs at low effort unless an effort is
   * pinned: a spoken answer is forty words, and a second of thinking is
   * audible in a way it never is on screen.
   */
  const spokenPayload = useCallback(
    (text: string): ChatPayload => ({
      text,
      provider,
      permission,
      ...(activeModel ? { model: activeModel } : {}),
      effort: activeEffort ?? 'low',
      ...(activeProjectId ? { projectId: activeProjectId } : {}),
      voice: true,
    }),
    [activeEffort, activeModel, activeProjectId, permission, provider],
  );

  /* ------------------------------ runtime ----------------------------- */

  const goToChat = useCallback((id: string | null) => navigate(chatPath(id)), [navigate]);

  /**
   * Pick a contact. A counterpart change is a different conversation entirely,
   * so the open transcript goes with it and the thread list refetches. Picking
   * the contact already selected only returns to the open conversation: it
   * must never throw the transcript away.
   */
  const chooseCounterpart = useCallback(
    (agentId: string | null) => {
      if (agentId === sessions.counterpartId) {
        void navigate(chatPath(sessions.activeId));
        return;
      }
      sessions.selectCounterpart(agentId);
      chat.reset();
      void navigate('/');
    },
    [chat.reset, navigate, sessions],
  );

  const runtime = useRookeryRuntime({
    chat,
    sessions,
    provider,
    model: activeModel,
    effort: activeEffort,
    permission,
    projectId: activeProjectId,
    lang: config?.voice.lang ?? 'de-DE',
    onThreadSwitch: goToChat,
  });

  /* ------------------------- conversation in URL ---------------------- */

  // The URL is what survives a reload: `/c/<id>` opens that conversation
  // when it is not the active one already. A thread the server no longer has
  // sends the user to a blank chat instead of an empty transcript.
  const chatMatch = useMatch(CHAT_PATH + ':sessionId');
  const urlSessionId = chatMatch?.params.sessionId ?? null;
  const switchToThread = runtime.threads.switchToThread;
  useEffect(() => {
    if (!urlSessionId || urlSessionId === sessions.activeId || chat.busy) return;
    void switchToThread(urlSessionId);
    // Only the URL may trigger this; a switch started elsewhere updates the
    // URL itself and must not re-run the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSessionId]);

  const assistantName = config?.assistantName ?? 'Rookery';
  const error = chat.error;
  /** The open thread is a voice conversation: offer to pick it up by voice again. */
  const openVoiceSession = sessions.voiceSessions.find((session) => session.id === sessions.activeId);
  // On the chat page the breadcrumb names the counterpart, the way a messenger
  // puts the person you are writing to in the window title.
  const title =
    pathname === '/' || pathname.startsWith(CHAT_PATH)
      ? 'Chat · ' +
        (counterpart ? counterpart.name + ' (' + counterpart.title + ')' : assistantName)
      : pageTitle(pathname, {
          agent: (id) => org.agentById(id)?.name,
          team: (id) => org.teams.find((team) => team.id === id)?.name,
          task: (id) => tasks.tasks.find((task) => task.id === id)?.title,
          job: (id) => cron.jobById(id)?.name,
        });

  /* ---------------------------- hands-free ---------------------------- */

  if (pathname === VOICE_PATH) {
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <VoicePage
          socket={socket}
          config={config}
          assistantName={assistantName}
          buildPayload={spokenPayload}
          onSessionsChanged={() => void sessions.refresh()}
          onExit={() => void navigate(chatPath(sessions.activeId))}
        />
        <Toaster />
      </AssistantRuntimeProvider>
    );
  }

  /* ------------------------- composer controls ------------------------ */

  const composerLeft = (
    <DropdownMenu>
      <ComposerMenuButton label={projectLabel} ariaLabel="Projekt" />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Projekt</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={projectId} onValueChange={chooseProject}>
          <DropdownMenuRadioItem value={NO_PROJECT}>Kein Projekt</DropdownMenuRadioItem>
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

  const composerRight = (
    <>
      <ContextIndicator provider={provider} context={context} live={chat.quota} />

      <DropdownMenu>
        <ComposerMenuButton label={PERMISSION_LABEL[permission]} ariaLabel="Zugriff" />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Zugriff</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={permission}
            onValueChange={(value) => setPermission(value as PermissionLevel)}
          >
            {PERMISSIONS.map((level) => (
              <DropdownMenuRadioItem key={level} value={level} className="flex-col items-start gap-0.5">
                <span>{PERMISSION_LABEL[level]}</span>
                <span className="text-xs text-muted-foreground">{PERMISSION_HINT[level]}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <ModelMenu
        provider={provider}
        model={activeModel}
        providers={providers}
        onSelect={chooseModel}
      />

      <DropdownMenu>
        <ComposerMenuButton
          label={activeEffort ? EFFORT_LABEL[activeEffort] : 'Effort'}
          ariaLabel="Effort"
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Effort</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
            <DropdownMenuRadioItem value={DEFAULT} className="flex-col items-start gap-0.5">
              <span>Standard</span>
              <span className="text-xs text-muted-foreground">Was der Anbieter vorsieht.</span>
            </DropdownMenuRadioItem>
            {EFFORT_LEVELS.map((level) => (
              <DropdownMenuRadioItem key={level} value={level} className="flex-col items-start gap-0.5">
                <span>{EFFORT_LABEL[level]}</span>
                <span className="text-xs text-muted-foreground">{EFFORT_HINT[level]}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerSlotsProvider left={composerLeft} right={composerRight}>
        <SidebarProvider>
          <div className="flex h-dvh w-full pr-0.5">
            <AppSidebar
              connected={connected && !offline}
              counterpartId={sessions.counterpartId}
              chatPath={chatPath(sessions.activeId)}
              voiceSessions={sessions.voiceSessions}
              activeId={sessions.activeId}
              onSelectCounterpart={chooseCounterpart}
            />
            <SidebarInset>
              <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger />
                <Separator orientation="vertical" className="mr-2 h-4" />
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">{assistantName}</BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{title}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                <div className="ml-auto flex items-center gap-1">
                  {openVoiceSession && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mr-1 gap-1.5"
                      onClick={() => void navigate(VOICE_PATH + '?session=' + openVoiceSession.id)}
                    >
                      <AudioLinesIcon className="size-4" />
                      Im Sprachmodus fortsetzen
                    </Button>
                  )}
                  <ThemeToggle />
                </div>
              </header>

              {(offline || !connected) && (
                <Alert variant="destructive" className="m-4">
                  <CircleAlertIcon />
                  <AlertTitle>Keine Verbindung zum Rookery-Server.</AlertTitle>
                  <AlertDescription>
                    Starte ihn mit <code>npm start</code> und lade neu.
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive" className="mx-4 mt-4">
                  <CircleAlertIcon />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Routes>
                {['/', CHAT_PATH + ':sessionId'].map((path) => (
                  <Route
                    key={path}
                    path={path}
                    element={
                      <ChatPage
                        assignments={chat.assignments}
                        counterpart={counterpart}
                        assistantName={assistantName}
                      />
                    }
                  />
                ))}
                <Route
                  path="/dashboard"
                  element={
                    <DashboardPage
                      assistantName={assistantName}
                      config={config}
                      providers={providers}
                      sessions={sessions.sessions}
                      memoryStats={memories.stats}
                      org={org}
                      tasks={tasks}
                      onOpenSession={(id) => void runtime.threads.switchToThread(id)}
                      onNewChat={() => void runtime.threads.switchToNewThread()}
                    />
                  }
                />

                <Route path="/org" element={<OrgPage org={org} />} />
                <Route path="/org/agents/new" element={<AgentFormPage org={org} />} />
                <Route path="/org/agents/:id/edit" element={<AgentFormPage org={org} />} />
                <Route
                  path="/org/agents/:id"
                  element={
                    <AgentDetailPage org={org} socket={socket} onOpenChat={chooseCounterpart} />
                  }
                />
                <Route path="/org/teams/new" element={<TeamFormPage org={org} />} />
                <Route path="/org/teams/:id/edit" element={<TeamFormPage org={org} />} />
                <Route path="/org/projects/new" element={<ProjectFormPage org={org} />} />
                <Route path="/org/projects/:id/edit" element={<ProjectFormPage org={org} />} />

                <Route path="/tasks" element={<TasksPage tasks={tasks} org={org} />} />
                <Route path="/tasks/new" element={<TaskFormPage org={org} tasks={tasks} />} />
                <Route path="/tasks/:id/edit" element={<TaskFormPage org={org} tasks={tasks} />} />
                <Route
                  path="/tasks/:id"
                  element={<TaskDetailPage org={org} tasks={tasks} socket={socket} />}
                />

                <Route path="/cron" element={<CronPage cron={cron} org={org} />} />
                <Route path="/cron/new" element={<CronFormPage cron={cron} org={org} />} />
                <Route path="/cron/:id/edit" element={<CronFormPage cron={cron} org={org} />} />
                <Route path="/cron/:id" element={<CronDetailPage cron={cron} />} />

                <Route path="/assignments" element={<AssignmentsPage org={org} />} />
                <Route path="/assignments/:id" element={<AssignmentDetailPage org={org} />} />

                <Route
                  path="/memory"
                  element={
                    <MemoryPage
                      items={memories.items}
                      stats={memories.stats}
                      query={memories.query}
                      kind={memories.kind}
                      loading={memories.loading}
                      highlighted={highlighted}
                      onQuery={memories.setQuery}
                      onKind={(value) => memories.setKind(value as MemoryKind | '')}
                      onAdd={(input) => void memories.add(input)}
                      onForget={(id) => void memories.forget(id)}
                      graph={memoryGraph}
                      sleep={sleep}
                      onPatch={(id, changes) => {
                        void memories.patch(id, changes).then(() => void memoryGraph.refresh());
                      }}
                    />
                  }
                />
                <Route
                  path="/settings"
                  element={
                    config ? (
                      <SettingsPage
                        config={config}
                        providers={providers}
                        voices={speech.voices}
                        onSave={(patch) => {
                          void api
                            .updateConfig(patch)
                            .then((next) => {
                              setConfig(next);
                              toast('Einstellungen gespeichert');
                            })
                            .catch(() => toast.error('Speichern fehlgeschlagen'));
                        }}
                      />
                    ) : null
                  }
                />
                <Route path="/tools" element={<ToolsPage />} />
                <Route path="/tools/new" element={<ToolFormPage />} />
                <Route path="/tools/:id" element={<ToolDetailPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/skills/new" element={<SkillFormPage />} />
                <Route path="/skills/import" element={<SkillImportPage />} />
                <Route path="/skills/:name/edit" element={<SkillFormPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </SidebarInset>
          </div>
        </SidebarProvider>
      </ComposerSlotsProvider>
      <Toaster />
    </AssistantRuntimeProvider>
  );
}
