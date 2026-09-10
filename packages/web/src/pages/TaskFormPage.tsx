import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { TASK_PRIORITY_LABEL } from '@/lib/format';
import type { TaskPriority } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import type { TasksState } from '@/hooks/useTasks';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** Radix' selects have no empty value, so "unset" needs sentinels. */
const NO_PROJECT = '__none__';
const NO_ASSIGNEE = '__none__';

const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high'];

interface TaskFormPageProps {
  org: OrgState;
  tasks: TasksState;
}

/**
 * Create or edit a task.
 *
 * The assignee is optional on purpose: leaving it empty is the normal case,
 * because "Planen" on the detail page is what decides who does the work.
 */
export function TaskFormPage({ org, tasks }: TaskFormPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const existing = tasks.tasks.find((task) => task.id === id);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [assigneeId, setAssigneeId] = useState<string>(NO_ASSIGNEE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title);
    setDescription(existing.description);
    setProjectId(existing.projectId ?? NO_PROJECT);
    setPriority(existing.priority);
    setAssigneeId(existing.assigneeId ?? NO_ASSIGNEE);
  }, [existing]);

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      toast.error('Ein Titel ist Pflicht');
      return;
    }
    if (!description.trim()) {
      toast.error('Eine Beschreibung ist Pflicht');
      return;
    }

    setSaving(true);
    try {
      if (editing && id) {
        await api.updateTask(id, {
          title: title.trim(),
          description: description.trim(),
          priority,
          projectId: projectId === NO_PROJECT ? null : projectId,
          assigneeId: assigneeId === NO_ASSIGNEE ? null : assigneeId,
        });
        toast('Aufgabe gespeichert');
        await tasks.refresh();
        void navigate('/tasks/' + id);
      } else {
        const created = await api.createTask({
          title: title.trim(),
          description: description.trim(),
          priority,
          ...(projectId !== NO_PROJECT ? { projectId } : {}),
          ...(assigneeId !== NO_ASSIGNEE ? { assigneeId } : {}),
        });
        toast('Aufgabe angelegt');
        await tasks.refresh();
        void navigate('/tasks/' + created.id);
      }
    } catch (error) {
      toast.error('Speichern fehlgeschlagen', { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {editing ? 'Aufgabe bearbeiten' : 'Aufgabe anlegen'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Die Beschreibung muss für sich stehen: ein Agent sieht nichts als sie.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Aufgabe</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="task-title" className="text-[12px] text-muted-foreground">
                Titel
              </Label>
              <Input
                id="task-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-description" className="text-[12px] text-muted-foreground">
                Beschreibung
              </Label>
              <Textarea
                id="task-description"
                rows={6}
                placeholder="Ziel, Rahmenbedingungen, woran man merkt, dass es fertig ist."
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-project" className="text-[12px] text-muted-foreground">
                Projekt
              </Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="task-project" className="w-full">
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

            <div className="space-y-1.5">
              <Label htmlFor="task-priority" className="text-[12px] text-muted-foreground">
                Priorität
              </Label>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as TaskPriority)}
              >
                <SelectTrigger id="task-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {TASK_PRIORITY_LABEL[entry]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-assignee" className="text-[12px] text-muted-foreground">
                Zuständig
              </Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger id="task-assignee" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ASSIGNEE}>Noch offen</SelectItem>
                  {org.agents
                    .filter((agent) => !agent.archived)
                    .map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name} · {agent.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-[10.5px] text-muted-foreground/80">
                Leer lassen ist normal: „Planen“ entscheidet, wer übernimmt.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => void navigate(editing && id ? '/tasks/' + id : '/tasks')}
          >
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Speichern
          </Button>
        </div>
      </div>
    </div>
  );
}
