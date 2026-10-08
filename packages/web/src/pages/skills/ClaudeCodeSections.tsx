import { useCallback, useMemo, useState } from 'react';

import { BookTextIcon as BookOpenIcon, RefreshCwIcon } from '@/components/icons';

import { reportFailure } from '@/lib/errors';
import { formatNumber } from '@/lib/stats';
import type { ExternalHookSet, ExternalOverview } from '@/lib/types';
import { useExternal } from '@/hooks/useExternal';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import { AudienceSelect, ChangedBadge } from './approval-controls';
import {
  SOURCE_COLUMN_LABELS,
  SUBAGENT_COLUMN_LABELS,
  sourceColumns,
  subagentColumns,
  type SourceTally,
} from './external-columns';

/**
 * The other shelf: what the Claude Code on this machine has installed.
 *
 * These are read out of `~/.claude` and never copied here, so the sources
 * table has no name column that opens anything: what a source holds is found
 * with `find_skill` during a turn, not browsed here. The switch is the whole
 * decision - a single plugin can hold three hundred entries, which is why one
 * is never available until somebody says so.
 *
 * Subagent types come out of the same shelves. Each one carries its own
 * system prompt and tool list into a turn Rookery otherwise composes itself,
 * so none of them is handed over until somebody approved it - and the approval
 * is tied to the file as it was read: edit the agent in Claude Code and the
 * row goes back to "Changed" until it is looked at again.
 *
 * Every setter in `useExternal` rethrows after it has reloaded, so each call
 * here reports its failure instead of leaving it unhandled.
 */
export function ClaudeCodeSections() {
  const external = useExternal();
  const { overview } = external;
  const [agentSearch, setAgentSearch] = useState('');

  const sources = overview?.sources ?? [];
  const agents = overview?.agents ?? [];
  const hooks = overview?.hooks ?? [];
  const plugins = overview?.plugins ?? [];

  const tallies = useMemo(() => tallyPerSource(overview), [overview]);
  const pluginBySource = useMemo(
    () => new Map(plugins.map((plugin) => [plugin.sourceId, plugin])),
    [plugins],
  );
  const sourceLabels = useMemo(
    () => new Map(sources.map((source) => [source.id, source.label])),
    [sources],
  );
  const sourceLabelOf = useCallback(
    (sourceId: string) => sourceLabels.get(sourceId) ?? sourceId,
    [sourceLabels],
  );

  const sourceTableColumns = useMemo(
    () =>
      sourceColumns({
        tallies,
        pluginBySource,
        onToggleSource: (source, on) => void attempt(external.setSource(source, on)),
        onToggleLoadWhole: (plugin, on) =>
          void attempt(external.setPlugin(plugin, { loadWhole: on })),
      }),
    [external, pluginBySource, tallies],
  );

  const subagentTableColumns = useMemo(
    () =>
      subagentColumns({
        sourceLabelOf,
        onSetAudience: (agent, audience) => void attempt(external.setAgent(agent, { audience })),
        onApprove: (agent, enabled) => void attempt(external.setAgent(agent, { enabled })),
      }),
    [external, sourceLabelOf],
  );

  const offline = external.error ? <ServerOffline onRetry={() => void external.reload()} /> : undefined;

  return (
    <>
      <Fade delay={100}>
        <SectionHeading title="From Claude Code" hint={sourcesHint(overview)}>
          <DataTable
            data={sources}
            columns={sourceTableColumns}
            getRowId={(source) => source.id}
            idPrefix="skill-sources"
            columnLabels={SOURCE_COLUMN_LABELS}
            searchable
            searchPlaceholder="Search sources"
            searchText={(source) => source.label + ' ' + (source.plugin ?? '')}
            initialSorting={[{ id: 'skillCount', desc: true }]}
            rowLabel={{ singular: 'Source', plural: 'Sources' }}
            loading={external.loading}
            error={offline}
            actions={
              <Button size="sm" variant="outline" onClick={() => void attempt(external.rescan(), 'Reading')}>
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

      <Fade delay={150}>
        <SectionHeading title="Subagents from Claude Code" hint={subagentsHint(overview)}>
          <DataTable
            data={agents}
            columns={subagentTableColumns}
            getRowId={(agent) => agent.id}
            idPrefix="external-agents"
            columnLabels={SUBAGENT_COLUMN_LABELS}
            searchable
            search={agentSearch}
            onSearchChange={setAgentSearch}
            searchPlaceholder="Search subagents"
            searchText={(agent) => agent.name + ' ' + agent.description}
            initialSorting={[{ id: 'name', desc: false }]}
            rowLabel={{ singular: 'Subagent', plural: 'Subagents' }}
            loading={external.loading}
            error={offline}
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
                  query={agentSearch.trim() || undefined}
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
      {hooks.length ? (
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

              {hooks.map((set) => (
                <HookSetCard
                  key={set.sourceId}
                  set={set}
                  sourceLabel={sourceLabelOf(set.sourceId)}
                  onSetAudience={(audience) => void attempt(external.setHook(set, { audience }))}
                  onApprove={(enabled) => void attempt(external.setHook(set, { enabled }))}
                />
              ))}
            </div>
          </SectionHeading>
        </Fade>
      ) : null}
    </>
  );
}

/** Runs one of the setters; they rethrow after reloading, so the failure is reported here. */
function attempt(call: Promise<void>, action = 'Update'): Promise<void> {
  return call.catch((caught: unknown) => reportFailure(action, caught));
}

function tallyPerSource(overview: ExternalOverview | null): Map<string, SourceTally> {
  const tallies = new Map<string, SourceTally>();
  const tallyOf = (sourceId: string): SourceTally => {
    const existing = tallies.get(sourceId);
    if (existing) return existing;
    const created = { agents: 0, hooks: 0 };
    tallies.set(sourceId, created);
    return created;
  };
  for (const agent of overview?.agents ?? []) tallyOf(agent.sourceId).agents += 1;
  for (const set of overview?.hooks ?? []) tallyOf(set.sourceId).hooks += set.handlerCount;
  return tallies;
}

function sourcesHint(overview: ExternalOverview | null): string {
  const sources = overview?.sources ?? [];
  if (sources.length === 0) {
    return 'Nothing installed in the Claude Code on this machine, or reading it is switched off.';
  }
  const installed = sources.reduce((sum, source) => sum + source.skillCount, 0);
  // The server's own list, not the sum of the switched-on shelves: a name that
  // sits on two shelves counts once, which is also how the assistant sees it.
  const available = overview?.skills.length ?? 0;
  return (
    formatNumber(available) +
    ' of ' +
    formatNumber(installed) +
    ' installed skills are available. The assistant is told they exist and searches them when a task needs one.'
  );
}

function subagentsHint(overview: ExternalOverview | null): string {
  const agents = overview?.agents ?? [];
  if (agents.length === 0) {
    return 'No subagent types in the Claude Code on this machine, or reading it is switched off.';
  }
  return (
    formatNumber(agents.filter((agent) => agent.active).length) +
    ' of ' +
    formatNumber(agents.length) +
    ' subagent types are approved. An approved one can be delegated to during a turn; its prompt is read when the turn starts.'
  );
}

function HookSetCard({
  set,
  sourceLabel,
  onSetAudience,
  onApprove,
}: {
  set: ExternalHookSet;
  sourceLabel: string;
  onSetAudience(audience: ExternalHookSet['audience']): void;
  onApprove(enabled: boolean): void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{sourceLabel}</span>
          <span className="text-sm text-muted-foreground">
            {formatNumber(set.handlerCount)} handler(s) over {set.events.join(', ')}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {set.enabled && !set.active ? <ChangedBadge /> : null}
          <AudienceSelect
            value={set.audience}
            label={'Audience for the hooks of ' + sourceLabel}
            onChange={onSetAudience}
          />
          <Switch
            checked={set.enabled}
            aria-label={'Approve the hooks of ' + sourceLabel}
            onCheckedChange={onApprove}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{set.path}</p>
      {/* Wide content scrolls in its own box; the page never does. */}
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
        {set.commands.join('\n\n')}
      </pre>
    </div>
  );
}
