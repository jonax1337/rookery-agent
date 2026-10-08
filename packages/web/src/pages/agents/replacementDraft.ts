export interface ReplacementDraft {
  /** Why the agent is proposed for replacement - the text before the successor draft. */
  rationale: string;
  name: string;
  title: string;
  instructions: string;
}

// The slug in parentheses is part of the format but not of the draft the form edits.
const PROPOSAL_FORMAT =
  /^([\s\S]*?)\n\nProposed successor: (.+?) \(.+?\), (.+?)\.\n\n([\s\S]+)$/;

/**
 * Pulls the successor draft out of a stage-3 `probation` action's `reason`
 * text - see org/controller.ts#develop, which writes it.
 */
export function parseReplacementDraft(reason: string): ReplacementDraft | null {
  const match = reason.match(PROPOSAL_FORMAT);
  if (!match) return null;
  const [, rationale, name, title, instructions] = match;
  if (rationale === undefined || !name || !title || !instructions) return null;
  return { rationale, name, title, instructions };
}
