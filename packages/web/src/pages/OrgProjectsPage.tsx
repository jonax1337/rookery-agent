import { useCallback, useMemo, useState } from 'react';

import { ArchiveIcon, DeleteIcon as Trash2Icon, FolderOpenIcon as FolderIcon } from '@/components/icons';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { groupBy } from '@/lib/group-by';
import { formatNumber } from '@/lib/stats';
import type { Project } from '@/lib/types';
import { useAllSessions } from '@/hooks/useAllSessions';
import { useConnection, useOrgState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { ProjectDrawer } from './org/ProjectDrawer';
import { PROJECT_COLUMN_LABELS, projectColumns } from './org/project-columns';

/**
 * What the company works on, and where on disk it happens.
 *
 * Two facts that exist in the database and are rendered nowhere else: a
 * project's description, and how many conversations are filed under it. The
 * second one is the reason this tab loads the conversation list - there is no
 * count endpoint, so the number is counted over the loaded conversations and
 * the page says so whenever that list sits on its ceiling.
 *
 * Archived projects are not shown: `GET /api/org` calls `listProjects(orgId)`,
 * which filters `archived = 0`, and nothing hands the archived ones back. So
 * there is no status column and no way to reactivate from here - archiving
 * makes the row disappear, and the confirmation says so before it happens.
 */
export function OrgProjectsPage() {
  const org = useOrgState();
  const { socket } = useConnection();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  // The conversation counts have no endpoint of their own; this is the same
  // single request `/chats` makes, and it is capped at 500 by the server.
  const sessions = useAllSessions(socket);

  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const sessionsByProject = useMemo(
    () => groupBy(sessions.sessions, (session) => session.projectId),
    [sessions.sessions],
  );

  const conversationsOf = useCallback(
    (project: Project) => sessionsByProject.get(project.id)?.length ?? 0,
    [sessionsByProject],
  );

  const archive = useCallback(
    async (project: Project): Promise<void> => {
      const ok = await confirm({
        title: 'Archive ' + project.name + '?',
        description:
          'The project will disappear from this list and all selection fields — the server ' +
          'no longer returns archived projects, so it cannot be reactivated here. ' +
          describeConversations(conversationsOf(project), {
            one: 'conversation remains linked to it.',
            many: 'conversations remain linked to it.',
          }),
        confirmLabel: 'Archive',
        destructive: true,
        icon: ArchiveIcon,
      });
      if (!ok) return;

      try {
        await api.updateProject(project.id, { archived: true });
        await org.refresh();
        toast(project.name + ' archived');
      } catch (caught) {
        reportFailure('Archive', caught);
      }
    },
    [conversationsOf, confirm, org],
  );

  const remove = useCallback(
    async (project: Project): Promise<void> => {
      const ok = await confirm({
        title: 'Delete ' + project.name + '?',
        description:
          'The entry will be deleted. The directory on disk remains untouched. ' +
          describeConversations(conversationsOf(project), {
            one: 'conversation will lose its project association.',
            many: 'conversations will lose their project association.',
          }),
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;

      try {
        await api.deleteProject(project.id);
        await org.refresh();
        toast(project.name + ' deleted');
      } catch (caught) {
        reportFailure('Delete', caught);
      }
    },
    [conversationsOf, confirm, org],
  );

  const columns = useMemo(
    () =>
      projectColumns({
        sessionsByProject,
        sessionsLoading: sessions.loading,
        onOpen: (project) => setDrawerId(project.id),
        onArchive: (project) => void archive(project),
        onDelete: (project) => void remove(project),
      }),
    [archive, remove, sessions.loading, sessionsByProject],
  );

  const drawerProject = org.projects.find((project) => project.id === drawerId) ?? null;

  return (
    <>
      {dialog}
      {bulk.dialog}

      <Fade>
        <DataTable
          data={org.projects}
          columns={columns}
          getRowId={(project) => project.id}
          idPrefix="projects"
          onRowClick={(project) => setDrawerId(project.id)}
          rowClickIgnoreColumns={['select', 'name', 'path', 'actions']}
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search projects"
          searchText={(project) =>
            project.name + ' ' + (project.description ?? '') + ' ' + (project.path ?? '')
          }
          columnLabels={PROJECT_COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Project', plural: 'projects' }}
          loading={org.loading && org.projects.length === 0}
          error={org.error ? <ServerOffline onRetry={() => void org.refresh()} /> : undefined}
          filters={
            // The conversation column rests on a capped list; when the cap bites,
            // the number is a lower bound and the table has to admit it.
            sessions.capped ? (
              <Badge variant="outline">
                Conversations: based on {formatNumber(sessions.limit)} loaded conversations
              </Badge>
            ) : undefined
          }
          bulkActions={(selected, clear) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void bulk.run({
                  rows: selected,
                  noun: { singular: 'Project', plural: 'Projects' },
                  nameOf: (project) => project.name,
                  verb: 'delete',
                  done: 'deleted',
                  confirmLabel: 'Delete',
                  description:
                    'The entries will be deleted; the directories on disk remain untouched.',
                  run: (project) => api.deleteProject(project.id),
                  after: org.refresh,
                  clear,
                })
              }
            >
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
          )}
          empty={
            <EmptyState
              icon={FolderIcon}
              title="No projects yet"
              description="A project gives work a directory and organizes conversations. Without a project, everything runs in the shared workspace."
              actionLabel="Create project"
              actionTo="/org/projects/new"
              variant="plain"
            />
          }
          filteredEmpty={
            <NoResults query={search.trim() || undefined} onReset={() => setSearch('')} />
          }
        />
      </Fade>

      <ProjectDrawer
        project={drawerProject}
        sessions={drawerProject ? (sessionsByProject.get(drawerProject.id) ?? []) : []}
        capped={sessions.capped}
        limit={sessions.limit}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
      />
    </>
  );
}

/** "3 conversations remain linked to it." - or the sentence for when none are loaded. */
function describeConversations(count: number, outcome: { one: string; many: string }): string {
  if (count === 0) return 'No loaded conversations are associated with it.';
  return formatNumber(count) + ' ' + (count === 1 ? outcome.one : outcome.many);
}
