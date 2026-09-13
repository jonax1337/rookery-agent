import { useCallback, useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  MessagesSquareIcon,
  PencilIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { relativeTime, shorten } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Project, Session } from '@/lib/types';
import { useAllSessions } from '@/hooks/useAllSessions';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useConnection, useOrgState } from '@/providers/rookery-provider';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RelatedItem } from '@/components/common/related-item';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemGroup } from '@/components/ui/item';

/**
 * What the company works on, and where on disk it happens.
 *
 * Two facts that exist in the database and were rendered nowhere until now:
 * a project's description, and how many conversations are filed under it. The
 * second one is the reason this tab loads the conversation list - there is no
 * count endpoint, so the number is counted over the loaded conversations and
 * the page says so whenever that list sits on its ceiling.
 *
 * The directory gets the mono face and a copy button, because a path is
 * something people paste into a terminal rather than read.
 *
 * Archived projects are not shown: `GET /api/org` calls `listProjects(orgId)`,
 * which filters `archived = 0`, and nothing hands the archived ones back. So
 * there is no status column and no way to reactivate from here - archiving
 * makes the row disappear, and the confirmation says so before it happens.
 */

const column = createRookeryColumnHelper<Project>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  path: 'Directory',
  sessions: 'Conversations',
  actions: 'Actions',
};

/** How many conversations the drawer lists. A glance, not the archive. */
const DRAWER_SESSIONS = 5;

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

  /** Conversations per project id, counted once per list change. */
  const byProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions.sessions) {
      if (!session.projectId) continue;
      const list = map.get(session.projectId);
      if (list) list.push(session);
      else map.set(session.projectId, [session]);
    }
    return map;
  }, [sessions.sessions]);

  /* -------------------------------- actions ------------------------------- */

  const archive = useCallback(
    async (project: Project): Promise<void> => {
      const conversations = byProject.get(project.id)?.length ?? 0;
      const ok = await confirm({
        title: project.name + ' archive?',
        description:
          'The project will disappear from this list and all selection fields — the server ' +
          'no longer returns archived projects, so it cannot be reactivated here. ' +
          '' +
          (conversations > 0
            ? formatNumber(conversations) +
              (conversations === 1 ? ' conversation remains' : ' conversations remain') +
              ' linked to it.'
            : 'No loaded conversations are associated with it.'),
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
    [byProject, confirm, org],
  );

  const remove = useCallback(
    async (project: Project): Promise<void> => {
      const conversations = byProject.get(project.id)?.length ?? 0;
      const ok = await confirm({
        title: project.name + ' delete?',
        description:
          'The entry will be deleted. The directory on disk remains untouched. ' +
          (conversations > 0
            ? formatNumber(conversations) +
              (conversations === 1 ? ' conversation will lose' : ' conversations will lose') +
              ' its project association.'
            : 'No loaded conversations are associated with it.'),
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
    [byProject, confirm, org],
  );

  /* -------------------------------- columns ------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<Project>({ rowLabel: (project) => project.name + ' selected' }),

        column.accessor('name', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
          cell: ({ row }) => (
            <DetailDrawerTrigger
              className="font-medium"
              onClick={() => setDrawerId(row.original.id)}
            >
              {row.original.name}
            </DetailDrawerTrigger>
          ),
          enableHiding: false,
        }),

        column.accessor((project) => project.description ?? '', {
          id: 'description',
          header: ({ column: head }) => (
            <DataTableColumnHeader column={head} title="Description" />
          ),
          cell: ({ row }) =>
            row.original.description ? (
              <span className="line-clamp-1 max-w-[28rem] text-muted-foreground">
                {row.original.description}
              </span>
            ) : (
              emptyCell()
            ),
        }),

        column.accessor((project) => project.path ?? '', {
          id: 'path',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Directory" />,
          cell: ({ row }) => <PathCell path={row.original.path ?? null} />,
        }),

        column.accessor((project) => byProject.get(project.id)?.length ?? 0, {
          id: 'sessions',
          header: ({ column: head }) => (
            <DataTableColumnHeader column={head} title="Conversations" align="end" />
          ),
          cell: ({ row }) => {
            const count = byProject.get(row.original.id)?.length ?? 0;
            return (
              <span className="block text-right tabular-nums text-muted-foreground">
                {sessions.loading ? '…' : formatNumber(count)}
              </span>
            );
          },
        }),

        actionsColumn<Project>((project) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + project.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setDrawerId(project.id)}>
                <SquareArrowOutUpRightIcon />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to={'/org/projects/' + project.id + '/edit'}>
                  <PencilIcon />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void archive(project)}>
                <ArchiveIcon />
                Archive
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(project)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [archive, byProject, remove, sessions.loading],
  );

  const drawerProject = org.projects.find((project) => project.id === drawerId) ?? null;

  return (
    <>
      {dialog}
      {bulk.dialog}

      <DataTable
        data={org.projects}
        columns={columns}
        getRowId={(project) => project.id}
        idPrefix="projekte"
        onRowClick={(project) => setDrawerId(project.id)}
        rowClickIgnoreColumns={['select', 'name', 'path', 'actions']}
        searchable
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search projects"
        searchText={(project) =>
          project.name + ' ' + (project.description ?? '') + ' ' + (project.path ?? '')
        }
        columnLabels={COLUMN_LABELS}
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
                  'The entries will be deleted; the directories on disk remain ' +
                  'untouched.',
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
            description="A project gives assignments a working directory and organizes conversations. Without a project, everything runs in the shared workspace."
            actionLabel="Create project"
            actionTo="/org/projects/new"
            variant="plain"
          />
        }
        filteredEmpty={
          <NoResults
            {...(search.trim() ? { query: search.trim() } : {})}
            onReset={() => setSearch('')}
          />
        }
      />

      <ProjectDrawer
        project={drawerProject}
        sessions={drawerProject ? (byProject.get(drawerProject.id) ?? []) : []}
        capped={sessions.capped}
        limit={sessions.limit}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
      />
    </>
  );
}

/* -------------------------------- the path -------------------------------- */

/**
 * The working directory, in the mono face, with a copy button.
 *
 * A project without a path is not missing anything - its assignments run in
 * the shared workspace - so it says that rather than showing an empty cell.
 */
function PathCell({ path }: { path: string | null }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  if (!path) return <span className="text-muted-foreground">Workspace</span>;

  return (
    <div className="flex min-w-0 max-w-[22rem] items-center gap-1">
      <span className="truncate font-mono text-xs" title={path}>
        {path}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        aria-label="Copy directory"
        onClick={() => copyToClipboard(path)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/* --------------------------------- drawer --------------------------------- */

interface ProjectDrawerProps {
  project: Project | null;
  sessions: readonly Session[];
  capped: boolean;
  limit: number;
  onOpenChange(open: boolean): void;
}

function ProjectDrawer({ project, sessions, capped, limit, onOpenChange }: ProjectDrawerProps) {
  // Newest first, so "die letzten fünf" means the last five.
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DRAWER_SESSIONS),
    [sessions],
  );

  return (
    <DetailDrawer
      open={project !== null}
      onOpenChange={onOpenChange}
      title={project?.name ?? 'Project'}
      description={project?.description || 'No description provided.'}
      footer={
        project ? (
          <Button asChild>
            <NavLink to={'/org/projects/' + project.id + '/edit'}>Edit</NavLink>
          </Button>
        ) : null
      }
    >
      {project ? (
        <>
          <MetaList
            columns={1}
            items={[
              {
                label: 'Directory',
                value: project.path ?? 'Workspace',
                icon: FolderOpenIcon,
                mono: Boolean(project.path),
              },
              {
                label: 'Conversations',
                value: formatNumber(sessions.length),
                icon: MessagesSquareIcon,
              },
              {
                label: 'Basis',
                value: capped
                  ? 'counted across ' +
                    formatNumber(limit) +
                    ' loaded conversations — the server does not return more'
                  : null,
              },
              { label: 'Created', value: formatDateTime(project.createdAt) },
              { label: 'Last updated', value: formatDateTime(project.updatedAt) },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium">Last discussed</h3>
            {recent.length === 0 ? (
              <EmptyState
                icon={MessagesSquareIcon}
                title="No conversations for this project yet"
                description="Assign a conversation to this project using the project selector in the composer."
                actionLabel="View conversations"
                actionTo="/chats"
                variant="plain"
                size="sm"
              />
            ) : (
              <ItemGroup className="gap-2">
                {recent.map((session) => (
                  <RelatedItem
                    key={session.id}
                    to={'/c/' + session.id}
                    title={shorten(session.title, 70)}
                    description={
                      relativeTime(session.updatedAt) +
                      ' · ' +
                      formatNumber(session.messageCount) +
                      ' ' +
                      (session.messageCount === 1 ? 'Message' : 'Messages')
                    }
                  />
                ))}
              </ItemGroup>
            )}
          </div>
        </>
      ) : null}
    </DetailDrawer>
  );
}
