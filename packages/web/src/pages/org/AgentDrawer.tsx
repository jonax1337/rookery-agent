import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';

import {
  BriefcaseBusinessIcon as Building2Icon,
  CpuIcon,
  DownloadIcon as InboxIcon,
  PenToolIcon as PencilIcon,
  ShieldCheckIcon as ShieldIcon,
  UsersIcon,
} from '@/components/icons';

import { api } from '@/lib/api';
import { PERMISSION_LABEL, relativeTime, shorten } from '@/lib/format';
import { formatDateTime } from '@/lib/stats';
import type { Agent, Assignment } from '@/lib/types';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { RelatedItem } from '@/components/common/related-item';
import { StatusBadge } from '@/components/common/status-badge';
import { ResultMarkdown } from '@/components/result-markdown';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';

/** How many past assignments the drawer fetches. A glance, not a history. */
const DRAWER_ASSIGNMENTS = 5;

/** Rows the skeleton holds while the assignments load. */
const SKELETON_ROWS = 3;

interface AgentDrawerProps {
  agent: Agent | null;
  onOpenChange(open: boolean): void;
  teamName: string | null;
  managerName: string | null;
}

/**
 * One agent at a glance, without leaving the table.
 *
 * The last assignments are fetched when the drawer opens rather than joined
 * into the list: `GET /api/org` carries no assignment history per agent, and
 * five rows for the one person being looked at is one request, not N.
 */
export function AgentDrawer({ agent, onOpenChange, teamName, managerName }: AgentDrawerProps) {
  const { recent, failed } = useRecentAssignments(agent?.id ?? null);

  return (
    <DetailDrawer
      open={agent !== null}
      onOpenChange={onOpenChange}
      title={agent?.name ?? 'Agent'}
      description={agent?.title}
      className="data-[vaul-drawer-direction=right]:sm:max-w-xl"
      footer={
        agent ? (
          <Button asChild>
            <NavLink to={'/org/agents/' + agent.id}>Open agent</NavLink>
          </Button>
        ) : null
      }
    >
      {agent ? (
        <>
          <InstructionsSection agent={agent} />
          <AgentFacts agent={agent} teamName={teamName} managerName={managerName} />
          <RecentRunsSection agent={agent} recent={recent} failed={failed} />
        </>
      ) : null}
    </DetailDrawer>
  );
}

function useRecentAssignments(agentId: string | null) {
  const [recent, setRecent] = useState<Assignment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setRecent(null);
    setFailed(false);
    if (!agentId) return;
    let cancelled = false;
    api
      .assignments({ agentId, limit: DRAWER_ASSIGNMENTS })
      .then((list) => {
        if (!cancelled) setRecent(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { recent, failed };
}

function InstructionsSection({ agent }: { agent: Agent }) {
  const instructions = agent.instructions.trim();

  return (
    <SectionHeading title="Instructions" size="sm" level="h3" flush>
      {instructions === '' ? (
        <EmptyState
          icon={PencilIcon}
          title="No custom instructions"
          description={agent.name + ' works only from the assignment text.'}
          actionLabel="Edit"
          actionTo={'/org/agents/' + agent.id + '/edit'}
          variant="plain"
          size="sm"
        />
      ) : (
        <>
          {/* Six lines is the fold; Tailwind needs the class spelled out. */}
          <div className="line-clamp-6">
            <ResultMarkdown text={instructions} />
          </div>
          {/* A fold, not a truncation: the whole text stays one click away. */}
          <Accordion type="single" collapsible>
            <AccordionItem value="full" className="border-b-0">
              <AccordionTrigger>Show full text</AccordionTrigger>
              <AccordionContent>
                <ResultMarkdown text={instructions} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      )}
    </SectionHeading>
  );
}

function AgentFacts({
  agent,
  teamName,
  managerName,
}: {
  agent: Agent;
  teamName: string | null;
  managerName: string | null;
}) {
  return (
    <MetaList
      columns={1}
      items={[
        { label: 'Slug', value: agent.slug, mono: true },
        {
          label: 'Team',
          value: teamName ?? 'No team',
          icon: Building2Icon,
          ...(agent.teamId ? { to: '/org/agents?team=' + agent.teamId } : {}),
        },
        {
          label: 'Manager',
          value: managerName ?? 'The assistant',
          icon: UsersIcon,
          ...(agent.managerId ? { to: '/org/agents/' + agent.managerId } : {}),
        },
        {
          label: 'Provider',
          value: (
            <ProviderCell
              layout="inline"
              fallback="Default"
              provider={agent.provider}
              model={agent.model}
            />
          ),
          icon: CpuIcon,
        },
        {
          label: 'Permission',
          value: agent.permission ? PERMISSION_LABEL[agent.permission] : 'Default',
          icon: ShieldIcon,
        },
        { label: 'Hired', value: formatDateTime(agent.createdAt) },
      ]}
    />
  );
}

function RecentRunsSection({
  agent,
  recent,
  failed,
}: {
  agent: Agent;
  recent: Assignment[] | null;
  failed: boolean;
}) {
  return (
    <SectionHeading title="Recent runs" size="sm" level="h3" flush>
      {failed ? (
        <ServerOffline size="sm" />
      ) : recent === null ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={'No assignments for ' + agent.name}
          description="Work runs in a separate process, independently of the conversation."
          actionLabel="Open agent"
          actionTo={'/org/agents/' + agent.id}
          variant="plain"
          size="sm"
        />
      ) : (
        <ItemGroup className="gap-2">
          {recent.map((assignment) => (
            <RelatedItem
              key={assignment.id}
              to={'/assignments/' + assignment.id}
              title={shorten(assignment.task, 80)}
              description={relativeTime(assignment.createdAt)}
              trailing={<StatusBadge kind="assignment" status={assignment.status} />}
            />
          ))}
        </ItemGroup>
      )}
    </SectionHeading>
  );
}
