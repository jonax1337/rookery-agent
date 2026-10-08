import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { BanIcon as CircleXIcon, CircleCheckIcon } from '@/components/icons';

import { reportFailure } from '@/lib/errors';
import { shorten } from '@/lib/format';
import {
  applyJudgement,
  feedbackKey,
  postMemoryFeedback,
  type MemoryFeedbackVerdict,
} from '@/lib/memory-recall';
import type { MemoryRecord } from '@/lib/types';
import type { Highlighted } from '@/providers/rookery-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Spinner } from '@/components/ui/spinner';

/** How much of the memory the verdict buttons' accessible names quote. */
const QUOTE_LENGTH = 40;

/**
 * The "was the point / was ballast" control on the rows the running turn's
 * recall highlighted (concept 4.2b, S6).
 *
 * What this page's own clicks have already told the dream is `judged`;
 * `pending` guards the moment between a click and its response.
 *
 * Returns `undefined` while there is nothing to vote on - no highlighted batch,
 * or no turn to post against - so the column stays out of the table: an
 * always-empty column would read as a vote that failed rather than as one that
 * was never offered.
 */
export function useRecallFeedback(
  highlighted: Highlighted,
): ((memory: MemoryRecord) => ReactNode) | undefined {
  const { turnId, ids } = highlighted;
  const [judged, setJudged] = useState<Record<string, MemoryFeedbackVerdict>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());

  const judge = useCallback(
    async (memory: MemoryRecord, verdict: MemoryFeedbackVerdict): Promise<void> => {
      if (!turnId) return;
      const key = feedbackKey(turnId, memory.id);
      if (key in judged || pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      try {
        await postMemoryFeedback(memory.id, turnId, verdict);
        setJudged((current) => applyJudgement(current, turnId, memory.id, verdict));
      } catch (caught) {
        reportFailure('Feedback', caught);
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [turnId, judged, pending],
  );

  return useMemo(() => {
    if (!turnId || ids.size === 0) return undefined;

    return (memory: MemoryRecord): ReactNode => {
      if (!ids.has(memory.id)) return null;
      const key = feedbackKey(turnId, memory.id);
      const verdict = judged[key];
      if (verdict) return <VerdictBadge verdict={verdict} />;
      return (
        <VerdictButtons
          name={shorten(memory.content, QUOTE_LENGTH)}
          busy={pending.has(key)}
          onJudge={(chosen) => void judge(memory, chosen)}
        />
      );
    };
  }, [ids, judge, judged, pending, turnId]);
}

function VerdictBadge({ verdict }: { verdict: MemoryFeedbackVerdict }) {
  const isPoint = verdict === 'point';
  return (
    <Badge variant={isPoint ? 'secondary' : 'outline'} className="gap-1">
      {isPoint ? <CircleCheckIcon aria-hidden="true" /> : <CircleXIcon aria-hidden="true" />}
      {isPoint ? 'Was the point' : 'Was ballast'}
    </Badge>
  );
}

function VerdictButtons({
  name,
  busy,
  onJudge,
}: {
  name: string;
  busy: boolean;
  onJudge(verdict: MemoryFeedbackVerdict): void;
}) {
  return (
    <ButtonGroup>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label={'Mark “' + name + '” as the point'}
        disabled={busy}
        onClick={() => onJudge('point')}
      >
        {busy ? <Spinner /> : <CircleCheckIcon aria-hidden="true" />}
      </Button>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label={'Mark “' + name + '” as ballast'}
        disabled={busy}
        onClick={() => onJudge('ballast')}
      >
        {busy ? <Spinner /> : <CircleXIcon aria-hidden="true" />}
      </Button>
    </ButtonGroup>
  );
}
