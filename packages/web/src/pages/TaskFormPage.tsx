import { useEffect, useId, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ListTodoIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type TaskInput, type TaskPatch } from '@/lib/api';
import {
  isSettableTaskStatus,
  SETTABLE_TASK_STATUS,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  type SettableTaskStatus,
} from '@/lib/format';
import type { Task, TaskPriority } from '@/lib/types';
import { useOrgState, useTasksState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import {
  ChoiceField,
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
  type ChoiceOption,
} from '@/components/forms/form-kit';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Create or edit a task.
 *
 * The assignee stays optional on purpose: leaving it open is the normal case,
 * because "Planen" on the detail page is what decides who does the work.
 *
 * The status select only offers what a person may set by hand. `planned`,
 * `running` and `failed` belong to the planner and the runner, so a task in
 * one of those states shows it and leaves it alone rather than offering a
 * value the server would reject.
 */


interface TaskDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  projectId: string | null;
  assigneeId: string | null;
  /** `null` while the runner owns the state - then the select is read-only. */
  status: SettableTaskStatus | null;
}

const EMPTY: TaskDraft = {
  title: '',
  description: '',
  priority: 'normal',
  projectId: null,
  assigneeId: null,
  status: null,
};

const schema = z.object({
  title: z.string().trim().min(1, 'Ein Titel ist Pflicht.'),
  description: z
    .string()
    .trim()
    .min(1, 'Ohne Beschreibung hat der Planer nichts, woraus er einen Auftrag machen kann.'),
});

const PRIORITY_OPTIONS: ChoiceOption<TaskPriority>[] = [
  { value: 'high', label: TASK_PRIORITY_LABEL.high, description: 'Zuerst, vor allem anderen.' },
  { value: 'normal', label: TASK_PRIORITY_LABEL.normal, description: 'Der Normalfall.' },
  { value: 'low', label: TASK_PRIORITY_LABEL.low, description: 'Wenn Zeit dafür ist.' },
];

function draftOf(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    projectId: task.projectId ?? null,
    assigneeId: task.assigneeId ?? null,
    status: isSettableTaskStatus(task.status) ? task.status : null,
  };
}

function buildPatch(draft: TaskDraft): TaskPatch {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    priority: draft.priority,
    projectId: draft.projectId,
    assigneeId: draft.assigneeId,
    ...(draft.status ? { status: draft.status } : {}),
  };
}

function toInput(patch: TaskPatch): TaskInput {
  return {
    title: patch.title ?? '',
    description: patch.description ?? '',
    ...(patch.priority ? { priority: patch.priority } : {}),
    ...(patch.projectId ? { projectId: patch.projectId } : {}),
    ...(patch.assigneeId ? { assigneeId: patch.assigneeId } : {}),
  };
}

export function TaskFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const tasks = useTasksState();
  const org = useOrgState();

  const editing = Boolean(id);
  const task = tasks.tasks.find((entry) => entry.id === id);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<TaskDraft>(EMPTY);

  // A `task` broadcast arrives on every change anywhere - the runner writing
  // a result, the planner setting an assignee - so the fill has to happen
  // exactly once, or a half-written edit gets reset under the cursor.
  useEffect(() => {
    if (!task) return;
    hydrate(task.id, () => draftOf(task));
  }, [hydrate, task]);

  const projectOptions = useMemo<EntityOption[]>(
    () =>
      org.projects
        .filter((project) => !project.archived)
        .map((project) => ({ value: project.id, label: project.name })),
    [org.projects],
  );

  const agentOptions = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name, hint: agent.title })),
    [org.agents],
  );

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    const saved =
      editing && id ? await api.updateTask(id, patch) : await api.createTask(toInput(patch));
    markSaved();
    await tasks.refresh();
    toast(editing ? 'Aufgabe gespeichert' : 'Aufgabe angelegt');
    void navigate('/tasks/' + saved.id);
  });

  const leaf = editing ? (task?.title ?? 'Aufgabe bearbeiten') : 'Aufgabe anlegen';

  usePageMeta(
    {
      breadcrumb: [{ label: 'Aufgaben', to: '/tasks' }, { label: leaf }],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo={editing && id ? '/tasks/' + id : '/tasks'}
          submitting={saving}
          submitDisabled={!dirty || saving}
        />
      ),
    },
    [dirty, editing, formId, id, saving],
  );

  if (editing && !task && !tasks.loading) {
    return (
      <PageBody width="2xl">
        <EmptyState
          icon={ListTodoIcon}
          title="Diese Aufgabe gibt es nicht mehr"
          description="Sie wurde gelöscht oder hat nie existiert."
          actionLabel="Zu den Aufgaben"
          actionTo="/tasks"
        />
      </PageBody>
    );
  }

  // Ohne geladene Aufgabe keine Eingabefelder: ein leeres Formular würde die
  // Aufgabe beim Speichern mit Leerwerten überschreiben.
  if (editing && !task) {
    return (
      <PageBody width="2xl">
        <FormFieldsSkeleton fields={4} />
      </PageBody>
    );
  }

  return (
    <PageBody width="2xl">
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description="Die Beschreibung muss für sich stehen: ein Agent sieht nichts als sie."
      >
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="task-title">Titel</FieldLabel>
            <Input
              id="task-title"
              value={draft.title}
              aria-invalid={Boolean(errors.title)}
              onChange={(event) => set({ title: event.target.value })}
            />
            <FieldError>{errors.title}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-description">Beschreibung</FieldLabel>
            <Textarea
              id="task-description"
              rows={8}
              placeholder="Ziel, Rahmenbedingungen, woran man merkt, dass es fertig ist."
              value={draft.description}
              aria-invalid={Boolean(errors.description)}
              onChange={(event) => set({ description: event.target.value })}
            />
            <FieldDescription>Der Planer liest diesen Text.</FieldDescription>
            <FieldError>{errors.description}</FieldError>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="task-priority-high">Priorität</FieldLabel>
            <ChoiceField
              id="task-priority"
              options={PRIORITY_OPTIONS}
              value={draft.priority}
              onChange={(priority) => set({ priority })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="task-project">Projekt</FieldLabel>
            <EntityCombobox
              id="task-project"
              options={projectOptions}
              value={draft.projectId}
              onChange={(projectId) => set({ projectId })}
              placeholder="Kein Projekt"
              emptyLabel="Kein Projekt gefunden"
            />
            <FieldDescription>
              Das Projekt entscheidet, in welchem Verzeichnis gearbeitet wird.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-assignee">Zuständig</FieldLabel>
            <EntityCombobox
              id="task-assignee"
              options={agentOptions}
              value={draft.assigneeId}
              onChange={(assigneeId) => set({ assigneeId })}
              placeholder="Noch offen"
              emptyLabel="Kein Agent gefunden"
            />
            <FieldDescription>
              Offen lassen ist normal: „Planen“ entscheidet, wer übernimmt.
            </FieldDescription>
          </Field>

          {editing && task ? (
            <Field>
              <FieldLabel htmlFor="task-status">Status</FieldLabel>
              <NativeSelect
                id="task-status"
                className="w-full"
                value={draft.status ?? ''}
                disabled={draft.status === null}
                onChange={(event) => set({ status: event.target.value as SettableTaskStatus })}
              >
                {draft.status === null ? (
                  <NativeSelectOption value="">{TASK_STATUS_LABEL[task.status]}</NativeSelectOption>
                ) : null}
                {SETTABLE_TASK_STATUS.map((status) => (
                  <NativeSelectOption key={status} value={status}>
                    {TASK_STATUS_LABEL[status]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {draft.status === null
                  ? 'Diesen Zustand setzt der Lauf selbst — von Hand gehen nur Offen, Fertig und Abgebrochen.'
                  : 'Geplant, Läuft und Fehlgeschlagen setzt der Planer bzw. der Lauf selbst.'}
              </FieldDescription>
            </Field>
          ) : null}
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
