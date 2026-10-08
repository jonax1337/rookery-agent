import { useState } from 'react';

import { failureMessage } from '@/lib/errors';

export interface ProposalDecision {
  busy: boolean;
  /** Why the last attempt failed; `null` before the first attempt and while one runs. */
  error: string | null;
  submit(): Promise<void>;
}

/**
 * The one consequential click on a proposal card: busy while the call runs,
 * the failure kept on the card where the person just clicked.
 */
export function useProposalDecision(decide: () => Promise<void>): ProposalDecision {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await decide();
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, submit };
}
