import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  BookOpenIcon,
  ChevronDownIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { useBulkAction } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { useDeleteSkill } from '@/components/common/entity-actions';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkills } from '@/hooks/useSkills';
import { relativeTime } from '@/lib/format';
import { formatNumber, formatDateTime } from '@/lib/stats';
import { AUDIENCE_LABEL } from '@/lib/tools';
import type { Skill } from '@/lib/types';

/**
 * The skills folder as one table - the twin of the Werkzeuge page.
 *
 * It used to be a `ul.divide-y` inside a card: no search, no filter, and the
 * name linked straight into the edit form, so there was no way to *read* a
 * skill without opening its source. The name now points at the new detail
 * page, and `files.length` finally appears somewhere - the server has been
 * sending it all along and nothing showed it.
 *
 * Every number here rests on `GET /api/skills`, which returns the whole
 * folder; there is no list limit, so no card needs a footnote about its base.
 */

const column = createRookeryColumnHelper<Skill>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Beschreibung',
  audience: 'Für wen',
  files: 'Dateien',
  updatedAt: 'Geändert',
  actions: 'Aktionen',
};

type Tab = 'alle' | 'assistant' | 'agents' | 'both';

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, loading, error, refresh, remove } = useSkills();
  const { dialog, deleteSkill } = useDeleteSkill(remove);
  const bulk = useBulkAction();

  const [tab, setTab] = useState<Tab>('alle');
  const [search, setSearch] = useState('');

  usePageMeta({
    breadcrumb: [{ label: 'Skills' }],
    // One primary action, with its variant on the split: writing a skill and
    // importing one both add a skill, so the second belongs in the menu rather
    // than glued beside the first as an equal.
    actions: (
      <>
        <Button asChild size="sm">
          <NavLink to="/skills/new">
            <PlusIcon data-icon="inline-start" />
            Skill anlegen
          </NavLink>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton tone="header" label="Weitere Möglichkeiten, Skills hinzuzufügen" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <NavLink to="/skills/import">
                <DownloadIcon />
                Importieren
              </NavLink>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
  });

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<Skill>({ rowLabel: (skill) => skill.name + ' wählen' }),

        column.accessor('name', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
          cell: ({ row }) => (
            // The detail page, not the edit form: reading a skill should not
            // start by opening its source in a textarea.
            <NavLink
              to={'/skills/' + row.original.name}
              className="font-medium hover:underline"
            >
              {row.original.name}
            </NavLink>
          ),
          enableHiding: false,
        }),

        column.accessor('description', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Beschreibung" />,
          cell: ({ row }) => (
            <p className="line-clamp-1 max-w-[32rem] text-muted-foreground">
              {row.original.description}
            </p>
          ),
        }),

        column.accessor('audience', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Für wen" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {AUDIENCE_LABEL[row.original.audience]}
            </Badge>
          ),
        }),

        column.accessor((skill) => skill.files.length, {
          id: 'files',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Dateien" align="end" />
          ),
          cell: ({ row }) =>
            row.original.files.length > 0 ? (
              <span className="block text-right tabular-nums text-muted-foreground">
                {formatNumber(row.original.files.length)}
              </span>
            ) : (
              emptyCell('end')
            ),
        }),

        column.accessor('updatedAt', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Geändert" />,
          cell: ({ row }) => relativeTimeCell(row.original.updatedAt),
        }),

        actionsColumn<Skill>((skill) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Aktionen für ' + skill.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void navigate('/skills/' + skill.name)}>
                <SquareArrowOutUpRightIcon />
                Öffnen
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigate('/skills/' + skill.name + '/edit')}
              >
                <PencilIcon />
                Bearbeiten
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void deleteSkill(skill)}>
                <Trash2Icon />
                Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [deleteSkill, navigate],
  );

  const counts = useMemo(
    () => ({
      alle: skills.length,
      assistant: skills.filter((skill) => skill.audience === 'assistant').length,
      agents: skills.filter((skill) => skill.audience === 'agents').length,
      both: skills.filter((skill) => skill.audience === 'both').length,
    }),
    [skills],
  );

  const rows = useMemo(
    () => (tab === 'alle' ? skills : skills.filter((skill) => skill.audience === tab)),
    [skills, tab],
  );

  /** The most recently touched skill, for the fourth card. */
  const newest = useMemo(
    () =>
      skills.reduce<Skill | null>(
        (best, skill) => (best === null || skill.updatedAt > best.updatedAt ? skill : best),
        null,
      ),
    [skills],
  );

  const cards: StatCardProps[] = [
    {
      label: 'Skills',
      value: formatNumber(counts.alle),
      headline: counts.alle === 0 ? 'Noch nichts hinterlegt' : 'Anleitungen im Skills-Ordner',
      footnote: 'Je ein Ordner mit SKILL.md unter dem Rookery-Verzeichnis',
    },
    {
      label: 'Für den Assistenten',
      value: formatNumber(counts.assistant),
      headline: 'Nur im Chat und im Sprachmodus',
      footnote:
        counts.both > 0
          ? 'Dazu ' + formatNumber(counts.both) + ' für Assistent und Agenten'
          : 'Ausschliesslich dem Assistenten zugeteilt',
    },
    {
      label: 'Für Agenten',
      value: formatNumber(counts.agents),
      headline: 'Nur in den Aufträgen der Agenten',
      footnote:
        counts.both > 0
          ? 'Dazu ' + formatNumber(counts.both) + ' für Assistent und Agenten'
          : 'Ausschliesslich den Agenten zugeteilt',
    },
    {
      label: 'Zuletzt geändert',
      value: newest ? relativeTime(newest.updatedAt) : '–',
      headline: newest ? newest.name : 'Noch keine Änderung',
      ...(newest ? { footnote: formatDateTime(newest.updatedAt), to: '/skills/' + newest.name } : {}),
    },
  ];

  return (
    <PageBody>
      {dialog}
      {bulk.dialog}

      <StatCards items={cards} />

      <DataTable
        data={rows}
        columns={columns}
        getRowId={(skill) => skill.name}
        idPrefix="skills"
        onRowClick={(skill) => void navigate('/skills/' + skill.name)}
        rowClickIgnoreColumns={['select', 'name', 'actions']}
        tabs={[
          { value: 'alle', label: 'Alle', count: counts.alle },
          { value: 'assistant', label: 'Assistent', count: counts.assistant },
          { value: 'agents', label: 'Agenten', count: counts.agents },
          { value: 'both', label: 'Beide', count: counts.both },
        ]}
        tab={tab}
        onTabChange={(value) => setTab(value as Tab)}
        tabLabel="Auswahl der Skills"
        searchable
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Skills durchsuchen"
        searchText={(skill) => skill.name + ' ' + skill.description}
        columnLabels={COLUMN_LABELS}
        initialSorting={[{ id: 'name', desc: false }]}
        rowLabel={{ singular: 'Skill', plural: 'Skills' }}
        loading={loading}
        error={error ? <ServerOffline onRetry={() => void refresh()} /> : undefined}
        bulkActions={(selected, clear) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void bulk.run({
                rows: selected,
                noun: { singular: 'Skill', plural: 'Skills' },
                nameOf: (skill) => skill.name,
                verb: 'löschen',
                done: 'gelöscht',
                confirmLabel: 'Löschen',
                description:
                  'Gelöscht werden die Ordner von ' +
                  selected.map((skill) => '„' + skill.name + '“').join(', ') +
                  '. Das lässt sich nicht rückgängig machen.',
                run: (skill) => remove(skill.name),
                clear,
              })
            }
          >
            <Trash2Icon data-icon="inline-start" />
            Löschen
          </Button>
        )}
        empty={
          tab === 'alle' ? (
            <EmptyState
              icon={BookOpenIcon}
              title="Noch keine Skills"
              description="Ein Skill ist eine geschriebene Anleitung für eine Art von Aufgabe — etwa „Wochenbericht schreiben“ mit den Schritten, die immer gleich sind. Der Assistent und die Agenten sehen die Liste in jedem Turn."
              actionLabel="Skill anlegen"
              actionTo="/skills/new"
              action={
                <Button variant="outline" asChild>
                  <NavLink to="/skills/import">
                    <DownloadIcon data-icon="inline-start" />
                    Aus GitHub importieren
                  </NavLink>
                </Button>
              }
              variant="plain"
              size="sm"
            />
          ) : (
            <EmptyState
              icon={BookOpenIcon}
              title="Keine Skills in dieser Auswahl"
              description="In dieser Registerkarte steht gerade nichts. Alle Skills liegen unter „Alle“."
              actionLabel="Alle anzeigen"
              onAction={() => {
                setTab('alle');
                setSearch('');
              }}
              variant="plain"
              size="sm"
            />
          )
        }
        filteredEmpty={
          <NoResults
            {...(search.trim() ? { query: search.trim() } : {})}
            onReset={() => setSearch('')}
          />
        }
      />
    </PageBody>
  );
}
