import { useCallback, useEffect, useState } from 'react';
import { StarIcon } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import type { AgentReview } from '@/lib/types';
import { cn } from '@/lib/utils';

const STARS = [1, 2, 3, 4, 5];

/**
 * A star rating plus an optional comment, for one finished assignment - the
 * "star row" from docs/concepts/agent-performance-management.md, phase 1.
 * A click on a star saves immediately (no confirm step, no dialog); the
 * comment saves on blur, but only once a rating exists to attach it to and
 * only when it changed.
 */
export function AssignmentReviewCard({
  assignmentId,
  review,
  onSaved,
}: {
  assignmentId: string;
  review: AgentReview | undefined;
  onSaved: (review: AgentReview) => void;
}) {
  const savedComment = review?.comment ?? '';
  const rating = review?.overall ?? 0;

  const [comment, setComment] = useState(savedComment);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setComment(savedComment);
  }, [review?.id, savedComment]);

  const save = useCallback(
    async (overall: number): Promise<void> => {
      setSaving(true);
      setError(null);
      try {
        const saved = await api.reviewAssignment(assignmentId, {
          overall,
          comment: comment.trim() || undefined,
        });
        onSaved(saved);
      } catch (caught) {
        setError(failureMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [assignmentId, comment, onSaved],
  );

  const saveEditedComment = (): void => {
    if (rating && comment.trim() !== savedComment) void save(rating);
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{rating ? 'Your rating' : 'Rate this run'}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StarRating value={rating} disabled={saving} onRate={(stars) => void save(stars)} />
        <Textarea
          placeholder="What was good or bad about this? (optional)"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onBlur={saveEditedComment}
          rows={2}
          disabled={saving}
        />
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function StarRating({
  value,
  disabled,
  onRate,
}: {
  value: number;
  disabled: boolean;
  onRate: (stars: number) => void;
}) {
  const [hover, setHover] = useState(0);

  return (
    <div className="flex items-center gap-1">
      {STARS.map((star) => (
        <button
          key={star}
          type="button"
          disabled={disabled}
          className="text-muted-foreground hover:text-status-warn disabled:opacity-60"
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onRate(star)}
          aria-label={'Rate ' + star + (star === 1 ? ' star' : ' stars')}
        >
          <StarIcon
            className={cn('size-5', (hover || value) >= star && 'fill-status-warn text-status-warn')}
          />
        </button>
      ))}
    </div>
  );
}
