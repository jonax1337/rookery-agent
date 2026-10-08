import { useCallback, useEffect, useState } from 'react';

import { useRecord } from '@/hooks/useRecord';
import { api } from '@/lib/api';
import type { AgentReview, AssignmentDetail, AssignmentStatus, AssignmentView } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

export interface AssignmentDetailHandle {
  /** The loaded record - always the one for the requested id, never a previous page's. */
  detail: AssignmentDetail | null;
  loading: boolean;
  /** The server said 404: the run is gone. */
  missing: boolean;
  /** Anything else that went wrong, as one sentence. */
  loadError: string | null;
  reload: () => Promise<void>;
  /** The socket's newest word about this run: moves while it works. */
  live: AssignmentView | undefined;
  /** The reviews for this run - at most one per source. */
  reviews: AgentReview[];
  /** Puts a just-saved review in place of the one from the same source. */
  addReview: (saved: AgentReview) => void;
}

/**
 * One assignment's record, kept fresh from the socket.
 *
 * Freshness comes from the socket, not from polling: `org.live[id]` carries
 * the newest word about this run, so the character count and the duration
 * move while it works, and the record is refetched exactly when the *status*
 * changes - which is the moment the payload gains a result, an error and a
 * duration the live view never had.
 */
export function useAssignmentDetail(id: string | undefined): AssignmentDetailHandle {
  const org = useOrgState();
  const { record, loading, missing, error: loadError, reload } = useRecord<AssignmentDetail>(
    id,
    api.assignment,
  );

  // `useRecord` keeps the previous record until the next answer arrives; after
  // navigating from a run to one of its children that would show the parent's
  // data under the child's address.
  const detail = record?.assignment.id === id ? record : null;

  // Kept in local state so saving a rating updates the star row instantly
  // instead of waiting for the next reload() the socket happens to trigger.
  const [reviews, setReviews] = useState<AgentReview[]>([]);
  useEffect(() => {
    setReviews(detail?.reviews ?? []);
  }, [detail?.reviews]);

  const addReview = useCallback((saved: AgentReview) => {
    setReviews((previous) => [saved, ...previous.filter((entry) => entry.source !== saved.source)]);
  }, []);

  const live = id ? org.live[id] : undefined;

  // Only the status drives the refetch: the live view's object identity
  // changes several times a second while a run streams, and reloading on each
  // of them is what made the old page flicker.
  const liveStatus: AssignmentStatus | undefined = live?.status;
  useEffect(() => {
    if (liveStatus) void reload();
  }, [liveStatus, reload]);

  return { detail, loading, missing, loadError, reload, live, reviews, addReview };
}
