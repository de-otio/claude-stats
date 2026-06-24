/**
 * Phase-A accuracy contract for the cost-per-successful-task outcome model.
 *
 * This is the single dependency every Phase-A module builds against
 * (signals, combiner, evidence gatherer, integration). It owns the closed signal
 * registry, the default weights, the thresholds, and the evidence/lexicon types.
 *
 * Plan: ../../../plans/cost-per-successful-task-accuracy/README.md
 * Analysis: ../../../doc/analysis/cost-per-successful-task/ (06 §6.1–6.2, 07 §7.1)
 *
 * PRIVACY (load-bearing): no field in `OutcomeSignal`, `EvidenceTag`, or
 * `OutcomeVerdict` may ever carry prompt-derived text. The evidence channel is a
 * closed enum of *tags*, not free text. These types flow to the read-only MCP
 * server and the `serve` LAN path; a prompt substring leaking into them would
 * break the project's local-only guarantee. Detectors read prompt text but emit
 * only tags.
 */
import type { ProjectGitActivity } from '../recap/types.js';

/**
 * Four-state task outcome. `observable = success ∪ failed`; `in_flight` and
 * `unobservable` are deliberately held OUT of the success rate.
 */
export type TaskOutcome = 'success' | 'failed' | 'in_flight' | 'unobservable';

/**
 * Closed set of outcome-signal ids. Phase B/C/D append to this union (test/build
 * results, git revert/churn, PR review, LLM judge) without touching the combiner.
 */
export type SignalId =
  | 'base_ladder'        // legacy confidence/git ladder, encoded as a signal
  | 'repair_turn'        // a user follow-up rejected/corrected the work (negative)
  | 'acceptance_turn'    // a user follow-up accepted/approved the work (positive)
  | 'truncation_high'    // many max_tokens stops — incompleteness (negative, weak)
  | 'rework_abandoned';  // mutating edits, no commit, ended unresolved (negative, weak)

/** Evidence is reported as enum tags only — never prompt-derived text (see PRIVACY). */
export type EvidenceTag = SignalId;

/**
 * A single piece of outcome evidence. `value` is sign+magnitude in [-1, +1]:
 * positive = success-ward, negative = failure-ward. Detectors must clamp to range.
 */
export interface OutcomeSignal {
  readonly id: SignalId;
  readonly value: number;
  /** PRIVACY: enum tag only — no prompt text. */
  readonly evidence: EvidenceTag;
}

/** Registry entry: the calibration default for a signal. */
export interface SignalSpec {
  /** Default weight (overridable later by the calibration harness, 07 §7.3). */
  readonly defaultWeight: number;
  /** Expected direction — documentation + validation aid; detectors still clamp. */
  readonly direction: 'positive' | 'negative' | 'either';
}

/**
 * Default weights. UNCALIBRATED Phase-A placeholders chosen so that:
 *  - `base_ladder` is decisive on its own (a single base signal of ±1 clears τ);
 *  - no single weak signal can cross a threshold alone (each < |TAU_HI|);
 *  - the combiner only *refines* held-out (in_flight/unobservable) base verdicts.
 * The calibration harness (deferred, human checkpoint) replaces these.
 */
export const SIGNAL_REGISTRY: Readonly<Record<SignalId, SignalSpec>> = {
  base_ladder:      { defaultWeight: 1.0,  direction: 'either' },
  repair_turn:      { defaultWeight: 0.6,  direction: 'negative' },
  acceptance_turn:  { defaultWeight: 0.5,  direction: 'positive' },
  truncation_high:  { defaultWeight: 0.15, direction: 'negative' },
  rework_abandoned: { defaultWeight: 0.25, direction: 'negative' },
};

/** Decision thresholds on the combined score. Symmetric by design. */
export const TAU_HI = 0.5;
export const TAU_LO = -0.5;

/**
 * Evidence for one task, gathered from its messages (T0.5). Prompt text is held
 * in-process only and never leaves via a report payload — detectors consume it
 * and emit tags. All sequences are timestamp-ascending; ties broken by `uuid`
 * (the deterministic ordering the detectors rely on).
 */
export interface TaskEvidence {
  /**
   * User-authored prompt texts in this task's window, in turn order. These are the
   * follow-up turns the conversational detector scans. Already sanitised upstream
   * (system blocks stripped). NEVER copy these into an OutcomeSignal/verdict.
   */
  readonly userPrompts: readonly string[];
  /** Assistant `stopReason` per assistant message, in order (e.g. 'end_turn', 'max_tokens'). */
  readonly stopReasons: readonly string[];
  /** Ordered edit events: a mutating tool touching a file at a timestamp. */
  readonly editEvents: readonly EditEvent[];
  /**
   * Whether this task produced any commit (from `git.commitsToday > 0`). Commit
   * *timestamps* are not available (ProjectGitActivity is a count), so the rework
   * detector uses this boolean plus edit timing, not commit-vs-edit ordering.
   */
  readonly committed: boolean;
  /** End of the task's activity window (epoch ms) — for "ended shortly after edit" logic. */
  readonly lastActivityMs: number;
}

export interface EditEvent {
  readonly tool: string;
  readonly filePath: string;
  readonly ts: number;
}

/**
 * Repair/acceptance lexicon, injected so the multi-locale extension never edits
 * the detector. v1 default is English (see `EN_REPAIR_LEXICON` in the detector).
 * Phrases are matched literally (case-insensitive, word-boundary) — NO regex
 * backtracking surface (ReDoS guard, security review Sec-1).
 */
export interface RepairLexicon {
  /** Phrases signalling the model's output was wrong / must be redone (negative). */
  readonly repair: readonly string[];
  /** Phrases signalling acceptance / approval (positive). */
  readonly acceptance: readonly string[];
}

/** Input to the pure combiner. */
export interface CombineInput {
  /** The legacy-ladder verdict (labels/hidden already resolved upstream). */
  readonly base: TaskOutcome;
  /** Extra Tier-0 signals; empty ⇒ the verdict is exactly `base`. */
  readonly signals: readonly OutcomeSignal[];
  /** Optional weight overrides (calibration); defaults from SIGNAL_REGISTRY. */
  readonly weights?: Readonly<Partial<Record<SignalId, number>>>;
}

/** Output of the pure combiner. `labelled` is always false here (proxy); the
 *  label/hidden short-circuit lives in `classifyOutcome`, before the combiner. */
export interface OutcomeVerdict {
  readonly outcome: TaskOutcome;
  readonly labelled: boolean;
  readonly score: number;
  readonly evidence: readonly EvidenceTag[];
}

/** Re-export so detectors that reason about git can import from the contract. */
export type { ProjectGitActivity };
