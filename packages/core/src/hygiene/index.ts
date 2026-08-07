/**
 * Efficiency-hygiene — the self-audit layer.
 *
 * Runs the six detectors over one flat, timestamp-ordered message array,
 * applies per-detector suppression (`config.hygiene.suppressions[]`, Phase 0),
 * and reduces the result to a weekly-digest shape. Pure; the store query and
 * config plumbing live in `packages/cli/src/hygiene/index.ts`.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 */
import type { RateOverrides } from "../pricing.js";
import { detectCacheChurn } from "./cacheChurn.js";
import { detectRetryLoop } from "./retryLoop.js";
import { detectContextBloat } from "./contextBloat.js";
import { detectReEntryBurn } from "./reEntryBurn.js";
import { detectAbandonedSpend } from "./abandonedSpend.js";
import { detectTierMismatch } from "./tierMismatch.js";
import {
  DEFAULT_HYGIENE_THRESHOLDS,
  type HygieneDetectorId,
  type HygieneDetectorResult,
  type HygieneFinding,
  type HygieneMessageRow,
  type HygieneThresholds,
  type TierMismatchClassification,
} from "./types.js";

export type {
  HygieneDetectorId,
  HygieneDetectorResult,
  HygieneFinding,
  HygieneMessageRow,
  HygieneThresholds,
  TierMismatchClassification,
} from "./types.js";
export { DEFAULT_HYGIENE_THRESHOLDS } from "./types.js";
export { computeTierParity, detectTierMismatch, type TierParityComparison, type TierParityVerdict } from "./tierMismatch.js";

const TITLES: Record<HygieneDetectorId, string> = {
  "cache-churn": "Cache churn",
  "retry-loop": "Retry loop",
  "abandoned-spend": "Abandoned spend",
  "context-bloat": "Context bloat",
  "re-entry-burn": "Re-entry burn",
  "tier-mismatch": "Tier mismatch",
};

export interface RunHygieneDetectorsOptions {
  thresholds?: Partial<{ [K in keyof HygieneThresholds]: Partial<HygieneThresholds[K]> }>;
  /** Detector ids the user has dismissed as "not waste" (Phase 0 config). */
  suppressions?: readonly string[];
  rateOverrides?: RateOverrides;
  /**
   * Per-session task classification (`store.getTaskClass()`, mapped by
   * sessionId), the join key tier-mismatch needs that the message rows don't
   * carry. `undefined` means the classifier has NEVER run (the caller found
   * no `session_task_class` rows at all) — tier-mismatch reports
   * `computed: false` rather than an empty finding list, so "no mismatch"
   * and "nothing to compare yet" stay distinguishable (I1). A defined map —
   * even an empty one, e.g. the classifier ran but nothing in THIS window
   * matched — is a real "computed, found nothing" result.
   */
  taskClassBySession?: ReadonlyMap<string, TierMismatchClassification>;
}

function mergeThresholds(overrides: RunHygieneDetectorsOptions["thresholds"]): HygieneThresholds {
  if (!overrides) return DEFAULT_HYGIENE_THRESHOLDS;
  return {
    cacheChurn: { ...DEFAULT_HYGIENE_THRESHOLDS.cacheChurn, ...overrides.cacheChurn },
    retryLoop: { ...DEFAULT_HYGIENE_THRESHOLDS.retryLoop, ...overrides.retryLoop },
    contextBloat: { ...DEFAULT_HYGIENE_THRESHOLDS.contextBloat, ...overrides.contextBloat },
    reEntryBurn: { ...DEFAULT_HYGIENE_THRESHOLDS.reEntryBurn, ...overrides.reEntryBurn },
    abandonedSpend: { ...DEFAULT_HYGIENE_THRESHOLDS.abandonedSpend, ...overrides.abandonedSpend },
    tierMismatch: { ...DEFAULT_HYGIENE_THRESHOLDS.tierMismatch, ...overrides.tierMismatch },
  };
}

/**
 * Run all six detectors over one window's messages. Every detector always
 * runs (so a digest can report "N suppressed" honestly) — suppression only
 * hides the result, never skips the computation.
 */
export function runHygieneDetectors(
  rows: readonly HygieneMessageRow[],
  opts: RunHygieneDetectorsOptions = {},
): HygieneDetectorResult[] {
  const t = mergeThresholds(opts.thresholds);
  const suppressed = new Set(opts.suppressions ?? []);

  // Tier-mismatch is the one detector with an input every other detector
  // doesn't need (the task classifier's output) — its `computed` flag is
  // keyed on that map being defined at all (see `taskClassBySession` doc);
  // the other five only ever need the message rows, so they're always
  // computed.
  const tierMismatchComputed = opts.taskClassBySession !== undefined;

  const byDetector: Array<[HygieneDetectorId, HygieneFinding[], boolean, string | undefined]> = [
    ["cache-churn", detectCacheChurn(rows, t.cacheChurn, opts.rateOverrides), true, undefined],
    ["retry-loop", detectRetryLoop(rows, t.retryLoop, opts.rateOverrides), true, undefined],
    ["abandoned-spend", detectAbandonedSpend(rows, t.abandonedSpend, opts.rateOverrides), true, undefined],
    ["context-bloat", detectContextBloat(rows, t.contextBloat, opts.rateOverrides), true, undefined],
    ["re-entry-burn", detectReEntryBurn(rows, t.reEntryBurn, opts.rateOverrides), true, undefined],
    [
      "tier-mismatch",
      tierMismatchComputed ? detectTierMismatch(rows, opts.taskClassBySession!, t.tierMismatch, opts.rateOverrides) : [],
      tierMismatchComputed,
      tierMismatchComputed ? undefined : "Run the `task-class` command at least once to enable tier-mismatch reporting.",
    ],
  ];

  return byDetector.map(([detectorId, findings, computed, enablementPath]) => ({
    detectorId,
    title: TITLES[detectorId],
    findings,
    suppressed: suppressed.has(detectorId),
    computed,
    ...(enablementPath !== undefined ? { enablementPath } : {}),
  }));
}

/** The weekly-digest shape — "top waste patterns" plus the trend figure the
 *  justification pack's credibility section wants (I2: only the aggregate
 *  trend, never a per-session/per-dev feed, is meant to leave the machine, and
 *  even that only by the developer's explicit choice elsewhere). */
export interface HygieneDigest {
  /** Active (non-suppressed) results, most total waste first. */
  active: HygieneDetectorResult[];
  /** Detector ids currently suppressed, for an honest "N hidden" line. */
  suppressedIds: HygieneDetectorId[];
  /** Sum of `estimatedWaste` across all findings in `active`. */
  totalEstimatedWaste: number;
  /** Total findings across all active detectors (a session hit by two
   *  detectors counts twice — each is a separate, independently-checkable claim). */
  totalFindings: number;
}

/** Reduce detector results into the digest a card/tool renders. Suppressed
 *  detectors are excluded from `active` and `totalEstimatedWaste`, but their
 *  ids are still reported so the digest can say "N detectors are turned off"
 *  rather than silently looking clean. */
export function buildHygieneDigest(results: readonly HygieneDetectorResult[]): HygieneDigest {
  const active = results
    .filter((r) => !r.suppressed)
    .map((r) => r)
    .sort((a, b) => waste(b) - waste(a));
  const suppressedIds = results.filter((r) => r.suppressed).map((r) => r.detectorId);
  const totalEstimatedWaste = active.reduce((n, r) => n + waste(r), 0);
  const totalFindings = active.reduce((n, r) => n + r.findings.length, 0);
  return { active, suppressedIds, totalEstimatedWaste, totalFindings };
}

function waste(r: HygieneDetectorResult): number {
  return r.findings.reduce((n, f) => n + f.estimatedWaste, 0);
}
