import { useCallback, useEffect, useId } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FolderIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type ProjectInput, type ProjectPatch } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Project } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import {
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * A project: a name for a body of work, and the directory its assignments
 * run in.
 *
 * There is no existence check for that directory anywhere on the server, so
 * this page does not pretend to have one - no "Prüfen" button, no green tick.
 * It says what an empty field means and leaves the truth to the first
 * assignment.
 */

interface ProjectDraft {
  name: string;
  description: string;
  path: string;
  archived: boolean;
}

const EMPTY: ProjectDraft = { name: '', description: '', path: '', archived: false };

const schema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
});

function draftOf(project: Project): ProjectDraft {
  return {
    name: project.name,
    description: project.description ?? '',
    path: project.path ?? '',
    archived: project.archived,
  };
}

function buildPatch(draft: ProjectDraft): ProjectPatch {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    path: draft.path.trim() || null,
    archived: draft.archived,
  };
}

function toInput(patch: ProjectPatch): ProjectInput {
  return {
    name: patch.name ?? '',
    ...(patch.description ? { description: patch.description } : {}),
    ...(patch.path ? { path: patch.path } : {}),
  };
}

export function ProjectFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();

  const editing = Boolean(id);
  const project = org.projects.find((entry) => entry.id === id);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<ProjectDraft>(EMPTY);

  useEffect(() => {
    if (!project) return;
    hydrate(project.id, () => draftOf(project));
  }, [hydrate, project]);

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    if (editing && id) await api.updateProject(id, patch);
    else await api.createProject(toInput(patch));
    markSaved();
    await org.refresh();
    toast(editing ? 'Project saved' : 'Project created');
    void navigate('/org/projects');
  });

  const remove = useCallback(async (): Promise<void> => {
    if (!id || !project) return;
    const ok = await confirm({
      title: 'Delete project?',
      description:
        'The project “' +
        project.name +
        '” will disappear from all selection lists. Associated conversations and assignments will remain, but will no longer have a project.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(id);
      await org.refresh();
      toast('Project deleted', { description: project.name });
      void navigate('/org/projects');
    } catch (caught) {
      reportFailure('Delete', caught);
    }
  }, [confirm, id, navigate, org, project]);

  const leaf = editing ? (project?.name ?? 'Edit project') : 'Create project';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Organization', to: '/org/projects' },
        { label: 'Projects', to: '/org/projects' },
        { label: leaf },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/org/projects"
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            editing
              ? [
                  {
                    label: 'Project delete',
                    icon: Trash2Icon,
                    destructive: true,
                    onSelect: () => void remove(),
                  },
                ]
              : []
          }
        />
      ),
    },
    [dirty, editing, formId, remove, saving],
  );

  if (editing && !project && !org.loading) {
    return (
      <PageBody width="2xl">
        <EmptyState
          icon={FolderIcon}
          title="This project no longer exists"
          description="It was deleted or never existed."
          actionLabel="View projects"
          actionTo="/org/projects"
        />
      </PageBody>
    );
  }

  if (editing && !project) {
    return (
      <PageBody width="2xl">
        <FormFieldsSkeleton fields={3} />
      </PageBody>
    );
  }

  return (
    <PageBody width="2xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description="A project groups conversations and assignments and defines the directory where work happens."
      >
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => set({ name: event.target.value })}
            />
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="project-description">Description</FieldLabel>
            <Textarea
              id="project-description"
              rows={3}
              placeholder="What this project is about."
              value={draft.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="project-path">Directory</FieldLabel>
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <FolderIcon />
              </InputGroupAddon>
              <InputGroupInput
                id="project-path"
                className="font-mono"
                placeholder="E:\DEV\my-project"
                value={draft.path}
                onChange={(event) => set({ path: event.target.value })}
              />
            </InputGroup>
            <FieldDescription>
              Leave empty to use the Rookery workspace. The path is checked only when an assignment
              first runs.
            </FieldDescription>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          {/*
            Im Neu-Modus abgeschaltet statt ausgeblendet: eine Feldzahl, die
            sich zwischen Create und Edit ändert, liest sich wie ein
            anderes Formular.
          */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Archived</FieldTitle>
              <FieldDescription>
                {editing
                  ? 'Archived projects disappear from selection lists but remain linked to their assignments.'
                  : 'A new project is always active. You can archive it later.'}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="project-archived"
              checked={draft.archived}
              disabled={!editing}
              onCheckedChange={(archived) => set({ archived })}
            />
          </Field>
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
