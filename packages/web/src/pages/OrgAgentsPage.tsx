import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { ArchiveIcon, UserIcon as UserRoundIcon } from '@/components/icons';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_LABEL } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { Agent, PermissionLevel } from '@/lib/types';
import { useOrgPerformance } from '@/hooks/useOrgPerformance';
import { useOrgState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { FilterCombobox } from '@/components/common/filter-combobox';
import { Button } from '@/components/ui/button';

import { AgentDrawer } from './org/AgentDrawer';
import { AGENT_COLUMN_LABELS, agentColumns } from './org/agent-columns';

/**
 * Everyone who works here, as one table.
 *
 * The team filter lives in the URL, so the member count on the Teams tab can
 * link straight into "the four people in Redaktion".
 *
 * What is missing is missing on the server: `GET /api/org` calls
 * `listAgents(orgId)`, which filters `archived = 0`, and no endpoint hands
 * archived agents over. So there is no "Show archived" switch and no
 * archived count - archiving simply removes the row, and the confirmation
 * says so.
 */

/** Team filter value for "belongs to no team at all". */
const NO_TEAM = '__none__';
/** Access filter value for "inherits the level from the settings". */
const INHERITED = '__default__';

const PERMISSIONS: readonly PermissionLevel[] = ['chat', 'read', 'write', 'full'];

export function OrgAgentsPage() {
  const org = useOrgState();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();
  const { entries } = useOrgPerformance();

  const [searchParams, setSearchParams] = useSearchParams();
  const team = searchParams.get('team');
  const [permission, setPermission] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const standings = useMemo(
    () => new Map((entries ?? []).map((entry) => [entry.agent.id, entry])),
    [entries],
  );

  /**
   * The team filter lives in the URL so the Teams tab can link into it. Written
   * with `replace` because filtering is not a place in the history - the back
   * button should leave the page, not step through five filter states.
   */
  const setTeam = useCallback(
    (value: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set('team', value);
          else next.delete('team');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const clearFilters = () => {
    setTeam(null);
    setPermission(null);
  };

  const archive = useCallback(
    async (agent: Agent): Promise<void> => {
      const ok = await confirm({
        title: 'Archive ' + agent.name + '?',
        description: archiveDescription(agent, org.teams, org.agents),
        confirmLabel: 'Archive',
        destructive: true,
        icon: ArchiveIcon,
      });
      if (!ok) return;

      try {
        await api.updateAgent(agent.id, { archived: true });
        await org.refresh();
        toast(agent.name + ' archived');
      } catch (caught) {
        reportFailure('Archive', caught);
      }
    },
    [confirm, org],
  );

  const columns = useMemo(
    () =>
      agentColumns({
        org,
        standings,
        onOpen: (agent) => setDrawerId(agent.id),
        onOpenPage: (agent) => void navigate('/org/agents/' + agent.id),
        onArchive: (agent) => void archive(agent),
      }),
    [archive, navigate, org, standings],
  );

  const rows = useMemo(
    () =>
      org.agents.filter(
        (agent) =>
          (!team || (team === NO_TEAM ? !agent.teamId : agent.teamId === team)) &&
          (!permission ||
            (permission === INHERITED ? !agent.permission : agent.permission === permission)),
      ),
    [org.agents, permission, team],
  );

  const filtered = team !== null || permission !== null;
  const drawerAgent = org.agents.find((agent) => agent.id === drawerId) ?? null;
  const resetEverything = () => {
    setSearch('');
    clearFilters();
  };

  return (
    <>
      {dialog}
      {bulk.dialog}

      <Fade>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(agent) => agent.id}
          idPrefix="agents"
          onRowClick={(agent) => setDrawerId(agent.id)}
          rowClickIgnoreColumns={['select', 'name', 'actions']}
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search agents"
          searchText={(agent) => agent.name + ' ' + agent.title + ' ' + agent.slug}
          columnLabels={AGENT_COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Agent', plural: 'Agents' }}
          loading={org.loading && org.agents.length === 0}
          error={org.error ? <ServerOffline onRetry={() => void org.refresh()} /> : undefined}
          filters={
            <>
              <FilterCombobox
                label="Team"
                placeholder="Team"
                value={team}
                onChange={setTeam}
                options={[
                  { value: NO_TEAM, label: 'No team' },
                  ...org.teams.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
              />
              <FilterCombobox
                label="Permission"
                placeholder="Permission"
                value={permission}
                onChange={setPermission}
                options={[
                  { value: INHERITED, label: 'Default' },
                  ...PERMISSIONS.map((level) => ({
                    value: level,
                    label: PERMISSION_LABEL[level],
                  })),
                ]}
              />
            </>
          }
          bulkActions={(selected, clear) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void bulk.run({
                  rows: selected,
                  noun: { singular: 'Agent', plural: 'Agents' },
                  nameOf: (agent) => agent.name,
                  verb: 'archive',
                  done: 'archived',
                  confirmLabel: 'Archive',
                  icon: ArchiveIcon,
                  description:
                    'They will no longer accept assignments and will disappear from this list. ' +
                    'Assignments and memories will remain.',
                  run: (agent) => api.updateAgent(agent.id, { archived: true }),
                  after: org.refresh,
                  clear,
                })
              }
            >
              <ArchiveIcon data-icon="inline-start" />
              Archive
            </Button>
          )}
          empty={
            // The table's own `empty` fires when nothing was handed over at all -
            // which, with the facet filters applied before the hand-over, is also
            // what an empty filter result looks like. The two say different
            // things, so the page picks the right sentence.
            <Fade>
              {filtered ? (
                <NoResults onReset={resetEverything} />
              ) : (
                <EmptyState
                  icon={UserRoundIcon}
                  title="No agents hired yet"
                  description="Without agents, the assistant works alone. An agent is a separate process with its own instructions, Memory, and permission level."
                  actionLabel="Hire agent"
                  actionTo="/org/agents/new"
                  variant="plain"
                />
              )}
            </Fade>
          }
          filteredEmpty={
            <Fade>
              <NoResults query={search.trim() || undefined} onReset={resetEverything} />
            </Fade>
          }
        />
      </Fade>

      {filtered && rows.length > 0 ? (
        <Fade delay={50}>
          <div className="px-4 lg:px-6">
            <p className="text-xs text-muted-foreground">
              Filtered from <CountingNumber number={org.agents.length} /> active agents.{' '}
              <Button
                variant="link"
                className="h-auto gap-0 p-0 text-left align-baseline"
                onClick={clearFilters}
              >
                Clear filter
              </Button>
            </p>
          </div>
        </Fade>
      ) : null}

      <AgentDrawer
        agent={drawerAgent}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
        teamName={org.teams.find((entry) => entry.id === drawerAgent?.teamId)?.name ?? null}
        managerName={org.agentById(drawerAgent?.managerId)?.name ?? null}
      />
    </>
  );
}

/** What archiving costs, in the terms the reader cannot see from the row. */
function archiveDescription(
  agent: Agent,
  teams: readonly { id: string; name: string }[],
  agents: readonly Agent[],
): string {
  const teamName = teams.find((entry) => entry.id === agent.teamId)?.name;
  const reports = agents.filter((entry) => entry.managerId === agent.id).length;

  return [
    agent.name +
      ' will no longer accept assignments and will disappear from this list — the server ' +
      'no longer returns archived agents.',
    teamName ? 'The team ' + teamName + ' will lose a member.' : null,
    reports > 0
      ? formatNumber(reports) +
        (reports === 1 ? ' direct report will report' : ' direct reports will report') +
        ' to no one afterward.'
      : null,
    'Assignments and memories will remain.',
  ]
    .filter(Boolean)
    .join(' ');
}
