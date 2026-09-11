import * as React from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  AudioLinesIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchXIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';

import { failureMessage, reportFailure } from '@/lib/errors';
import {
  formatDateTime,
  NO_PROJECT,
  relativeTime,
  SESSION_KIND_LABEL,
  timeAgo,
  UNTITLED_SESSION,
} from '@/lib/format';
import { SESSION_TITLE_MAX, sessionTitleSchema } from '@/lib/session';
import { formatNumber } from '@/lib/stats';
import type { Session } from '@/lib/types';
import {
  useAllSessionsState,
  useChatSession,
  useConfig,
  useConnection,
  useOrgState,
  useSessionsState,
} from '@/providers/rookery-provider';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import { usePageMeta } from '@/components/shell/page-meta';

import { PageBody } from '@/components/blocks/page-body';
import { cappedBadge, StatCards, StatCardsSkeleton } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import {
  DetailDrawer,
  useDrawerSubject,
} from '@/components/blocks/detail-drawer';
import { FormField } from '@/components/forms/form-kit';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { FilterCombobox } from '@/components/common/filter-combobox';
import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { RowMenuButton } from '@/components/common/row-menu-button';
import {
  buildSessionColumns,
  SESSION_COLUMN_LABELS,
  SESSION_SORTING,
  UNKNOWN_AGENT,
} from '@/components/common/session-columns';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
 * The columns themselves come from `buildSessionColumns` - the dashboard shows
 * the same records and had written its own set, with its own words for
 * `session.kind` and its own name for a deleted agent.
 */

/** The "everything" entry of the two filter comboboxes. */
const ANY = '__any__';
/** The counterpart value that means the assistant rather than an agent. */
const ASSISTANT = 'assistant';

type Tab = 'alle' | 'assistent' | 'agenten' | 'sprache' | 'archiv';

const TABS: Tab[] = ['alle', 'assistent', 'agenten', 'sprache', 'archiv'];

const TAB_LABEL: Record<Tab, string> = {
  alle: 'Alle',
  assistent: 'Assistent',
  agenten: 'Agenten',
  sprache: 'Sprache',
  archiv: 'Archiv',
};

type Period = 'alle' | 'heute' | 'woche' | 'monat' | 'aelter';

const PERIOD_LABEL: Record<Period, string> = {
  alle: 'Jederzeit',
  heute: 'Heute',
  woche: 'Diese Woche',
  monat: 'Dieser Monat',
  aelter: 'Älter',
};

export function ConversationsPage() {
  const navigate = useNavigate();
  const { socket } = useConnection();
  const { assistantName } = useConfig();
  const org = useOrgState();
  const { chat, openConversation, newConversation } = useChatSession();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  // The one shared list from the provider, archive included - the tabs decide
  // which rows are on screen. Sharing it is what lets a deletion here move
  // the rail's badge, and what keeps `/chats` down to one request.
  const { sessions, loading, error, capped, refresh, sessionById, update, reset, remove } =
    useAllSessionsState();
  // The chat hub holds its own slice and its own active thread. A row mutated
  // here is very possibly the conversation that is open behind this page, so
  // it has to be told - nothing on the wire tells it.
  const openThread = useSessionsState();

  // The real counts, from the one aggregate call in this API. Shared with the
  // other lists, so the same tile is equally current wherever it stands.
  const totals = useStatsTotals(socket);

  /* ------------------------------- filters ------------------------------- */

  const [params, setParams] = useSearchParams();
  const tab = readTab(params.get('art'));
  const counterpart = params.get('gegenueber') ?? ANY;

  const [project, setProject] = React.useState<string>(ANY);
  const [period, setPeriod] = React.useState<Period>('alle');
  const [search, setSearch] = React.useState('');

  // Both facets live in the URL so a filtered list can be linked to and
  // survives a reload; everything else is a passing choice.
  const setParam = React.useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setTab = React.useCallback(
    (value: string) => setParam('art', value === 'alle' ? null : value),
    [setParam],
  );
  const setCounterpart = React.useCallback(
    (value: string) => setParam('gegenueber', value === ANY ? null : value),
    [setParam],
  );

  const filtersActive =
    tab !== 'alle' ||
    counterpart !== ANY ||
    project !== ANY ||
    period !== 'alle' ||
    search.trim() !== '';

  const resetFilters = React.useCallback(() => {
    setProject(ANY);
    setPeriod('alle');
    setSearch('');
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('art');
        next.delete('gegenueber');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  /* -------------------------------- rows --------------------------------- */

  const counts = React.useMemo(() => tabCounts(sessions), [sessions]);

  const rows = React.useMemo(() => {
    const since = periodStart(period);
    return sessions.filter((session) => {
      if (!matchesTab(session, tab)) return false;
      if (counterpart !== ANY) {
        const own = session.agentId ?? ASSISTANT;
        if (own !== counterpart) return false;
      }
      if (project !== ANY) {
        const own = session.projectId ?? NO_PROJECT;
        if (own !== project) return false;
      }
      if (period === 'aelter') return session.updatedAt < monthStart();
      if (since !== null && session.updatedAt < since) return false;
      return true;
    });
  }, [counterpart, period, project, sessions, tab]);

  /* ------------------------------- actions ------------------------------- */

  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const detail = sessionById(detailId ?? undefined) ?? null;

  // A spoken conversation opens as what it is: a transcript. Sending it
  // straight back into the microphone is the one thing the reader did not ask
  // for - continuing it hands-free is a separate entry in the row menu.
  const open = React.useCallback(
    (session: Session) => openConversation(session.id),
    [openConversation],
  );

  /**
   * Keep the open conversation in step with a row this page just changed.
   *
   * The chat hub holds its own list and its own active thread, and neither
   * `PATCH` nor `DELETE /api/sessions/:id` sends anything over the socket. So
   * a deletion here would leave the hub answering into a session the server
   * no longer has, and a rename would never reach its header.
   */
  const syncOpenThread = React.useCallback(
    (id: string, effect?: { dropped?: boolean; cleared?: boolean }) => {
      if (openThread.activeId === id) {
        if (effect?.dropped) openThread.setActiveId(null);
        if (effect?.dropped || effect?.cleared) chat.reset();
      }
      void openThread.refresh();
    },
    [chat, openThread],
  );

  const assignProject = React.useCallback(
    (session: Session, value: string) => {
      void update(session.id, { projectId: value === NO_PROJECT ? null : value }).catch(
        (caught: unknown) => reportFailure('Projekt setzen', caught),
      );
    },
    [update],
  );

  const setArchived = React.useCallback(
    (session: Session, archived: boolean) => {
      void update(session.id, { archived })
        .then(() => toast(archived ? 'Gespräch archiviert' : 'Gespräch zurückgeholt'))
        .catch((caught: unknown) => reportFailure(archived ? 'Archivieren' : 'Zurückholen', caught));
    },
    [update],
  );

  const confirmReset = React.useCallback(
    async (session: Session) => {
      const ok = await confirm({
        title: 'Gespräch zurücksetzen?',
        description:
          'Alle Nachrichten dieses Gesprächs werden entfernt. Titel, Projekt und Gegenüber bleiben.',
        confirmLabel: 'Zurücksetzen',
        destructive: true,
        icon: RotateCcwIcon,
      });
      if (!ok) return;
      try {
        await reset(session.id);
        syncOpenThread(session.id, { cleared: true });
        toast('Gespräch zurückgesetzt');
      } catch (caught) {
        reportFailure('Zurücksetzen', caught);
      }
    },
    [confirm, reset, syncOpenThread],
  );

  const confirmDelete = React.useCallback(
    async (session: Session) => {
      const ok = await confirm({
        title: 'Gespräch löschen?',
        description: 'Dieses Gespräch und alle Nachrichten werden gelöscht.',
        confirmLabel: 'Löschen',
        destructive: true,
      });
      if (!ok) return;
      try {
        await remove(session.id);
        setDetailId((current) => (current === session.id ? null : current));
        syncOpenThread(session.id, { dropped: true });
        toast('Gespräch gelöscht');
      } catch (caught) {
        reportFailure('Löschen', caught);
      }
    },
    [confirm, remove, syncOpenThread],
  );

  /* ------------------------------- columns ------------------------------- */

  const columns = React.useMemo(
    () =>
      buildSessionColumns({
        assistantName,
        agentName: (id) => org.agentById(id)?.name,
        selectable: true,
        showProvider: true,
        onOpenDetail: (session) => {
          setRenaming(false);
          setDetailId(session.id);
        },
        projectName: (session) =>
          org.projects.find((entry) => entry.id === session.projectId)?.name ?? '',
        rowActions: (session) => (
          <RowMenu
            session={session}
            projects={org.projects}
            onOpen={() => open(session)}
            onRename={() => {
              setRenaming(true);
              setDetailId(session.id);
            }}
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
      assistantName,
      confirmDelete,
      confirmReset,
      navigate,
      open,
      org,
      setArchived,
    ],
  );

  /* -------------------------------- meta --------------------------------- */

  usePageMeta({
    // One crumb, like every other top-level list: the dashboard gave up its
    // own "Rookery" root, and a single page carrying one would be the outlier.
    breadcrumb: [{ label: 'Gespräche' }],
    // One primary action, with its variant on the split. Speaking and writing
    // both start a conversation, so the voice entry belongs on this button
    // rather than glued beside it as a second, equal-looking one.
    actions: (
      <>
        <Button size="sm" onClick={newConversation}>
          <PlusIcon data-icon="inline-start" />
          Neues Gespräch
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton tone="header" label="Weitere Möglichkeiten, ein Gespräch zu beginnen" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <NavLink to="/voice">
                <AudioLinesIcon />
                Sprachgespräch
              </NavLink>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
  });

  /* -------------------------------- cards -------------------------------- */

  const newest = sessions.reduce<Session | null>(
    (best, session) => (!best || session.updatedAt > best.updatedAt ? session : best),
    null,
  );
  const voice = sessions.filter((session) => session.kind === 'voice');
  const newestVoice = voice.reduce<Session | null>(
    (best, session) => (!best || session.updatedAt > best.updatedAt ? session : best),
    null,
  );
  const allConversations = totals ? totals.sessions + totals.archivedSessions : null;

  return (
    <PageBody>
      {dialog}
      {bulk.dialog}

      {loading && sessions.length === 0 ? (
        <StatCardsSkeleton />
      ) : (
        <StatCards
          items={[
            {
              label: 'Gespräche',
              value: allConversations === null ? '–' : formatNumber(allConversations),
              headline:
                totals === null
                  ? 'Zahlen werden geladen'
                  : formatNumber(totals.archivedSessions) + ' davon archiviert',
              footnote: 'Gezählt in der Datenbank, nicht in der Liste',
            },
            {
              label: 'Nachrichten',
              value: totals === null ? '–' : formatNumber(totals.messages),
              headline:
                totals === null || allConversations === null || allConversations === 0
                  ? 'Noch nichts geschrieben'
                  : 'Im Schnitt ' +
                    formatNumber(Math.round(totals.messages / allConversations)) +
                    ' pro Gespräch',
              footnote: 'Alle Nachrichten aller Gespräche',
            },
            {
              label: 'Sprachgespräche',
              value: formatNumber(voice.length),
              // This one has no COUNT(*) behind it: /api/stats knows sessions,
              // not their kind. So it says which list it counted.
              ...cappedBadge(capped),
              headline: newestVoice ? 'Zuletzt ' + timeAgo(newestVoice.updatedAt) : 'Noch keins',
              footnote:
                'In den ' + formatNumber(sessions.length) + ' geladenen Gesprächen gezählt',
            },
            {
              label: 'Zuletzt aktiv',
              value: newest ? relativeTime(newest.updatedAt) : '–',
              headline: newest ? (
                <span className="line-clamp-1">{newest.title || UNTITLED_SESSION}</span>
              ) : (
                'Noch kein Gespräch'
              ),
              footnote: 'Zuletzt geöffnet',
            },
          ]}
        />
      )}

      {/*
        No chart. "Gespräche pro Tag" would need a window the table does not
        have and would say less than the first row of it - and the table is
        what this page is for.
      */}

      <DataTable<Session>
        data={rows}
        columns={columns}
        getRowId={(session) => session.id}
        idPrefix="gespraeche"
        tabLabel="Reiter"
        tabs={TABS.map((value) => ({
          value,
          label: TAB_LABEL[value],
          count: counts[value],
        }))}
        tab={tab}
        onTabChange={setTab}
        searchable
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Gespräche durchsuchen"
        searchText={(session) => searchTextOf(session, org.agentById, assistantName)}
        filters={
          <>
            <FilterCombobox
              label="Gegenüber"
              value={counterpart}
              onChange={(next) => setCounterpart(next ?? ANY)}
              showClear={false}
              options={[
                { value: ANY, label: 'Alle Gegenüber' },
                { value: ASSISTANT, label: assistantName },
                ...org.agents
                  .filter((agent) => !agent.archived)
                  .map((agent) => ({ value: agent.id, label: agent.name })),
              ]}
            />
            <FilterCombobox
              label="Projekt"
              value={project}
              onChange={(next) => setProject(next ?? ANY)}
              showClear={false}
              options={[
                { value: ANY, label: 'Alle Projekte' },
                { value: NO_PROJECT, label: 'Kein Projekt' },
                ...org.projects
                  .filter((entry) => !entry.archived)
                  .map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
            />
            <Select value={period} onValueChange={(value) => setPeriod(value as Period)}>
              <SelectTrigger size="sm" className="w-36" aria-label="Zeitraum">
                <SelectValue placeholder="Zeitraum" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(Object.keys(PERIOD_LABEL) as Period[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {PERIOD_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </>
        }
        /*
          Keine Primaeraktion in der Werkzeugleiste: "Neues Gespräch" steht im
          Seitenkopf. Der zweite Knopf war nicht nur doppelt, er drueckte die
          Leiste schon bei 1440 px in eine zweite Reihe.
        */
        columnLabels={SESSION_COLUMN_LABELS}
        initialColumnVisibility={{ projekt: false }}
        initialSorting={SESSION_SORTING}
        groupTime={(session) => session.updatedAt}
        groupSortId="zuletzt"
        bulkActions={(selected, clear) => (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void bulk.run({
                rows: selected,
                noun: { singular: 'Gespräch', plural: 'Gespräche' },
                nameOf: (session) => session.title || UNTITLED_SESSION,
                verb: 'löschen',
                done: 'gelöscht',
                confirmLabel: 'Löschen',
                description:
                  'Die gewählten Gespräche und alle ihre Nachrichten werden gelöscht.',
                run: async (session) => {
                  await remove(session.id);
                  syncOpenThread(session.id, { dropped: true });
                },
                clear,
              })
            }
          >
            <Trash2Icon data-icon="inline-start" />
            Löschen
          </Button>
        )}
        onRowClick={open}
        rowClickIgnoreColumns={['select', 'titel', 'actions']}
        rowClassName={(session) => (session.archived ? 'opacity-70' : undefined)}
        capped={capped}
        rowLabel={{ singular: 'Gespräch', plural: 'Gesprächen' }}
        loading={loading}
        {...(error ? { error: <ServerOffline onRetry={() => void refresh()} /> } : {})}
        empty={
          <EmptyState
            icon={MessagesSquareIcon}
            title="Noch keine Gespräche"
            description="Stell die erste Frage — alles, was ihr besprecht, sammelt sich hier."
            actionLabel="Neues Gespräch"
            onAction={newConversation}
            action={
              <Button variant="outline" asChild>
                <NavLink to="/voice">Sprechen</NavLink>
              </Button>
            }
            variant="plain"
          />
        }
        filteredEmpty={
          <EmptyState
            icon={SearchXIcon}
            title="Kein Gespräch passt zu dieser Auswahl"
            description="Ändere Suche, Zeitraum, Gegenüber oder Reiter."
            actionLabel={filtersActive ? 'Filter zurücksetzen' : undefined}
            onAction={resetFilters}
            variant="plain"
            size="sm"
          />
        }
      />

      <ConversationDrawer
        session={detail}
        open={detail !== null}
        onOpenChange={(next) => {
          if (!next) setDetailId(null);
        }}
        focusTitle={renaming}
        assistantName={assistantName}
        agentName={
          detail?.agentId ? (org.agentById(detail.agentId)?.name ?? UNKNOWN_AGENT) : assistantName
        }
        projects={org.projects}
        onRename={async (id, title) => {
          const renamed = await update(id, { title });
          syncOpenThread(id);
          return renamed;
        }}
        onProject={(session, value) => assignProject(session, value)}
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

/* ------------------------------ the drawer ------------------------------- */

interface ConversationDrawerProps {
  session: Session | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opened through "Umbenennen": the title field takes the caret. */
  focusTitle: boolean;
  assistantName: string;
  agentName: string;
  projects: { id: string; name: string; archived: boolean }[];
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
function ConversationDrawer({
  session: chosen,
  open,
  onOpenChange,
  focusTitle,
  assistantName,
  agentName,
  projects,
  onRename,
  onProject,
  onOpen,
  onReset,
  onDelete,
}: ConversationDrawerProps) {
  // Die Zeile bleibt stehen, bis die Schublade zugefahren ist; sonst
  // verschwaende der Inhalt im selben Bild und die Bewegung fiele aus.
  const session = useDrawerSubject(chosen);
  const [title, setTitle] = React.useState('');
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const id = session?.id ?? null;

  // Keyed on the id alone: a socket refresh while the field is being typed in
  // must not pull the caret back to the stored title.
  React.useEffect(() => {
    setTitle(session?.title ?? '');
    setTitleError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Greift nur, bevor ueberhaupt je eine Zeile gewaehlt war - dann gibt es
  // auch nichts zu animieren.
  if (!session) return null;

  async function commitTitle(): Promise<void> {
    if (!session) return;
    // Dieselbe Regel wie im Umbenennen-Dialog des Chats: bis dahin nahm dieses
    // Feld Titel an, die die andere Oberflaeche abgelehnt haette.
    const parsed = sessionTitleSchema.safeParse({ title });
    if (!parsed.success) {
      setTitleError(parsed.error.issues[0]?.message ?? 'Ein Gespräch braucht einen Titel.');
      if (!title.trim()) setTitle(session.title);
      return;
    }
    const next = parsed.data.title;
    if (next === session.title) return;
    try {
      await onRename(session.id, next);
      setTitleError(null);
    } catch (caught) {
      // Today this failure is swallowed and the old title silently returns;
      // here it says what happened and leaves the typed text standing.
      setTitleError(failureMessage(caught));
    }
  }

  const projectName = projects.find((entry) => entry.id === session.projectId)?.name;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={session.title || UNTITLED_SESSION}
      description={
        'Angelegt am ' +
        formatDateTime(session.createdAt) +
        ' · ' +
        formatNumber(session.messageCount) +
        (session.messageCount === 1 ? ' Nachricht' : ' Nachrichten')
      }
      footer={
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onOpen(session)}>
            <SquareArrowOutUpRightIcon data-icon="inline-start" />
            {session.kind === 'voice' ? 'Mitschrift öffnen' : 'Öffnen'}
          </Button>
          <Button variant="outline" onClick={() => onReset(session)}>
            <RotateCcwIcon data-icon="inline-start" />
            Zurücksetzen
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => onDelete(session)}>
            <Trash2Icon data-icon="inline-start" />
            Löschen
          </Button>
        </div>
      }
    >
      <FieldGroup className="gap-4">
        {/* FormField haengt die Meldung per `aria-describedby` an die Eingabe:
            `role="alert"` liest sie einmal vor, danach fand sie niemand mehr,
            der ins abgelehnte Feld zuruecksprang. */}
        <FormField id="gespraech-titel" label="Titel" error={titleError}>
          {(control) => (
            <Input
              {...control}
              value={title}
              autoFocus={focusTitle}
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

        <Field>
          <FieldLabel htmlFor="gespraech-projekt">Projekt</FieldLabel>
          <FilterCombobox
            id="gespraech-projekt"
            label="Projekt"
            value={session.projectId ?? NO_PROJECT}
            onChange={(next) => onProject(session, next ?? NO_PROJECT)}
            showClear={false}
            className="w-full"
            options={[
              { value: NO_PROJECT, label: 'Kein Projekt' },
              ...projects
                .filter((entry) => !entry.archived || entry.id === session.projectId)
                .map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
          />
        </Field>
      </FieldGroup>

      <MetaList
        columns={1}
        items={[
          {
            label: 'Gegenüber',
            value: session.agentId ? agentName : assistantName,
            ...(session.agentId ? { to: '/org/agents/' + session.agentId } : {}),
          },
          { label: 'Art', value: SESSION_KIND_LABEL[session.kind] },
          {
            label: 'Anbieter & Modell',
            value: (
              <ProviderCell
                provider={session.provider}
                {...(session.model ? { model: session.model } : {})}
                layout="inline"
                fallback="Standard"
              />
            ),
          },
          { label: 'Projekt', value: projectName ?? 'Kein Projekt' },
          { label: 'Verzeichnis', value: session.cwd, mono: true },
          { label: 'Nachrichten', value: formatNumber(session.messageCount) },
          { label: 'Angelegt', value: formatDateTime(session.createdAt) },
          { label: 'Zuletzt aktiv', value: formatDateTime(session.updatedAt) },
          { label: 'Abgelegt', value: session.archived ? 'Im Archiv' : null },
          {
            label: 'Provider-Sitzung',
            value: session.providerSessionId ?? null,
            mono: true,
          },
        ]}
      />
    </DetailDrawer>
  );
}

/* ------------------------------- the menu -------------------------------- */

interface RowMenuProps {
  session: Session;
  projects: { id: string; name: string; archived: boolean }[];
  onOpen(): void;
  onRename(): void;
  onProject(value: string): void;
  onVoice(): void;
  onArchive(archived: boolean): void;
  onReset(): void;
  onDelete(): void;
}

function RowMenu({
  session,
  projects,
  onOpen,
  onRename,
  onProject,
  onVoice,
  onArchive,
  onReset,
  onDelete,
}: RowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Aktionen für ' + (session.title || UNTITLED_SESSION)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onOpen}>
          <SquareArrowOutUpRightIcon />
          {session.kind === 'voice' ? 'Mitschrift öffnen' : 'Öffnen'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <PencilIcon />
          Umbenennen
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Projekt zuweisen</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={session.projectId ?? NO_PROJECT}
              onValueChange={onProject}
            >
              <DropdownMenuRadioItem value={NO_PROJECT}>Kein Projekt</DropdownMenuRadioItem>
              {projects
                .filter((entry) => !entry.archived || entry.id === session.projectId)
                .map((entry) => (
                  <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* A spoken conversation is read like any other; this is the way
            back into the microphone, for both kinds. */}
        <DropdownMenuItem onSelect={onVoice}>
          <AudioLinesIcon />
          {session.kind === 'voice' ? 'Sprachgespräch fortsetzen' : 'Im Sprachmodus fortsetzen'}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => onArchive(!session.archived)}>
          {session.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {session.archived ? 'Zurückholen' : 'Archivieren'}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={onReset}>
          <RotateCcwIcon />
          Zurücksetzen
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Löschen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------- helpers -------------------------------- */

function readTab(value: string | null): Tab {
  if (value === null) return 'alle';
  // `?art=voice` is the spelling a link from elsewhere in the app uses.
  if (value === 'voice') return 'sprache';
  if (value === 'chat') return 'alle';
  return (TABS as string[]).includes(value) ? (value as Tab) : 'alle';
}

function matchesTab(session: Session, tab: Tab): boolean {
  if (tab === 'archiv') return session.archived;
  // Every other facet is a view of the conversations still in use.
  if (session.archived) return false;
  switch (tab) {
    case 'assistent':
      return session.agentId === undefined && session.kind === 'chat';
    case 'agenten':
      return session.agentId !== undefined;
    case 'sprache':
      return session.kind === 'voice';
    default:
      return true;
  }
}

function tabCounts(sessions: readonly Session[]): Record<Tab, number> {
  const counts: Record<Tab, number> = { alle: 0, assistent: 0, agenten: 0, sprache: 0, archiv: 0 };
  for (const session of sessions) {
    for (const tab of TABS) if (matchesTab(session, tab)) counts[tab] += 1;
  }
  return counts;
}

/** `null` means "no lower bound"; `aelter` is handled as an upper one. */
function periodStart(period: Period): number | null {
  if (period === 'alle' || period === 'aelter') return null;
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (period === 'heute') return date.getTime();
  if (period === 'woche') {
    // Monday starts the week, the way a German calendar prints it.
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
  }
  return monthStart();
}

/**
 * Midnight on the first of the current month.
 *
 * Its own function because `aelter` needs the boundary as a plain number:
 * `periodStart` is declared `number | null` for the two periods that have no
 * lower bound, and a comparison cannot use a maybe-null.
 */
function monthStart(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
}

/**
 * What the toolbar search looks at.
 *
 * The row's own fields plus the counterpart's name, because "was habe ich mit
 * Mara besprochen" is the question this page exists for - and `agentId` alone
 * is a string nobody types.
 */
function searchTextOf(
  session: Session,
  agentById: (id: string | undefined) => { name: string } | undefined,
  assistantName: string,
): string {
  const counterpart = session.agentId ? (agentById(session.agentId)?.name ?? '') : assistantName;
  return [session.title, counterpart, session.model ?? '', session.cwd].join(' ');
}
