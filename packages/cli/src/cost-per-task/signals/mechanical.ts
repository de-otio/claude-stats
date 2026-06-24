/**
 * Mechanical signal detectors — structural/behavioral signals that don't
 * require reading prompt text.
 *
 * Both signals produced here are "weak" by design: their registry weights
 * (truncation_high: 0.15, rework_abandoned: 0.25) are each below TAU_HI (0.5),
 * so neither can cross the success/failure threshold on its own. They refine
 * verdicts only in combination with other negative signals.
 */
import type { OutcomeSignal, TaskEvidence } from '../outcome-types.js';

/**
 * Fires when the assistant hit the token limit repeatedly (≥ 2 max_tokens stops).
 * Multiple truncations strongly suggest the response was never completed.
 */
export function truncationSignal(ev: TaskEvidence): OutcomeSignal | null {
  const count = ev.stopReasons.filter((r) => r === 'max_tokens').length;
  if (count >= 2) {
    return { id: 'truncation_high', value: -1, evidence: 'truncation_high' };
  }
  return null;
}

/**
 * Fires when the task made mutating edits but never produced a commit.
 *
 * Design note: this is a weak negative signal. A committed task with edits is
 * normal iteration (edit → commit) and produces null. An uncommitted task with
 * no edits at all is unobservable by this signal. Only the "edits present, no
 * commit" case fires — suggesting work started but was abandoned or left in an
 * unresolved state. The combiner's abstain band (|score| < TAU) handles the
 * ambiguous middle ground where this is the only signal; it will not push a
 * neutral base verdict past a threshold alone.
 */
export function reworkSignal(ev: TaskEvidence): OutcomeSignal | null {
  if (ev.editEvents.length > 0 && ev.committed === false) {
    return { id: 'rework_abandoned', value: -1, evidence: 'rework_abandoned' };
  }
  return null;
}
