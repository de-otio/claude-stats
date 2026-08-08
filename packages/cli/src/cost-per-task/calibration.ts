/**
 * Calibration metrics for the cost-per-successful-task outcome model.
 *
 * The auto/proxy success rate is only trustworthy to the extent it agrees with
 * ground truth. This module measures that agreement against the user's explicit
 * outcome labels (the ✓/~/✗ controls → corrections DB), so a human can decide
 * whether to turn the experimental signals on (doc 07 §7.3–7.5).
 *
 * Pure: data in → metrics out. No I/O. The eval set (labelled tasks + their
 * proxy/combined predictions) is assembled by `buildCalibrationReport` in
 * ./index.ts; this module only scores it.
 *
 * Privacy: operates on outcomes/scores only — never prompt text.
 */
import type { TaskOutcome } from './outcome-types.js';

const ALL_OUTCOMES: readonly TaskOutcome[] = ['success', 'failed', 'in_flight', 'unobservable'];

/**
 * Default precision floor for the `failed` class — the weak side of the proxy
 * (06 §6, 07 §7.4). A wrong "failed" is the costly error, so we gate on its
 * precision before trusting the rate. Tunable by the caller; this is a sane
 * starting point, not a calibrated constant.
 */
export const FAILED_PRECISION_FLOOR = 0.7;

/** One evaluated task: what the classifier predicted vs the user's label. */
export interface LabelledPair {
  readonly predicted: TaskOutcome;
  /** Ground truth, mapped from the user's outcome label. */
  readonly actual: TaskOutcome;
  /** Combined score in [-1, +1] for the with-signals path; null for proxy-only. */
  readonly score: number | null;
}

/** Per-class precision/recall/F1 (one-vs-rest). `null` where the denominator is 0. */
export interface ClassMetrics {
  readonly support: number;       // actual instances of this class
  readonly predicted: number;     // predicted instances of this class
  readonly truePositives: number;
  readonly precision: number | null; // TP / predicted   (null when predicted = 0)
  readonly recall: number | null;    // TP / support     (null when support  = 0)
  readonly f1: number | null;
}

export interface CalibrationMetrics {
  readonly n: number;                 // labelled pairs scored
  /**
   * Exact matches, as a COUNT. Carried alongside `accuracy` because the outcome
   * calibration gate (`cli/src/calibration/`) needs agreed/disagreed counts, and
   * recovering them as `round(accuracy * n)` reintroduces a float round-trip
   * into the denominator of an honesty figure.
   */
  readonly hits: number;
  readonly accuracy: number | null;   // exact-match rate over all pairs
  readonly observableN: number;       // pairs whose ACTUAL ∈ {success, failed}
  readonly perClass: Readonly<Record<TaskOutcome, ClassMetrics>>;
  /** Brier score over observable pairs that carry a score; lower is better. */
  readonly brier: number | null;
  readonly failedPrecision: number | null;
  readonly meetsFailedFloor: boolean;
}

export interface CalibrationReport {
  readonly n: number;
  readonly floor: number;
  /** Legacy proxy ladder vs labels. */
  readonly proxyOnly: CalibrationMetrics;
  /** Proxy ladder + Tier-0 signals (the combiner) vs labels. */
  readonly withSignals: CalibrationMetrics;
}

/** Map a user outcome label to the four-state outcome used for prediction. */
export function labelToOutcome(label: 'success' | 'partial' | 'fail'): TaskOutcome {
  return label === 'success' ? 'success' : label === 'fail' ? 'failed' : 'in_flight';
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** One-vs-rest metrics for a single class over the pairs. */
export function classMetricsFor(
  pairs: readonly LabelledPair[],
  cls: TaskOutcome,
): ClassMetrics {
  let support = 0;
  let predicted = 0;
  let truePositives = 0;
  for (const p of pairs) {
    if (p.actual === cls) support += 1;
    if (p.predicted === cls) predicted += 1;
    if (p.actual === cls && p.predicted === cls) truePositives += 1;
  }
  const precision = predicted > 0 ? truePositives / predicted : null;
  const recall = support > 0 ? truePositives / support : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { support, predicted, truePositives, precision, recall, f1 };
}

/** Pairs whose prediction equals the label. */
export function exactMatches(pairs: readonly LabelledPair[]): number {
  let hits = 0;
  for (const p of pairs) if (p.predicted === p.actual) hits += 1;
  return hits;
}

/** Exact-match accuracy over all pairs; null when there are none. */
export function accuracy(pairs: readonly LabelledPair[]): number | null {
  if (pairs.length === 0) return null;
  return exactMatches(pairs) / pairs.length;
}

/**
 * Brier score over observable pairs (actual ∈ {success, failed}) that carry a
 * score. The score in [-1,+1] is mapped to a success probability p=(score+1)/2;
 * the target y is 1 for an actual success, 0 for an actual failure. Returns null
 * when no such pair exists. Lower is better (0 = perfect, 0.25 = uninformative).
 */
export function brierScore(pairs: readonly LabelledPair[]): number | null {
  let sum = 0;
  let count = 0;
  for (const p of pairs) {
    if (p.score === null) continue;
    if (p.actual !== 'success' && p.actual !== 'failed') continue;
    const prob = (clamp(p.score, -1, 1) + 1) / 2;
    const y = p.actual === 'success' ? 1 : 0;
    sum += (prob - y) ** 2;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

/** Score a set of labelled pairs into the full calibration metrics. */
export function calibrationMetrics(
  pairs: readonly LabelledPair[],
  floor: number = FAILED_PRECISION_FLOOR,
): CalibrationMetrics {
  const perClass = Object.fromEntries(
    ALL_OUTCOMES.map((c) => [c, classMetricsFor(pairs, c)]),
  ) as Record<TaskOutcome, ClassMetrics>;

  const observableN = pairs.filter(
    (p) => p.actual === 'success' || p.actual === 'failed',
  ).length;

  const failedPrecision = perClass.failed.precision;
  return {
    n: pairs.length,
    hits: exactMatches(pairs),
    accuracy: accuracy(pairs),
    observableN,
    perClass,
    brier: brierScore(pairs),
    failedPrecision,
    meetsFailedFloor: failedPrecision !== null && failedPrecision >= floor,
  };
}
