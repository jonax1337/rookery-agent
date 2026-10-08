import { useState } from 'react';

import { DetailDrawer, useDrawerSubject } from '@/components/blocks/detail-drawer';
import { FilterCombobox } from '@/components/common/filter-combobox';
import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { FormField } from '@/components/forms/form-kit';
import { DeleteIcon, ExternalLinkIcon, RotateCcwIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { failureMessage } from '@/lib/errors';
import { formatDateTime, NO_PROJECT, SESSION_KIND_LABEL, UNTITLED_SESSION } from '@/lib/format';
import { SESSION_TITLE_MAX, sessionTitleSchema } from '@/lib/session';
import { formatNumber } from '@/lib/stats';
import type { Session } from '@/lib/types';
import { projectNameOf, projectOptions, type ProjectSummary } from './project-options';

interface ConversationDrawerProps {
  session: Session | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opened through "Rename": the title field takes the caret. */
  focusTitle: boolean;
  projects: readonly ProjectSummary[];
  onRename(id: string, title: string): Promise<unknown>;
  onProject(session: Session, value: string): void;
  onOpen(session: Session): void;
  onReset(session: Session): void;
  onDelete(session: Session): void;
}

/**
 * One conversation, in the block's row sheet.
 *
 * The original's demo chart is gone: a single conversation has no time series
 * anywhere in this API, and six invented months in the header of a real
 * record would be the most convincing lie on the page.
 */
export function ConversationDrawer({
  session: chosen,
  open,
  onOpenChange,
  focusTitle,
  projects,
  onRename,
  onProject,
  onOpen,
  onReset,
  onDelete,
}: ConversationDrawerProps) {
  // The row stays until the drawer has closed; otherwise the content would
  // vanish in the same frame and the closing motion would be lost.
  const session = useDrawerSubject(chosen);

  // Only reached before any row was ever chosen - nothing to animate then.
  if (!session) return null;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={session.title || UNTITLED_SESSION}
      description={describeSession(session)}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onOpen(session)}>
            <ExternalLinkIcon data-icon="inline-start" />
            {session.kind === 'voice' ? 'Open transcript' : 'Open'}
          </Button>
          <Button variant="outline" onClick={() => onReset(session)}>
            <RotateCcwIcon data-icon="inline-start" />
            Reset
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => onDelete(session)}>
            <DeleteIcon data-icon="inline-start" />
            Delete
          </Button>
        </div>
      }
    >
      <FieldGroup className="gap-4">
        {/* Keyed on the id: a socket refresh while the field is being typed in
            must not pull the caret back to the stored title. */}
        <ConversationTitleField
          key={session.id}
          session={session}
          autoFocus={focusTitle}
          onRename={onRename}
        />
        <ConversationProjectField
          session={session}
          projects={projects}
          onProject={(value) => onProject(session, value)}
        />
      </FieldGroup>

      <SessionMeta session={session} projectName={projectNameOf(projects, session.projectId)} />
    </DetailDrawer>
  );
}

function describeSession(session: Session): string {
  return (
    'Created on ' +
    formatDateTime(session.createdAt) +
    ' · ' +
    formatNumber(session.messageCount) +
    (session.messageCount === 1 ? ' message' : ' messages')
  );
}

interface ConversationTitleFieldProps {
  session: Session;
  autoFocus: boolean;
  onRename(id: string, title: string): Promise<unknown>;
}

/** The title input: saves on blur or Enter, and says why when the title is refused. */
function ConversationTitleField({ session, autoFocus, onRename }: ConversationTitleFieldProps) {
  const [title, setTitle] = useState(session.title);
  const [error, setError] = useState<string | null>(null);

  async function commitTitle(): Promise<void> {
    // Same rule as the chat's rename dialog: this field used to accept titles
    // the other surface would have rejected.
    const parsed = sessionTitleSchema.safeParse({ title });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'A conversation needs a title.');
      if (!title.trim()) setTitle(session.title);
      return;
    }
    const next = parsed.data.title;
    if (next === session.title) return;
    try {
      await onRename(session.id, next);
      setError(null);
    } catch (caught) {
      // Said out loud, with the typed text left standing, rather than the
      // old title silently returning.
      setError(failureMessage(caught));
    }
  }

  // FormField attaches the message to the input via `aria-describedby`:
  // `role="alert"` reads it out once, after which nobody who jumped back
  // into the rejected field would find it.
  return (
    <FormField id="conversation-title" label="Title" error={error}>
      {(control) => (
        <Input
          {...control}
          value={title}
          autoFocus={autoFocus}
          maxLength={SESSION_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commitTitle();
            }
          }}
        />
      )}
    </FormField>
  );
}

interface ConversationProjectFieldProps {
  session: Session;
  projects: readonly ProjectSummary[];
  onProject(value: string): void;
}

function ConversationProjectField({ session, projects, onProject }: ConversationProjectFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor="conversation-project">Project</FieldLabel>
      <FilterCombobox
        id="conversation-project"
        label="Project"
        value={session.projectId ?? NO_PROJECT}
        onChange={(next) => onProject(next ?? NO_PROJECT)}
        showClear={false}
        className="w-full"
        options={projectOptions(projects, session.projectId)}
      />
    </Field>
  );
}

function SessionMeta({
  session,
  projectName,
}: {
  session: Session;
  projectName: string | undefined;
}) {
  return (
    <MetaList
      columns={1}
      items={[
        { label: 'Type', value: SESSION_KIND_LABEL[session.kind] },
        {
          label: 'Provider & Model',
          value: (
            <ProviderCell
              provider={session.provider}
              {...(session.model ? { model: session.model } : {})}
              layout="inline"
              fallback="Default"
            />
          ),
        },
        { label: 'Project', value: projectName ?? 'No project' },
        { label: 'Directory', value: session.cwd, mono: true },
        { label: 'Messages', value: formatNumber(session.messageCount) },
        { label: 'Created', value: formatDateTime(session.createdAt) },
        { label: 'Last active', value: formatDateTime(session.updatedAt) },
        { label: 'Archived', value: session.archived ? 'Archived' : null },
        {
          label: 'Provider session',
          value: session.providerSessionId ?? null,
          mono: true,
        },
      ]}
    />
  );
}
