/**
 * Tier mismatch — a more expensive model tier on task classes where the
 * developer's own history shows a cheaper tier at parity.
 *
 * Three tiers are compared, at three boundaries: `top` (Opus) against `mid`
 * (Sonnet), and `frontier` (Fable, Mythos) against both. `frontier` is split
 * from `top` because it costs 2x: lumped together, the choice between Opus and
 * Fable, the most expensive routing decision a developer makes, was invisible.
 *
 * The scenario (constraint-impact/02-model-policy-impact.md, efficiency-hygiene
 * README): an org takes Opus away to save money, and nobody measures what
 * that cost in rework. This detector runs the same per-class comparison
 * *before* a manager has to ask the question, pointed at the developer's own
 * choices: "you kept using the top tier here even though your own history
 * shows the mid tier does just as well."
 *
 * EVIDENTIARY BAR — deliberately the highest of the six detectors, because a
 * false "parity" verdict tells a developer to downshift a class the top tier
 * actually helps on:
 *   1. Compared WITHIN task class, never in aggregate (a workload shift would
 *      otherwise masquerade as tier parity — constraint-impact/02 §2.2).
 *   2. Grain follows the classifier's own confidence: the FINE class when
 *      confidence supports it (medium/high), the COARSE class otherwise
 *      (spec's own words: "fine where its confidence supports it, coarse
 *      otherwise" — a session at LOW confidence contributes to the coarser,
 *      more reliable bucket rather than diluting a fine class that might be
 *      wrong).
 *   3. Every class gets a verdict, INCLUDING "top-tier-favored" and
 *      "insufficient-data" — a null result is reported, not dropped
 *      (constraint-impact/02 §2.3's two-sided obligation). `computeTierParity`
 *      is the honest full table; `detectTierMismatch` is the subset of it
 *      that becomes a card.
 *   4. Sample-size floor per tier (`minSessionsPerTier`, default 8): below it
 *      the class abstains rather than asserting parity on noise.
 *   5. Correlational, not causal, by construction and by wording: the rule
 *      text never says the top tier "wasted" a session, only that outcomes
 *      were comparable across a tier boundary IN THIS HISTORY — the exact
 *      caveat language the manager-facing report in constraint-impact/02
 *      §2.2 requires.
 *   6. Carries the task classifier's own §5.10 caveat: agreement is measured
 *      against the classifier's generated corpus, not human-labelled
 *      sessions — a strong signal, not proof.
 *
 * PROXY, STATED: "attempts per successful task" (constraint-impact/02 §2.1)
 * needs outcome detection, which this build does not yet calibrate (Lane K,
 * deferred). This detector uses TURNS (message count) and TOOL-ERROR RATE as
 * the available proxies for rework — coarser than the ideal metric, but
 * derived from data every session already has, and stated as a proxy rather
 * than dressed up as the real thing.
 */
import type { RateOverrides } from "../pricing.js";
import { modelTier, type ModelTier } from "../pricing.js";
// Shared percent formatter rather than a local one — `insight.ts`'s own doc
// warns that a hand-rolled percent formatter is exactly how a null ratio ends
// up rendered inconsistently with the rest of the product (`abandonedSpend.ts`
// reuses `formatMoney` from here for the same reason).
import { formatPercent } from "../insight.js";
import { groupBySession, messageCost } from "./util.js";
import type { HygieneFinding, HygieneMessageRow, HygieneThresholds, TierMismatchClassification } from "./types.js";

/** Verdict for one class's comparison at one boundary. Every class with a
 *  classified session on a boundary's tiers gets a row — a class that never
 *  clears `minSessionsPerTier` still appears, marked `insufficient-data`,
 *  so a report can say "N classes had too little data to compare" instead of
 *  silently having nothing to say about them. `top-tier-favored` means the
 *  HIGHER tier of the boundary did measurably better (the name predates the
 *  `frontier` tier and is kept for the existing consumers). */
export type TierParityVerdict = "parity" | "top-tier-favored" | "insufficient-data";

/** The tiers the detector compares (haiku and unknown sessions are outside the question). */
export type ComparedTier = "frontier" | "top" | "mid";

/** The three boundaries compared, higher tier first. Order is the output order within a class. */
export const TIER_BOUNDARIES: ReadonlyArray<{ boundary: TierBoundary; higher: ComparedTier; lower: ComparedTier }> = [
  { boundary: "top-vs-mid", higher: "top", lower: "mid" },
  { boundary: "frontier-vs-top", higher: "frontier", lower: "top" },
  { boundary: "frontier-vs-mid", higher: "frontier", lower: "mid" },
];

export type TierBoundary = "top-vs-mid" | "frontier-vs-top" | "frontier-vs-mid";

/**
 * One class at one boundary. The `*Top` fields describe the boundary's HIGHER
 * tier and the `*Mid` fields its LOWER tier (the names predate the `frontier`
 * tier: on `top-vs-mid` they are literally top and mid). `higherTier` /
 * `lowerTier` say which tiers a row compares.
 */
export interface TierParityComparison {
  /** The fine class name, or `coarse:<name>` when confidence didn't support
   *  the fine grain for enough of this class's sessions. */
  classKey: string;
  grain: "fine" | "coarse";
  boundary: TierBoundary;
  higherTier: ComparedTier;
  lowerTier: ComparedTier;
  verdict: TierParityVerdict;
  nTop: number;
  nMid: number;
  avgTurnsTop: number | null;
  avgTurnsMid: number | null;
  errorRateTop: number | null;
  errorRateMid: number | null;
  avgCostTop: number | null;
  avgCostMid: number | null;
  /** Higher-tier session ids in this class — the candidates a "parity" finding
   *  names as downshift-eligible. */
  topSessionIds: string[];
}

const CLASSIFIER_CAVEAT =
  "Class agreement is measured against the task classifier's generated corpus, not human-labelled sessions " +
  "(constraint-impact/05-task-class-spec.md §5.10) — a strong signal, not proof.";

interface ClassedSession {
  sessionId: string;
  classKey: string;
  grain: "fine" | "coarse";
  tier: ComparedTier;
  turns: number;
  toolErrors: number;
  cost: number;
}

/**
 * R1: which measures here read output tokens? Turn count and tool-error rate
 * (the parity VERDICT) read neither output nor stop reason, so flagged
 * (placeholder-output) rows keep counting there. Cost, and the dominant-tier
 * weighting built on cost, include output tokens, which on a flagged row are
 * a placeholder; those measures price a flagged row with its output excluded
 * (input and cache counts on such rows are real). This understates a flagged
 * session's cost rather than inventing output, the conservative direction for
 * an estimated-waste figure.
 */
function costExcludingPlaceholderOutput(m: HygieneMessageRow, overrides?: RateOverrides): number {
  return messageCost(m.outputPlaceholder ? { ...m, outputTokens: 0 } : m, overrides);
}

function sumCostExcludingPlaceholderOutput(messages: readonly HygieneMessageRow[], overrides?: RateOverrides): number {
  let total = 0;
  for (const m of messages) total += costExcludingPlaceholderOutput(m, overrides);
  return total;
}

function dominantTier(messages: readonly HygieneMessageRow[], overrides?: RateOverrides): ModelTier {
  const costByTier = new Map<ModelTier, number>();
  for (const m of messages) {
    if (!m.model) continue;
    const tier = modelTier(m.model);
    costByTier.set(tier, (costByTier.get(tier) ?? 0) + costExcludingPlaceholderOutput(m, overrides));
  }
  let best: ModelTier = "unknown";
  let bestCost = -1;
  for (const [tier, cost] of costByTier) {
    if (cost > bestCost) {
      best = tier;
      bestCost = cost;
    }
  }
  return best;
}

function avg(ns: readonly number[]): number | null {
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * Classify every session (with a known task class and a frontier-, top- or
 * mid-tier dominant model) into per-class tier groups and compare them at each
 * boundary. Pure; the full table, including null results — see module doc
 * point 3.
 *
 * Rows per class: `top-vs-mid` whenever the class has a top or mid session (as
 * before the `frontier` split); `frontier-vs-top` and `frontier-vs-mid` only
 * when the class has a frontier session, so a class that never used Fable gains
 * no phantom row.
 */
export function computeTierParity(
  rows: readonly HygieneMessageRow[],
  taskClassBySession: ReadonlyMap<string, TierMismatchClassification>,
  thresholds: HygieneThresholds["tierMismatch"],
  overrides?: RateOverrides,
): TierParityComparison[] {
  const sessions: ClassedSession[] = [];

  for (const group of groupBySession(rows)) {
    const cls = taskClassBySession.get(group.sessionId);
    // No stored classification, or the classifier itself abstained: excluded
    // rather than guessed at (I1 — no forced attribution).
    if (!cls || cls.fine === "unknown") continue;

    const tier = dominantTier(group.messages, overrides);
    // Only a frontier/top/mid question; haiku/unknown sessions don't inform it.
    // NOT redundant with the `top`/`mid` filters below (adversarial review
    // D2-R1 checked): those filters only decide who joins each SIDE of a
    // comparison, so without this skip a task class whose usage is entirely
    // haiku/unknown would still open a `byClass` bucket and emit a phantom
    // `insufficient-data` row — a report line implying the comparison was
    // attempted for a class that is outside the question altogether.
    if (tier !== "frontier" && tier !== "top" && tier !== "mid") continue;

    const supportsFine = cls.confidence !== "low";
    const grain: "fine" | "coarse" = supportsFine ? "fine" : "coarse";
    const classKey = supportsFine ? cls.fine : `coarse:${cls.coarse}`;

    sessions.push({
      sessionId: group.sessionId,
      classKey,
      grain,
      tier,
      turns: group.messages.length,
      toolErrors: group.messages.reduce((n, m) => n + m.toolErrorCount, 0),
      cost: sumCostExcludingPlaceholderOutput(group.messages, overrides),
    });
  }

  const byClass = new Map<string, ClassedSession[]>();
  for (const s of sessions) {
    const list = byClass.get(s.classKey);
    if (list) list.push(s);
    else byClass.set(s.classKey, [s]);
  }

  const comparisons: TierParityComparison[] = [];
  for (const [classKey, list] of byClass) {
    const grain = list[0]!.grain;
    for (const { boundary, higher, lower } of TIER_BOUNDARIES) {
      const hi = list.filter((s) => s.tier === higher);
      const lo = list.filter((s) => s.tier === lower);
      // Which boundaries a class gets a row for: see the doc above.
      const involved = higher === "frontier" ? hi.length > 0 : hi.length > 0 || lo.length > 0;
      if (!involved) continue;
      comparisons.push(compareBoundary(classKey, grain, boundary, higher, lower, hi, lo, thresholds));
    }
  }

  // Deterministic order for callers/tests/reports: by class, then by boundary
  // in `TIER_BOUNDARIES` order (the sort is stable).
  comparisons.sort((a, b) => a.classKey.localeCompare(b.classKey));
  return comparisons;
}

/** One class's verdict at one boundary: the original top-vs-mid arithmetic, over any pair of tiers. */
function compareBoundary(
  classKey: string,
  grain: "fine" | "coarse",
  boundary: TierBoundary,
  higherTier: ComparedTier,
  lowerTier: ComparedTier,
  top: readonly ClassedSession[],
  mid: readonly ClassedSession[],
  thresholds: HygieneThresholds["tierMismatch"],
): TierParityComparison {
  const nTop = top.length;
  const nMid = mid.length;

  const avgTurnsTop = avg(top.map((s) => s.turns));
  const avgTurnsMid = avg(mid.map((s) => s.turns));
  const avgCostTop = avg(top.map((s) => s.cost));
  const avgCostMid = avg(mid.map((s) => s.cost));

  const turnsTop = top.reduce((n, s) => n + s.turns, 0);
  const errorsTop = top.reduce((n, s) => n + s.toolErrors, 0);
  const turnsMid = mid.reduce((n, s) => n + s.turns, 0);
  const errorsMid = mid.reduce((n, s) => n + s.toolErrors, 0);
  const errorRateTop = turnsTop > 0 ? errorsTop / turnsTop : null;
  const errorRateMid = turnsMid > 0 ? errorsMid / turnsMid : null;

  let verdict: TierParityVerdict;
  // `nTop > 0 && nMid > 0` is required even when a caller configures
  // `minSessionsPerTier: 0` — "compare zero sessions against N" is not a
  // comparison, and without this an empty tier's null average would divide
  // against a nullish operand below (a landmine for a future maintainer
  // who trusts the type, not just the current arithmetic's accidental
  // safety).
  if (nTop === 0 || nMid === 0 || nTop < thresholds.minSessionsPerTier || nMid < thresholds.minSessionsPerTier) {
    verdict = "insufficient-data";
  } else {
    // avgTurnsTop/avgTurnsMid are never null here (nTop > 0 and nMid > 0
    // just above, and every session has >= 1 message), so this division
    // is safe.
    const turnsRatio = avgTurnsMid! / avgTurnsTop!;
    let errorRatio: number;
    if ((errorRateTop ?? 0) === 0) {
      errorRatio = (errorRateMid ?? 0) === 0 ? 1 : Infinity;
    } else {
      errorRatio = (errorRateMid ?? 0) / errorRateTop!;
    }
    // Deliberately ONE-SIDED (adversarial review D2-1): this only rejects
    // the lower tier being WORSE than the higher tier by more than the
    // tolerance. A class where the lower tier is dramatically BETTER (fewer
    // turns, fewer errors) also passes — and correctly so, since the
    // detector's purpose is "is the higher tier's extra cost buying anything
    // on this class", and a lower tier that outperforms answers that
    // question even more strongly than an exact tie would. The verdict
    // name "parity" is loose (it does not require the two tiers to be
    // *close*, only that the lower is not worse) — the finding's `rule` text
    // spells this out explicitly so a reader doesn't infer symmetry that
    // was never tested.
    const parity = turnsRatio <= 1 + thresholds.maxRelativeGap && errorRatio <= 1 + thresholds.maxRelativeGap;
    verdict = parity ? "parity" : "top-tier-favored";
  }

  return {
    classKey,
    grain,
    boundary,
    higherTier,
    lowerTier,
    verdict,
    nTop,
    nMid,
    avgTurnsTop,
    avgTurnsMid,
    errorRateTop,
    errorRateMid,
    avgCostTop,
    avgCostMid,
    topSessionIds: top.map((s) => s.sessionId),
  };
}

function labelFor(c: TierParityComparison): string {
  return c.grain === "coarse" ? `${c.classKey.slice("coarse:".length)} (coarse class)` : c.classKey;
}

/** How each compared tier is named in a finding. `adj` = "mid-tier", `noun` = "mid tier", `short` = "mid". */
const TIER_NAMES: Record<ComparedTier, { adj: string; noun: string; short: string }> = {
  frontier: { adj: "frontier-tier", noun: "frontier tier", short: "frontier" },
  top: { adj: "top-tier", noun: "top tier", short: "top" },
  mid: { adj: "mid-tier", noun: "mid tier", short: "mid" },
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtNum(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(1);
}

/**
 * The subset of `computeTierParity`'s table that becomes a card: classes at
 * "parity" with at least one higher-tier session (nothing to name as
 * downshift-eligible otherwise). `top-tier-favored` and `insufficient-data`
 * classes are computed but never fire — that is the detector working
 * correctly, not a gap (module doc point 3).
 */
export function detectTierMismatch(
  rows: readonly HygieneMessageRow[],
  taskClassBySession: ReadonlyMap<string, TierMismatchClassification>,
  thresholds: HygieneThresholds["tierMismatch"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const comparisons = computeTierParity(rows, taskClassBySession, thresholds, overrides);
  const findings: HygieneFinding[] = [];

  for (const c of comparisons) {
    // No `|| c.nTop === 0` guard here (removed — D2-3, confirmed dead):
    // `computeTierParity` already forces `insufficient-data` whenever
    // `nTop === 0` (its own `nTop === 0 || nMid === 0 || …` branch above),
    // so `verdict === "parity"` already implies `nTop > 0`. A second guard
    // for the same invariant just obscures that the first check is load-bearing.
    if (c.verdict !== "parity") continue;

    const label = labelFor(c);
    const estimatedWaste = Math.max(0, c.nTop * ((c.avgCostTop ?? 0) - (c.avgCostMid ?? 0)));
    const hi = TIER_NAMES[c.higherTier];
    const lo = TIER_NAMES[c.lowerTier];

    findings.push({
      detectorId: "tier-mismatch",
      sessionIds: c.topSessionIds,
      estimatedWaste,
      rule:
        `${cap(lo.adj)} sessions classified as "${label}" took no meaningfully more turns and errored no more often ` +
        `than ${hi.adj} sessions on the same class, over this history — correlation within your own usage, not a ` +
        `controlled comparison. (This is a one-sided check: it does not claim the tiers performed identically, ` +
        `only that the ${lo.noun} was not measurably worse.)`,
      threshold:
        `≥${thresholds.minSessionsPerTier} sessions per tier; turns and error-rate gap within ` +
        `${Math.round(thresholds.maxRelativeGap * 100)}%`,
      remedy: `Consider defaulting "${label}" tasks to the ${lo.noun} — this history shows no meaningful outcome gap.`,
      detail:
        `n(${hi.short})=${c.nTop}, n(${lo.short})=${c.nMid}; avg turns ${hi.short} ${fmtNum(c.avgTurnsTop)} vs ${lo.short} ${fmtNum(c.avgTurnsMid)}; ` +
        `tool-error rate ${hi.short} ${formatPercent(c.errorRateTop, 1)} vs ${lo.short} ${formatPercent(c.errorRateMid, 1)}. ${CLASSIFIER_CAVEAT}`,
    });
  }

  return findings;
}
