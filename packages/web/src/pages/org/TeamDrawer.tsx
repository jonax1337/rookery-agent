import { NavLink } from 'react-router';

import { UserIcon as UserRoundIcon, UsersIcon } from '@/components/icons';

import { PERMISSION_LABEL } from '@/lib/format';
import { formatDateTime } from '@/lib/stats';
import type { Agent, Team } from '@/lib/types';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RelatedItem } from '@/components/common/related-item';
import { Button } from '@/components/ui/button';
import { ItemGroup } from '@/components/ui/item';

interface TeamDrawerProps {
  team: Team | null;
  members: readonly Agent[];
  leadName: string | null;
  onOpenChange(open: boolean): void;
}

export function TeamDrawer({ team, members, leadName, onOpenChange }: TeamDrawerProps) {
  return (
    <DetailDrawer
      open={team !== null}
      onOpenChange={onOpenChange}
      title={team?.name ?? 'Team'}
      description={team?.purpose || 'No purpose provided.'}
      footer={
        team ? (
          <Button asChild>
            <NavLink to={'/org/teams/' + team.id + '/edit'}>Edit</NavLink>
          </Button>
        ) : null
      }
    >
      {team ? (
        <>
          <Fade>
            <MetaList
              columns={1}
              items={[
                {
                  label: 'Lead',
                  value: leadName ?? 'No lead',
                  icon: UserRoundIcon,
                  ...(team.leadId ? { to: '/org/agents/' + team.leadId } : {}),
                },
                {
                  label: 'Members',
                  value: <CountingNumber number={members.length} />,
                  icon: UsersIcon,
                  to: '/org/agents?team=' + team.id,
                },
                { label: 'Created', value: formatDateTime(team.createdAt) },
                { label: 'Last updated', value: formatDateTime(team.updatedAt) },
              ]}
            />
          </Fade>

          <Fade delay={50}>
            <SectionHeading title="Who works here" size="sm" level="h3" flush>
              {members.length === 0 ? (
                <EmptyState
                  icon={UserRoundIcon}
                  title="No members in this team yet"
                  description="Assign the team in an agent’s profile to add that agent."
                  actionLabel="Hire agent"
                  actionTo="/org/agents/new"
                  variant="plain"
                  size="sm"
                />
              ) : (
                <ItemGroup className="gap-2">
                  {members.map((agent) => (
                    <RelatedItem
                      key={agent.id}
                      to={'/org/agents/' + agent.id}
                      title={agent.name}
                      description={agent.title + (agent.id === team.leadId ? ' · Lead' : '')}
                      trailing={
                        <span className="text-xs text-muted-foreground">
                          {agent.permission ? PERMISSION_LABEL[agent.permission] : 'Default'}
                        </span>
                      }
                    />
                  ))}
                </ItemGroup>
              )}
            </SectionHeading>
          </Fade>
        </>
      ) : null}
    </DetailDrawer>
  );
}
