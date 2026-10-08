import type { PromotionNotice } from '../memory/sleep.js';

/**
 * The words that tell the user a retrieval policy went in force (S26,
 * concept 9.6).
 *
 * Everything quoted is a number, an id or the promotion's own stored
 * rationale, which carries no verbatim text by construction (E19/S21), so
 * the message can outlive the memories the evaluation stood on.
 */
export function promotionMessage(notice: PromotionNotice): { title: string; body: string } {
  const { version, evaluation } = notice;
  const audit = evaluation.auditCiLow === undefined ? '' : ', audit ci_low ' + evaluation.auditCiLow.toFixed(4);
  const body = [
    'A new ' + notice.slot + ' policy is in force for ' + notice.owner +
      ' (version ' + version.version + ').',
    '',
    notice.rationale,
    '',
    'delta ' + evaluation.delta.toFixed(4) +
      ', ci_low ' + evaluation.ciLow.toFixed(4) +
      ', over ' + evaluation.closed + ' of ' + evaluation.traces + ' traces' +
      audit + '.',
    'No further promotion of this slot before ' + new Date(notice.cooldownUntil).toISOString() + '.',
    '',
    'Take it back on its own: POST /api/dream/policies/' + version.id + '/revert' +
      (notice.prevActiveId ? ' (restores version ' + notice.prevActiveId + ').' : '.'),
    'Take the whole night back: undo sleep run ' + notice.runId + '.',
  ].join('\n');
  return {
    title: 'Retrieval policy ' + notice.slot + ' v' + version.version + ' is in force',
    body,
  };
}
