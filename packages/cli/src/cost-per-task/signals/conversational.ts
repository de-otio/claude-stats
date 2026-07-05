/**
 * Conversational repair / acceptance detector (Phase-A, Tier-0).
 *
 * Scans follow-up turns (userPrompts[1..]) for literal repair or acceptance
 * phrases. The first prompt is the task's original request and is intentionally
 * excluded — a user asking "fix the bug" is not a verdict on any prior work.
 *
 * ReDoS guard: matching uses String.includes only — no regex.
 * PRIVACY: the detector consumes prompt text but emits only EvidenceTags.
 */

import type { TaskEvidence, OutcomeSignal, RepairLexicon } from '../outcome-types.js';

export const EN_REPAIR_LEXICON: RepairLexicon = {
  repair: [
    "that's wrong",
    "that is wrong",
    "still broken",
    "doesn't work",
    "does not work",
    "not working",
    "revert",
    "undo that",
    "that didn't work",
    "that did not work",
    "still failing",
    "still fails",
    "nope that's not",
    "that's not right",
    "wrong again",
  ],
  acceptance: [
    "that works",
    "works now",
    "perfect",
    "looks good",
    "lgtm",
    "ship it",
    "thanks that",
    "great that",
    "that's correct",
    "fixed it",
  ],
} as const;

/**
 * Detect repair or acceptance signals from conversational follow-up turns.
 *
 * Only prompts at index >= 1 are examined (index 0 is the task request itself).
 * Repair takes precedence over acceptance when both are present.
 *
 * @returns OutcomeSignal with id/value/evidence, or null when no verdict.
 */
export function conversationalSignal(
  ev: TaskEvidence,
  lexicon: RepairLexicon = EN_REPAIR_LEXICON,
): OutcomeSignal | null {
  // Follow-up turns only — exclude the initial task prompt (index 0).
  const followUps = ev.userPrompts.slice(1);

  if (followUps.length === 0) {
    return null;
  }

  let foundRepair = false;
  let foundAcceptance = false;

  for (const prompt of followUps) {
    const lower = prompt.toLowerCase();

    if (!foundRepair) {
      for (const phrase of lexicon.repair) {
        if (lower.includes(phrase)) {
          foundRepair = true;
          break;
        }
      }
    }

    if (!foundAcceptance) {
      for (const phrase of lexicon.acceptance) {
        if (lower.includes(phrase)) {
          foundAcceptance = true;
          break;
        }
      }
    }

    // Early exit: repair found, no need to scan further.
    if (foundRepair) break;
  }

  if (foundRepair) {
    return { id: 'repair_turn', value: -1, evidence: 'repair_turn' };
  }

  if (foundAcceptance) {
    return { id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' };
  }

  return null;
}
