import { useCallback, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { ArchiveIcon, MessagesSquareIcon, PencilIcon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_VARIANT,
  formatDuration,
  MEMORY_KIND_LABEL,
  PERMISSION_LABEL,
  PROVIDER_LABEL,
  relativeTime,
  shorten,
} from '@/lib/format';
import type { RookerySocket } from '@/lib/socket';
import type { AgentDetail, AssignmentView } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { AssignmentsView } from '@/components/AssignmentsView';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const NO_PROJECT = '__none__';

interface AgentDetailPageProps {
  org: OrgState;
  socket: RookerySocket;
  /** Makes this agent the chat's counterpart and goes to the conversation. */
  onOpenChat(agentId: string | null): void;
}

/**
 * One member of staff: who they are, what they are working on, what they know.
 *
 * The assignment form here talks to the socket directly rather than through
 * the chat hook: handing an agent a task from their own page is not a turn in
 * the conversation and must not land in the transcript.
 */
export function AgentDetailPage({ org, socket, onOpenChat }: AgentDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [task, setTask] = useState('');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<AssignmentView[]>([]);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    try {
      setDetail(await api.agent(id));
    } catch (caught) {
      toast.error('Agent konnte nicht geladen werden', {
        description: (caught as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const agent = detail?.agent ?? null;

  const assign = (): void => {
    if (!agent || busy) return;
    const trimmed = task.trim();
    if (!trimmed) return;

    setBusy(true);
    setLive([]);
    setResult('');
    setError(null);

    socket.sendAssign(
      {
        agent: agent.slug,
        task: trimmed,
        ...(projectId !== NO_PROJECT ? { projectId } : {}),
      },
      {
        onEvent: (event) => {
          if (event.type === 'assignment') {
            const view = event.assignment;
            setLive((current) => {
              const index = current.findIndex((entry) => entry.id === view.id);
              if (index === -1) return [...current, view];
              const next = [...current];
              next[index] = { ...(next[index] as AssignmentView), ...view };
              return next;
            });
          } else if (event.type === 'text') {
            setResult((current) => current + event.delta);
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        onDone: (text) => {
          if (text) setResult(text);
          setBusy(false);
          setTask('');
          void load();
          void org.refresh();
          toast('Auftrag abgeschlossen');
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
        },
      },
    );
  };

  const archive = async (): Promise<void> => {
    if (!agent) return;
    try {
      await api.updateAgent(agent.id, { archived: true });
      await org.refresh();
      await load();
      toast(agent.name + ' archiviert');
    } catch (caught) {
      toast.error('Archivieren fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  if (loading && !agent) return <Shell>Agent wird geladen …</Shell>;
  if (!agent) return <Shell>Dieser Agent existiert nicht.</Shell>;

  const manager = org.agentById(agent.managerId);
  const team = org.teams.find((entry) => entry.id === agent.teamId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        {/* ------------------------------- header ------------------------------ */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
              <Badge variant="outline" className="font-mono text-[11px] font-normal">
                {agent.slug}
              </Badge>
              {agent.archived && <Badge variant="secondary">archiviert</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{agent.title}</p>
            <p className="text-xs text-muted-foreground">
              {team ? 'Team ' + team.name : 'Ohne Team'} ·{' '}
              {manager ? 'berichtet an ' + manager.name : 'berichtet an den Assistenten'}
              {agent.provider && ' · ' + PROVIDER_LABEL[agent.provider]}
              {agent.model && ' · ' + agent.model}
              {agent.permission && ' · ' + PERMISSION_LABEL[agent.permission]}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onOpenChat(agent.id)}>
              <MessagesSquareIcon />
              Chat öffnen
            </Button>
            <Button asChild variant="outline" size="sm">
              <NavLink to={'/org/agents/' + agent.id + '/edit'}>
                <PencilIcon />
                Bearbeiten
              </NavLink>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={agent.archived}
              onClick={() => void archive()}
            >
              <ArchiveIcon />
              Archivieren
            </Button>
          </div>
        </div>

        {/* ---------------------------- instructions --------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Anweisungen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{agent.instructions}</p>
          </CardContent>
        </Card>

        {/* -------------------------------- assign ----------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Auftrag geben</CardTitle>
            <CardDescription>
              Läuft als eigener Prozess, kalt gestartet, im Projektverzeichnis oder im Arbeitsraum.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="assign-task" className="text-[12px] text-muted-foreground">
                Anweisung
              </Label>
              <Textarea
                id="assign-task"
                rows={4}
                placeholder={'Was soll ' + agent.name + ' tun?'}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assign-project" className="text-[12px] text-muted-foreground">
                Projekt
              </Label>
              <Select value={projectId} onValueChange={setProjectId} disabled={busy}>
                <SelectTrigger id="assign-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>Kein Projekt</SelectItem>
                  {org.projects
                    .filter((project) => !project.archived)
                    .map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end">
              <Button onClick={assign} disabled={busy || !task.trim()}>
                <SendIcon />
                {busy ? 'Läuft …' : 'Auftrag geben'}
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {live.length > 0 && <AssignmentsView assignments={live} />}

            {result && (
              <div className="rounded-xl border p-4">
                <ResultMarkdown text={result} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* ----------------------------- assignments --------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Letzte Aufträge</CardTitle>
          </CardHeader>
          <CardContent>
            {detail && detail.assignments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch keine Aufträge.</p>
            ) : (
              <ul className="divide-y">
                {detail?.assignments.map((assignment) => (
                  <li key={assignment.id}>
                    <NavLink
                      to={'/assignments/' + assignment.id}
                      className="-mx-2 flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted/60"
                    >
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {shorten(assignment.task, 90)}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={ASSIGNMENT_STATUS_VARIANT[assignment.status]}
                          className="h-5"
                        >
                          {ASSIGNMENT_STATUS_LABEL[assignment.status]}
                        </Badge>
                        <span className="tabular text-xs text-muted-foreground">
                          {formatDuration(assignment.durationMs) || '—'} ·{' '}
                          {relativeTime(assignment.createdAt)}
                        </span>
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------- reports ----------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Direkt unterstellt</CardTitle>
          </CardHeader>
          <CardContent>
            {detail && detail.reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">Niemand berichtet an {agent.name}.</p>
            ) : (
              <ul className="divide-y">
                {detail?.reports.map((report) => (
                  <li key={report.id}>
                    <NavLink
                      to={'/org/agents/' + report.id}
                      className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted/60"
                    >
                      <span className="font-medium">{report.name}</span>
                      <span className="text-xs text-muted-foreground">{report.title}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------- memory ------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>Gedächtnis</CardTitle>
            <CardDescription>Was {agent.name} aus eigenen Aufträgen gelernt hat.</CardDescription>
          </CardHeader>
          <CardContent>
            {detail && detail.memories.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch nichts gespeichert.</p>
            ) : (
              <ul className="space-y-2">
                {detail?.memories.map((memory) => (
                  <li key={memory.id} className="flex items-start gap-2 text-sm">
                    <Badge variant="secondary" className="mt-0.5 shrink-0">
                      {MEMORY_KIND_LABEL[memory.kind]}
                    </Badge>
                    <span className="leading-relaxed">{memory.content}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Shell({ children }: { children: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-6">
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
