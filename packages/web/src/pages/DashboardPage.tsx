import { NavLink } from 'react-router';
import { ArrowRightIcon, PlusIcon } from 'lucide-react';
import { MEMORY_KIND_LABEL, relativeTime } from '@/lib/format';
import type { MemoryKind, MemoryStats, ProviderStatus, PublicConfig, Session } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import type { TasksState } from '@/hooks/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex CLI' };

interface DashboardPageProps {
  assistantName: string;
  config: PublicConfig | null;
  providers: ProviderStatus[];
  sessions: Session[];
  memoryStats: MemoryStats | null;
  org: OrgState;
  tasks: TasksState;
  onOpenSession(id: string): void;
  onNewChat(): void;
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function providerBadge(status: ProviderStatus) {
  if (!status.available) return <Badge variant="destructive">Nicht gefunden</Badge>;
  if (!status.authenticated) return <Badge variant="secondary">Nicht angemeldet</Badge>;
  return <Badge>Bereit</Badge>;
}

export function DashboardPage({
  assistantName,
  config,
  providers,
  sessions,
  memoryStats,
  org,
  tasks,
  onOpenSession,
  onNewChat,
}: DashboardPageProps) {
  const recent = sessions.slice(0, 5);
  const kinds = Object.entries(memoryStats?.byKind ?? {}).filter(([, count]) => count > 0);
  const staff = org.agents.filter((agent) => !agent.archived).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {assistantName} auf einen Blick: Anbieter, Gedächtnis und die letzten Gespräche.
            </p>
          </div>
          <Button onClick={onNewChat}>
            <PlusIcon />
            Neues Gespräch
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Anbieter</CardTitle>
              <CardDescription>Angemeldet über deine bestehenden CLI-Sitzungen.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {providers.length === 0 && (
                <p className="text-sm text-muted-foreground">Noch keine Statusdaten vom Server.</p>
              )}
              {providers.map((status) => (
                <div key={status.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{PROVIDER_NAME[status.id] ?? status.id}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[status.version, status.detail].filter(Boolean).join(' · ') || status.binary}
                    </div>
                  </div>
                  {providerBadge(status)}
                </div>
              ))}
              {config && (
                <p className="text-xs text-muted-foreground">
                  Standard: {PROVIDER_NAME[config.defaultProvider] ?? config.defaultProvider}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Gedächtnis</CardTitle>
              <CardDescription>Was {assistantName} sich über dich gemerkt hat.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-3xl font-semibold tabular-nums">{memoryStats?.total ?? 0}</div>
              {kinds.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {kinds.map(([kind, count]) => (
                    <Badge key={kind} variant="secondary">
                      {MEMORY_KIND_LABEL[kind as MemoryKind] ?? kind} · {count}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Noch nichts gespeichert. {assistantName} lernt nach jedem Gespräch dazu.
                </p>
              )}
              <Button variant="outline" size="sm" asChild>
                <NavLink to="/memory">
                  Gedächtnis öffnen
                  <ArrowRightIcon />
                </NavLink>
              </Button>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Firma</CardTitle>
              <CardDescription>
                {org.snapshot?.organization.name ?? 'Noch keine Firma geladen.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-6">
                <Figure value={staff} label={staff === 1 ? 'Agent' : 'Agenten'} />
                <Figure
                  value={org.teams.length}
                  label={org.teams.length === 1 ? 'Team' : 'Teams'}
                />
                <Figure
                  value={org.running.length}
                  label={org.running.length === 1 ? 'laufender Auftrag' : 'laufende Aufträge'}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <NavLink to="/org">
                    Firma öffnen
                    <ArrowRightIcon />
                  </NavLink>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <NavLink to="/assignments">
                    Aufträge
                    <ArrowRightIcon />
                  </NavLink>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Aufgaben</CardTitle>
              <CardDescription>
                {tasks.topLevel.length === 1
                  ? '1 Aufgabe auf dem Board'
                  : tasks.topLevel.length + ' Aufgaben auf dem Board'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-6">
                <Figure value={tasks.countByStatus.open} label="offen" />
                <Figure value={tasks.countByStatus.running} label="laufen" />
                <Figure value={tasks.countByStatus.done} label="fertig" />
              </div>
              <Button variant="outline" size="sm" asChild>
                <NavLink to="/tasks">
                  Aufgaben öffnen
                  <ArrowRightIcon />
                </NavLink>
              </Button>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Letzte Gespräche</CardTitle>
              <CardDescription>
                {sessions.length === 1 ? '1 Gespräch' : sessions.length + ' Gespräche'} insgesamt
              </CardDescription>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">Noch keine Gespräche.</p>
              ) : (
                <ul className="divide-y">
                  {recent.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        onClick={() => onOpenSession(session.id)}
                        className="flex w-full items-center justify-between gap-4 py-2.5 text-left text-sm hover:bg-muted/60 rounded-md px-2 -mx-2"
                      >
                        <span className="truncate font-medium">{session.title || 'Neues Gespräch'}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {session.messageCount} Nachrichten · {relativeTime(session.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
