import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { BanIcon, CheckIcon, Loader2Icon, PencilIcon, PlayIcon, WandSparklesIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  relativeTime,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_VARIANT,
  TASK_STATUS_LABEL,
  TASK_STATUS_VARIANT,
} from '@/lib/format';
import type { RookerySocket } from '@/lib/socket';
import type { AssignmentView, Task, TaskDetail, TaskPlan } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import type { TasksState } from '@/hooks/useTasks';
import { AssignmentsView } from '@/components/AssignmentsView';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface TaskDetailPageProps {
  org: OrgState;
  tasks: TasksState;
  socket: RookerySocket;
}

/**
 * One task: what it is, who does it, and the two things you can do to it -
 * plan it and run it.
 *
 * The board state (`useTasks`) is the live copy: it merges the `task`
 * broadcast, so a subtask moving from planned to running while the run streams
 * updates the list here without this page tracking it itself. The fetched
 * detail only fills in what the broadcast does not carry: the assignee record
 * and the assignment the task ran as.
 */
export function TaskDetailPage({ org, tasks, socket }: TaskDetailPageProps) {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const [hint, setHint] = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<TaskPlan | null>(null);

  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<AssignmentView[]>([]);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    try {
      setDetail(await api.task(id));
    } catch (caught) {
      toast.error('Aufgabe konnte nicht geladen werden', {
        description: (caught as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Prefer the board's copy: it is the one the socket keeps current.
  const boardTask = id ? tasks.tasks.find((entry) => entry.id === id) : undefined;
  const task: Task | null = boardTask ?? detail?.task ?? null;

  const children = useMemo<Task[]>(() => {
    if (!id) return [];
    const fromBoard = tasks.childrenOf(id);
    return fromBoard.length ? fromBoard : (detail?.children ?? []);
  }, [id, tasks, detail]);

  const doPlan = async (): Promise<void> => {
    if (!id || planning) return;
    setPlanning(true);
    setError(null);
    try {
      const answer = await api.planTask(id, hint.trim() || undefined);
      setPlan(answer.plan);
      setDetail((current) =>
        current ? { ...current, task: answer.task, children: answer.children } : current,
      );
      await tasks.refresh();
      toast('Plan steht');
    } catch (caught) {
      toast.error('Planen fehlgeschlagen', { description: (caught as Error).message });
      setError((caught as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const doRun = (): void => {
    if (!id || running) return;
    setRunning(true);
    setLive([]);
    setResult('');
    setError(null);

    socket.sendRunTask(
      { taskId: id },
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
          setRunning(false);
          void load();
          void tasks.refresh();
          void org.refresh();
          toast('Aufgabe ausgeführt');
        },
        onError: (message) => {
          setError(message);
          setRunning(false);
        },
      },
    );
  };

  const setStatus = async (status: 'done' | 'cancelled'): Promise<void> => {
    if (!id) return;
    try {
      await api.updateTask(id, { status });
      await tasks.refresh();
      await load();
      toast(status === 'done' ? 'Aufgabe abgeschlossen' : 'Aufgabe abgebrochen');
    } catch (caught) {
      toast.error('Status konnte nicht geändert werden', {
        description: (caught as Error).message,
      });
    }
  };

  if (loading && !task) return <Shell>Aufgabe wird geladen …</Shell>;
  if (!task) return <Shell>Diese Aufgabe existiert nicht.</Shell>;

  const assignee = org.agentById(task.assigneeId) ?? detail?.assignee ?? null;
  const project = org.projects.find((entry) => entry.id === task.projectId);
  const isRunning = task.status === 'running' || running;
  const settled = task.status === 'done' || task.status === 'cancelled';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        {/* ------------------------------- header ------------------------------ */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{task.title}</h1>
              <Badge variant={TASK_STATUS_VARIANT[task.status]}>
                {TASK_STATUS_LABEL[task.status]}
              </Badge>
              <Badge variant={TASK_PRIORITY_VARIANT[task.priority]}>
                {TASK_PRIORITY_LABEL[task.priority]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {assignee ? assignee.name + ' · ' + assignee.title : 'Noch niemand zugewiesen'}
              {project && ' · ' + project.name}
              {' · angelegt ' + relativeTime(task.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <NavLink to={'/tasks/' + task.id + '/edit'}>
                <PencilIcon />
                Bearbeiten
              </NavLink>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isRunning || settled}
              onClick={() => void setStatus('done')}
            >
              <CheckIcon />
              Abschließen
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={settled}
              onClick={() => void setStatus('cancelled')}
            >
              <BanIcon />
              Abbrechen
            </Button>
          </div>
        </div>

        {task.error && (
          <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
            {task.error}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* ----------------------------- description --------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Beschreibung</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{task.description}</p>
            {task.planNote && (
              <p className="rounded-lg bg-muted/60 p-3 text-[13px] leading-relaxed text-muted-foreground">
                {task.planNote}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------- planning ---------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Planen</CardTitle>
            <CardDescription>
              Ein Modell liest die Belegschaft und entscheidet: eine Person oder ein Schnitt in
              Teilaufgaben. Das dauert ein paar Sekunden.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="task-hint" className="text-[12px] text-muted-foreground">
                Hinweis für die Planung
              </Label>
              <Input
                id="task-hint"
                placeholder="optional, z. B. „bitte an Mara“"
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                disabled={planning}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {settled && (
                <p className="me-auto text-xs text-muted-foreground">
                  {task.status === 'done'
                    ? 'Erledigt. Zum erneuten Ausführen eine neue Aufgabe anlegen.'
                    : 'Abgebrochen. Zum erneuten Ausführen eine neue Aufgabe anlegen.'}
                </p>
              )}
              <Button
                variant="outline"
                onClick={() => void doPlan()}
                disabled={planning || isRunning || settled}
              >
                {planning ? <Loader2Icon className="animate-spin" /> : <WandSparklesIcon />}
                {planning ? 'Wird geplant …' : 'Planen'}
              </Button>
              <Button onClick={doRun} disabled={isRunning || settled}>
                {isRunning ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
                {isRunning ? 'Läuft …' : 'Ausführen'}
              </Button>
            </div>

            {plan && <PlanView plan={plan} org={org} />}
          </CardContent>
        </Card>

        {/* ------------------------------- subtasks ---------------------------- */}
        {children.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Teilaufgaben</CardTitle>
              <CardDescription>
                {children.length === 1 ? '1 Teilaufgabe' : children.length + ' Teilaufgaben'} in
                Abhängigkeitsreihenfolge.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {children.map((child) => {
                  const owner = org.agentById(child.assigneeId);
                  return (
                    <li
                      key={child.id}
                      className="flex flex-wrap items-center gap-3 py-2.5 text-sm"
                    >
                      <Badge
                        variant={TASK_STATUS_VARIANT[child.status]}
                        className="h-5 shrink-0"
                      >
                        {TASK_STATUS_LABEL[child.status]}
                      </Badge>
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {child.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {owner?.name ?? 'offen'}
                      </span>
                      {child.assignmentId && (
                        <NavLink
                          to={'/assignments/' + child.assignmentId}
                          className="shrink-0 text-xs text-primary underline underline-offset-2"
                        >
                          Auftrag
                        </NavLink>
                      )}
                      {child.error && (
                        <p className="w-full text-[11px] leading-snug text-destructive">
                          {child.error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* -------------------------------- run -------------------------------- */}
        {live.length > 0 && <AssignmentsView assignments={live} />}

        {(result || task.result) && (
          <Card>
            <CardHeader>
              <CardTitle>Ergebnis</CardTitle>
            </CardHeader>
            <CardContent>
              <ResultMarkdown text={result || task.result || ''} />
            </CardContent>
          </Card>
        )}

        {detail?.assignment && (
          <p className="text-xs text-muted-foreground">
            Ausgeführt als{' '}
            <NavLink
              to={'/assignments/' + detail.assignment.id}
              className="text-primary underline underline-offset-2"
            >
              Auftrag
            </NavLink>
            .
          </p>
        )}
      </div>
    </div>
  );
}

/** The planner's answer, before or alongside the subtasks it created. */
function PlanView({ plan, org }: { plan: TaskPlan; org: OrgState }) {
  const nameOf = (slug: string): string =>
    org.agents.find((agent) => agent.slug === slug)?.name ?? slug;

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={plan.mode === 'split' ? 'default' : 'secondary'}>
          {plan.mode === 'split' ? 'Aufgeteilt' : 'Eine Person'}
        </Badge>
        {plan.assignee && (
          <span className="text-sm font-medium">{nameOf(plan.assignee)}</span>
        )}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{plan.reason}</p>

      {plan.subtasks.length > 0 && (
        <ol className="space-y-2">
          {plan.subtasks.map((subtask, index) => (
            <li key={index} className="rounded-lg bg-muted/50 p-2.5">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                <span className="tabular text-muted-foreground">{index + 1}.</span>
                {subtask.title}
                <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                  {nameOf(subtask.agent)}
                </Badge>
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                {subtask.description}
              </p>
              {subtask.dependsOn.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  Wartet auf:{' '}
                  {subtask.dependsOn.map((entry) => plan.subtasks[entry]?.title ?? entry).join(', ')}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
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
