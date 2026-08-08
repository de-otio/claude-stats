/**
 * Outcome calibration — turning "high confidence" from a label into a measured
 * claim, or refusing to state one.
 *
 * This suite attaches a confidence tier to a great many numbers: attribution
 * confidence, classifier confidence, hygiene findings. Every one of those is an
 * assertion about reliability that nothing has ever checked. The practice
 * contract forbids uncalibrated confidence numbers by name. This module is what
 * measures them — and, far more often, what says they cannot yet be measured.
 *
 * Pure: tallies in, an estimate out. No store, no clock, no I/O. Callers
 * (`cli/src/calibration/`) gather the labelled subset and hand it over.
 *
 * ── WHAT THE FIGURE ACTUALLY MEASURES (read this before quoting it) ──────────
 *
 * It is NOT the mechanism's accuracy, and the surfaces must never let it be
 * read as one.
 *
 * Ground truth here comes from corrections, and corrections are not a random
 * sample. A user rules on what they notice, and they notice a wrong answer far
 * more readily than a right one. So the denominator is "items you chose to rule
 * on", which is enriched for the mechanism's mistakes. What comes out is
 *
 *     agreement on the reviewed subset,
 *
 * which is biased DOWNWARD relative to accuracy over all items. That direction
 * is the only reason the figure is worth publishing at all: read as a floor it
 * is informative and safe, read as an accuracy it is a lie the report cannot
 * survive being caught in.
 *
 * The unit is chosen to keep that bias one-directional, which took some care:
 *
 *  - **Only EXPLICIT statements count.** Silence is never agreement. A user who
 *    tags a session with the right key and walks away, leaving a stale automatic
 *    link untombstoned, has not endorsed that link — counting the untouched link
 *    as "upheld" would bias the figure UPWARD and leave the net direction
 *    unknowable, which would make the number uninterpretable rather than merely
 *    conservative. So an automatic link counts only when the user made an
 *    explicit statement about that exact (session, key) pair.
 *  - **Misses are not disagreements.** A manual link naming a key the automatic
 *    pass never proposed is a RECALL failure, and folding it into a precision
 *    rate would conflate two different quantities into one meaningless one. It
 *    is counted separately (`unproposed`) and reported beside the rate, never
 *    inside it. Recall already has a home: the coverage denominator.
 *
 * Design: doc/analysis/constraint-impact/03-measurement-mechanics.md §Gap 5,
 *         doc/analysis/ticket-attribution/04-reporting-and-roi.md §4.2.
 */
import type { AttributionSource } from "./types/insight.js";

// ─── The minimum sample ───────────────────────────────────────────────────────

/**
 * Below this many explicit rulings, no rate is reported at all.
 *
 * Chosen from the **rule of three**, not from taste. With `n` observations and
 * zero disagreements, the 95% upper bound on the disagreement rate is
 * approximately `3/n`. So a PERFECT run of 29 rulings still cannot distinguish a
 * mechanism that errs one time in ten from one that never errs — the best
 * possible evidence at that sample size is consistent with a 10%+ error rate. At
 * n = 30 a clean sheet finally says "under 10%", which is the weakest statement
 * that is worth a reader's attention.
 *
 * The Wilson interval says the same thing from the other side: at n = 30 and a
 * point estimate near 0.9 the 95% interval is roughly [0.74, 0.97] — wide, but
 * bounded away from the "could be a coin flip" region that any smaller sample
 * sits in.
 *
 * An agreement rate computed from four corrections is noise wearing a percentage
 * sign, and publishing it would discredit every other figure in the report. The
 * floor is deliberately high enough that most stores will read "uncalibrated"
 * for a long time. That is the honest answer, and the enablement path is the
 * deliverable in that state.
 */
export const MIN_CALIBRATION_N = 30;

/** Two-sided 95% normal quantile — the `z` behind every interval here. */
export const WILSON_Z_95 = 1.959963984540054;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Which mechanism is being calibrated. A closed union: each member needs its own
 * ground-truth source, its own enablement sentence, and its own honest reading
 * of what "agreement" means, so a new subject is a deliberate addition and never
 * a free-text label.
 */
export type CalibrationSubject = "attribution" | "outcome";

/**
 * The window the rulings behind an estimate were gathered over.
 *
 * Required on every estimate, because the two subjects this suite ships do NOT
 * agree on it and nothing said so: attribution is gathered whole-store
 * (`getTicketLinkGrades` takes no date bound — a deliberate choice, since a
 * per-window cut of an already-scarce sample would read "uncalibrated" forever),
 * while outcome is gathered over the surface's own period. Both then rode on
 * period-scoped surfaces, side by side, in a feature whose entire subject is the
 * scope of a claim. A reader comparing "88% (n=41)" against "uncalibrated
 * (n=12)" had no way to know the first counted three years and the second
 * counted this week.
 *
 * The period members are spelled out rather than collapsed to one `"period"`
 * value on purpose. The dashboard caps an `all` period at a month for
 * performance (`attachCalibration`), so a sentence reading "over this period"
 * would be plainly WRONG on the very selection where the gap is widest. Naming
 * the actual window is the only wording that is true in every case.
 */
export type CalibrationScope = "whole-store" | "day" | "week" | "month" | "custom-range";

/** Explicit rulings, split by whether the mechanism was upheld. */
export interface ReviewTally {
  /** The user explicitly endorsed what the mechanism said. */
  readonly agreed: number;
  /** The user explicitly contradicted what the mechanism said. */
  readonly disagreed: number;
}

/** A confidence interval on the agreement rate. Both bounds in [0, 1]. */
export interface AgreementInterval {
  readonly lo: number;
  readonly hi: number;
}

export type CalibrationState = "measured" | "uncalibrated";

/**
 * One subject's calibration. `rate` and `interval` are BOTH null whenever
 * `state === "uncalibrated"` — the type makes "report a number below the
 * minimum" unrepresentable rather than merely discouraged, because a surface
 * that receives a number will render it.
 */
export interface CalibrationEstimate {
  readonly subject: CalibrationSubject;
  /** The window the rulings were gathered over — see {@link CalibrationScope}.
   *  Travels with the figure exactly as `minN` does, because a rate whose scope
   *  the reader has to assume is a claim stronger than its basis. */
  readonly scope: CalibrationScope;
  readonly state: CalibrationState;
  /** The denominator, always present. `agreed + disagreed`. */
  readonly n: number;
  readonly agreed: number;
  readonly disagreed: number;
  /** Agreement on the reviewed subset — NOT accuracy. Null when uncalibrated. */
  readonly rate: number | null;
  /** 95% Wilson score interval on `rate`. Null when uncalibrated. */
  readonly interval: AgreementInterval | null;
  /** The floor this estimate was gated against; travels with the figure. */
  readonly minN: number;
  /** Further rulings needed before a rate would be reported. 0 once measured. */
  readonly needed: number;
}

// ─── Interval ─────────────────────────────────────────────────────────────────

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Wilson score interval for a binomial proportion.
 *
 * Deliberately Wilson and not the textbook normal ("Wald") interval: Wald
 * degenerates exactly where this module operates. At `agreed = n` it returns the
 * zero-width interval [1, 1] — "100% agreement, no uncertainty" from a handful
 * of observations, which is the precise failure this whole module exists to
 * prevent. Wilson stays bounded inside (0, 1) and keeps real width at small `n`
 * and at extreme proportions.
 *
 * Returns [0, 1] for `n <= 0` — with no observations the rate could be anything,
 * and a degenerate interval would understate that.
 */
export function wilsonInterval(agreed: number, n: number, z: number = WILSON_Z_95): AgreementInterval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = agreed / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { lo: clamp01(centre - halfWidth), hi: clamp01(centre + halfWidth) };
}

// ─── Gating ───────────────────────────────────────────────────────────────────

/** What `calibrate` needs beyond the tally itself. */
export interface CalibrateOptions {
  /**
   * The window the tally was gathered over. REQUIRED, and deliberately not
   * defaulted: a default would let a caller ship a figure whose scope nobody
   * decided, which is the exact defect this field was added to close. Only the
   * gatherer knows the answer, so only the gatherer may state it.
   */
  readonly scope: CalibrationScope;
  readonly minN?: number;
}

/**
 * Fold a tally into a gated estimate.
 *
 * The gate is the point of the function: below `minN` it returns the
 * `uncalibrated` state with a null rate, and the caller has nothing to render a
 * percentage from even if it wanted to.
 */
export function calibrate(
  subject: CalibrationSubject,
  tally: ReviewTally,
  opts: CalibrateOptions,
): CalibrationEstimate {
  const minN = opts.minN ?? MIN_CALIBRATION_N;
  const agreed = Math.max(0, Math.trunc(tally.agreed));
  const disagreed = Math.max(0, Math.trunc(tally.disagreed));
  const n = agreed + disagreed;

  if (n < minN) {
    return {
      subject,
      scope: opts.scope,
      state: "uncalibrated",
      n,
      agreed,
      disagreed,
      rate: null,
      interval: null,
      minN,
      needed: minN - n,
    };
  }

  return {
    subject,
    scope: opts.scope,
    state: "measured",
    n,
    agreed,
    disagreed,
    rate: agreed / n,
    interval: wilsonInterval(agreed, n),
    minN,
    needed: 0,
  };
}

// ─── Attribution: folding ticket links into rulings ───────────────────────────

/**
 * One `ticket_links` row, reduced to the four fields calibration reads. Rows
 * arrive tombstones-included — a tombstone IS the disagreement signal, so the
 * usual "active links only" query would filter away half the evidence.
 */
export interface TicketLinkGrade {
  readonly sessionId: string;
  readonly ticketKey: string;
  readonly source: AttributionSource;
  readonly negated: boolean;
}

export interface AttributionReview extends ReviewTally {
  /**
   * Manual links naming a (session, key) pair the automatic pass never
   * proposed: the mechanism's RECALL misses.
   *
   * Reported beside the rate and never inside it (see the module header). Kept
   * out of the rendered prose as well — recall is what the coverage denominator
   * already reports on every surface that quotes an attributed figure, and a
   * second recall number in a precision caveat would read as if it qualified the
   * precision figure.
   */
  readonly unproposed: number;
}

/** `tag` is the manual source; everything else is written by extraction. */
const isManualSource = (source: AttributionSource): boolean => source === "tag";

/**
 * Composite key for one (session, key) pair.
 *
 * The separator is U+0000, written as an ESCAPE rather than as a literal byte:
 * a raw control character in a source file is invisible in a diff, breaks grep,
 * and is a hazard no reviewer can see. It is also the one delimiter that cannot
 * occur in either component (a session id is a UUID; a ticket key is validated
 * against a strict pattern in `tickets.ts`), so two distinct pairs can never
 * collide onto one key — which a naive `${a}-${b}` join could allow.
 */
const pairKey = (sessionId: string, ticketKey: string): string =>
  `${sessionId}\u0000${ticketKey}`;

/**
 * Fold every `ticket_links` row into explicit rulings on the automatic pass.
 *
 * One ruling per (session, key) pair that carries BOTH an automatic proposal and
 * a manual statement:
 *
 *  - manual affirmation (`tag`, not negated)  → **agreed**: the user looked at
 *    the pass's claim and endorsed it.
 *  - manual tombstone (`tag`, negated)        → **disagreed**: the user looked
 *    at the pass's claim and struck it out.
 *
 * A pair with only an automatic row was never ruled on and is not counted; a
 * pair with only a manual affirmation is an `unproposed` miss. Both exclusions
 * are argued in the module header — they are what keeps the remaining bias
 * one-directional.
 *
 * Extraction can write several source rows (branch, commit, prompt) for one
 * pair. They are one CLAIM about that pair, not three, so they collapse: the
 * unit of judgement is the pair, which is also the unit the user acts on.
 */
export function reviewAttributionLinks(rows: readonly TicketLinkGrade[]): AttributionReview {
  const proposed = new Set<string>();
  /** pair → the manual statement's polarity (true = tombstone). */
  const manual = new Map<string, boolean>();

  for (const row of rows) {
    const key = pairKey(row.sessionId, row.ticketKey);
    if (isManualSource(row.source)) {
      manual.set(key, row.negated);
      continue;
    }
    // A negated automatic row would be a tombstone the extractor never writes
    // (`runTicketExtraction` never sets `negated`, and `negateTicketLink` always
    // writes at `tag`). Guarded anyway: were one to exist, it is not a claim the
    // pass is making, so it must not become something the user can "uphold".
    if (!row.negated) proposed.add(key);
  }

  let agreed = 0;
  let disagreed = 0;
  let unproposed = 0;
  for (const [key, negated] of manual) {
    if (!proposed.has(key)) {
      // A tombstone on a pair the pass never proposed is pre-emptive — it rules
      // on nothing, so it is neither a disagreement nor a miss.
      if (!negated) unproposed += 1;
      continue;
    }
    if (negated) disagreed += 1;
    else agreed += 1;
  }

  return { agreed, disagreed, unproposed };
}
