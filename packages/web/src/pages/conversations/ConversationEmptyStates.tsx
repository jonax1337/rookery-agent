import { NavLink } from 'react-router';

import { EmptyState } from '@/components/common/empty-state';
import { MessageSquareIcon, SearchIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';

export function NoConversationsYet({ onNewConversation }: { onNewConversation(): void }) {
  return (
    <EmptyState
      icon={MessageSquareIcon}
      title="No conversations yet"
      description="Ask the first question — everything you discuss will be collected here."
      actionLabel="New conversation"
      onAction={onNewConversation}
      action={
        <Button variant="outline" asChild>
          <NavLink to="/voice">Speak</NavLink>
        </Button>
      }
      variant="plain"
    />
  );
}

interface NoMatchingConversationsProps {
  /** Offers "Reset filters" only when there is something to reset. */
  filtersActive: boolean;
  onReset(): void;
}

export function NoMatchingConversations({ filtersActive, onReset }: NoMatchingConversationsProps) {
  return (
    <EmptyState
      icon={SearchIcon}
      title="No conversations match this selection"
      description="Change the search, time period, or tab."
      actionLabel={filtersActive ? 'Reset filters' : undefined}
      onAction={onReset}
      variant="plain"
      size="sm"
    />
  );
}
