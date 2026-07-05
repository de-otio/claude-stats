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
import { buildDailyDigest, dayWindowInTz } from '../recap/index.js';
import type { DateRangeOpts } from '../reporter/index.js';
import { createWindowedGitProvider } from '../recap/git.js';
import type { Confidence, ProjectGitActivity, DailyDigestItem } from '../recap/types.js';
import {
  computeSignature,
  latestOutcome,
  openCorrections,
  type CorrectionSignature,
  type CorrectionsClient,
  type OutcomeValue,
} from '../recap/corrections.js';
import type { TaskOutcome, OutcomeSignal } from './outcome-types.js';
import { combineOutcome } from './combine.js';
import {
  calibrationMetrics,
  labelToOutcome,
  FAILED_PRECISION_FLOOR,
  type CalibrationReport,
  type LabelledPair,
} from './calibration.js';
import { buildTaskEvidence } from './evidence/gather.js';
import { conversationalSignal } from './signals/conversational.js';
import { truncationSignal, reworkSignal, toolErrorSignal, revertSignal } from './signals/mechanical.js';
import { runJudge, type JudgeProvider } from './judge.js';
import { classifyArchetype } from './efficiency/archetype.js';
import { computeFrontier } from './efficiency/frontier.js';
import { deriveLevers } from './efficiency/levers.js';
import { buildEfficiencyReport } from './efficiency/index.js';
import type { Archetype, ClassifiedTask, EfficiencyReport } from './efficiency/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Period = 'day' | 'week' | 'month' | 'all';

/**
 * Four-state task outcome. `observable = success ∪ failed`; `in_flight` and
 * `unobservable` are deliberately held OUT of the success rate (an unfinished
 * task is not a failure; an unmeasurable one is not either).
 *
 * Canonical definition lives in {@link ./outcome-types.ts} (the Phase-A accuracy
 * contract); re-exported here so existing importers are unaffected.
 */
export type { TaskOutcome } from './outcome-types.js';

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
  /**
   * Rules-based task archetype (efficiency frontier, value-per-cost Phase 1).
   * Derived from the `DailyDigestItem` tool/path/duration fields where records
   * are built — never carries prompt text, paths, or project names itself.
   */
  archetype: Archetype;
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
  /**
   * Cost-efficiency frontier block (value-per-cost Phase 1). ALWAYS attached:
   * an empty window or one where no archetype clears the sample floor yields a
   * valid empty/abstained shape, never `undefined`. Every leaf is a number,
   * a model-name string, or a fixed-enum value — no prompt text, paths, project
   * names, or session ids (plan A4/A5), so it is safe on the read-only MCP and
   * `serve` LAN surfaces.
   */
  efficiency?: EfficiencyReport;
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
interface ClassifierItem {
  confidence: Confidence;
  git: ProjectGitActivity | null;
  hidden?: boolean;
  hasMutatingWork: boolean;
}

/**
 * The legacy proxy ladder: confidence × git observability → a four-state base
 * verdict (no label handling). This is the exact behaviour shipped before the
 * Phase-A accuracy work; it is the `base` the combiner refines when extended
 * signals are supplied.
 */
function baseLadder(item: ClassifierItem): TaskOutcome {
  if (item.confidence === 'high') return 'success'; // pushed commit or merged PR
  if (item.confidence === 'medium') {
    // `medium` bundles two distinct cases (see computeConfidence): a local commit
    // that hasn't been pushed yet, and a long, edit-heavy session with nothing
    // committed. A commit is a completion signal — the user committed the work —
    // so a committed task is `success`, not `in_flight`; only the no-commit case
    // (substantial edits still uncommitted) is genuinely unfinished work.
    if (item.git !== null && item.git.commitsToday > 0) return 'success';
    return 'in_flight';
  }
  // confidence === 'low': git observable + code-changing work but nothing landed
  // is the only defensible automatic failure; absence of signal is never failure.
  if (item.git !== null && item.hasMutatingWork) return 'failed';
  return 'unobservable';
}

/**
 * Classify a task into the four-state outcome. Explicit labels win; otherwise the
 * legacy proxy ladder ({@link baseLadder}) decides.
 *
 * `extendedSignals` is the Phase-A accuracy hook (off by default): when supplied
 * (only when `CostPerTaskOptions.experimentalSignals` is set), the Tier-0 signals
 * are folded into the base verdict by {@link combineOutcome}. When omitted, this
 * returns the legacy verdict verbatim — behaviour-preserving by construction, so
 * the live metric is unchanged until calibration flips the flag on (see
 * doc/analysis/cost-per-successful-task/07-accuracy-plan.md §7.5).
 *
 * @param item.hasMutatingWork  whether the task used a workspace-mutating tool.
 * @param extendedSignals  Tier-0 signals; when present, refine a held-out base.
 */
export function classifyOutcome(
  item: ClassifierItem,
  label?: OutcomeValue | null,
  extendedSignals?: readonly OutcomeSignal[],
): { outcome: TaskOutcome; labelled: boolean } {
  // 1. Explicit user labels win, always (resolved BEFORE the combiner).
  if (label === 'success') return { outcome: 'success', labelled: true };
  if (label === 'fail') return { outcome: 'failed', labelled: true };
  if (label === 'partial') return { outcome: 'in_flight', labelled: true };
  // A user-hidden item is an asserted negative (aborted / not real work).
  if (item.hidden === true) return { outcome: 'failed', labelled: true };

  // 2. Legacy proxy ladder.
  const base = baseLadder(item);

  // 3. Flag off (no extended signals): legacy verdict verbatim.
  if (extendedSignals === undefined) return { outcome: base, labelled: false };

  // 4. Flag on: fold Tier-0 signals into the base (decisive base never flipped;
  //    no-signal never becomes failure — enforced by combineOutcome).
  const verdict = combineOutcome({ base, signals: extendedSignals });
  return { outcome: verdict.outcome, labelled: false };
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

/**
 * Gather the Phase-A Tier-0 outcome signals for a task (imperative shell). Reads
 * the task's session messages, builds {@link buildTaskEvidence} (prompt text held
 * in process only), and runs the pure detectors. Returns enum-tag signals only —
 * no prompt text escapes. Called solely when `experimentalSignals` is enabled.
 *
 * v1 window approximation: uses all messages from the task's sessions. A session
 * can contain more than one task, so conversational signals may bleed across
 * tasks in the same session — acceptable for the default-off hook; segment-scoped
 * windowing is future work (and the flag stays off until calibration anyway).
 */
/** Mutable per-run budget for LLM-judge calls (shared across a report's tasks). */
interface JudgeBudget {
  provider: JudgeProvider;
  remaining: number;
}

async function gatherExtendedSignals(
  store: Store,
  item: DailyDigestItem,
  judge?: JudgeBudget,
): Promise<readonly OutcomeSignal[]> {
  const committed = (item.git?.commitsToday ?? 0) > 0;
  const messages = item.sessionIds.flatMap((sid) => store.getSessionMessages(sid));
  const evidence = buildTaskEvidence(messages, committed, item.git?.subjects ?? []);
  const signals: OutcomeSignal[] = [
    conversationalSignal(evidence),
    truncationSignal(evidence),
    reworkSignal(evidence),
    toolErrorSignal(evidence),
    revertSignal(evidence),
  ].filter((s): s is OutcomeSignal => s !== null);

  // Phase D: only judge AMBIGUOUS tasks (held-out base) — the combiner ignores
  // signals on a decisive base, so judging those would just burn calls — and only
  // while the per-run budget lasts.
  if (judge && judge.remaining > 0) {
    const base = baseLadder({
      confidence: item.confidence,
      git: item.git,
      hasMutatingWork: hasMutatingWork(item.toolHistogram),
    });
    if (base === 'in_flight' || base === 'unobservable') {
      judge.remaining -= 1;
      const verdict = await runJudge(judge.provider, evidence);
      if (verdict) signals.push(verdict);
    }
  }
  return signals;
}

const DAY_MS = 86_400_000;

function ymdFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * The list of YYYY-MM-DD date strings (in `tz`) to aggregate for a period —
 * either a preset (`opts.period`) or an explicit custom range (`opts.since`/
 * `opts.until`, both inclusive, custom range takes precedence when both are
 * present, mirroring {@link periodRange}'s precedence rule). Deterministic
 * given `nowMs`; `'all'` and a custom range are both bounded by `earliestMs`
 * so neither enumerates from the epoch / from before any data exists.
 */
export function datesForPeriod(
  opts: DateRangeOpts,
  tz: string,
  nowMs: number,
  earliestMs: number | null,
): string[] {
  const fmt = ymdFormatter(tz);
  const today = fmt.format(nowMs);

  if (opts.since && opts.until) {
    let startMs = dayWindowInTz(opts.since, tz).startMs;
    if (earliestMs !== null) startMs = Math.max(startMs, earliestMs);
    const untilStartMs = dayWindowInTz(opts.until, tz).startMs;
    // `endMs` is exclusive (midnight at the START of the day AFTER `until`);
    // cap it at `nowMs` so a future `until` doesn't enumerate unobserved days.
    const endMs = Math.min(dayWindowInTz(opts.until, tz).endMs, nowMs);

    const out = new Set<string>();
    // Step by day from startMs up to (but not including) endMs; the Set dedups
    // any DST overlap.
    for (let t = Math.min(startMs, endMs); t < endMs; t += DAY_MS) {
      out.add(fmt.format(t));
    }
    // Guard the boundary day exactly like the preset branches below do for
    // `today`: include `until`'s own day, or `today` when `until` was
    // capped by `nowMs` (a future/in-progress `until`).
    out.add(untilStartMs <= nowMs ? opts.until : today);
    return [...out].sort();
  }

  const period = opts.period;
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
    // 'all' (or an unset period) — from the earliest session day (or today
    // if the store is empty).
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

/**
 * Augment digestDeps with a windowed git provider so the per-day digest loop
 * fetches git/gh data ONCE per project over the whole window instead of once
 * per (day × project) — the dominant cost of a cold multi-day report (a "month"
 * window spawned ~30·N git/gh subprocesses; this collapses it to ~3·N).
 *
 * Production-path only: when the caller already injected its own git deps
 * (tests pass fakes for `getProjectGitActivity` / `getAuthorEmail`), those win
 * unchanged — the windowed provider, which shells out to real git/gh, must not
 * shadow an injected fake.
 */
function withWindowedGit(
  digestDeps: BuildDailyDigestDeps,
  dates: string[],
  tz: string,
): BuildDailyDigestDeps {
  if (
    digestDeps.getProjectGitActivity !== undefined ||
    digestDeps.getAuthorEmail !== undefined ||
    dates.length === 0
  ) {
    return digestDeps;
  }
  const windowStartMs = dayWindowInTz(dates[0]!, tz).startMs;
  const windowEndMs = dayWindowInTz(dates[dates.length - 1]!, tz).endMs;
  const provider = createWindowedGitProvider(windowStartMs, windowEndMs);
  return {
    ...digestDeps,
    getAuthorEmail: provider.getAuthorEmail,
    getProjectGitActivity: provider.getProjectGitActivity,
  };
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
  /**
   * Custom date range (both `YYYY-MM-DD`, inclusive), taking precedence over
   * `period` when both are set — mirrors `periodRange`'s precedence rule in
   * `../reporter/index.js`. Must be provided together.
   */
  since?: string;
  until?: string;
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
  /**
   * Phase-A accuracy hook (default: false). When true, Tier-0 outcome signals
   * (conversational repair/acceptance, truncation, rework) are gathered per task
   * and folded into the proxy verdict via the evidence combiner. Default-OFF is
   * load-bearing: it changes the live success rate, which must stay calibration-
   * gated until the calibration harness exists (doc 07 §7.5). It must NOT be set
   * to `true` by any production caller (MCP / serve / dashboard / CLI) before
   * then — a test enforces this. Prompt text read for these signals stays in
   * process and never enters the report payload.
   */
  experimentalSignals?: boolean;
  /**
   * Phase-D LLM judge (opt-in). When set AND `experimentalSignals` is true, an
   * independent model rules on ambiguous (held-out) tasks. Null/undefined → no
   * judge, no external call. PRIVACY: enabling this sends a blinded task summary
   * (incl. prompt text) to the provider's endpoint — see Config.llmJudge.
   */
  judgeProvider?: JudgeProvider | null;
  /** Cap on judge calls per run (cost guard; default 25). */
  maxJudgeCalls?: number;
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

  const earliestMs =
    period === 'all' || (opts.since && opts.until) ? store.getEarliestSessionTimestamp() : null;
  const dates = datesForPeriod({ period, since: opts.since, until: opts.until }, tz, nowMs, earliestMs);
  const { windowStart, windowEnd } = windowBoundsMs(dates, tz, nowMs);

  // Phase-D budget: only when experimental signals are on AND a judge is given.
  const judgeBudget: JudgeBudget | undefined =
    opts.experimentalSignals && opts.judgeProvider
      ? { provider: opts.judgeProvider, remaining: opts.maxJudgeCalls ?? 25 }
      : undefined;

  // ── Pool digest items across the window ──
  // One git-SHA memo for the whole report: HEAD is stable across the per-day
  // digests, so this collapses N_days × N_projects git subprocesses into one
  // per distinct project.
  const commitShaCache = new Map<string, string | null>();
  const digestDeps = withWindowedGit({ ...opts.digestDeps, commitShaCache }, dates, tz);
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
      digestDeps,
    );

    for (const item of digest.items) {
      const sig = computeSignature({
        project: item.project,
        filePathsTouched: item.filePathsTouched,
        firstPrompt: item.firstPrompt,
      });
      const label = corrections ? latestOutcome(corrections.forSignature(sig)) : null;
      // Phase-A accuracy hook: gather Tier-0 signals only when explicitly enabled.
      // Prompt text read here (via buildTaskEvidence) stays in process — only the
      // resulting enum-tag signals reach the combiner, never the report payload.
      const extendedSignals = opts.experimentalSignals
        ? await gatherExtendedSignals(store, item, judgeBudget)
        : undefined;
      const { outcome, labelled } = classifyOutcome(
        {
          confidence: item.confidence,
          git: item.git,
          hidden: item.hidden,
          hasMutatingWork: hasMutatingWork(item.toolHistogram),
        },
        label,
        extendedSignals,
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
        // Archetype is computed at THIS layer, where the DailyDigestItem fields
        // (toolHistogram/filePathsTouched/duration) are in scope; the efficiency
        // module never imports DailyDigestItem (plan A5).
        archetype: classifyArchetype({
          toolHistogram: item.toolHistogram,
          filePathsTouched: item.filePathsTouched,
          duration: item.duration,
        }),
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

/**
 * Build a calibration report: how well the proxy ladder and the experimental
 * combiner agree with the user's explicit outcome labels (ground truth).
 *
 * Only labelled tasks form the eval set. For each, the prediction is computed
 * with the label (and `hidden`) suppressed — so the label is pure ground truth
 * and the prediction is what the classifier would have said unaided. Two
 * predictions are scored: the legacy proxy ladder, and the ladder + Tier-0
 * signals (the combiner). Read-only and prompt-text-free.
 *
 * Use the `withSignals.meetsFailedFloor` result to decide whether the signals
 * are trustworthy enough to enable (`experimentalSignals`) — doc 07 §7.4–7.5.
 */
export async function buildCalibrationReport(
  store: Store,
  opts: CostPerTaskOptions & { floor?: number } = {},
): Promise<CalibrationReport> {
  const period: Period = opts.period ?? 'month';
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const floor = opts.floor ?? FAILED_PRECISION_FLOOR;
  const corrections: CorrectionsClient | null =
    opts.correctionsClient === undefined ? openCorrections() : opts.correctionsClient;

  const earliestMs =
    period === 'all' || (opts.since && opts.until) ? store.getEarliestSessionTimestamp() : null;
  const dates = datesForPeriod({ period, since: opts.since, until: opts.until }, tz, nowMs, earliestMs);

  // Calibration measures the signals' agreement, so run the judge here whenever a
  // provider is given (independent of experimentalSignals — that's the point).
  const judgeBudget: JudgeBudget | undefined = opts.judgeProvider
    ? { provider: opts.judgeProvider, remaining: opts.maxJudgeCalls ?? 25 }
    : undefined;

  const proxyPairs: LabelledPair[] = [];
  const signalPairs: LabelledPair[] = [];

  // One git-SHA memo for the whole report (see buildCostPerTaskReport).
  const commitShaCache = new Map<string, string | null>();
  const digestDeps = withWindowedGit({ ...opts.digestDeps, commitShaCache }, dates, tz);
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
      digestDeps,
    );

    for (const item of digest.items) {
      const sig = computeSignature({
        project: item.project,
        filePathsTouched: item.filePathsTouched,
        firstPrompt: item.firstPrompt,
      });
      const label = corrections ? latestOutcome(corrections.forSignature(sig)) : null;
      if (label === null) continue; // eval set = labelled tasks only

      const actual = labelToOutcome(label);
      // Prediction with the label AND hidden suppressed → pure unaided proxy.
      const base = classifyOutcome(
        {
          confidence: item.confidence,
          git: item.git,
          hidden: false,
          hasMutatingWork: hasMutatingWork(item.toolHistogram),
        },
        null,
      ).outcome;
      const verdict = combineOutcome({ base, signals: await gatherExtendedSignals(store, item, judgeBudget) });

      proxyPairs.push({ predicted: base, actual, score: null });
      signalPairs.push({ predicted: verdict.outcome, actual, score: verdict.score });
    }
  }

  return {
    n: proxyPairs.length,
    floor,
    proxyOnly: calibrationMetrics(proxyPairs, floor),
    withSignals: calibrationMetrics(signalPairs, floor),
  };
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

  // Efficiency frontier (value-per-cost Phase 1). Built from a privacy-clean
  // projection of the records (cost/archetype/outcome/dominantModel only) via
  // the injected pure functions. Always attached — an empty/abstained shape is
  // a valid report. `aggregate` stays pure: classifyArchetype already ran where
  // the records were built; computeFrontier/deriveLevers are pure.
  const classifiedTasks: readonly ClassifiedTask[] = records.map((r) => ({
    cost: r.cost,
    archetype: r.archetype,
    outcome: r.outcome,
    dominantModel: r.dominantModel,
  }));
  const efficiency = buildEfficiencyReport(classifiedTasks, { computeFrontier, deriveLevers });

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
    efficiency,
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
    // Some messages carry a placeholder model (e.g. Claude Code's own
    // "<synthetic>" tag on compacted/summary content) that never has token
    // usage or a dominant-model attribution — skip it rather than surface an
    // all-zero row a caller can't act on.
    if (a.tasksObservable === 0 && a.successCount === 0 && a.costObservable === 0 && a.costByModelExact === 0) {
      continue;
    }
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
