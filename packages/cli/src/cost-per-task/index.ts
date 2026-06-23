/**
 * Cost per successful task.
 *
 * Re-projects the daily-recap pipeline into the metric Laurie Voss argues
 * matters once model subsidies end: equivalent-API dollars spent per *shipped /
 * user-confirmed* task, overall and per model.
 *
 *   cost_per_successful_task = Σ cost(observable attempts) / count(successful)
 *                            = mean_cost_per_attempt / success_rate
 *
 * Design (see doc/analysis/cost-per-successful-task/):
 *   - Task unit = a recap DailyDigestItem (a cluster of topic-segments).
 *   - Numerator = item.estimatedCost (per-segment cost incl. folded subagent
 *     cost; fixed in Phase 0). Per-model split = item.costByModel.
 *   - Outcome is FOUR-state and never conflates "failed" with "unobservable":
 *     success / failed / in_flight / unobservable. The rate is computed over
 *     the OBSERVABLE subset (success ∪ failed), with coverage reported beside
 *     it. Explicit user labels override the proxy.
 *
 * This module is pure orchestration over the store + recap pipeline + the
 * corrections (label) store. All nondeterminism (clock, tz, git, cache,
 * embeddings) is injectable for testing.
 */
import type { Store } from '../store/index.js';
import type { BuildDailyDigestDeps } from '../recap/index.js';
import { buildDailyDigest } from '../recap/index.js';
import type { Confidence, ProjectGitActivity } from '../recap/types.js';
import {
  computeSignature,
  latestOutcome,
  openCorrections,
  type CorrectionSignature,
  type CorrectionsClient,
  type OutcomeValue,
} from '../recap/corrections.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Period = 'day' | 'week' | 'month' | 'all';

/**
 * Four-state task outcome. `observable = success ∪ failed`; `in_flight` and
 * `unobservable` are deliberately held OUT of the success rate (an unfinished
 * task is not a failure; an unmeasurable one is not either).
 */
export type TaskOutcome = 'success' | 'failed' | 'in_flight' | 'unobservable';

export interface TaskRecord {
  id: string;
  project: string;
  cost: number;
  costByModel: Readonly<Record<string, number>>;
  /** Model with the largest cost share for this task (proxy for who did it). */
  dominantModel: string | null;
  outcome: TaskOutcome;
  /** True when `outcome` came from an explicit user label, not a proxy. */
  labelled: boolean;
  confidence: Confidence;
}

export interface ModelCostPerTask {
  model: string;
  tasksObservable: number;
  successCount: number;
  /** null when tasksObservable < MIN_OBSERVABLE_FOR_MODEL_RATE (too noisy). */
  successRate: number | null;
  /** Cost of observable tasks this model dominates (numerator for the rate). */
  costObservable: number;
  /** Exact message-level cost attributed to this model across observable tasks. */
  costByModelExact: number;
  meanCostPerAttempt: number | null;
  costPerSuccessfulTask: number | null;
}

/**
 * A single task surfaced for in-dashboard labelling. Carries prompt-derived
 * text (`title`, `signature.promptPrefix`), so it is ONLY ever populated when
 * `CostPerTaskOptions.includeTasks` is set — which the VS Code webview does and
 * the read-only MCP server / `serve` LAN path deliberately do NOT (keeping the
 * metric payload prompt-text-free on those surfaces).
 */
export interface LabellableTask {
  id: string;
  /** Short prompt-derived heading for display (webview-only). */
  title: string;
  project: string;
  outcome: TaskOutcome;
  labelled: boolean;
  confidence: Confidence;
  /** Signature the webview echoes back to write/clear an outcome correction. */
  signature: CorrectionSignature;
}

/** Cap on tasks surfaced for labelling — most-expensive-first; the rest are omitted. */
export const MAX_LABELLABLE_TASKS = 25;

export interface CostPerTaskReport {
  period: Period;
  windowStart: number;
  windowEnd: number;
  tasksTotal: number;
  observable: number;
  /** observable / tasksTotal (0 when there are no tasks). */
  coverage: number;
  successCount: number;
  failedCount: number;
  inFlightCount: number;
  unobservableCount: number;
  /** success / observable, or null when nothing is observable. */
  successRate: number | null;
  totalCostObservable: number;
  meanCostPerAttempt: number | null;
  /** The headline. null when there are no successes. */
  costPerSuccessfulTask: number | null;
  /** How many outcomes are user-labelled (vs proxied) — ground-truth share. */
  labelledCount: number;
  byModel: ModelCostPerTask[];
  /**
   * Per-task list for in-dashboard labelling. Present ONLY when
   * `opts.includeTasks` is set (VS Code webview). Undefined on the read-only
   * MCP and `serve` surfaces so no prompt text leaks there.
   */
  tasks?: readonly LabellableTask[];
}

/** Below this many observable tasks, a per-model rate is too noisy to report. */
export const MIN_OBSERVABLE_FOR_MODEL_RATE = 10;

/** Tools that mutate the workspace — used to decide whether a low-confidence,
 *  git-observable task represents an *attempt* that failed to land (vs a pure
 *  read/Q&A session we simply can't judge). */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ─── Outcome classifier (pure) ──────────────────────────────────────────────

/**
 * Classify a task into the four-state outcome. Explicit labels win; otherwise
 * the recap `confidence` proxy is interpreted, consulting `git` for
 * observability. The cardinal rule: never call the *absence* of a signal a
 * failure.
 *
 * @param item.hasMutatingWork  whether the task used a workspace-mutating tool
 *   (Edit/Write/…). A low-confidence, git-observable task is only called
 *   `failed` when it actually attempted to change code and nothing landed;
 *   a pure read/Q&A session is `unobservable`.
 */
export function classifyOutcome(
  item: {
    confidence: Confidence;
    git: ProjectGitActivity | null;
    hidden?: boolean;
    hasMutatingWork: boolean;
  },
  label?: OutcomeValue | null,
): { outcome: TaskOutcome; labelled: boolean } {
  // 1. Explicit user labels win, always.
  if (label === 'success') return { outcome: 'success', labelled: true };
  if (label === 'fail') return { outcome: 'failed', labelled: true };
  if (label === 'partial') return { outcome: 'in_flight', labelled: true };
  // A user-hidden item is an asserted negative (aborted / not real work).
  if (item.hidden === true) return { outcome: 'failed', labelled: true };

  // 2. Proxy from the recap confidence + git observability.
  if (item.confidence === 'high') return { outcome: 'success', labelled: false }; // pushed commit or merged PR
  if (item.confidence === 'medium') return { outcome: 'in_flight', labelled: false }; // local commits / substantial, unshipped

  // confidence === 'low'
  if (item.git !== null && item.hasMutatingWork) {
    // Git was observable (repo + author matched) and code-changing work was
    // attempted, yet nothing landed → the only defensible automatic failure.
    return { outcome: 'failed', labelled: false };
  }
  // No instrument (no git), or no code-changing attempt to judge.
  return { outcome: 'unobservable', labelled: false };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function dominantModel(costByModel: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestVal = -Infinity;
  for (const [model, cost] of Object.entries(costByModel)) {
    if (cost > bestVal) {
      bestVal = cost;
      best = model;
    }
  }
  return best;
}

/** Short, prompt-derived heading for a labellable task (webview display only). */
function taskTitle(item: { label?: string | null; firstPrompt: string | null }): string {
  if (item.label) return item.label;
  let raw = item.firstPrompt ?? '';
  // firstPrompt is wrapped by wrapUntrusted; extract the inner content (mirrors
  // computeSignature) so the heading is the real prompt, not the advisory note.
  const m = raw.match(/<untrusted-stored-content>([\s\S]*?)<\/untrusted-stored-content>/);
  raw = (m ? m[1]! : raw).replace(/\s+/g, ' ').trim();
  if (raw.length === 0) return '(no prompt)';
  return raw.length > 70 ? raw.slice(0, 69) + '…' : raw;
}

function hasMutatingWork(toolHistogram: Readonly<Record<string, number>>): boolean {
  for (const tool of Object.keys(toolHistogram)) {
    if (MUTATING_TOOLS.has(tool)) return true;
  }
  return false;
}

const DAY_MS = 86_400_000;

function ymdFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * The list of YYYY-MM-DD date strings (in `tz`) to aggregate for a period.
 * Deterministic given `nowMs`; `'all'` is bounded by `earliestMs` so it never
 * enumerates from the epoch.
 */
export function datesForPeriod(period: Period, tz: string, nowMs: number, earliestMs: number | null): string[] {
  const fmt = ymdFormatter(tz);
  const today = fmt.format(nowMs);
  if (period === 'day') return [today];

  let startMs: number;
  if (period === 'week') {
    startMs = nowMs - 6 * DAY_MS;
  } else if (period === 'month') {
    // Keep only same-calendar-month days; avoids tz-midnight arithmetic.
    const ym = today.slice(0, 7);
    const out = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const d = fmt.format(nowMs - i * DAY_MS);
      if (d.slice(0, 7) === ym) out.add(d);
    }
    return [...out].sort();
  } else {
    // 'all' — from the earliest session day (or today if the store is empty).
    startMs = earliestMs ?? nowMs;
  }

  const out = new Set<string>();
  // Step by day from startMs through nowMs; the Set dedups any DST overlap.
  for (let t = Math.min(startMs, nowMs); t <= nowMs; t += DAY_MS) {
    out.add(fmt.format(t));
  }
  out.add(today);
  return [...out].sort();
}

function windowBoundsMs(dates: string[], tz: string, nowMs: number): { windowStart: number; windowEnd: number } {
  // Approximate the window from the first date's UTC midnight; exact bounds are
  // not load-bearing (they are reporting metadata, not used for filtering).
  if (dates.length === 0) return { windowStart: nowMs, windowEnd: nowMs };
  const first = dates[0]!;
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  void tz;
  return { windowStart: Date.UTC(y, m - 1, d), windowEnd: nowMs };
}

// ─── Report builder ─────────────────────────────────────────────────────────

export interface CostPerTaskOptions {
  period?: Period;
  projectPath?: string;
  accountUuid?: string;
  repoUrl?: string;
  includeCI?: boolean;
  byModel?: boolean;
  /**
   * When true, the report includes a `tasks` list (per-task id/title/signature)
   * for in-dashboard labelling. Carries prompt-derived text — leave OFF for the
   * read-only MCP and `serve` surfaces. Default: false.
   */
  includeTasks?: boolean;
  // ── Injectables (default to production behaviour) ──
  /** Epoch-ms "now". Defaults to Date.now(). Injected for deterministic tests. */
  nowMs?: number;
  /** IANA tz. Defaults to the host tz. */
  tz?: string;
  /**
   * Label store. `undefined` → open the real corrections DB; `null` → no
   * labels (proxy only). A client instance is used as-is (tests pass a temp).
   */
  correctionsClient?: CorrectionsClient | null;
  /** Injected recap deps (git/cache/embeddings/clock) — for tests. */
  digestDeps?: BuildDailyDigestDeps;
}

/**
 * Build the cost-per-successful-task report for a window + filters.
 *
 * Iterates `buildDailyDigest` per day across the window, pools the items,
 * classifies each into the four-state outcome (labels override proxies), and
 * aggregates overall and (optionally) per dominant model.
 *
 * Note: items are NOT deduped across days. Within a single window pass each day
 * is computed once, so there are no re-emissions to dedup; a task spanning local
 * midnight may be counted twice (documented v1 bias) — deduping by signature
 * would instead risk dropping the cost of legitimately distinct same-signature
 * work, which is worse for the numerator.
 */
export async function buildCostPerTaskReport(
  store: Store,
  opts: CostPerTaskOptions = {},
): Promise<CostPerTaskReport> {
  const period: Period = opts.period ?? 'month';
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const corrections: CorrectionsClient | null =
    opts.correctionsClient === undefined ? openCorrections() : opts.correctionsClient;

  const earliestMs = period === 'all' ? store.getEarliestSessionTimestamp() : null;
  const dates = datesForPeriod(period, tz, nowMs, earliestMs);
  const { windowStart, windowEnd } = windowBoundsMs(dates, tz, nowMs);

  // ── Pool digest items across the window ──
  const records: TaskRecord[] = [];
  const tasks: LabellableTask[] = [];
  for (const date of dates) {
    const digest = await buildDailyDigest(
      store,
      {
        date,
        tz,
        projectPath: opts.projectPath,
        accountUuid: opts.accountUuid,
        repoUrl: opts.repoUrl,
        includeCI: opts.includeCI ?? false,
      },
      opts.digestDeps,
    );

    for (const item of digest.items) {
      const sig = computeSignature({
        project: item.project,
        filePathsTouched: item.filePathsTouched,
        firstPrompt: item.firstPrompt,
      });
      const label = corrections ? latestOutcome(corrections.forSignature(sig)) : null;
      const { outcome, labelled } = classifyOutcome(
        {
          confidence: item.confidence,
          git: item.git,
          hidden: item.hidden,
          hasMutatingWork: hasMutatingWork(item.toolHistogram),
        },
        label,
      );
      records.push({
        id: item.id,
        project: item.project,
        cost: item.estimatedCost,
        costByModel: item.costByModel,
        dominantModel: dominantModel(item.costByModel),
        outcome,
        labelled,
        confidence: item.confidence,
      });
      if (opts.includeTasks) {
        tasks.push({
          id: item.id,
          title: taskTitle(item),
          project: item.project,
          outcome,
          labelled,
          confidence: item.confidence,
          signature: sig,
        });
      }
    }
  }

  const report = aggregate(records, period, windowStart, windowEnd, opts.byModel !== false);
  if (opts.includeTasks) {
    // Most-expensive-first: the tasks whose label most moves the metric. Cost
    // is on the record, not the task; align by id (ids are unique per window).
    const costById = new Map(records.map((r) => [r.id, r.cost]));
    const ranked = [...tasks].sort(
      (a, b) => (costById.get(b.id) ?? 0) - (costById.get(a.id) ?? 0),
    );
    return { ...report, tasks: ranked.slice(0, MAX_LABELLABLE_TASKS) };
  }
  return report;
}

/** Pure aggregation over classified task records. Exported for direct testing. */
export function aggregate(
  records: readonly TaskRecord[],
  period: Period,
  windowStart: number,
  windowEnd: number,
  byModel: boolean,
): CostPerTaskReport {
  const successCount = records.filter((r) => r.outcome === 'success').length;
  const failedCount = records.filter((r) => r.outcome === 'failed').length;
  const inFlightCount = records.filter((r) => r.outcome === 'in_flight').length;
  const unobservableCount = records.filter((r) => r.outcome === 'unobservable').length;
  const tasksTotal = records.length;
  const observableRecords = records.filter((r) => r.outcome === 'success' || r.outcome === 'failed');
  const observable = observableRecords.length;
  const totalCostObservable = observableRecords.reduce((sum, r) => sum + r.cost, 0);
  const labelledCount = records.filter((r) => r.labelled).length;

  const successRate = observable > 0 ? successCount / observable : null;
  const meanCostPerAttempt = observable > 0 ? totalCostObservable / observable : null;
  const costPerSuccessfulTask = successCount > 0 ? totalCostObservable / successCount : null;
  const coverage = tasksTotal > 0 ? observable / tasksTotal : 0;

  return {
    period,
    windowStart,
    windowEnd,
    tasksTotal,
    observable,
    coverage,
    successCount,
    failedCount,
    inFlightCount,
    unobservableCount,
    successRate,
    totalCostObservable,
    meanCostPerAttempt,
    costPerSuccessfulTask,
    labelledCount,
    byModel: byModel ? aggregateByModel(observableRecords) : [],
  };
}

function aggregateByModel(observableRecords: readonly TaskRecord[]): ModelCostPerTask[] {
  interface Acc {
    tasksObservable: number;
    successCount: number;
    costObservable: number;
    costByModelExact: number;
  }
  const byModel = new Map<string, Acc>();
  const ensure = (m: string): Acc => {
    let a = byModel.get(m);
    if (!a) {
      a = { tasksObservable: 0, successCount: 0, costObservable: 0, costByModelExact: 0 };
      byModel.set(m, a);
    }
    return a;
  };

  for (const r of observableRecords) {
    // Dominant-model assignment for the rate (success is a task property, not
    // divisible across models).
    if (r.dominantModel !== null) {
      const a = ensure(r.dominantModel);
      a.tasksObservable += 1;
      a.costObservable += r.cost;
      if (r.outcome === 'success') a.successCount += 1;
    }
    // Exact message-level cost split — independent of the dominant assignment.
    for (const [model, cost] of Object.entries(r.costByModel)) {
      ensure(model).costByModelExact += cost;
    }
  }

  const rows: ModelCostPerTask[] = [];
  for (const [model, a] of byModel) {
    const enoughToRate = a.tasksObservable >= MIN_OBSERVABLE_FOR_MODEL_RATE;
    rows.push({
      model,
      tasksObservable: a.tasksObservable,
      successCount: a.successCount,
      successRate: enoughToRate && a.tasksObservable > 0 ? a.successCount / a.tasksObservable : null,
      costObservable: a.costObservable,
      costByModelExact: a.costByModelExact,
      meanCostPerAttempt: a.tasksObservable > 0 ? a.costObservable / a.tasksObservable : null,
      costPerSuccessfulTask:
        enoughToRate && a.successCount > 0 ? a.costObservable / a.successCount : null,
    });
  }
  // Most expensive-to-succeed first (nulls last) — the rows a user cares about.
  rows.sort((x, y) => (y.costPerSuccessfulTask ?? -1) - (x.costPerSuccessfulTask ?? -1));
  return rows;
}
