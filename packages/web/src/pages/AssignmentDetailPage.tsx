import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { BanIcon, ListTodoIcon, SendIcon, TriangleAlertIcon, UserRoundIcon } from 'lucide-react';

import { api } from '@/lib/api';
import {
  ASSIGNMENT_STATUS_LABEL,
  REQUESTER_LABEL,
  formatDuration,
  relativeTime,
  shorten,
  timeAgo,
} from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { AssignmentDetail } from '@/lib/types';
import { useOrgState, useTasksState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';

import { PageBody } from '@/components/blocks/page-body';
import { StatCards, StatCardsSkeleton, type StatCardProps } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { MetaList, MetaListSkeleton } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { ResultCard } from '@/components/common/result-card';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { RunningBadge, StatusBadge } from '@/components/common/status-badge';
import { useRecord } from '@/hooks/useRecord';
import {
  ASSIGNMENT_COLUMN_LABELS,
  ASSIGNMENT_ROW_LABEL,
  ASSIGNMENT_SORTING,
  buildAssignmentColumns,
  toAssignmentRow,
} from '@/pages/AssignmentsPage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * One assignment: what was asked, who did it, what came back.
 *
 * The facts used to be a single muted line with `' · '` between them - seven
 * unlabelled fragments that could not be linked and stopped being readable at
 * the fourth. They are a two-column `MetaList` now, the four numbers a
 * `StatCards` row, and result, error and sub-assignments sit behind tabs
 * instead of stacking three cards down the page.
 *
 * Freshness comes from the socket, not from polling: `org.live[id]` carries
 * the newest word about this run, so the character count and the duration
 * move while it works, and the record is refetched exactly when the *status*
 * changes - which is the moment the payload gains a result, an error and a
 * duration the live view never had.
 */

type TabValue = 'ergebnis' | 'fehler' | 'weitergegeben';

export function AssignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrgState();
  const { tasks } = useTasksState();
  const { dialog, cancelAssignment } = useCancelAssignment();

  const [tab, setTab] = useState<TabValue>('ergebnis');

  /* ------------------------------ the record ----------------------------- */

  const {
    record: detail,
    loading,
    missing,
    error: loadError,
    reload,
  } = useRecord<AssignmentDetail>(id, api.assignment);

  const live = id ? org.live[id] : undefined;
  /**
   * The status the socket last reported. Only this drives the refetch: the
   * live view's object identity changes several times a second while a run
   * streams, and reloading on each of them is what made the old page flicker.
   * A change of status - above all `running` to an end state - is exactly when
   * the record gains something the socket does not carry.
   */
  const liveStatus = live?.status;
  useEffect(() => {
    if (liveStatus) void reload();
  }, [liveStatus, reload]);

  /* -------------------------------- actions ------------------------------ */

  const assignment = detail?.assignment ?? null;
  const status = liveStatus ?? assignment?.status;
  const open = status === 'pending' || status === 'running';

  const cancel = useCallback(async (): Promise<void> => {
    if (!id) return;
    await cancelAssignment(id);
  }, [cancelAssignment, id]);

  // The same question the stop button asks everywhere else - the child table
  // used to cancel a run without a word.
  const cancelChild = useCallback(
    (childId: string): void => {
      void cancelAssignment(childId);
    },
    [cancelAssignment],
  );

  /** The board task this run belongs to, when one points at it. */
  const task = useMemo(
    () => (id ? tasks.find((entry) => entry.assignmentId === id) : undefined),
    [id, tasks],
  );

  /* -------------------------------- header ------------------------------- */

  const title = assignment ? shorten(assignment.task, 60) : 'Auftrag';

  usePageMeta(
    {
      ...(assignment ? { title } : {}),
      breadcrumb: [{ label: 'Aufträge', to: '/assignments' }, { label: title }],
      actions: assignment ? (
        <>
          {open ? (
            <Button size="sm" variant="destructive" onClick={() => void cancel()}>
              <BanIcon data-icon="inline-start" />
              Abbrechen
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="Weitere Aktionen" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {task ? (
                <DropdownMenuItem asChild>
                  <NavLink to={'/tasks/' + task.id}>
                    <ListTodoIcon data-icon="inline-start" />
                    Zur Aufgabe
                  </NavLink>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <NavLink to={'/org/agents/' + assignment.agentId}>
                  <UserRoundIcon data-icon="inline-start" />
                  Agent öffnen
                </NavLink>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null,
    },
    [assignment?.id, open, task?.id, cancel, title],
  );

  /* -------------------------------- columns ------------------------------ */

  const childColumns = useMemo(
    () => buildAssignmentColumns({ selectable: false, onCancel: (row) => cancelChild(row.id) }),
    [cancelChild],
  );

  const childRows = useMemo(
    () =>
      (detail?.children ?? []).map((child) =>
        toAssignmentRow(child, org.agentById(child.agentId), org.live[child.id]),
      ),
    [detail?.children, org],
  );

  /* -------------------------------- states ------------------------------- */

  if (!assignment || !status) {
    if (loading) return <AssignmentDetailSkeleton />;
    return (
      <PageBody width="3xl">
        {loadError && !missing ? (
          <ServerOffline onRetry={() => void reload()} />
        ) : (
          <EmptyState
            icon={SendIcon}
            title="Diesen Auftrag gibt es nicht"
            description="Der Eintrag wurde gelöscht, oder die Adresse stimmt nicht."
            actionLabel="Zu den Aufträgen"
            actionTo="/assignments"
          />
        )}
      </PageBody>
    );
  }

  /* -------------------------------- numbers ------------------------------ */

  const agent = detail?.agent ?? org.agentById(assignment.agentId) ?? null;
  const project = org.projects.find((entry) => entry.id === assignment.projectId);
  const children = detail?.children ?? [];
  // The live view wins where it has something to say: while a run streams, its
  // character count and duration are newer than the stored row.
  const chars = live?.chars ?? assignment.chars;
  const durationMs = live?.durationMs ?? assignment.durationMs;
  const error = assignment.error ?? live?.error;
  const result = assignment.result ?? '';

  const cards: StatCardProps[] = [
    {
      label: 'Status',
      value: ASSIGNMENT_STATUS_LABEL[status],
      ...(open ? { badge: <RunningBadge count={1} /> } : {}),
      headline: agent ? agent.name + ' führt aus' : 'Agent unbekannt',
      footnote: 'Angelegt ' + timeAgo(assignment.createdAt),
    },
    {
      label: 'Dauer',
      value: formatDuration(durationMs) || '–',
      headline:
        open && assignment.startedAt
          ? 'Läuft seit ' + relativeTime(assignment.startedAt)
          : durationMs
            ? 'Vom Start bis zur Antwort'
            : 'Noch nicht gelaufen',
      footnote: assignment.startedAt
        ? 'Start ' + formatDateTime(assignment.startedAt)
        : 'Kein Startzeitpunkt',
    },
    {
      label: 'Zeichen',
      value: chars > 0 ? formatNumber(chars) : '–',
      headline: chars > 0 ? 'Länge der Antwort' : 'Noch nichts geschrieben',
      // Not a hedge but the plain truth: the assignment row carries `chars`
      // and nothing else - no tokens, no cost (see serverGaps).
      footnote: 'Der Server zählt Zeichen, keine Tokens',
    },
    {
      label: 'Weitergegeben',
      value: formatNumber(children.length),
      headline: children.length === 0 ? 'Alles selbst erledigt' : 'Unteraufträge an andere Agenten',
      footnote: 'Direkt aus diesem Auftrag heraus',
    },
  ];

  return (
    <PageBody width="3xl">
      {dialog}

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind="assignment" status={status} />
        {agent ? (
          <Badge variant="outline" className="font-mono font-normal">
            {agent.slug}
          </Badge>
        ) : null}
        {assignment.depth > 0 ? (
          <Badge variant="secondary" className="tabular-nums">
            Ebene {assignment.depth}
          </Badge>
        ) : null}
      </div>

      <p className="text-base leading-snug whitespace-pre-wrap">{assignment.task}</p>

      <MetaList
        columns={2}
        items={[
          {
            label: 'Agent',
            value: agent?.name ?? 'Unbekannt',
            ...(agent ? { to: '/org/agents/' + agent.id } : {}),
          },
          {
            label: 'Anbieter',
            value: (
              <ProviderCell
                layout="inline"
                showModel={false}
                {...(assignment.provider ? { provider: assignment.provider } : {})}
              />
            ),
          },
          { label: 'Modell', value: assignment.model ?? 'Standardmodell', mono: true },
          { label: 'Projekt', value: project?.name ?? 'Kein Projekt' },
          { label: 'Ebene', value: assignment.depth > 0 ? String(assignment.depth) : 'Direkt' },
          {
            label: 'Angefordert von',
            value:
              REQUESTER_LABEL[assignment.requesterKind] +
              (assignment.requesterAgentId
                ? ' · ' + (org.agentById(assignment.requesterAgentId)?.name ?? 'Unbekannt')
                : ''),
          },
          { label: 'Angelegt', value: formatDateTime(assignment.createdAt) },
          { label: 'Gestartet', value: assignment.startedAt ? formatDateTime(assignment.startedAt) : null },
          { label: 'Beendet', value: assignment.finishedAt ? formatDateTime(assignment.finishedAt) : null },
        ]}
      />

      {/* The stat row brings its own `px-4 lg:px-6`, which would sit on top of
          the measure's padding and shift the cards against everything else. */}
      <StatCards items={cards} className="px-0 lg:px-0" />

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <TabsList>
          <TabsTrigger value="ergebnis">Ergebnis</TabsTrigger>
          {error ? (
            <TabsTrigger value="fehler">
              Fehler
              <Badge variant="destructive">1</Badge>
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="weitergegeben">
            Weitergegeben
            {children.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {children.length}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ergebnis" className="mt-4">
          {result ? (
            <ResultCard
              text={result}
              description="Was der Agent am Ende des Laufs zurückgegeben hat."
            />
          ) : (
            <EmptyState
              icon={SendIcon}
              title="Noch kein Ergebnis"
              description={
                open
                  ? 'Der Auftrag läuft noch. Sobald der Agent fertig ist, steht die Antwort hier.'
                  : 'Dieser Auftrag hat keine Antwort hinterlassen.'
              }
              variant="outline"
              size="sm"
            />
          )}
        </TabsContent>

        {error ? (
          <TabsContent value="fehler" className="mt-4">
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Der Auftrag ist gescheitert</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            </Alert>
          </TabsContent>
        ) : null}

        <TabsContent value="weitergegeben" className="mt-4">
          <DataTable
            flush
            idPrefix="auftrag-kinder"
            data={childRows}
            columns={childColumns}
            getRowId={(row) => row.id}
            searchable
            searchPlaceholder="Aufträge durchsuchen"
            searchText={(row) => row.task}
            initialSorting={ASSIGNMENT_SORTING}
            paginate={false}
            columnLabels={ASSIGNMENT_COLUMN_LABELS}
            rowLabel={ASSIGNMENT_ROW_LABEL}
            empty={
              <EmptyState
                icon={SendIcon}
                title="Dieser Auftrag wurde nicht weitergegeben"
                description="Ein Agent kann Teile seiner Arbeit an andere abgeben; dieser hat alles selbst erledigt."
                variant="plain"
                size="sm"
              />
            }
          />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

/* ---------------------------------- parts --------------------------------- */

/** The loading state in the geometry the loaded page will have. */
function AssignmentDetailSkeleton() {
  return (
    <PageBody width="3xl">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-6 w-full max-w-xl" />

      <MetaListSkeleton rows={6} />
      <StatCardsSkeleton />

      <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </PageBody>
  );
}
