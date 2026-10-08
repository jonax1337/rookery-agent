import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { PageBody } from '@/components/blocks/page-body';
import { ServerOffline } from '@/components/common/empty-state';
import {
  buildSessionColumns,
  SESSION_COLUMN_LABELS,
  SESSION_SORTING,
} from '@/components/common/session-columns';
import { DeleteIcon } from '@/components/icons';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import { useConversationActions } from '@/hooks/useConversationActions';
import { useConversationFilters } from '@/hooks/useConversationFilters';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import {
  CONVERSATION_TAB_LABEL,
  CONVERSATION_TABS,
  filterSessions,
  searchTextOf,
  tabCounts,
} from '@/lib/conversation-filters';
import type { Session } from '@/lib/types';
import {
  useAllSessionsState,
  useChatSession,
  useConfig,
  useConnection,
  useOrgState,
} from '@/providers/rookery-provider';
import { ConversationDrawer } from './conversations/ConversationDrawer';
import {
  NoConversationsYet,
  NoMatchingConversations,
} from './conversations/ConversationEmptyStates';
import { ConversationFilterControls } from './conversations/ConversationFilterControls';
import { ConversationHeaderActions } from './conversations/ConversationHeaderActions';
import { ConversationRowMenu } from './conversations/ConversationRowMenu';
import { ConversationStatCards } from './conversations/ConversationStatCards';
import { projectNameOf } from './conversations/project-options';

/**
 * Every conversation there is - the assistant's and the agents', written and
 * spoken, filed and archived.
 *
 * This is the page the thread list left the sidebar for. The sidebar could
 * only ever show a title and a date, one counterpart at a time, and it grew
 * until it was the tallest thing in the app; the table below is what a list
 * of conversations actually needs: facets, a search, who it is with, how long
 * it got, when it last moved, and every action a conversation has.
 *
 * One request carries the whole page (`useAllSessions`), because there is no
 * server-side paging: facets, comboboxes and the period select are pure
 * client filters over that one list, so switching a tab keeps sorting, column
 * visibility and page size standing instead of refetching a different slice.
 *
 * The columns themselves come from `buildSessionColumns`, shared with the
 * dashboard, which shows the same records.
 */
export function ConversationsPage() {
  const navigate = useNavigate();
  const { socket } = useConnection();
  const { assistantName } = useConfig();
  const org = useOrgState();
  const { openConversation, newConversation } = useChatSession();

  // The one shared list from the provider, archive included - the tabs decide
  // which rows are on screen. Sharing it is what lets a deletion here move
  // the rail's badge, and what keeps `/chats` down to one request.
  const { sessions, loading, error, capped, refresh, sessionById } = useAllSessionsState();

  // The real counts, from the one aggregate call in this API. Shared with the
  // other lists, so the same tile is equally current wherever it stands.
  const totals = useStatsTotals(socket);

  const filters = useConversationFilters();
  const { tab, project, period } = filters;
  const counts = useMemo(() => tabCounts(sessions), [sessions]);
  const rows = useMemo(
    () => filterSessions(sessions, { tab, project, period }),
    [sessions, tab, project, period],
  );

  const [detailId, setDetailId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const detail = sessionById(detailId ?? undefined) ?? null;

  const closeDetailOf = useCallback(
    (id: string) => setDetailId((current) => (current === id ? null : current)),
    [],
  );
  const {
    assignProject,
    setArchived,
    rename,
    confirmReset,
    confirmDelete,
    deleteSelected,
    confirmDialog,
    bulkDialog,
  } = useConversationActions(closeDetailOf);

  // A spoken conversation opens as what it is: a transcript. Sending it
  // straight back into the microphone is the one thing the reader did not ask
  // for - continuing it hands-free is a separate entry in the row menu.
  const open = useCallback(
    (session: Session) => openConversation(session.id),
    [openConversation],
  );

  const showDetail = useCallback((session: Session) => {
    setRenaming(false);
    setDetailId(session.id);
  }, []);

  const showDetailForRename = useCallback((session: Session) => {
    setRenaming(true);
    setDetailId(session.id);
  }, []);

  const columns = useMemo(
    () =>
      buildSessionColumns({
        selectable: true,
        showProvider: true,
        onOpenDetail: showDetail,
        projectName: (session) => projectNameOf(org.projects, session.projectId) ?? '',
        rowActions: (session) => (
          <ConversationRowMenu
            session={session}
            projects={org.projects}
            onOpen={() => open(session)}
            onRename={() => showDetailForRename(session)}
            onProject={(value) => assignProject(session, value)}
            onVoice={() => void navigate('/voice?session=' + session.id)}
            onArchive={(archived) => setArchived(session, archived)}
            onReset={() => void confirmReset(session)}
            onDelete={() => void confirmDelete(session)}
          />
        ),
      }),
    [
      assignProject,
      confirmDelete,
      confirmReset,
      navigate,
      open,
      org.projects,
      setArchived,
      showDetail,
      showDetailForRename,
    ],
  );

  // One crumb, like every other top-level list: the dashboard gave up its
  // own "Rookery" root, and a single page carrying one would be the outlier.
  usePageMeta({
    breadcrumb: [{ label: 'Conversations' }],
    actions: <ConversationHeaderActions onNewConversation={newConversation} />,
  });

  return (
    <PageBody>
      {confirmDialog}
      {bulkDialog}

      <ConversationStatCards sessions={sessions} loading={loading} capped={capped} totals={totals} />

      {/*
        No chart. "Conversations per day" would need a window the table does not
        have and would say less than the first row of it - and the table is
        what this page is for.
      */}

      {/* Only the container moves: a list animates as a whole, never row by row. */}
      <Fade delay={50}>
        <DataTable<Session>
          data={rows}
          columns={columns}
          getRowId={(session) => session.id}
          idPrefix="gespraeche"
          tabLabel="Tab"
          tabs={CONVERSATION_TABS.map((value) => ({
            value,
            label: CONVERSATION_TAB_LABEL[value],
            count: counts[value],
          }))}
          tab={tab}
          onTabChange={filters.setTab}
          searchable
          search={filters.search}
          onSearchChange={filters.setSearch}
          searchPlaceholder="Search conversations"
          searchText={(session) => searchTextOf(session, assistantName)}
          filters={
            <ConversationFilterControls
              project={project}
              period={period}
              projects={org.projects}
              onProjectChange={filters.setProject}
              onPeriodChange={filters.setPeriod}
            />
          }
          /*
            No primary action in the toolbar: "New conversation" lives in the
            page header. The second button was not just a duplicate, it pushed
            the toolbar into a second row at 1440 px.
          */
          columnLabels={SESSION_COLUMN_LABELS}
          initialColumnVisibility={{ projekt: false }}
          initialSorting={SESSION_SORTING}
          groupTime={(session) => session.updatedAt}
          groupSortId="zuletzt"
          bulkActions={(selected, clear) => (
            <Button variant="outline" size="sm" onClick={() => void deleteSelected(selected, clear)}>
              <DeleteIcon data-icon="inline-start" />
              Delete
            </Button>
          )}
          onRowClick={open}
          rowClickIgnoreColumns={['select', 'titel', 'actions']}
          rowClassName={(session) => (session.archived ? 'opacity-70' : undefined)}
          capped={capped}
          rowLabel={{ singular: 'Conversation', plural: 'conversations' }}
          loading={loading}
          {...(error ? { error: <ServerOffline onRetry={() => void refresh()} /> } : {})}
          empty={<NoConversationsYet onNewConversation={newConversation} />}
          filteredEmpty={
            <NoMatchingConversations
              filtersActive={filters.filtersActive}
              onReset={filters.resetFilters}
            />
          }
        />
      </Fade>

      <ConversationDrawer
        session={detail}
        open={detail !== null}
        onOpenChange={(next) => {
          if (!next) setDetailId(null);
        }}
        focusTitle={renaming}
        projects={org.projects}
        onRename={rename}
        onProject={assignProject}
        onOpen={(session) => {
          setDetailId(null);
          open(session);
        }}
        onReset={(session) => void confirmReset(session)}
        onDelete={(session) => void confirmDelete(session)}
      />
    </PageBody>
  );
}
