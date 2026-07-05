/**
 * Pure evidence combiner for the cost-per-successful-task outcome model (T3).
 *
 * Folds the legacy-ladder `base` verdict together with the Tier-0 signals into a
 * single {@link OutcomeVerdict}. Pure: no I/O, no mutation of inputs.
 *
 * Safety invariants enforced here (see plan 06 §6.1–6.2):
 *  - A decisive base (`success`/`failed`) is NEVER flipped by signals.
 *  - With no signals, a held-out base (`in_flight`/`unobservable`) stays held out
 *    — it can never become `failed`/`success` (score is 0, inside the band).
 *  - Signals only *refine* a held-out base, and only when they clear ±τ.
 *
 * Labels/hidden are resolved upstream in `classifyOutcome`; not handled here.
 */
import {
  SIGNAL_REGISTRY,
  TAU_HI,
  TAU_LO,
  type CombineInput,
  type EvidenceTag,
  type OutcomeVerdict,
  type SignalId,
} from './outcome-types.js';

/** Resolve a signal's weight: caller override wins, else the registry default. */
function weightOf(
  id: SignalId,
  weights: CombineInput['weights'],
): number {
  return weights?.[id] ?? SIGNAL_REGISTRY[id].defaultWeight;
}

export function combineOutcome(input: CombineInput): OutcomeVerdict {
  const { base, signals, weights } = input;

  // Decisive base wins, never flipped. Extra signals are ignored.
  if (base === 'success' || base === 'failed') {
    const w = weightOf('base_ladder', weights);
    return {
      outcome: base,
      labelled: false,
      score: base === 'success' ? w : -w,
      evidence: ['base_ladder'],
    };
  }

  // Held-out base (in_flight | unobservable): signals refine, base contributes 0.
  const score = signals.reduce(
    (acc, s) => acc + weightOf(s.id, weights) * s.value,
    0,
  );
  const evidence: readonly EvidenceTag[] = signals.map((s) => s.evidence);

  const outcome =
    score >= TAU_HI ? 'success' : score <= TAU_LO ? 'failed' : base;

  return { outcome, labelled: false, score, evidence };
}
