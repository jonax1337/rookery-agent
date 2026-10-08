import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  BookTextIcon as BookOpenIcon,
  DeleteIcon as Trash2Icon,
  DownloadIcon,
  PlusIcon,
} from '@/components/icons';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { useBulkAction } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { useDeleteSkill } from '@/components/common/entity-actions';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkills } from '@/hooks/useSkills';
import { relativeTime } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Skill } from '@/lib/types';

import { ClaudeCodeSections } from './skills/ClaudeCodeSections';
import { SKILL_COLUMN_LABELS, skillColumns } from './skills/skill-columns';

/**
 * The skills folder as one table - the twin of the Tools page.
 *
 * The name points at the detail page rather than the edit form, so a skill can
 * be *read* without opening its source, and `files.length` appears in its own
 * column.
 *
 * Every number here rests on `GET /api/skills`, which returns the whole
 * folder; there is no list limit, so no card needs a footnote about its base.
 */

type Tab = 'all' | 'assistant' | 'agents' | 'both';

const TAB_LABELS: Record<Tab, string> = {
  all: 'All',
  assistant: 'Assistant',
  agents: 'Agents',
  both: 'Both',
};

const TABS = Object.keys(TAB_LABELS) as Tab[];

/** A skill that ships with Rookery has no folder to delete. */
function isRemovable(skill: Skill): boolean {
  return skill.origin !== 'builtin';
}

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, loading, error, refresh, remove } = useSkills();
  const { dialog, deleteSkill } = useDeleteSkill(remove);
  const bulk = useBulkAction();

  const [tab, setTab] = useState<Tab>('all');
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
      skillColumns({
        onOpen: (skill) => void navigate('/skills/' + skill.name),
        onEdit: (skill) => void navigate('/skills/' + skill.name + '/edit'),
        onDelete: (skill) => void deleteSkill(skill),
      }),
    [deleteSkill, navigate],
  );

  const counts = useMemo(
    () => ({
      all: skills.length,
      assistant: countFor(skills, 'assistant'),
      agents: countFor(skills, 'agents'),
      both: countFor(skills, 'both'),
    }),
    [skills],
  );

  const rows = useMemo(
    () => (tab === 'all' ? skills : skills.filter((skill) => skill.audience === tab)),
    [skills, tab],
  );

  return (
    <PageBody>
      {dialog}
      {bulk.dialog}

      <Fade>
        <StatCards items={buildSkillCards(counts, skills)} />
      </Fade>

      <Fade delay={50}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(skill) => skill.name}
          idPrefix="skills"
          onRowClick={(skill) => void navigate('/skills/' + skill.name)}
          rowClickIgnoreColumns={['select', 'name', 'actions']}
          tabs={TABS.map((name) => ({ value: name, label: TAB_LABELS[name], count: counts[name] }))}
          tab={tab}
          onTabChange={(value) => setTab(value as Tab)}
          tabLabel="Skill selection"
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search skills"
          searchText={(skill) => skill.name + ' ' + skill.description}
          columnLabels={SKILL_COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Skill', plural: 'Skills' }}
          loading={loading}
          error={error ? <ServerOffline onRetry={() => void refresh()} /> : undefined}
          bulkActions={(selected, clear) => {
            // Shipped skills are left out of the run rather than counted as a
            // failure afterwards.
            const removable = selected.filter(isRemovable);
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
                      removable.map((skill) => '“' + skill.name + '”').join(', ') +
                      ' will be deleted. This cannot be undone.',
                    run: (skill) => remove(skill.name),
                    clear,
                  })
                }
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            );
          }}
          empty={
            <Fade>
              {tab === 'all' ? (
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
              ) : (
                <EmptyState
                  icon={BookOpenIcon}
                  title="No skills in this selection"
                  description="There is nothing in this tab right now. You can find every skill under “All”."
                  actionLabel="Show all"
                  onAction={() => {
                    setTab('all');
                    setSearch('');
                  }}
                  variant="plain"
                  size="sm"
                />
              )}
            </Fade>
          }
          filteredEmpty={
            <Fade>
              <NoResults query={search.trim() || undefined} onReset={() => setSearch('')} />
            </Fade>
          }
        />
      </Fade>

      <ClaudeCodeSections />
    </PageBody>
  );
}

function countFor(skills: readonly Skill[], audience: Skill['audience']): number {
  return skills.filter((skill) => skill.audience === audience).length;
}

/**
 * The most recently touched skill, for the fourth card. Only ones with a file
 * behind them qualify: a skill that ships with Rookery has no mtime, and
 * reading its zero as a date put "01/01/1970" on the card of a fresh
 * installation.
 */
function newestSkill(skills: readonly Skill[]): Skill | null {
  return skills.reduce<Skill | null>(
    (best, skill) =>
      skill.updatedAt > 0 && (best === null || skill.updatedAt > best.updatedAt) ? skill : best,
    null,
  );
}

// The headline counts roll in from zero once the hook has data and keep
// rolling whenever a refetch moves them. `thousandSeparator` keeps
// `formatNumber`'s en-GB comma in the resting pose - `CountingNumber`
// has no separator support and would quietly drop it above a thousand.
function animatedCount(value: number) {
  return <SlidingNumber number={value} fromNumber={0} thousandSeparator="," />;
}

function buildSkillCards(counts: Record<Tab, number>, skills: readonly Skill[]): StatCardProps[] {
  const newest = newestSkill(skills);
  const bothNote =
    counts.both > 0 ? 'Add ' + formatNumber(counts.both) + ' for assistant and agents' : null;

  return [
    {
      label: 'Skills',
      value: animatedCount(counts.all),
      headline: counts.all === 0 ? 'Nothing added yet' : 'Guides in the skills folder',
      footnote: 'One folder with a SKILL.md file in the Rookery directory',
    },
    {
      label: 'For the assistant',
      value: animatedCount(counts.assistant),
      headline: 'Only in chat and voice mode',
      footnote: bothNote ?? 'Assigned exclusively to the assistant',
    },
    {
      label: 'For agents',
      value: animatedCount(counts.agents),
      headline: 'Only in agent assignments',
      footnote: bothNote ?? 'Assigned exclusively to agents',
    },
    {
      label: 'Last updated',
      value: newest ? relativeTime(newest.updatedAt) : '–',
      headline: newest ? newest.name : 'No updates yet',
      ...(newest ? { footnote: formatDateTime(newest.updatedAt), to: '/skills/' + newest.name } : {}),
    },
  ];
}
