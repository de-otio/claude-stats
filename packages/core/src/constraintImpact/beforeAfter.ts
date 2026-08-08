/**
 * Constraint before/after engine — the reason this build exists
 * (`doc/analysis/constraint-impact/`).
 *
 * An org cuts a token budget or removes a model tier. The bill falls, and
 * nobody measures what it cost in rework and elapsed time. This module makes
 * that measurable: it compares the windows either side of a DECLARED policy
 * boundary (`config.policyEvents` — never inferred, `03 §3.1`), per task
 * class, so a workload shift cannot masquerade as policy damage (`02 §2.2`).
 *
 * Pure: rows in, a report out. No store, no clock (the boundary is a date
 * string the caller already resolved), no I/O. The imperative shell
 * (`cli/src/constraintImpact/`) gathers the session rows and the task-class
 * map and calls `compareConstraintImpact`.
 *
 * ── SCOPE (read before extending or quoting this report) ───────────────────
 *
 * `02 §2.1`'s table lists "attempts per successful task" — the recap task-
 * clustering pipeline's four-state outcome — as one of the metrics this
 * engine should report. This module does NOT compute it, on purpose:
 *
 *  1. The recap "task" (a topic-segment cluster, `cli/src/recap/segment.ts` /
 *     `cluster.ts`) has no identity across a months-long boundary — precisely
 *     the instability Gap 1 in `03-measurement-mechanics.md` built the
 *     session-level classifier to sidestep. Joining a recap task to a task
 *     class through its (possibly several) `sessionIds` would reintroduce
 *     that instability at the join.
 *  2. The outcome proxy behind that pipeline is not calibrated at session
 *     grain (`core/calibration.ts`'s header: agreement is measured on a
 *     self-selected correction sample and is a floor, not an accuracy).
 *     Building a policy-boundary verdict on an uncalibrated outcome model is
 *     the exact failure this build's review rounds keep finding.
 *
 * Instead this engine follows the precedent the tier-mismatch detector
 * already set for the identical honesty problem (`core/hygiene/
 * tierMismatch.ts`, "PROXY, STATED"): TURNS (message count) and TOOL-ERROR
 * RATE stand in for rework, stated as a proxy, never dressed up as the real
 * thing. Alongside them: the two channels `01 §1.3` argues are decisive
 * anyway — active dev-minutes and tokens — plus cost. A recap-task-grained,
 * calibrated "attempts" metric remains a real gap for a later phase, not a
 * silent omission; `NOT_MEASURED` names it so a report consumer sees the gap
 * rather than inferring completeness (I1).
 */
import type { PolicyEvent } from "../types/insight.js";
import type { TaskClass, CoarseTaskClass, Confidence } from "../types/insight.js";
import { classificationGrain } from "../taskClass/index.js";
import { trendOf } from "../insight.js";

// ─── Scope + defaults ──────────────────────────────────────────────────────────

/** Named so a report can state what it deliberately does not measure, rather
 *  than a reader inferring completeness from silence — see the module header. */
export const NOT_MEASURED = [
  "attempts-per-successful-task (recap-task grain; see module header SCOPE)",
  "throttle wait / re-entry hours (constraint-impact/03 §3.2 Gap 2)",
  "escalation chains (constraint-impact/03 §3.2 Gap 3)",
] as const;

/**
 * Below this many sessions on EITHER side, a class abstains rather than
 * asserting a delta on noise. Same default as tier-mismatch's
 * `minSessionsPerTier` — the two comparisons ask a structurally similar
 * question (top-vs-mid, before-vs-after) and share a floor for consistency,
 * not because 8 is independently derived here.
 */
export const DEFAULT_MIN_SESSIONS_PER_CLASS = 8;

const CONFOUND_NOTE =
  "Evidence, not proof (constraint-impact/02 §2.2): workload, team, and codebase all move alongside a " +
  "policy boundary. This report compares WITHIN task class specifically to reduce that confound, never to " +
  "eliminate it. Model VERSION changes are visible in modelsBefore/modelsAfter (a model-tier removal is one " +
  "event on an honest timeline, not the only one); pricing-table updates and team-size changes are NOT " +
  "tracked here and should be checked by hand before these numbers are quoted to anyone outside the team.";

/** A net effect smaller than this many dollars, or than this fraction of the
 *  class's token savings (whichever is larger), reads as "negligible" rather
 *  than a false-precision favorable/unfavorable call. */
const NEGLIGIBLE_NET_FLOOR = 1;
const NEGLIGIBLE_NET_FRACTION = 0.1;

// ─── Input shape ────────────────────────────────────────────────────────────────

/**
 * One session's contribution to the comparison — the narrow projection the
 * engine needs. Built by the CLI glue from `getMessagesForHygiene` (cost,
 * tokens, turns, tool errors, models — all message-sourced, the same rows
 * `core/hygiene` prices) and `getSessions` (active dev-minutes, median
 * response time — session-aggregate columns with no message-level analogue
 * to disagree with).
 */
export interface ConstraintImpactSessionRow {
  readonly sessionId: string;
  readonly cost: number;
  readonly tokensTotal: number;
  readonly turns: number;
  readonly toolErrors: number;
  /** Null when the session predates the `active_duration_ms` column or the
   *  parser never recorded it — excluded from the average, never treated as
   *  zero (a silent zero would understate shepherding cost). */
  readonly activeDurationMs: number | null;
  readonly medianResponseTimeMs: number | null;
  /** Distinct model ids used in this session — the confound annotation
   *  (`02 §2.2` point 3: "model version bumps ... visible in the per-message
   *  model strings"). */
  readonly models: readonly string[];
}

/**
 * Everything the classifier knows about one session. Structurally identical
 * to `core/hygiene`'s `TierMismatchClassification` — deliberately not
 * imported from there (hygiene is a downstream consumer of task-class, not a
 * dependency of it); the shape is duck-typed so either satisfies this.
 */
export interface ConstraintImpactClassification {
  readonly fine: TaskClass;
  readonly coarse: CoarseTaskClass;
  readonly confidence: Confidence;
}

// ─── Output shape ───────────────────────────────────────────────────────────────

export type ClassImpactVerdict = "compared" | "insufficient-data";

/** `insight.ts#trendOf`'s own vocabulary, reused rather than re-invented. */
export type Trend = ReturnType<typeof trendOf>;

export type ImpactDirection = "favorable" | "unfavorable" | "negligible" | "unknown";

/**
 * One task class's before/after comparison. Every class with at least one
 * session on either side gets a row, INCLUDING `insufficient-data` — a null
 * result is reported, not dropped (`02 §2.3`'s two-sided obligation: the
 * report says where it has nothing to say, rather than looking complete).
 */
export interface ClassImpactComparison {
  /** The fine class name, or `coarse:<name>` when confidence didn't support
   *  the fine grain for enough of this class's sessions. */
  readonly classKey: string;
  readonly grain: "fine" | "coarse";
  readonly verdict: ClassImpactVerdict;
  /** The floor this verdict was gated against; travels with the figure. */
  readonly minSessionsPerClass: number;
  readonly nBefore: number;
  readonly nAfter: number;

  readonly avgCostBefore: number | null;
  readonly avgCostAfter: number | null;
  /** Distribution signal, not just the mean (`02 §2.2` point 2: one
   *  pathological task must not carry the argument). */
  readonly medianCostBefore: number | null;
  readonly medianCostAfter: number | null;
  readonly costTrend: Trend;

  readonly avgTokensBefore: number | null;
  readonly avgTokensAfter: number | null;
  readonly tokensTrend: Trend;

  /** Rework proxy — see module SCOPE. Messages per session. */
  readonly avgTurnsBefore: number | null;
  readonly avgTurnsAfter: number | null;
  readonly turnsTrend: Trend;

  /** Rework proxy — see module SCOPE. Σ tool errors / Σ turns across the
   *  side's sessions, not a mean of per-session rates (a quiet session must
   *  not out-vote a busy one). */
  readonly toolErrorRateBefore: number | null;
  readonly toolErrorRateAfter: number | null;
  readonly toolErrorRateTrend: Trend;

  /** Shepherding cost (`01 §1.3`). */
  readonly avgActiveMinutesBefore: number | null;
  readonly avgActiveMinutesAfter: number | null;
  readonly activeMinutesTrend: Trend;
  /** Sessions WITH a non-null `active_duration_ms`, out of `nBefore`/`nAfter`
   *  — the coverage denominator for the average beside it. */
  readonly activeMinutesCoverageBefore: number;
  readonly activeMinutesCoverageAfter: number;

  readonly medianResponseMsBefore: number | null;
  readonly medianResponseMsAfter: number | null;
  readonly medianResponseTrend: Trend;

  /** Confound annotation — distinct models used, sorted. */
  readonly modelsBefore: readonly string[];
  readonly modelsAfter: readonly string[];

  /**
   * Money at the AFTER period's volume: `(avgCostBefore - avgCostAfter) *
   * nAfter` — what these `nAfter` sessions would have cost under the old
   * per-session average, minus what they actually cost. Positive = the
   * policy saved money. Null when `verdict !== "compared"`.
   */
  readonly tokenSavingsAtAfterVolume: number | null;

  /**
   * Dev-time cost at the AFTER period's volume, in minutes:
   * `(avgActiveMinutesAfter - avgActiveMinutesBefore) * nAfter`. Positive =
   * MORE dev time now (a cost, not a saving). Null when either side has no
   * active-minutes coverage, or `verdict !== "compared"`.
   */
  readonly devTimeDeltaMinutesAtAfterVolume: number | null;

  /**
   * `devTimeDeltaMinutesAtAfterVolume` priced at the configured hourly rate.
   * Null absent a configured rate — NEVER an invented one (`01 §1.3`) — or
   * absent `devTimeDeltaMinutesAtAfterVolume`.
   */
  readonly devTimeCostAtAfterVolume: number | null;

  /**
   * `tokenSavingsAtAfterVolume - devTimeCostAtAfterVolume`. Positive = net
   * favourable to the policy at this class's after-period volume. Null
   * whenever either term is null — most commonly, no hourly rate configured.
   */
  readonly netEffectAtAfterVolume: number | null;

  /**
   * Loose direction read off `netEffectAtAfterVolume`, for the two-sided
   * top-line (`02 §2.3`). `"unknown"` whenever the net figure is null — NEVER
   * inferred from cost alone: a token saving with no dev-time data is
   * evidence of an unmeasured class, not a favourable one.
   */
  readonly direction: ImpactDirection;
}

export interface ConstraintImpactReport {
  readonly policyEvent: PolicyEvent;
  /** UTC-midnight epoch-ms the before/after split happened at. */
  readonly boundaryMs: number;
  readonly minSessionsPerClass: number;
  /** Null when no rate is configured — the salary denominator never runs on
   *  an invented number (`01 §1.3`, Gap 4). */
  readonly hourlyRate: number | null;
  readonly currency: string;
  readonly classes: readonly ClassImpactComparison[];
  readonly classesCompared: number;
  readonly classesInsufficientData: number;
  /** Σ `tokenSavingsAtAfterVolume` over COMPARED classes only. Null when no
   *  class cleared the floor. */
  readonly totalTokenSavings: number | null;
  /** Σ `devTimeCostAtAfterVolume` over compared classes with a priced delta.
   *  Null whenever `hourlyRate` is null. */
  readonly totalDevTimeCost: number | null;
  readonly totalNetEffect: number | null;
  readonly netEffectAvailable: boolean;
  readonly notMeasured: readonly string[];
  readonly confoundNote: string;
}

// ─── Boundary ───────────────────────────────────────────────────────────────────

/**
 * UTC-midnight epoch-ms for a policy event's `YYYY-MM-DD` date.
 *
 * UTC, not the host's local timezone: a policy boundary is a calendar fact
 * declared once in shared config, and tz-local parsing would make the SAME
 * config produce a DIFFERENT boundary depending on which machine runs the
 * report — worse than a boundary that is consistently a few hours early or
 * late for a non-UTC developer.
 */
export function parsePolicyEventBoundaryMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

// ─── Arithmetic helpers ─────────────────────────────────────────────────────────

function mean(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function median(ns: readonly number[]): number | null {
  if (ns.length === 0) return null;
  const sorted = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function distinctModels(rows: readonly ConstraintImpactSessionRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const m of r.models) set.add(m);
  return [...set].sort();
}

function coverageOf(rows: readonly ConstraintImpactSessionRow[]): number {
  return rows.filter((r) => r.activeDurationMs !== null).length;
}

function classifyDirection(net: number | null, scale: number): ImpactDirection {
  if (net === null) return "unknown";
  const epsilon = Math.max(NEGLIGIBLE_NET_FLOOR, Math.abs(scale) * NEGLIGIBLE_NET_FRACTION);
  if (Math.abs(net) < epsilon) return "negligible";
  return net > 0 ? "favorable" : "unfavorable";
}

// ─── Grouping ───────────────────────────────────────────────────────────────────

interface ClassGroup {
  grain: "fine" | "coarse";
  rows: ConstraintImpactSessionRow[];
}

function groupByClass(
  rows: readonly ConstraintImpactSessionRow[],
  taskClassBySession: ReadonlyMap<string, ConstraintImpactClassification>,
): Map<string, ClassGroup> {
  const map = new Map<string, ClassGroup>();
  for (const row of rows) {
    const cls = taskClassBySession.get(row.sessionId);
    // No stored classification, or the classifier itself abstained: excluded
    // rather than guessed at (I1 — no forced attribution). Mirrors
    // tier-mismatch's own rule for the identical join.
    if (!cls || cls.fine === "unknown") continue;
    const { classKey, grain } = classificationGrain(cls);
    let group = map.get(classKey);
    if (!group) {
      group = { grain, rows: [] };
      map.set(classKey, group);
    }
    group.rows.push(row);
  }
  return map;
}

// ─── Per-class comparison ───────────────────────────────────────────────────────

function insufficientDataRow(
  classKey: string,
  grain: "fine" | "coarse",
  minSessionsPerClass: number,
  beforeRows: readonly ConstraintImpactSessionRow[],
  afterRows: readonly ConstraintImpactSessionRow[],
): ClassImpactComparison {
  return {
    classKey,
    grain,
    verdict: "insufficient-data",
    minSessionsPerClass,
    nBefore: beforeRows.length,
    nAfter: afterRows.length,
    avgCostBefore: null,
    avgCostAfter: null,
    medianCostBefore: null,
    medianCostAfter: null,
    costTrend: "unknown",
    avgTokensBefore: null,
    avgTokensAfter: null,
    tokensTrend: "unknown",
    avgTurnsBefore: null,
    avgTurnsAfter: null,
    turnsTrend: "unknown",
    toolErrorRateBefore: null,
    toolErrorRateAfter: null,
    toolErrorRateTrend: "unknown",
    avgActiveMinutesBefore: null,
    avgActiveMinutesAfter: null,
    activeMinutesTrend: "unknown",
    activeMinutesCoverageBefore: coverageOf(beforeRows),
    activeMinutesCoverageAfter: coverageOf(afterRows),
    medianResponseMsBefore: null,
    medianResponseMsAfter: null,
    medianResponseTrend: "unknown",
    modelsBefore: distinctModels(beforeRows),
    modelsAfter: distinctModels(afterRows),
    tokenSavingsAtAfterVolume: null,
    devTimeDeltaMinutesAtAfterVolume: null,
    devTimeCostAtAfterVolume: null,
    netEffectAtAfterVolume: null,
    direction: "unknown",
  };
}

function compareOneClass(
  classKey: string,
  grain: "fine" | "coarse",
  beforeRows: readonly ConstraintImpactSessionRow[],
  afterRows: readonly ConstraintImpactSessionRow[],
  minSessionsPerClass: number,
  hourlyRate: number | null,
): ClassImpactComparison {
  const nBefore = beforeRows.length;
  const nAfter = afterRows.length;
  if (nBefore < minSessionsPerClass || nAfter < minSessionsPerClass) {
    return insufficientDataRow(classKey, grain, minSessionsPerClass, beforeRows, afterRows);
  }

  const avgCostBefore = mean(beforeRows.map((r) => r.cost));
  const avgCostAfter = mean(afterRows.map((r) => r.cost));
  const medianCostBefore = median(beforeRows.map((r) => r.cost));
  const medianCostAfter = median(afterRows.map((r) => r.cost));

  const avgTokensBefore = mean(beforeRows.map((r) => r.tokensTotal));
  const avgTokensAfter = mean(afterRows.map((r) => r.tokensTotal));

  const avgTurnsBefore = mean(beforeRows.map((r) => r.turns));
  const avgTurnsAfter = mean(afterRows.map((r) => r.turns));

  const turnsSumBefore = sum(beforeRows.map((r) => r.turns));
  const turnsSumAfter = sum(afterRows.map((r) => r.turns));
  const errorsSumBefore = sum(beforeRows.map((r) => r.toolErrors));
  const errorsSumAfter = sum(afterRows.map((r) => r.toolErrors));
  const toolErrorRateBefore = turnsSumBefore > 0 ? errorsSumBefore / turnsSumBefore : null;
  const toolErrorRateAfter = turnsSumAfter > 0 ? errorsSumAfter / turnsSumAfter : null;

  const activeBefore = beforeRows.map((r) => r.activeDurationMs).filter((v): v is number => v !== null);
  const activeAfter = afterRows.map((r) => r.activeDurationMs).filter((v): v is number => v !== null);
  const avgActiveMinutesBefore = activeBefore.length > 0 ? mean(activeBefore) / 60000 : null;
  const avgActiveMinutesAfter = activeAfter.length > 0 ? mean(activeAfter) / 60000 : null;

  // M-1: the field is `medianResponseMs*`, and every other `median*` field in
  // this comparison (`medianCostBefore/After`) is the actual `median()` of the
  // per-session values, not their mean — so this one follows that convention
  // rather than silently reporting a mean of medians under a median's name. A
  // median-of-medians is also the more honest aggregate for response time
  // specifically: it stays robust to the one session with a long tail (a
  // network stall, a huge single tool call) that a mean would let dominate.
  const respBefore = beforeRows.map((r) => r.medianResponseTimeMs).filter((v): v is number => v !== null);
  const respAfter = afterRows.map((r) => r.medianResponseTimeMs).filter((v): v is number => v !== null);
  const medianResponseMsBefore = median(respBefore);
  const medianResponseMsAfter = median(respAfter);

  const tokenSavingsAtAfterVolume = (avgCostBefore - avgCostAfter) * nAfter;

  const devTimeDeltaMinutesAtAfterVolume =
    avgActiveMinutesBefore !== null && avgActiveMinutesAfter !== null
      ? (avgActiveMinutesAfter - avgActiveMinutesBefore) * nAfter
      : null;

  const devTimeCostAtAfterVolume =
    hourlyRate !== null && devTimeDeltaMinutesAtAfterVolume !== null
      ? (devTimeDeltaMinutesAtAfterVolume / 60) * hourlyRate
      : null;

  const netEffectAtAfterVolume =
    devTimeCostAtAfterVolume !== null ? tokenSavingsAtAfterVolume - devTimeCostAtAfterVolume : null;

  return {
    classKey,
    grain,
    verdict: "compared",
    minSessionsPerClass,
    nBefore,
    nAfter,
    avgCostBefore,
    avgCostAfter,
    medianCostBefore,
    medianCostAfter,
    costTrend: trendOf(avgCostAfter, avgCostBefore),
    avgTokensBefore,
    avgTokensAfter,
    tokensTrend: trendOf(avgTokensAfter, avgTokensBefore),
    avgTurnsBefore,
    avgTurnsAfter,
    turnsTrend: trendOf(avgTurnsAfter, avgTurnsBefore),
    toolErrorRateBefore,
    toolErrorRateAfter,
    // `?? 0` here would read a MISSING after-side rate (no turns at all on
    // that side, so no denominator) as "the error rate fell to zero" — a
    // favourable trend manufactured out of absent data. Abstain instead, the
    // same way `activeMinutesTrend` and `medianResponseTrend` below do (I1).
    toolErrorRateTrend:
      toolErrorRateBefore !== null && toolErrorRateAfter !== null
        ? trendOf(toolErrorRateAfter, toolErrorRateBefore)
        : "unknown",
    avgActiveMinutesBefore,
    avgActiveMinutesAfter,
    activeMinutesTrend:
      avgActiveMinutesBefore !== null && avgActiveMinutesAfter !== null
        ? trendOf(avgActiveMinutesAfter, avgActiveMinutesBefore)
        : "unknown",
    activeMinutesCoverageBefore: activeBefore.length,
    activeMinutesCoverageAfter: activeAfter.length,
    medianResponseMsBefore,
    medianResponseMsAfter,
    medianResponseTrend:
      medianResponseMsBefore !== null && medianResponseMsAfter !== null
        ? trendOf(medianResponseMsAfter, medianResponseMsBefore)
        : "unknown",
    modelsBefore: distinctModels(beforeRows),
    modelsAfter: distinctModels(afterRows),
    tokenSavingsAtAfterVolume,
    devTimeDeltaMinutesAtAfterVolume,
    devTimeCostAtAfterVolume,
    netEffectAtAfterVolume,
    direction: classifyDirection(netEffectAtAfterVolume, tokenSavingsAtAfterVolume),
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────────

export interface CompareConstraintImpactOptions {
  readonly minSessionsPerClass?: number;
  /** The salary denominator (`config.rate.hourly`). `null`/absent means "not
   *  configured" — the engine states dev-time in minutes and stops, never
   *  inventing a rate (`01 §1.3`). */
  readonly hourlyRate?: number | null;
  readonly currency?: string;
}

/**
 * The abstention floor, or the default when the caller handed over something
 * that cannot BE a floor.
 *
 * `NaN` is the case that matters: `Number("abc")` is NaN, `NaN ?? default` is
 * NaN (it is not nullish), and every `n < NaN` comparison is false — so a
 * non-numeric floor arriving from a CLI flag would silently DISABLE the
 * sample-size gate, mark a class with one session per side `"compared"`, and
 * publish a delta computed on n=1 next to a `minSessionsPerClass` that
 * serialises to JSON `null`. A floor that vanishes on bad input is worse than
 * no floor at all, because the verdict still claims to have been gated (I1).
 * A floor below 1 is likewise not a floor.
 */
function resolveMinSessionsPerClass(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_MIN_SESSIONS_PER_CLASS;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MIN_SESSIONS_PER_CLASS;
  return Math.floor(raw);
}

/**
 * Compare the sessions either side of a declared policy boundary, per task
 * class. Pure; the full table, including insufficient-data rows — see
 * `ClassImpactComparison`'s doc comment.
 */
export function compareConstraintImpact(
  before: readonly ConstraintImpactSessionRow[],
  after: readonly ConstraintImpactSessionRow[],
  taskClassBySession: ReadonlyMap<string, ConstraintImpactClassification>,
  policyEvent: PolicyEvent,
  opts: CompareConstraintImpactOptions = {},
): ConstraintImpactReport {
  const minSessionsPerClass = resolveMinSessionsPerClass(opts.minSessionsPerClass);
  const hourlyRate = opts.hourlyRate ?? null;
  const currency = opts.currency ?? "USD";
  const boundaryMs = parsePolicyEventBoundaryMs(policyEvent.date);

  const beforeByClass = groupByClass(before, taskClassBySession);
  const afterByClass = groupByClass(after, taskClassBySession);

  const classKeys = new Set<string>([...beforeByClass.keys(), ...afterByClass.keys()]);
  const classes: ClassImpactComparison[] = [];
  for (const classKey of classKeys) {
    const beforeEntry = beforeByClass.get(classKey);
    const afterEntry = afterByClass.get(classKey);
    const grain = (beforeEntry ?? afterEntry)!.grain;
    const beforeRows = beforeEntry?.rows ?? [];
    const afterRows = afterEntry?.rows ?? [];
    classes.push(compareOneClass(classKey, grain, beforeRows, afterRows, minSessionsPerClass, hourlyRate));
  }
  classes.sort((a, b) => a.classKey.localeCompare(b.classKey));

  const compared = classes.filter((c) => c.verdict === "compared");
  const totalTokenSavings =
    compared.length > 0 ? sum(compared.map((c) => c.tokenSavingsAtAfterVolume ?? 0)) : null;
  const devTimeClasses = compared.filter((c) => c.devTimeCostAtAfterVolume !== null);
  const totalDevTimeCost =
    hourlyRate !== null && devTimeClasses.length > 0
      ? sum(devTimeClasses.map((c) => c.devTimeCostAtAfterVolume ?? 0))
      : null;
  const totalNetEffect =
    totalTokenSavings !== null && totalDevTimeCost !== null ? totalTokenSavings - totalDevTimeCost : null;

  return {
    policyEvent,
    boundaryMs,
    minSessionsPerClass,
    hourlyRate,
    currency,
    classes,
    classesCompared: compared.length,
    classesInsufficientData: classes.length - compared.length,
    totalTokenSavings,
    totalDevTimeCost,
    totalNetEffect,
    netEffectAvailable: hourlyRate !== null,
    notMeasured: NOT_MEASURED,
    confoundNote: CONFOUND_NOTE,
  };
}

// ─── CSV export ─────────────────────────────────────────────────────────────────

/** RFC 4180 field quoting — same rule `core/pack.ts`'s CSV renderers use,
 *  duplicated locally (a handful of lines) rather than imported so this
 *  module keeps no dependency on the pack's shape. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: readonly (string | number | null)[]): string {
  return cells.map(csvCell).join(",");
}

const CSV_HEADER = [
  "classKey",
  "grain",
  "verdict",
  "nBefore",
  "nAfter",
  "avgCostBefore",
  "avgCostAfter",
  "avgTokensBefore",
  "avgTokensAfter",
  "avgTurnsBefore",
  "avgTurnsAfter",
  "toolErrorRateBefore",
  "toolErrorRateAfter",
  "avgActiveMinutesBefore",
  "avgActiveMinutesAfter",
  "medianResponseMsBefore",
  "medianResponseMsAfter",
  "tokenSavingsAtAfterVolume",
  "devTimeDeltaMinutesAtAfterVolume",
  "devTimeCostAtAfterVolume",
  "netEffectAtAfterVolume",
  "direction",
  "modelsBefore",
  "modelsAfter",
] as const;

/**
 * "the slide the developer will inevitably have to make" (03 §3.3) — the
 * class table as a spreadsheet-importable CSV. Every class row, INCLUDING
 * `insufficient-data` ones (blank numeric cells, never a fabricated zero) —
 * the two-sided obligation applies to the export as much as to the JSON.
 */
export function renderConstraintImpactCsv(report: ConstraintImpactReport): string {
  const lines = [csvLine(CSV_HEADER)];
  for (const c of report.classes) {
    lines.push(
      csvLine([
        c.classKey,
        c.grain,
        c.verdict,
        c.nBefore,
        c.nAfter,
        c.avgCostBefore,
        c.avgCostAfter,
        c.avgTokensBefore,
        c.avgTokensAfter,
        c.avgTurnsBefore,
        c.avgTurnsAfter,
        c.toolErrorRateBefore,
        c.toolErrorRateAfter,
        c.avgActiveMinutesBefore,
        c.avgActiveMinutesAfter,
        c.medianResponseMsBefore,
        c.medianResponseMsAfter,
        c.tokenSavingsAtAfterVolume,
        c.devTimeDeltaMinutesAtAfterVolume,
        c.devTimeCostAtAfterVolume,
        c.netEffectAtAfterVolume,
        c.direction,
        c.modelsBefore.join(";"),
        c.modelsAfter.join(";"),
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
