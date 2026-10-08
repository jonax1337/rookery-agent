import { useMemo } from 'react';
import { NavLink } from 'react-router';

import { FolderOpenIcon, MessageSquareIcon as MessagesSquareIcon } from '@/components/icons';

import { relativeTime, shorten } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Project, Session } from '@/lib/types';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RelatedItem } from '@/components/common/related-item';
import { Button } from '@/components/ui/button';
import { ItemGroup } from '@/components/ui/item';

/** How many conversations the drawer lists. A glance, not the archive. */
const DRAWER_SESSIONS = 5;

interface ProjectDrawerProps {
  project: Project | null;
  sessions: readonly Session[];
  capped: boolean;
  limit: number;
  onOpenChange(open: boolean): void;
}

export function ProjectDrawer({ project, sessions, capped, limit, onOpenChange }: ProjectDrawerProps) {
  // Newest first, so "the last five" means the last five.
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DRAWER_SESSIONS),
    [sessions],
  );

  return (
    <DetailDrawer
      open={project !== null}
      onOpenChange={onOpenChange}
      title={project?.name ?? 'Project'}
      description={project?.description || 'No description provided.'}
      footer={
        project ? (
          <Button asChild>
            <NavLink to={'/org/projects/' + project.id + '/edit'}>Edit</NavLink>
          </Button>
        ) : null
      }
    >
      {project ? (
        <>
          <MetaList
            columns={1}
            items={[
              {
                label: 'Directory',
                value: project.path ?? 'Workspace',
                icon: FolderOpenIcon,
                mono: Boolean(project.path),
              },
              {
                label: 'Conversations',
                value: <CountingNumber number={sessions.length} />,
                icon: MessagesSquareIcon,
              },
              {
                label: 'Basis',
                value: capped
                  ? 'counted across ' +
                    formatNumber(limit) +
                    ' loaded conversations — the server does not return more'
                  : null,
              },
              { label: 'Created', value: formatDateTime(project.createdAt) },
              { label: 'Last updated', value: formatDateTime(project.updatedAt) },
            ]}
          />

          <SectionHeading title="Last discussed" size="sm" level="h3" flush>
            {recent.length === 0 ? (
              <EmptyState
                icon={MessagesSquareIcon}
                title="No conversations for this project yet"
                description="Assign a conversation to this project using the project selector in the composer."
                actionLabel="View conversations"
                actionTo="/chats"
                variant="plain"
                size="sm"
              />
            ) : (
              <ItemGroup className="gap-2">
                {recent.map((session) => (
                  <RelatedItem
                    key={session.id}
                    to={'/c/' + session.id}
                    title={shorten(session.title, 70)}
                    description={
                      relativeTime(session.updatedAt) +
                      ' · ' +
                      formatNumber(session.messageCount) +
                      ' ' +
                      (session.messageCount === 1 ? 'Message' : 'Messages')
                    }
                  />
                ))}
              </ItemGroup>
            )}
          </SectionHeading>
        </>
      ) : null}
    </DetailDrawer>
  );
}
