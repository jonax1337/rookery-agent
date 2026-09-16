import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  BookTextIcon as BookOpenIcon,
  DeleteIcon as AnimatedTrash2Icon,
  DeleteIcon as Trash2Icon,
  DownloadIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  PenToolIcon as PencilIcon,
  PlusIcon,
  RefreshCwIcon,
} from "@/components/icons";

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
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
import { SectionHeading } from '@/components/blocks/section-heading';
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
import { Switch } from '@/components/ui/switch';
import { useExternal } from '@/hooks/useExternal';
import { useSkills } from '@/hooks/useSkills';
import { relativeTime } from '@/lib/format';
import { formatNumber, formatDateTime } from '@/lib/stats';
import { AUDIENCE_LABEL } from '@/lib/tools';
import type { ExternalSource, Skill, SkillOrigin } from '@/lib/types';

/**
 * Who wrote a skill. Worth a column of its own now that the shelf is no
 * longer only what a person put there: the assistant writes one with
 * `write_skill` when it works something out, the nightly run distils one out
 * of what the memory keeps repeating, and a few ship with Rookery itself.
 */
const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  user: 'You',
  agent: 'Agent',
  sleep: 'Night',
  builtin: 'Rookery',
};

/**
 * The skills folder as one table - the twin of the Tools page.
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
  description: 'Description',
  audience: 'Audience',
  origin: 'Written by',
  files: 'Files',
  updatedAt: 'Updated',
  actions: 'Actions',
};

type Tab = 'alle' | 'assistant' | 'agents' | 'both';

/** The second table: one row per shelf found in Claude Code. */
const sourceColumn = createRookeryColumnHelper<ExternalSource>();

const SOURCE_COLUMN_LABELS: Record<string, string> = {
  label: 'Source',
  origin: 'Kind',
  skillCount: 'Skills',
  enabled: 'Available',
};

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, loading, error, refresh, remove } = useSkills();
  const { dialog, deleteSkill } = useDeleteSkill(remove);
  const bulk = useBulkAction();
  const external = useExternal();

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
            {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
            <PlusIcon data-icon="inline-start" />
            Create skill
          </NavLink>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton tone="header" label="More ways to add skills" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <NavLink to="/skills/import">
                <DownloadIcon />
                Import
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
        selectionColumn<Skill>({ rowLabel: (skill) => skill.name + ' selected' }),

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
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Description" />,
          cell: ({ row }) => (
            <p className="line-clamp-1 max-w-[32rem] text-muted-foreground">
              {row.original.description}
            </p>
          ),
        }),

        column.accessor('audience', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {AUDIENCE_LABEL[row.original.audience]}
            </Badge>
          ),
        }),

        column.accessor('origin', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Written by" />,
          cell: ({ row }) => (
            <Badge
              variant={row.original.origin === 'user' ? 'outline' : 'secondary'}
              className="font-normal"
            >
              {ORIGIN_LABEL[row.original.origin]}
            </Badge>
          ),
        }),

        column.accessor((skill) => skill.files.length, {
          id: 'files',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Files" align="end" />
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
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Updated" />,
          // A shipped skill has no mtime: it changes when Rookery does, so
          // the cell says where it comes from instead of "never".
          cell: ({ row }) =>
            relativeTimeCell(
              row.original.updatedAt,
              row.original.origin === 'builtin' ? { fallback: 'with Rookery' } : {},
            ),
        }),

        actionsColumn<Skill>((skill) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + skill.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void navigate('/skills/' + skill.name)}>
                <SquareArrowOutUpRightIcon />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigate('/skills/' + skill.name + '/edit')}
              >
                <PencilIcon />
                {/* Editing a shipped skill does not change it: it writes your
                    own copy, which then takes precedence. */}
                {skill.origin === 'builtin' ? 'Write your own version' : 'Edit'}
              </DropdownMenuItem>
              {skill.origin === 'builtin' ? null : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => void deleteSkill(skill)}>
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [deleteSkill, navigate],
  );

  const sourceColumns = useMemo(
    () =>
      sourceColumn.columns([
        sourceColumn.accessor('label', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
          cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
          enableHiding: false,
        }),
        sourceColumn.accessor('origin', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Kind" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {row.original.origin === 'home' ? 'Own folder' : 'Plugin'}
            </Badge>
          ),
        }),
        sourceColumn.accessor('skillCount', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Skills" />,
          cell: ({ row }) => formatNumber(row.original.skillCount),
        }),
        sourceColumn.accessor('enabled', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Available" />,
          cell: ({ row }) => (
            <Switch
              checked={row.original.enabled}
              aria-label={row.original.label + ' available'}
              onCheckedChange={(on) => void external.setSource(row.original, on)}
            />
          ),
        }),
      ]),
    [external],
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

  const externalSources = external.overview?.sources ?? [];
  const installedSkills = externalSources.reduce((sum, source) => sum + source.skillCount, 0);
  // The server's own list, not the sum of the switched-on shelves: a name that
  // sits on two shelves counts once, which is also how the assistant sees it.
  const availableSkills = external.overview?.skills.length ?? 0;

  /**
   * The most recently touched skill, for the fourth card. Only ones with a
   * file behind them qualify: a skill that ships with Rookery has no mtime,
   * and reading its zero as a date put "01/01/1970" on the card of a fresh
   * installation.
   */
  const newest = useMemo(
    () =>
      skills.reduce<Skill | null>(
        (best, skill) =>
          skill.updatedAt > 0 && (best === null || skill.updatedAt > best.updatedAt) ? skill : best,
        null,
      ),
    [skills],
  );

  // The headline counts roll in from zero once the hook has data and keep
  // rolling whenever a refetch moves them. `thousandSeparator` keeps
  // `formatNumber`'s en-GB comma in the resting pose - `CountingNumber`
  // has no separator support and would quietly drop it above a thousand.
  const animatedCount = (value: number) => (
    <SlidingNumber number={value} fromNumber={0} thousandSeparator="," />
  );

  const cards: StatCardProps[] = [
    {
      label: 'Skills',
      value: animatedCount(counts.alle),
      headline: counts.alle === 0 ? 'Nothing added yet' : 'Guides in the skills folder',
      footnote: 'One folder with a SKILL.md file in the Rookery directory',
    },
    {
      label: 'For the assistant',
      value: animatedCount(counts.assistant),
      headline: 'Only in chat and voice mode',
      footnote:
        counts.both > 0
          ? 'Add ' + formatNumber(counts.both) + ' for assistant and agents'
          : 'Assigned exclusively to the assistant',
    },
    {
      label: 'For agents',
      value: animatedCount(counts.agents),
      headline: 'Only in agent assignments',
      footnote:
        counts.both > 0
          ? 'Add ' + formatNumber(counts.both) + ' for assistant and agents'
          : 'Assigned exclusively to agents',
    },
    {
      label: 'Last updated',
      value: newest ? relativeTime(newest.updatedAt) : '–',
      headline: newest ? newest.name : 'No updates yet',
      ...(newest ? { footnote: formatDateTime(newest.updatedAt), to: '/skills/' + newest.name } : {}),
    },
  ];

  return (
    <PageBody>
      {dialog}
      {bulk.dialog}

      <Fade>
        <StatCards items={cards} />
      </Fade>

      <Fade delay={50}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(skill) => skill.name}
          idPrefix="skills"
          onRowClick={(skill) => void navigate('/skills/' + skill.name)}
          rowClickIgnoreColumns={['select', 'name', 'actions']}
          tabs={[
            { value: 'alle', label: 'All', count: counts.alle },
            { value: 'assistant', label: 'Assistant', count: counts.assistant },
            { value: 'agents', label: 'Agents', count: counts.agents },
            { value: 'both', label: 'Both', count: counts.both },
          ]}
          tab={tab}
          onTabChange={(value) => setTab(value as Tab)}
          tabLabel="Skill selection"
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
          bulkActions={(selected, clear) => {
            // A skill that ships with Rookery has no folder to delete, so it is
            // left out of the run rather than counted as a failure afterwards.
            const removable = selected.filter((skill) => skill.origin !== 'builtin');
            return (
            <Button
              size="sm"
              variant="outline"
              disabled={removable.length === 0}
              onClick={() =>
                void bulk.run({
                  rows: removable,
                  noun: { singular: 'Skill', plural: 'Skills' },
                  nameOf: (skill) => skill.name,
                  verb: 'delete',
                  done: 'deleted',
                  confirmLabel: 'Delete',
                  description:
                    'The folders for ' +
                    removable.map((skill) => '„' + skill.name + '“').join(', ') +
                    ' will be deleted. This cannot be undone.',
                  run: (skill) => remove(skill.name),
                  clear,
                })
              }
            >
              <AnimatedTrash2Icon data-icon="inline-start" />
              Delete
            </Button>
            );
          }}
          empty={
            tab === 'alle' ? (
              <Fade>
                <EmptyState
                  icon={BookOpenIcon}
                  title="No skills yet"
                  description="A skill is a written guide for a type of task, such as “Write a weekly report,” with steps that stay the same. The assistant and agents see the list in every turn."
                  actionLabel="Create skill"
                  actionTo="/skills/new"
                  action={
                    <Button variant="outline" asChild>
                      <NavLink to="/skills/import">
                        <DownloadIcon data-icon="inline-start" />
                        Import from GitHub
                      </NavLink>
                    </Button>
                  }
                  variant="plain"
                  size="sm"
                />
              </Fade>
            ) : (
              <Fade>
                <EmptyState
                  icon={BookOpenIcon}
                  title="No skills in this selection"
                  description="There is nothing in this tab right now. You can find every skill under “All”."
                  actionLabel="Show all"
                  onAction={() => {
                    setTab('alle');
                    setSearch('');
                  }}
                  variant="plain"
                  size="sm"
                />
              </Fade>
            )
          }
          filteredEmpty={
            <Fade>
              <NoResults
                {...(search.trim() ? { query: search.trim() } : {})}
                onReset={() => setSearch('')}
              />
            </Fade>
          }
        />
      </Fade>

      {/*
        The other shelf. These are read out of the Claude Code on this
        machine and never copied here, so the table has no name column
        that opens anything: what a source holds is found with `find_skill`
        during a turn, not browsed here. The switch is the whole decision -
        a single plugin can hold three hundred entries, which is why one is
        never available until somebody says so.
      */}
      <Fade delay={100}>
        <SectionHeading
          title="From Claude Code"
          hint={
            externalSources.length
              ? formatNumber(availableSkills) +
                ' of ' +
                formatNumber(installedSkills) +
                ' installed skills are available. The assistant is told they exist and searches them when a task needs one.'
              : 'Nothing installed in the Claude Code on this machine, or reading it is switched off.'
          }
        >
          <DataTable
            data={externalSources}
            columns={sourceColumns}
            getRowId={(source) => source.id}
            idPrefix="skill-sources"
            columnLabels={SOURCE_COLUMN_LABELS}
            searchable
            searchPlaceholder="Quellen durchsuchen"
            searchText={(source) => source.label + ' ' + (source.plugin ?? '')}
            initialSorting={[{ id: 'skillCount', desc: true }]}
            rowLabel={{ singular: 'Source', plural: 'Sources' }}
            loading={external.loading}
            error={external.error ? <ServerOffline onRetry={() => void external.reload()} /> : undefined}
            actions={
              <Button size="sm" variant="outline" onClick={() => void external.rescan()}>
                <RefreshCwIcon data-icon="inline-start" />
                Read again
              </Button>
            }
            empty={
              <Fade>
                <EmptyState
                  icon={BookOpenIcon}
                  title="Nothing found"
                  description="Rookery reads ~/.claude: the skills folder of Claude Code and those of every plugin switched on there. It never writes to them."
                  variant="plain"
                  size="sm"
                />
              </Fade>
            }
          />
        </SectionHeading>
      </Fade>
    </PageBody>
  );
}
