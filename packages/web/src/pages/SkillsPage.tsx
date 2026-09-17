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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useExternal } from '@/hooks/useExternal';
import { useSkills } from '@/hooks/useSkills';
import { relativeTime } from '@/lib/format';
import { formatNumber, formatDateTime } from '@/lib/stats';
import { AUDIENCE_LABEL, AUDIENCE_SHORT_LABEL, AUDIENCE_VALUES } from '@/lib/tools';
import type {
  ExternalAgentRef,
  ExternalSource,
  Skill,
  SkillOrigin,
  ToolServerAudience,
} from '@/lib/types';

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
  agents: 'Subagents',
  hooks: 'Hooks',
  enabled: 'Skills available',
  loadWhole: 'Whole plugin',
};

/** The third table: one row per subagent type found in those shelves. */
const agentColumn = createRookeryColumnHelper<ExternalAgentRef>();

const AGENT_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'When to use it',
  model: 'Model',
  tools: 'Tools',
  audience: 'Audience',
  enabled: 'Approved',
};

/**
 * The audience picker that sits beside every approval switch.
 *
 * A hook set is approved per source *and* per audience, and the two are not
 * interchangeable: the assistant runs with somebody watching, an agent does
 * not. Small and inline rather than a dialog, because it is the second half
 * of one decision, not a separate one.
 */
function AudienceSelect({
  value,
  label,
  onChange,
}: {
  value: ToolServerAudience;
  label: string;
  onChange: (next: ToolServerAudience) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ToolServerAudience)}>
      <SelectTrigger size="sm" className="w-[9.5rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AUDIENCE_VALUES.map((audience) => (
          <SelectItem key={audience} value={audience}>
            {AUDIENCE_SHORT_LABEL[audience]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, loading, error, refresh, remove } = useSkills();
  const { dialog, deleteSkill } = useDeleteSkill(remove);
  const bulk = useBulkAction();
  const external = useExternal();

  const [tab, setTab] = useState<Tab>('alle');
  const [search, setSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');

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

  const externalAgents = external.overview?.agents ?? [];
  const externalHooks = external.overview?.hooks ?? [];
  const externalPlugins = external.overview?.plugins ?? [];

  /** How many subagents and hook handlers each shelf brought along. */
  const perSource = useMemo(() => {
    const counts = new Map<string, { agents: number; hooks: number }>();
    const bump = (id: string, key: 'agents' | 'hooks', by: number) => {
      const entry = counts.get(id) ?? { agents: 0, hooks: 0 };
      entry[key] += by;
      counts.set(id, entry);
    };
    for (const agent of externalAgents) bump(agent.sourceId, 'agents', 1);
    for (const set of externalHooks) bump(set.sourceId, 'hooks', set.handlerCount);
    return counts;
  }, [externalAgents, externalHooks]);

  const pluginBySource = useMemo(
    () => new Map(externalPlugins.map((plugin) => [plugin.sourceId, plugin])),
    [externalPlugins],
  );

  const sourceLabel = useMemo(
    () => new Map((external.overview?.sources ?? []).map((source) => [source.id, source.label])),
    [external.overview],
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
        sourceColumn.accessor((source) => perSource.get(source.id)?.agents ?? 0, {
          id: 'agents',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Subagents" />,
          cell: ({ row }) => formatNumber(perSource.get(row.original.id)?.agents ?? 0),
        }),
        sourceColumn.accessor((source) => perSource.get(source.id)?.hooks ?? 0, {
          id: 'hooks',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Hooks" />,
          cell: ({ row }) => formatNumber(perSource.get(row.original.id)?.hooks ?? 0),
        }),
        sourceColumn.accessor('enabled', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Skills available" />,
          cell: ({ row }) => (
            <Switch
              checked={row.original.enabled}
              aria-label={row.original.label + ' skills available'}
              onCheckedChange={(on) => void external.setSource(row.original, on)}
            />
          ),
        }),
        // The whole shelf at once: skills, subagents and hooks of this plugin
        // go into the turn the way Claude Code itself would load them. Only a
        // plugin has a folder to load, so the person's own skills folder
        // shows nothing here.
        sourceColumn.accessor((source) => pluginBySource.get(source.id)?.loadWhole ?? false, {
          id: 'loadWhole',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Whole plugin" />,
          cell: ({ row }) => {
            const plugin = pluginBySource.get(row.original.id);
            if (!plugin) return emptyCell();
            return (
              <div className="flex items-center gap-2">
                <Switch
                  checked={plugin.loadWhole}
                  aria-label={'Load all of ' + row.original.label}
                  onCheckedChange={(on) => void external.setPlugin(plugin, { loadWhole: on })}
                />
                {plugin.loadWhole && !plugin.active ? (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    Changed
                  </Badge>
                ) : null}
              </div>
            );
          },
        }),
      ]),
    [external, perSource, pluginBySource],
  );

  const agentColumns = useMemo(
    () =>
      agentColumn.columns([
        agentColumn.accessor('name', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
          cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
          enableHiding: false,
        }),
        agentColumn.accessor('description', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="When to use it" />,
          cell: ({ row }) => (
            <p className="line-clamp-1 max-w-[28rem] text-muted-foreground">{row.original.description}</p>
          ),
        }),
        agentColumn.accessor((agent) => sourceLabel.get(agent.sourceId) ?? agent.sourceId, {
          id: 'source',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {sourceLabel.get(row.original.sourceId) ?? row.original.sourceId}
            </Badge>
          ),
        }),
        agentColumn.accessor((agent) => agent.model ?? '', {
          id: 'model',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Model" />,
          cell: ({ row }) => row.original.model ?? emptyCell(),
        }),
        agentColumn.accessor((agent) => (agent.tools ?? []).join(', '), {
          id: 'tools',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Tools" />,
          cell: ({ row }) =>
            row.original.tools?.length ? (
              <p className="line-clamp-1 max-w-[16rem] text-muted-foreground">
                {row.original.tools.join(', ')}
              </p>
            ) : (
              emptyCell()
            ),
        }),
        agentColumn.accessor('audience', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
          cell: ({ row }) => (
            <AudienceSelect
              value={row.original.audience}
              label={'Audience for ' + row.original.name}
              onChange={(audience) => void external.setAgent(row.original, { audience })}
            />
          ),
        }),
        agentColumn.accessor('enabled', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Approved" />,
          cell: ({ row }) => (
            <div className="flex items-center gap-2">
              <Switch
                checked={row.original.enabled}
                aria-label={'Approve ' + row.original.name}
                onCheckedChange={(on) => void external.setAgent(row.original, { enabled: on })}
              />
              {/* Approved once, and the file has moved on since: the approval
                  stands but nothing is handed over until somebody looks. */}
              {row.original.enabled && !row.original.active ? (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  Changed
                </Badge>
              ) : null}
            </div>
          ),
        }),
      ]),
    [external, sourceLabel],
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

      {/*
        Subagent types out of the same shelves. Each one carries its own
        system prompt and tool list into a turn Rookery otherwise composes
        itself, so none of them is handed over until somebody approved it -
        and the approval is tied to the file as it was read: edit the agent
        in Claude Code and the row goes back to "Changed" until it is looked
        at again.
      */}
      <Fade delay={150}>
        <SectionHeading
          title="Subagents from Claude Code"
          hint={
            externalAgents.length
              ? formatNumber(externalAgents.filter((agent) => agent.active).length) +
                ' of ' +
                formatNumber(externalAgents.length) +
                ' subagent types are approved. An approved one can be delegated to during a turn; its prompt is read when the turn starts.'
              : 'No subagent types in the Claude Code on this machine, or reading it is switched off.'
          }
        >
          <DataTable
            data={externalAgents}
            columns={agentColumns}
            getRowId={(agent) => agent.id}
            idPrefix="external-agents"
            columnLabels={AGENT_COLUMN_LABELS}
            searchable
            search={agentSearch}
            onSearchChange={setAgentSearch}
            searchPlaceholder="Search subagents"
            searchText={(agent) => agent.name + ' ' + agent.description}
            initialSorting={[{ id: 'name', desc: false }]}
            rowLabel={{ singular: 'Subagent', plural: 'Subagents' }}
            loading={external.loading}
            error={external.error ? <ServerOffline onRetry={() => void external.reload()} /> : undefined}
            empty={
              <Fade>
                <EmptyState
                  icon={BookOpenIcon}
                  title="Nothing found"
                  description="Rookery reads the agents folder of Claude Code and of every plugin switched on there. It never writes to them."
                  variant="plain"
                  size="sm"
                />
              </Fade>
            }
            filteredEmpty={
              <Fade>
                <NoResults
                  {...(agentSearch.trim() ? { query: agentSearch.trim() } : {})}
                  onReset={() => setAgentSearch('')}
                />
              </Fade>
            }
          />
        </SectionHeading>
      </Fade>

      {/*
        Hook sets. Not a table: a hook is a command line that runs around
        every tool call, and the whole point of the approval is that somebody
        read those lines first. So they are on the page, in full, before the
        switch - and they only ever travel in this direction.
      */}
      {externalHooks.length ? (
        <Fade delay={200}>
          <SectionHeading
            title="Hooks from Claude Code"
            hint="A hook set runs its own commands around every tool call of a turn. Off everywhere until you say otherwise, and approved separately for the assistant and for agents."
          >
            <div className="flex flex-col gap-4 px-4 lg:px-6">
              <Alert>
                <AlertTitle>Plugin hooks are written for someone at a keyboard</AlertTitle>
                <AlertDescription>
                  They expect a person to be watching. ECC&apos;s PreToolUse hook on Bash, for
                  example, refuses the first attempt and asks the model to state its facts and
                  repeat the command — in an unattended agent run that costs a round trip at best,
                  and can stall the run at worst. Approve hooks for the assistant first, and only
                  extend them to agents once you have seen what they do.
                </AlertDescription>
              </Alert>

              {externalHooks.map((set) => (
                <div
                  key={set.sourceId}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">
                        {sourceLabel.get(set.sourceId) ?? set.sourceId}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatNumber(set.handlerCount)} handler(s) over {set.events.join(', ')}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {set.enabled && !set.active ? (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          Changed
                        </Badge>
                      ) : null}
                      <AudienceSelect
                        value={set.audience}
                        label={'Audience for the hooks of ' + (sourceLabel.get(set.sourceId) ?? set.sourceId)}
                        onChange={(audience) => void external.setHook(set, { audience })}
                      />
                      <Switch
                        checked={set.enabled}
                        aria-label={'Approve the hooks of ' + (sourceLabel.get(set.sourceId) ?? set.sourceId)}
                        onCheckedChange={(on) => void external.setHook(set, { enabled: on })}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{set.path}</p>
                  {/* Wide content scrolls in its own box; the page never does. */}
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                    {set.commands.join('\n\n')}
                  </pre>
                </div>
              ))}
            </div>
          </SectionHeading>
        </Fade>
      ) : null}
    </PageBody>
  );
}
