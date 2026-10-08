import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import {
  cappedBadge,
  StatCards,
  StatCardsSkeleton,
  type StatCardProps,
} from '@/components/blocks/stat-cards';
import { LiveNumber } from '@/components/common/live-number';
import { newestSession } from '@/lib/conversation-filters';
import { relativeTime, timeAgo, UNTITLED_SESSION } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { Session, StatsTotals } from '@/lib/types';

interface ConversationStatCardsProps {
  sessions: readonly Session[];
  loading: boolean;
  /** The list sits on the server's limit, so figures derived from it are a floor. */
  capped: boolean;
  totals: StatsTotals | null;
}

export function ConversationStatCards({
  sessions,
  loading,
  capped,
  totals,
}: ConversationStatCardsProps) {
  if (loading && sessions.length === 0) return <StatCardsSkeleton />;

  const allConversations = totals ? totals.sessions + totals.archivedSessions : null;
  return (
    <Fade>
      <StatCards
        items={[
          conversationsCard(totals, allConversations),
          messagesCard(totals, allConversations),
          voiceCard(sessions, capped),
          lastActiveCard(newestSession(sessions)),
        ]}
      />
    </Fade>
  );
}

function conversationsCard(
  totals: StatsTotals | null,
  allConversations: number | null,
): StatCardProps {
  return {
    label: 'Conversations',
    value: allConversations === null ? '–' : <LiveNumber value={allConversations} />,
    headline:
      totals === null ? 'Loading totals' : formatNumber(totals.archivedSessions) + ' archived',
    footnote: 'All conversations, including archive',
  };
}

function messagesCard(totals: StatsTotals | null, allConversations: number | null): StatCardProps {
  return {
    label: 'Messages',
    value: totals === null ? '–' : <LiveNumber value={totals.messages} />,
    headline:
      totals === null || allConversations === null || allConversations === 0
        ? 'Nothing written yet'
        : 'Average ' +
          formatNumber(Math.round(totals.messages / allConversations)) +
          ' per conversation',
    footnote: 'All messages, including archive',
  };
}

function voiceCard(sessions: readonly Session[], capped: boolean): StatCardProps {
  const voice = sessions.filter((session) => session.kind === 'voice');
  const newestVoice = newestSession(voice);
  return {
    label: 'Voice conversations',
    value: <LiveNumber value={voice.length} />,
    // This one has no COUNT(*) behind it: /api/stats knows sessions,
    // not their kind. So it says which list it counted.
    ...cappedBadge(capped),
    headline: newestVoice ? 'Last run ' + timeAgo(newestVoice.updatedAt) : 'None yet',
    footnote: 'Based on ' + formatNumber(sessions.length) + ' loaded conversations',
  };
}

function lastActiveCard(newest: Session | null): StatCardProps {
  return {
    label: 'Last active',
    value: newest ? relativeTime(newest.updatedAt) : '–',
    headline: newest ? (
      <span className="line-clamp-1">{newest.title || UNTITLED_SESSION}</span>
    ) : (
      'No conversations yet'
    ),
    footnote: 'Last opened',
  };
}
