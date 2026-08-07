/**
 * Dashboard — builds pre-aggregated JSON for visualization tools.
 * See plans/11-dashboard-export.md for design.
 */
import type { Store, SessionRow, MessageFilter } from "../store/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { periodRange } from "../reporter/index.js";
import { estimateCost, lookupPlanFee, PLAN_FEES } from "@claude-stats/core/pricing";
import type { UsageWindow } from "@claude-stats/core/types";
import { classifyUsageIntensity } from "@claude-stats/core/planMechanics";
import { readClaudeAccount } from "../account.js";
import { resolveAccountFee, type Config } from "../config.js";
import { getTicketCostReport } from "../ticketing/index.js";
import { resolveDashboardCostVocabulary, type VocabularyResolution } from "../server/insights.js";
import type { Reconciliation, TicketCoverage } from "@claude-stats/core/types/insight";
import { computeReconciliation } from "@claude-stats/core/reconciliation";
import { buildFeeAttribution, type FeeAttribution } from "./fee-attribution.js";
import {
  scoreComplexity,
  scoreToTier,
  tierToModel,
  type ComplexityTier,
  type ModelEfficiencyData,
} from "../classifier.js";
import { attributeToolCosts, groupByMcpServer, detectAnomalies, aggregateMcpServerUsage } from "../spending.js";
import type { CostPerTaskReport, CostPerTaskOptions } from "../cost-per-task/index.js";
import type { CalibrationReport } from "../cost-per-task/calibration.js";
import type { CalibrationEstimate } from "@claude-stats/core/calibration";
import { buildAttributionCalibration } from "../calibration/index.js";
import { estimateEnergy, aggregateEnergy, localeToRegion, REGIONS, MODEL_ENERGY, nearestJourneyAnchor, modelClass } from "@claude-stats/core/energy";
import type { ModelClass } from "@claude-stats/core/energy";
import { decodeHtmlEntities } from "@claude-stats/core/sanitize";

/**
 * Human-readable, entity-decoded, length-capped preview of a stored prompt.
 * `prompt_text` is persisted HTML-escaped (see {@link sanitizePromptText}); the
 * dashboard renders previews on a Chart.js canvas and in HTML cells, neither of
 * which decode entities, so decode here at the display boundary.
 */
function promptPreviewOf(text: string | null | undefined): string {
  const decoded = decodeHtmlEntities(text);
  if (!decoded) return "(no prompt text)";
  return decoded.length > 120 ? decoded.slice(0, 120) + "..." : decoded;
}

/**
 * Format an epoch-ms instant as YYYY-MM-DD in the given IANA timezone.
 *
 * `new Date(ms).toISOString().slice(0, 10)` (the pattern this replaces at
 * every `*Iso` field below) reads the **UTC** calendar date, which is wrong
 * for any positive-offset timezone at local midnight — e.g. midnight
 * 2026-06-01 in Europe/Berlin (UTC+2 in June) is 2026-05-31T22:00:00Z, so
 * `.toISOString().slice(0,10)` reports "2026-05-31". Found while manually
 * verifying the custom-date-range feature (doc/analysis/custom-date-range):
 * a dashboard request for `since=2026-06-01` echoed back `sinceIso:
 * "2026-05-31"`. `since`/`until` are always constructed as local-tz
 * midnight (via `periodStart`/`periodRange`/`dayWindowInTz`), so they must
 * be read back out in the same timezone, not UTC.
 */
function ymdInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

type WorkCategory = "exploring" | "editing" | "running" | "researching" | "planning";

/** Map tool names to high-level work categories. */
const TOOL_CATEGORY: Record<string, WorkCategory> = {
  Read: "exploring", Grep: "exploring", Glob: "exploring", Agent: "exploring",
  Edit: "editing", Write: "editing", NotebookEdit: "editing",
  Bash: "running",
  WebSearch: "researching", WebFetch: "researching",
  EnterPlanMode: "planning", TodoWrite: "planning",
};

export interface DashboardSummary {
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheEfficiency: number;
  estimatedCost: number;
  /**
   * True when any priced message in this period rested on
   * `rateBasis: "first_party_fallback"` — a partner platform (Bedrock,
   * Vertex) billed with no configured partner rate, so `estimatedCost`
   * reused first-party per-token prices as a stand-in. The cost card's
   * caveat must say so (insight.ts `costCaveat`); a metered figure that
   * silently omits this reads as "actual metered cost" when it may not be.
   */
  anyFallbackRates: boolean;
  totalDurationMs: number;
  // Plan ROI
  planFee: number;
  planMultiplier: number;
  costPerPrompt: number;
  costPerActiveHour: number;
  dailyValueRate: number;
  // Velocity
  tokensPerMinute: number;
  outputTokensPerPrompt: number;
  promptsPerHour: number;
  // Session patterns
  totalActiveHours: number;
  avgSessionDurationMinutes: number;
  /**
   * Count of assistant responses that ended with stop_reason=max_tokens AND produced
   * fewer than 200 output tokens — i.e. near-empty responses cut off at the output limit.
   * NOT a measurement of Anthropic rate-limit rejections (those never reach the JSONL).
   */
  truncatedOutputs: number;
  // Current window
  currentWindowStart: string | null;
  currentWindowPrompts: number;
  currentWindowCost: number;
  // Subagents
  subagentSessions: number;
  parentSessionsWithChildren: number;
}

export interface DashboardData {
  generated: string;          // ISO timestamp
  period: string;
  timezone: string;
  sinceIso: string | null;    // ISO date of period start, or null for "all time"
  /**
   * ISO date of period end (resolved `until`). Optional (not `string | null`)
   * so pre-existing `DashboardData` test fixtures outside this task's file
   * allowlist that predate this field keep compiling; `buildDashboard` always
   * populates it.
   */
  untilIso?: string;
  summary: DashboardSummary;
  byDay: Array<{
    date: string;             // YYYY-MM-DD
    sessions: number;
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estimatedCost: number;
  }>;
  byProject: Array<{
    projectPath: string;
    sessions: number;
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    thinkingBlocks: number;
    workProfile: {
      exploring: number;
      editing: number;
      running: number;
      researching: number;
      planning: number;
    };
  }>;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
  byEntrypoint: Array<{
    entrypoint: string;
    sessions: number;
  }>;
  stopReasons: Array<{
    reason: string;
    count: number;
  }>;
  byHour: Array<{
    hour: string;             // "00"–"23"
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>;
  byWindow: UsageWindow[];
  byConversationCost: Array<{
    sessionId: string;
    projectPath: string;
    durationMs: number;
    estimatedCost: number;
    percentOfPlanFee: number;
    dominantModel: string;
    promptCount: number;
    isSubagent: boolean;
    childCount: number;
  }>;
  byWeek: Array<{
    week: string;             // ISO week start date YYYY-MM-DD (Monday)
    sessions: number;
    prompts: number;
    estimatedCost: number;
    activeHoursEstimate: number;
    windowCount: number;
    /** Windows that contained at least one truncated-output response.
     * NOT a measurement of Anthropic 5-hour rate-limit rejections. */
    windowsWithTruncatedOutput: number;
  }>;
  planUtilization: {
    weeklyPlanBudget: number;       // planFee / 4.33
    avgWeeklyCost: number;
    peakWeeklyCost: number;
    weeksBelowPlan: number;
    weeksAbovePlan: number;
    totalWeeks: number;
    // Window metrics
    avgWindowCost: number;
    medianWindowCost: number;
    windowsPerWeek: number;
    /** Percentage of 5-hour windows that contained a truncated-output response.
     * NOT a measurement of Anthropic rate-limit throttling. */
    truncatedOutputWindowPercent: number;
    totalWindows: number;
    // Recommendation
    recommendedPlan: string | null;  // "pro", "max_5x", "max_20x", "team_standard", "team_premium", "enterprise", or null
    currentPlanVerdict: string;      // "good-value" | "underusing" | "no-plan"
    /**
     * Usage-intensity classification of `monthlyEquiv` against Anthropic's
     * per-user Claude Code benchmarks (from `classifyUsageIntensity` in
     * @claude-stats/core/planMechanics). Optional so full-literal
     * planUtilization fixtures typecheck without it; when present it is
     * populated whenever planUtilization is non-null (byWeek.length > 0) and
     * is `null` only when planUtilization itself is null. Computation is B1's;
     * this is the declared contract only.
     */
    usageIntensityTier?: {
      tier: "light" | "typical" | "power";
      benchmarkUsd: number;
      source: "anthropic-benchmark";
    } | null;
    // Per-account breakdown (always populated when planUtilization is present)
    byAccount: Array<{
      accountId: string;             // truncated UUID for display
      emailAddress: string | null;   // from ~/.claude.json oauthAccount
      subscriptionType: string | null;
      detectedPlanFee: number | null;
      sessions: number;
      estimatedCost: number;
      planVerdict: string;
      // Per-account token detail + per-model split, mirroring the top-level
      // `byModel` shape. These are IN-WINDOW (sourced from the bounded
      // msgTotalsBySession), so Σ byAccount tokens == top-level byModel tokens.
      // `summary.inputTokens` et al. are in-window too now, so Σ byAccount also
      // equals the headline. (It previously did NOT: the summary summed
      // session-LIFETIME columns, so a boundary-straddling session made the two
      // differ by its entire pre-window history.)
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      byModel: Array<{ model: string; inputTokens: number; outputTokens: number; estimatedCost: number }>;
    }>;
  } | null;
  /** Subscription-fee-to-project attribution for the selected period. */
  feeAttribution: FeeAttribution | null;
  modelEfficiency: ModelEfficiencyData | null;
  contextAnalysis: ContextAnalysis | null;
  spending: DashboardSpending | null;
  energy: DashboardEnergy | null;
  /**
   * Cost-per-successful-task metric for the current period/filter, or null.
   * `buildDashboard` (synchronous) always leaves this null; it is populated
   * asynchronously by {@link attachCostPerTask} in the full-dashboard renderers
   * (serve / VS Code panel / CLI `dashboard`), because the metric iterates the
   * async recap pipeline per day and the lightweight callers (statusBar, MCP
   * `get_stats`) must not pay that cost.
   */
  costPerTask: CostPerTaskReport | null;
  /**
   * Calibration of the outcome proxy/signals against the user's labels. Null
   * until {@link attachCalibration} runs (VS Code panel only — it drives the
   * in-dashboard "is the success rate trustworthy yet" view + the activation
   * toggle). Sync signals only (no per-refresh LLM-judge calls).
   */
  calibration: CalibrationReport | null;
  /** Whether the experimental accuracy signals are currently enabled (config). */
  experimentalSignalsEnabled: boolean;
  recommendations: Recommendation[];
  /** All accounts present in the store for the current period — independent of
   * the account filter. Drives the dashboard's account selector. */
  availableAccounts: Array<{
    accountUuid: string;
    emailAddress: string | null;
    subscriptionType: string | null;
    sessionCount: number;
    /** True for the account currently logged in to Claude Code. */
    isCurrent: boolean;
  }>;
  /** The accountUuid currently being filtered to, or null for "all accounts combined". */
  selectedAccountUuid: string | null;
  /**
   * Inputs the Insights tab needs that no other block carries — ticket
   * attribution for the period and the user's hourly rate. Null until
   * {@link attachInsights} runs; the tab then renders each affected card's
   * honest-unavailable state rather than omitting it, so a caller that skips
   * the attach still gets a correct (if emptier) page rather than a broken one.
   *
   * Optional rather than `DashboardInsights | null`, matching {@link
   * DashboardData.untilIso}'s precedent: the many pre-existing `DashboardData`
   * literals in tests and fixtures across the repo keep compiling, and every
   * consumer must read it as `data.insights?.…` anyway because "not attached"
   * and "attached but empty" are both real states.
   */
  insights?: DashboardInsights | null;
  /**
   * The most recently active session's ticket attribution — what the
   * link/negate card (Lane L) renders and corrects. Undefined until {@link
   * attachTicketAttribution} runs (matching {@link insights}'s precedent, so
   * pre-existing `DashboardData` literals keep compiling); null when the
   * store holds no sessions at all. "Current session" means the same
   * most-recently-active session {@link Store.getMostRecentSessionId}
   * defines — not the window this dashboard happens to be filtered to, since
   * the card corrects attribution regardless of which period is on screen.
   */
  currentSessionTicket?: CurrentSessionTicket | null;
}

/** One row of {@link DashboardData.currentSessionTicket}'s `links` list. */
export interface CurrentSessionTicketLink {
  ticketKey: string;
  source: string;
  confidence: string;
  granularity: string;
  negated: boolean;
}

export interface CurrentSessionTicket {
  sessionId: string;
  links: readonly CurrentSessionTicketLink[];
}

/**
 * The Insights tab's extra inputs. Deliberately narrow: everything else the
 * five cards need is already on `DashboardData`, and duplicating a figure here
 * would create a second place for it to be wrong.
 */
export interface DashboardInsights {
  /**
   * The cost vocabulary for this dashboard as a whole, and which rule decided
   * it. Resolved once here so every surface speaks the same one; `mixed` is a
   * real verdict, not a failure, and the cost card renders it as such.
   */
  vocabulary: VocabularyResolution;
  /**
   * Ticket-attribution coverage for exactly this dashboard's window and
   * filters, or null when the store holds no active ticket links at all (which
   * is the state before Lane A's extraction is configured). Null and
   * zero-coverage are different answers and the card says so differently.
   */
  ticketCoverage: TicketCoverage | null;
  /** Costliest attributed ticket in the window, or null. */
  topTicket: { key: string; cost: number } | null;
  /** `config.rate.hourly` — absent means the dev-time clause is omitted, never estimated. */
  hourlyRate: number | null;
  /** `config.rate.currency`, defaulting to USD. Never auto-converted. */
  currency: string;
  /**
   * How well the automatic attribution pass has agreed with the user's explicit
   * rulings, gated at the minimum sample (Lane K).
   *
   * Whole-store, unlike `ticketCoverage` — calibration is a property of the
   * mechanism, not of this window, and a per-window cut of an already-scarce
   * sample would read "uncalibrated" forever regardless of how much the user
   * had reviewed. Null only when the gather itself failed.
   */
  attributionCalibration: CalibrationEstimate | null;
  /**
   * Bottom-up cost reconciled against `config.reconciliation.invoiceTotal`
   * for exactly this dashboard's window and filters — the SAME
   * `getTicketCostReport` call this block already makes for
   * `ticketCoverage`, so the bottom-up figure reconciliation compares can
   * never disagree with the one the coverage denominator uses. Null when no
   * invoice figure is configured, when the account mode isn't `metered`
   * (plan-mode cost is equivalent-API-value, not money — comparing it to an
   * invoice is a category error, not a residual), or when the window has no
   * local spend at all (the honest-empty state, not a manufactured
   * residual).
   */
  reconciliation: Reconciliation | null;
}

export interface Recommendation {
  id: string;
  severity: "critical" | "warning" | "info" | "success";
  title: string;
  body: string;
  /** Optional dollar-impact tag shown as a pill next to the title. */
  impact?: string;
}

export interface DashboardSpending {
  topSessionsByCost: Array<{
    sessionId: string;
    projectPath: string;
    estimatedCost: number;
    promptCount: number;
    durationMs: number;
    dominantModel: string;
  }>;
  topToolsByCost: Array<{
    tool: string;
    estimatedCost: number;
    invocationCount: number;
    isMcp: boolean;
    mcpServer: string | null;
  }>;
  costByModel: Array<{
    model: string;
    estimatedCost: number;
    inputTokens: number;
    outputTokens: number;
    percentage: number;
  }>;
  expensivePrompts: Array<{
    uuid: string;
    sessionId: string;
    model: string;
    totalTokens: number;
    estimatedCost: number;
    promptPreview: string;
    timesAvg: number;
    flags: string[];
  }>;
  cacheEfficiency: {
    overallHitRate: number;
    estimatedSavings: number;
  };
  mcpServers: Array<{
    server: string;
    estimatedCost: number;
    totalCalls: number;
    avgTokensPerCall: number;
  }>;
  /** Full MCP server breakdown from all messages (not just top N). */
  mcpServerUsage: Array<{
    server: string;
    estimatedCost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    messageCount: number;
    callCount: number;
    tools: Array<{ method: string; calls: number }>;
    projects: string[];
  }>;
  subagentOverhead: {
    totalCost: number;
    agentCount: number;
  };
}

export interface DashboardEnergy {
  /** Total energy including PUE overhead, in Wh. */
  totalEnergyWh: number;
  /** Total CO₂ emissions, in grams. */
  totalCO2Grams: number;
  /** Low end of ±55% confidence interval. */
  co2GramsLow: number;
  /** High end of ±55% confidence interval. */
  co2GramsHigh: number;
  /** Environmental equivalents for the total. */
  equivalents: {
    treesYears: number;
    carKm: number;
    transitKm: number;
    solarPanelM2: number;
    solarRegionKey: string;
    naturalGasM3: number;
    trainKm: number;
    nuclearWasteMl: number;
    windRotations: number;
    hydroTurbineLiters: number;
  };
  /** Nearest canonical driving journey for this period's carKm. */
  journeyAnchor: { key: string; km: number };
  /** ISO date (YYYY-MM-DD) of the effective period start — earliest message for "all time", else the since filter. */
  periodStartIso: string;
  /** ISO date (YYYY-MM-DD) of "now". */
  periodEndIso: string;
  /** Number of days covered by the period (>= 1). */
  periodDays: number;
  /** Energy and CO₂ per calendar day. */
  byDay: Array<{ date: string; energyWh: number; co2Grams: number }>;
  /** Energy and CO₂ per model (sorted by energyWh desc). */
  byModel: Array<{ model: string; energyWh: number; co2Grams: number; pct: number }>;
  /** Energy and CO₂ per project (sorted by energyWh desc). */
  byProject: Array<{ project: string; energyWh: number; co2Grams: number }>;
  /** Energy saved through cache read tokens (vs re-computing). */
  cacheImpact: { energySavedWh: number; co2SavedGrams: number; cacheEfficiencyPct: number };
  /** Sessions and energy fraction attributed to extended thinking. */
  thinkingImpact: { sessionsWithThinking: number; pctEnergyFromThinking: number };
  /** Distribution of detected inference regions. */
  inferenceGeo: { detected: Record<string, number>; coveragePct: number };
  /** Region key used for the carbon intensity calculation. */
  region: string;
  /** Grid carbon intensity used (gCO₂eq/kWh). */
  gridIntensity: number;
  /** Power Usage Effectiveness multiplier applied to raw inference energy. */
  pue: number;
  /** Per-model-class breakdown for the calculation-transparency panel. */
  byClass: Array<{
    cls: "haiku" | "sonnet" | "opus";
    msgs: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    rawEnergyWh: number;
    inputWhPer1K: number;
    outputWhPer1K: number;
  }>;
}

export interface ContextAnalysis {
  avgPromptsPerSession: number;
  medianPromptsPerSession: number;
  compactionRate: number;             // % of sessions with detected compaction
  avgPeakInputTokens: number;         // average peak input tokens across sessions
  sessionsNeedingCompaction: number;   // long sessions without compaction

  /** Conversation length histogram: bucket label → count */
  lengthDistribution: Array<{ bucket: string; count: number }>;

  /** Average input tokens at each prompt position (1-indexed) */
  contextGrowthCurve: Array<{ promptNumber: number; avgInputTokens: number; sessionCount: number }>;

  /** Sessions that may need better context management */
  longSessions: Array<{
    sessionId: string;
    projectPath: string;
    promptCount: number;
    durationMinutes: number;
    peakInputTokens: number;
    compacted: boolean;
    estimatedCost: number;
  }>;

  /** Cache efficiency bucketed by conversation length */
  cacheByLength: Array<{ bucket: string; cacheEfficiency: number; sessionCount: number }>;

  /** Detected compaction events (large input token drops) */
  compactionEvents: Array<{
    sessionId: string;
    promptPosition: number;
    tokensBefore: number;
    tokensAfter: number;
    reductionPercent: number;
  }>;
}


/**
 * Plan-fee ladder used to derive the `recommendedPlan` thresholds, in
 * ascending price order. Deliberately an explicit list rather than
 * `Object.entries(PLAN_FEES)` — the latter includes the `team` alias
 * (duplicate of `team_standard`'s fee, in insertion order, not price order)
 * and would corrupt the derived midpoints.
 */
const PLAN_FEE_LADDER = ["pro", "team_standard", "max_5x", "team_premium", "max_20x"] as const;

/**
 * Recommendation thresholds: the midpoint between each adjacent pair of fees
 * on the ladder. Derived from `PLAN_FEES` (core/pricing.ts) instead of
 * hand-coded, so the two never drift apart (analysis 03's drift lesson).
 * With pro 20 / team_standard 25 / max_5x 100 / team_premium 125 / max_20x 200:
 *   22.5 / 62.5 / 112.5 / 162.5 — matches the previously hand-coded constants.
 */
export const PLAN_LADDER_THRESHOLDS: readonly number[] = PLAN_FEE_LADDER.slice(1).map(
  (plan, i) => (PLAN_FEES[PLAN_FEE_LADDER[i]!]! + PLAN_FEES[plan]!) / 2,
);

export function buildDashboard(store: Store, opts: ReportOptions): DashboardData {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { since, until } = periodRange(opts, tz);
  // A custom since/until range has no preset name; downstream consumers (the
  // returned `period` field, the "day"-only display gates below) need an
  // unambiguous signal that this isn't one of the fixed presets.
  const isCustomRange = Boolean(opts.since && opts.until);

  // Include sessions ACTIVE in the period (last activity at/after `since`), not
  // just those that STARTED in it. A session running across the period boundary
  // (e.g. one straddling midnight into a new day/month) contributes cost, energy
  // and active-hours — all filtered by MESSAGE timestamp below — so it must be
  // counted here too, else the summary shows "0 sessions" beside a non-zero cost.
  // The session set is flipped to include CI/non-interactive AND source-deleted
  // sessions by default so every session-scoped aggregate (byAccount, byProject,
  // byDay, sessionCostMap, spending, context) reconciles with the message-scoped
  // headline (getMessageTotals, which counts every in-window message regardless
  // of session flags). Explicit caller values still win — server ?includeCI=,
  // CLI --include-ci; only callers that OMIT them inherit the new default.
  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    activeSince: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
    includeCI: opts.includeCI ?? true,
    includeDeleted: opts.includeDeleted ?? true,
  });

  // The SINGLE filter every message-scoped read uses. Declared once, next to the
  // `getSessions` call it must agree with, so the two halves of the dashboard
  // cannot be narrowed differently — a message-scoped read that quietly omitted
  // includeCI kept pricing CI work the session set had already dropped, and made
  // a CI-only project reappear in byProject under includeCI=false.
  const msgFilter: MessageFilter = {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
    includeCI: opts.includeCI ?? true,
    includeDeleted: opts.includeDeleted ?? true,
  };

  // ── Summary aggregation ──────────────────────────────────────────────────
  // Token totals are MESSAGE-scoped (assigned further down from `messageTotals`),
  // never summed from `rows`. Two reasons, both load-bearing:
  //
  //  1. Period correctness. The `sessions` token columns are LIFETIME totals for
  //     the whole session, so a session straddling the period boundary would
  //     contribute its entire history to the window — a week-long session dumped
  //     7.1 BILLION cache reads into a single day before this changed.
  //  2. Reconciliation. Cost is priced from `messages`; sourcing tokens from the
  //     same read makes "tokens" and "cost" describe the same work by
  //     construction rather than by coincidence.
  //
  // Prompts are message-scoped too, via `is_turn_start` — the per-message flag
  // marking an assistant message that answered a real user prompt rather than a
  // tool result. Without it there was no way to count prompts IN a window
  // (`messages` holds only assistant rows), so the summary summed session
  // lifetime `prompt_count`, which both over-counted (tool results counted as
  // prompts: 227 for ~4 real ones) and ignored the period entirely.
  let totalPrompts = 0;
  let totalDurationMs = 0;

  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });

  // Accumulators for grouping. Token fields are filled from the message-scoped
  // reads below; only genuinely session-level fields (session counts, prompts,
  // thinking blocks, the tool-derived work profile) accumulate from `rows`.
  type TokenBucket = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; estimatedCost: number };
  const emptyTokens = (): TokenBucket => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCost: 0 });
  const dayMap = new Map<string, { sessions: number; prompts: number } & TokenBucket>();
  const hourMap = new Map<number, TokenBucket>();
  const projectMap = new Map<string, { sessions: number; prompts: number; thinkingBlocks: number; workProfile: { exploring: number; editing: number; running: number; researching: number; planning: number } } & TokenBucket>();
  const entrypointMap = new Map<string, number>();

  for (const row of rows) {
    if (row.first_timestamp != null && row.last_timestamp != null) {
      totalDurationMs += Math.abs(row.last_timestamp - row.first_timestamp);
    }

    // byDay — a session is counted on the day it STARTED (a session-level fact);
    // its tokens are placed per-message below, so a session spanning midnight
    // contributes one session count here but token counts on each day it ran.
    const dateStr = row.first_timestamp != null
      ? dayFmt.format(new Date(row.first_timestamp))
      : "unknown";
    const dayEntry = dayMap.get(dateStr) ?? { sessions: 0, prompts: 0, ...emptyTokens() };
    dayEntry.sessions++;
    dayMap.set(dateStr, dayEntry);

    // byProject
    const projEntry = projectMap.get(row.project_path) ?? {
      sessions: 0, prompts: 0, thinkingBlocks: 0,
      workProfile: { exploring: 0, editing: 0, running: 0, researching: 0, planning: 0 },
      ...emptyTokens(),
    };
    projEntry.sessions++;
    projEntry.thinkingBlocks += row.thinking_blocks;
    const toolCounts: Array<{ name: string; count: number }> = JSON.parse(row.tool_use_counts || "[]");
    for (const tc of toolCounts) {
      const cat = TOOL_CATEGORY[tc.name];
      if (cat) projEntry.workProfile[cat] += tc.count;
    }
    projectMap.set(row.project_path, projEntry);

    // byEntrypoint
    const ep = row.entrypoint ?? "unknown";
    entrypointMap.set(ep, (entrypointMap.get(ep) ?? 0) + 1);
  }

  // ── Per-day / per-hour tokens + cost, message-scoped ─────────────────────
  // 15-minute UTC buckets are narrow enough that none can straddle a tz-local
  // day or hour boundary (real offsets include :30 and :45), so folding them
  // with the same Intl formatters used above is exact.
  const wantHourly = opts.period === "day" || (until - since) <= 86_400_000;
  for (const b of store.getMessageTotalsByBucket(msgFilter)) {
    const { cost } = estimateCost(b.model, b.input_tokens, b.output_tokens, b.cache_read_tokens, b.cache_creation_tokens);
    const dateStr = b.bucket_start != null ? dayFmt.format(new Date(b.bucket_start)) : "unknown";
    const dayEntry = dayMap.get(dateStr) ?? { sessions: 0, prompts: 0, ...emptyTokens() };
    dayEntry.inputTokens += b.input_tokens;
    dayEntry.outputTokens += b.output_tokens;
    dayEntry.cacheReadTokens += b.cache_read_tokens;
    dayEntry.cacheCreationTokens += b.cache_creation_tokens;
    dayEntry.estimatedCost += cost;
    dayEntry.prompts += b.prompt_count;
    totalPrompts += b.prompt_count;
    dayMap.set(dateStr, dayEntry);

    if (wantHourly && b.bucket_start != null) {
      const h = parseInt(hourFmt.format(new Date(b.bucket_start)), 10) % 24;
      const hourEntry = hourMap.get(h) ?? emptyTokens();
      hourEntry.inputTokens += b.input_tokens;
      hourEntry.outputTokens += b.output_tokens;
      hourEntry.cacheReadTokens += b.cache_read_tokens;
      hourEntry.cacheCreationTokens += b.cache_creation_tokens;
      hourEntry.estimatedCost += cost;
      hourMap.set(h, hourEntry);
    }
  }

  // ── Per-project tokens + cost, message-scoped ────────────────────────────
  for (const p of store.getMessageTotalsByProject(msgFilter)) {
    const { cost } = estimateCost(p.model, p.input_tokens, p.output_tokens, p.cache_read_tokens, p.cache_creation_tokens);
    const entry = projectMap.get(p.project_path) ?? {
      sessions: 0, prompts: 0, thinkingBlocks: 0,
      workProfile: { exploring: 0, editing: 0, running: 0, researching: 0, planning: 0 },
      ...emptyTokens(),
    };
    entry.inputTokens += p.input_tokens;
    entry.outputTokens += p.output_tokens;
    entry.cacheReadTokens += p.cache_read_tokens;
    entry.cacheCreationTokens += p.cache_creation_tokens;
    entry.estimatedCost += cost;
    entry.prompts += p.prompt_count;
    projectMap.set(p.project_path, entry);
  }

  // ── Cost from per-message model data ─────────────────────────────────────
  const messageTotals = store.getMessageTotals(msgFilter);

  let totalCost = 0;
  // The headline token totals come from this same read, so "tokens" and "cost"
  // are guaranteed to describe the same messages (see the note above `totalPrompts`).
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  // Set when any priced message this period rested on a fallback rate (see
  // DashboardSummary.anyFallbackRates) — surfaced so the cost card's caveat
  // can say the figure is an estimate rather than asserting "actual metered
  // cost" over a partner platform's separately-priced usage.
  let anyFallbackRates = false;
  const byModel: DashboardData["byModel"] = [];
  for (const mt of messageTotals) {
    const result = estimateCost(
      mt.model,
      mt.input_tokens,
      mt.output_tokens,
      mt.cache_read_tokens,
      mt.cache_creation_tokens,
    );
    if (result.rateBasis === "first_party_fallback") anyFallbackRates = true;
    totalCost += result.cost;
    totalInput += mt.input_tokens;
    totalOutput += mt.output_tokens;
    totalCacheRead += mt.cache_read_tokens;
    totalCacheCreate += mt.cache_creation_tokens;
    byModel.push({
      model: mt.model,
      inputTokens: mt.input_tokens,
      outputTokens: mt.output_tokens,
      estimatedCost: Math.round(result.cost * 100) / 100,
    });
  }

  // ── Fill empty day buckets for the full period range so charts always show
  //    all days in the selected window, not just days that have sessions ────
  if (since > 0) {
    // Cap at `until`'s own day, not always "today" — a historical custom range
    // (e.g. last month) shouldn't fill days between its end and now.
    const untilStr = dayFmt.format(new Date(until));
    let cursor = new Date(since);
    for (let i = 0; i < 400; i++) { // safety cap
      const dateStr = dayFmt.format(cursor);
      if (dateStr > untilStr) break;
      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, { sessions: 0, prompts: 0, ...emptyTokens() });
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // ── byDay / byProject ────────────────────────────────────────────────────
  // Cost is priced per bucket from that bucket's own model mix, not smeared
  // across the period in proportion to output tokens. The old proportional
  // split mispriced any day whose model mix differed from the period average
  // (an Opus-heavy day next to a Haiku-heavy one), and it silently inherited
  // whatever the session-lifetime token sums said. Σ byDay cost == headline
  // cost now holds because both price the same per-model message groups.
  const byDay: DashboardData["byDay"] = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      sessions: d.sessions,
      prompts: d.prompts,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      estimatedCost: Math.round(d.estimatedCost * 100) / 100,
    }));

  const byProject: DashboardData["byProject"] = Array.from(projectMap.entries())
    .sort(([, a], [, b]) => b.inputTokens - a.inputTokens)
    .map(([projectPath, p]) => ({
      projectPath,
      sessions: p.sessions,
      prompts: p.prompts,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      estimatedCost: Math.round(p.estimatedCost * 100) / 100,
      thinkingBlocks: p.thinkingBlocks,
      workProfile: p.workProfile,
    }));

  // ── Cache efficiency ─────────────────────────────────────────────────────
  const totalLogicalInput = totalInput + totalCacheCreate + totalCacheRead;
  const cacheEfficiency = totalLogicalInput > 0
    ? Math.round(((totalCacheRead / totalLogicalInput) * 100) * 10) / 10
    : 0;

  // ── Stop reasons ─────────────────────────────────────────────────────────
  const sessionIds = rows.map(r => r.session_id);
  const stopReasonMap = store.getStopReasonCounts(sessionIds);
  const stopReasons: DashboardData["stopReasons"] = Array.from(stopReasonMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count }));

  // ── Entrypoints ──────────────────────────────────────────────────────────
  const byEntrypoint: DashboardData["byEntrypoint"] = Array.from(entrypointMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([entrypoint, sessions]) => ({ entrypoint, sessions }));

  // ── Hourly breakdown (day period, or a custom range collapsed to a single day) ──
  const byHour: DashboardData["byHour"] = wantHourly
    ? Array.from({ length: 24 }, (_, h) => {
        const e = hourMap.get(h) ?? emptyTokens();
        return {
          hour: String(h).padStart(2, "0"),
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          cacheReadTokens: e.cacheReadTokens,
          cacheCreationTokens: e.cacheCreationTokens,
        };
      })
    : [];

  // ── Plan ROI metrics ─────────────────────────────────────────────────────
  // An explicit CLI `--plan-fee` (opts.planFee) is a deliberate single-number
  // override and wins. Otherwise per-account subscriptions are the source of
  // truth: sum each in-scope account's resolved fee (explicit per-account fee →
  // its plan-type default → telemetry-detected), so two different plans
  // (e.g. personal Max 20x + work Team Premium) add up correctly.
  const explicitPlanFee = opts.planFee && opts.planFee > 0 ? opts.planFee : 0;
  // Synthetic config for per-account fee resolution: the dashboard receives the
  // resolved pieces (accountFees map + any explicit global fee) rather than a
  // full Config, so reconstruct the minimal shape resolveAccountFee reads.
  const feeConfig: Config = { accountFees: opts.accountFees, plan: { monthly_fee: explicitPlanFee || undefined } };
  const sumPerAccountFees = (): number => {
    // Effective plan type per in-scope account: explicit per-account type →
    // telemetry subscription_type → (legacy) global configured type.
    const typeByAccount = new Map<string, string | null>();
    for (const row of rows) {
      const key = row.account_uuid ?? "(unknown)";
      const prev = typeByAccount.get(key) ?? null;
      typeByAccount.set(key, row.subscription_type ?? prev);
    }
    let total = 0;
    for (const [key, subType] of typeByAccount) {
      const effType = opts.accountFees?.[key]?.type ?? subType ?? opts.planType ?? null;
      const resolved = resolveAccountFee(feeConfig, key, effType, typeByAccount.size);
      if (resolved) total += resolved.monthlyFee;
    }
    return total;
  };
  const planFee = explicitPlanFee > 0 ? explicitPlanFee : sumPerAccountFees();
  const planMultiplier = planFee > 0 ? Math.round((totalCost / planFee) * 10) / 10 : 0;
  const costPerPrompt = totalPrompts > 0 ? totalCost / totalPrompts : 0;
  const daysInPeriod = since > 0 ? Math.max(1, (until - since) / (24 * 60 * 60 * 1000)) : 30;
  const dailyValueRate = totalCost / daysInPeriod;

  // ── Velocity + active hours ──────────────────────────────────────────────
  // Active time is derived from the merged timeline of all message timestamps in
  // the selected period. Gaps ≥ 30 min are treated as idle and excluded. We merge
  // across sessions first (rather than summing per-session durations) so that
  // overlapping parallel sessions — common when agents spawn subagents — don't
  // get double-counted.
  // `Store.getMessageTimestamps` has no `until` param (out of this task's file
  // allowlist to add one) — bound the upper edge here instead. A no-op for
  // presets, where `until` is already ~now.
  const mergedTimestamps = store.getMessageTimestamps({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
  }).filter(t => t <= until);
  const IDLE_GAP_MS = 30 * 60_000;
  let totalActiveDurationMs = 0;
  for (let i = 1; i < mergedTimestamps.length; i++) {
    const gap = mergedTimestamps[i]! - mergedTimestamps[i - 1]!;
    if (gap < IDLE_GAP_MS) totalActiveDurationMs += gap;
  }
  // Session-level active duration is still useful for per-session averages —
  // it doesn't over-count as long as we don't sum it into the period total.
  let totalSessionActiveMs = 0;
  let totalThrottleEvents = 0;
  for (const row of rows) {
    if (row.active_duration_ms != null) totalSessionActiveMs += row.active_duration_ms;
    totalThrottleEvents += row.throttle_events ?? 0;
  }
  const totalActiveHours = totalActiveDurationMs / 3_600_000;
  const avgSessionDurationMinutes = rows.length > 0
    ? (totalSessionActiveMs / rows.length) / 60_000
    : 0;
  const tokensPerMinute = totalActiveDurationMs > 0
    ? Math.round((totalInput + totalOutput) / (totalActiveDurationMs / 60_000))
    : 0;
  const outputTokensPerPrompt = totalPrompts > 0 ? Math.round(totalOutput / totalPrompts) : 0;
  const promptsPerHour = totalActiveHours > 0
    ? Math.round((totalPrompts / totalActiveHours) * 10) / 10
    : 0;
  const costPerActiveHour = totalActiveHours > 0 ? totalCost / totalActiveHours : 0;

  // ── Usage windows ────────────────────────────────────────────────────────
  const windowSince = since > 0 ? since : Date.now() - 30 * 24 * 60 * 60 * 1000;
  const byWindow = store.getUsageWindows({ since: windowSince });

  const currentWindow = byWindow[0] ?? null;
  const currentWindowStart = currentWindow ? new Date(currentWindow.windowStart).toISOString() : null;
  const currentWindowPrompts = currentWindow?.promptCount ?? 0;
  const currentWindowCost = currentWindow?.totalCostEquivalent ?? 0;

  // ── Per-conversation cost ranking ─────────────────────────────────────────
  // Bound to the SAME [since, until) the headline uses so each session's
  // IN-WINDOW contribution (not its whole lifetime) feeds byAccount /
  // byConversationCost / spending / contextAnalysis — the fix for Effect 3
  // (analysis §3.3.3). list_sessions' per-session cost stays unbounded via the
  // separate getCostBySession call.
  const msgTotalsBySession = store.getMessageTotalsBySession(sessionIds, {
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
  });
  const sessionCostMap = new Map<string, { cost: number; topModel: string; topModelTokens: number }>();
  for (const mt of msgTotalsBySession) {
    const entry = sessionCostMap.get(mt.session_id) ?? { cost: 0, topModel: mt.model ?? "", topModelTokens: 0 };
    const { cost } = estimateCost(mt.model, mt.input_tokens, mt.output_tokens, mt.cache_read_tokens, mt.cache_creation_tokens);
    entry.cost += cost;
    const tokens = mt.input_tokens + mt.output_tokens;
    if (tokens > entry.topModelTokens) {
      entry.topModel = mt.model ?? "";
      entry.topModelTokens = tokens;
    }
    sessionCostMap.set(mt.session_id, entry);
  }

  // Build a map of parent → child count for subagent linking
  const childCountMap = new Map<string, number>();
  for (const row of rows) {
    if (row.parent_session_id) {
      childCountMap.set(row.parent_session_id, (childCountMap.get(row.parent_session_id) ?? 0) + 1);
    }
  }

  const byConversationCost: DashboardData["byConversationCost"] = rows
    .map(row => {
      const costs = sessionCostMap.get(row.session_id);
      const cost = costs?.cost ?? 0;
      return {
        sessionId: row.session_id,
        projectPath: row.project_path,
        durationMs: row.first_timestamp != null && row.last_timestamp != null
          ? row.last_timestamp - row.first_timestamp
          : 0,
        estimatedCost: Math.round(cost * 10000) / 10000,
        percentOfPlanFee: planFee > 0 ? Math.round((cost / planFee) * 1000) / 10 : 0,
        dominantModel: costs?.topModel ?? "",
        promptCount: row.prompt_count,
        isSubagent: row.is_subagent === 1,
        childCount: childCountMap.get(row.session_id) ?? 0,
      };
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
    .slice(0, 20);

  // ── Model efficiency analysis ───────────────────────────────────────────
  const modelEfficiency = buildModelEfficiency(store, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
  });

  // ── Weekly aggregation + plan utilization ──────────────────────────────
  const weekMap = new Map<string, { sessions: number; prompts: number; cost: number; activeDurationMs: number }>();
  for (const row of rows) {
    const ts = row.first_timestamp ?? Date.now();
    const d = new Date(ts);
    // ISO week starts Monday — roll back to Monday
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const weekKey = monday.toISOString().slice(0, 10);
    const entry = weekMap.get(weekKey) ?? { sessions: 0, prompts: 0, cost: 0, activeDurationMs: 0 };
    entry.sessions++;
    entry.prompts += row.prompt_count;
    entry.activeDurationMs += row.active_duration_ms ?? 0;
    weekMap.set(weekKey, entry);
  }

  // Distribute cost to weeks proportionally by output tokens (same approach as byDay)
  const dayToWeek = new Map<string, string>();
  for (const dayEntry of byDay) {
    const d = new Date(dayEntry.date + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    dayToWeek.set(dayEntry.date, monday.toISOString().slice(0, 10));
  }
  for (const dayEntry of byDay) {
    const weekKey = dayToWeek.get(dayEntry.date);
    if (weekKey) {
      const entry = weekMap.get(weekKey);
      if (entry) entry.cost += dayEntry.estimatedCost;
    }
  }

  // Count windows per week
  const windowsByWeek = new Map<string, { count: number; throttled: number }>();
  for (const w of byWindow) {
    const d = new Date(w.windowStart);
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const weekKey = monday.toISOString().slice(0, 10);
    const entry = windowsByWeek.get(weekKey) ?? { count: 0, throttled: 0 };
    entry.count++;
    if (w.throttled) entry.throttled++;
    windowsByWeek.set(weekKey, entry);
  }

  const byWeek: DashboardData["byWeek"] = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, w]) => {
      const ww = windowsByWeek.get(week);
      return {
        week,
        sessions: w.sessions,
        prompts: w.prompts,
        estimatedCost: Math.round(w.cost * 100) / 100,
        activeHoursEstimate: Math.round((w.activeDurationMs / 3_600_000) * 10) / 10,
        windowCount: ww?.count ?? 0,
        windowsWithTruncatedOutput: ww?.throttled ?? 0,
      };
    });

  // ── Plan utilization analysis ─────────────────────────────────────────
  let planUtilization: DashboardData["planUtilization"] = null;
  if (byWeek.length > 0) {
    // Auto-detect plan fee from account subscription types if not explicitly set.
    // Group sessions by account to support multi-account usage.
    // Session-count + subscription-type per account come from the session `rows`
    // (a session-experience metric). Cost/tokens do NOT — see accountTokens below.
    const accountMap = new Map<string, { subscriptionType: string | null; sessions: number }>();
    for (const row of rows) {
      const acctKey = row.account_uuid ?? "(unknown)";
      const entry = accountMap.get(acctKey) ?? { subscriptionType: row.subscription_type, sessions: 0 };
      entry.sessions++;
      // Pick the most recent subscription type seen for this account
      if (row.subscription_type) entry.subscriptionType = row.subscription_type;
      accountMap.set(acctKey, entry);
    }

    // Per-account token + per-model + cost totals, sourced from a MESSAGE-scoped,
    // account-grouped query — the SAME query the headline (getMessageTotals) runs,
    // just GROUP BY account. This makes Σ byAccount == headline an IDENTITY,
    // independent of session first/last-timestamp drift: a session with a NULL
    // last_timestamp and an early first_timestamp is dropped from the session
    // `rows` set (its COALESCE(last,first) falls before `since`) but its in-window
    // messages still count here and in the headline. Orphan messages (session_id
    // absent from `sessions`) are dropped by the inner join, exactly as the
    // headline's EXISTS drops them. (The earlier `rows`+sessionCostMap source
    // under-counted by exactly those NULL-last sessions — verified on real data.)
    type AcctTokens = {
      inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheCreationTokens: number; cost: number;
      byModel: Map<string, { inputTokens: number; outputTokens: number; estimatedCost: number }>;
    };
    const accountTokens = new Map<string, AcctTokens>();
    const acctModelTotals = store.getMessageTotalsByAccount(msgFilter);
    for (const mt of acctModelTotals) {
      const acctKey = mt.account_uuid ?? "(unknown)";
      const entry = accountTokens.get(acctKey) ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0,
        byModel: new Map<string, { inputTokens: number; outputTokens: number; estimatedCost: number }>(),
      };
      entry.inputTokens += mt.input_tokens;
      entry.outputTokens += mt.output_tokens;
      entry.cacheReadTokens += mt.cache_read_tokens;
      entry.cacheCreationTokens += mt.cache_creation_tokens;
      const { cost } = estimateCost(mt.model, mt.input_tokens, mt.output_tokens, mt.cache_read_tokens, mt.cache_creation_tokens);
      entry.cost += cost;
      // Use mt.model as-is (matching the top-level byModel grouping key) so the
      // per-account split reconciles model-for-model with the headline split.
      const m = entry.byModel.get(mt.model) ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      m.inputTokens += mt.input_tokens;
      m.outputTokens += mt.output_tokens;
      m.estimatedCost += cost;
      entry.byModel.set(mt.model, m);
      accountTokens.set(acctKey, entry);
    }

    // `planFee` already resolves the effective subscription cost: an explicit
    // --plan-fee, else the sum of each in-scope account's per-account fee (see
    // sumPerAccountFees above). The per-account verdicts below use the same
    // resolveAccountFee, so the weekly budget and the per-account rows agree.
    const effectivePlanFee = planFee;

    const weeklyPlanBudget = effectivePlanFee > 0 ? effectivePlanFee / 4.33 : 0;
    const weeklyCosts = byWeek.map(w => w.estimatedCost);
    const avgWeeklyCost = weeklyCosts.reduce((s, c) => s + c, 0) / weeklyCosts.length;
    const peakWeeklyCost = Math.max(...weeklyCosts);
    const weeksBelowPlan = weeklyPlanBudget > 0 ? weeklyCosts.filter(c => c < weeklyPlanBudget).length : 0;
    const weeksAbovePlan = weeklyPlanBudget > 0 ? weeklyCosts.filter(c => c >= weeklyPlanBudget).length : 0;

    // Window metrics
    const windowCosts = byWindow.map(w => w.totalCostEquivalent).sort((a, b) => a - b);
    const avgWindowCost = windowCosts.length > 0
      ? windowCosts.reduce((s, c) => s + c, 0) / windowCosts.length : 0;
    const medianWindowCost = windowCosts.length > 0
      ? windowCosts[Math.floor(windowCosts.length / 2)]! : 0;
    const totalWeeks = byWeek.length;
    const windowsPerWeek = totalWeeks > 0 ? byWindow.length / totalWeeks : 0;
    // Share of 5-hour windows that contained at least one truncated-output response.
    // This is NOT a rate-limit throttle metric — the JSONL doesn't capture those at all.
    const truncatedCount = byWindow.filter(w => w.throttled).length;
    const truncatedOutputWindowPercent = byWindow.length > 0
      ? Math.round((truncatedCount / byWindow.length) * 1000) / 10 : 0;

    // Plan recommendation based on weekly API-equivalent cost. Ladder thresholds
    // are derived at module scope from PLAN_FEES (see PLAN_LADDER_THRESHOLDS).
    const monthlyEquiv = avgWeeklyCost * 4.33;
    let recommendedPlan: string | null = null;
    let currentPlanVerdict = "no-plan";

    if (monthlyEquiv < PLAN_LADDER_THRESHOLDS[0]!) recommendedPlan = "pro";
    else if (monthlyEquiv < PLAN_LADDER_THRESHOLDS[1]!) recommendedPlan = "team_standard";
    else if (monthlyEquiv < PLAN_LADDER_THRESHOLDS[2]!) recommendedPlan = "max_5x";
    else if (monthlyEquiv < PLAN_LADDER_THRESHOLDS[3]!) recommendedPlan = "team_premium";
    else if (monthlyEquiv <= PLAN_FEES.max_20x!) recommendedPlan = "max_20x";
    else recommendedPlan = "enterprise";

    // Usage-intensity classification: populated whenever planUtilization is
    // non-null (this branch only runs when byWeek.length > 0); null only when
    // planUtilization itself is null (the `else` branch below the containing
    // `if`). B4 (template) renders the intensity card only when this is set.
    const usageIntensityTier = classifyUsageIntensity(monthlyEquiv);

    if (effectivePlanFee > 0) {
      const utilRate = totalCost / effectivePlanFee;
      if (utilRate >= 1.0) currentPlanVerdict = "good-value";
      else currentPlanVerdict = "underusing";
    }

    // Build per-account breakdown
    // Transitional: resolve "(unknown)" for sessions collected before the aggregator
    // started stamping account_uuid from ~/.claude.json. Can be removed once all
    // users have re-collected (e.g. via `backfill`).
    const claudeAcct = readClaudeAccount();
    if (claudeAcct && accountMap.has("(unknown)") && accountMap.size === 1) {
      const unknown = accountMap.get("(unknown)")!;
      accountMap.delete("(unknown)");
      accountMap.set(claudeAcct.accountUuid, unknown);
      // Mirror the repair for the token/model accumulation so byAccount's new
      // token fields attach to the resolved UUID, not the transitional key.
      const unknownTokens = accountTokens.get("(unknown)");
      if (unknownTokens) {
        accountTokens.delete("(unknown)");
        accountTokens.set(claudeAcct.accountUuid, unknownTokens);
      }
    }
    // Email labels persisted the last time each account was current, so the
    // per-account breakdown shows a readable address for accounts OTHER than the
    // currently-logged-in one instead of a truncated UUID (mirrors the fallback
    // in buildAccountsForConfig).
    const emailLabelByUuid = new Map(
      store.listAccountsFull().map((a) => [a.accountUuid, a.emailLabel ?? null] as const),
    );
    // Emit one row per account present in EITHER map: `accountMap` (session
    // count / subscription type, from `rows`) OR `accountTokens` (cost / tokens,
    // message-scoped). The union matters because a NULL-last-timestamp session
    // can contribute in-window messages (→ accountTokens) while being absent from
    // `rows` (→ not in accountMap); such an account must still show its cost, or
    // Σ byAccount would again fall short of the headline.
    const allAcctKeys = new Set<string>([...accountMap.keys(), ...accountTokens.keys()]);
    const byAccount: DashboardData["planUtilization"] extends { byAccount: infer T } | null ? T : never =
      Array.from(allAcctKeys)
        .map((acctKey) => {
          const acct = accountMap.get(acctKey);
          const tokens = accountTokens.get(acctKey);
          const acctCost = tokens?.cost ?? 0;
          const sessions = acct?.sessions ?? 0;
          // Effective plan type, per account: an explicitly-configured per-account
          // type wins, then telemetry's subscription_type, then the (legacy)
          // global configured type. Two accounts can resolve to different plans.
          const subscriptionType =
            feeConfig.accountFees?.[acctKey]?.type ?? acct?.subscriptionType ?? opts.planType ?? null;
          // Prefer a user-configured per-account fee over the type-derived default.
          const detectedFee = resolveAccountFee(feeConfig, acctKey, subscriptionType, allAcctKeys.size)?.monthlyFee ?? null;
          let verdict = "no-plan";
          if (detectedFee && detectedFee > 0) {
            verdict = acctCost >= detectedFee ? "good-value" : "underusing";
          } else if (effectivePlanFee > 0) {
            // Fall back to proportional share of explicit plan fee
            const share = effectivePlanFee * (sessions / Math.max(rows.length, 1));
            verdict = acctCost >= share ? "good-value" : "underusing";
          }
          const email = claudeAcct?.accountUuid === acctKey
            ? claudeAcct.emailAddress
            : (emailLabelByUuid.get(acctKey) ?? null);
          const byModel = tokens
            ? Array.from(tokens.byModel.entries()).map(([model, m]) => ({
                model,
                inputTokens: m.inputTokens,
                outputTokens: m.outputTokens,
                estimatedCost: Math.round(m.estimatedCost * 100) / 100,
              }))
            : [];
          return {
            accountId: acctKey === "(unknown)" ? "(unknown)" : acctKey.slice(0, 8) + "...",
            emailAddress: email,
            subscriptionType,
            detectedPlanFee: detectedFee,
            sessions,
            estimatedCost: Math.round(acctCost * 100) / 100,
            planVerdict: verdict,
            inputTokens: tokens?.inputTokens ?? 0,
            outputTokens: tokens?.outputTokens ?? 0,
            cacheReadTokens: tokens?.cacheReadTokens ?? 0,
            cacheCreationTokens: tokens?.cacheCreationTokens ?? 0,
            byModel,
          };
        })
        .sort((a, b) => b.estimatedCost - a.estimatedCost);

    planUtilization = {
      weeklyPlanBudget: Math.round(weeklyPlanBudget * 100) / 100,
      avgWeeklyCost: Math.round(avgWeeklyCost * 100) / 100,
      peakWeeklyCost: Math.round(peakWeeklyCost * 100) / 100,
      weeksBelowPlan,
      weeksAbovePlan,
      totalWeeks,
      avgWindowCost: Math.round(avgWindowCost * 100) / 100,
      medianWindowCost: Math.round(medianWindowCost * 100) / 100,
      windowsPerWeek: Math.round(windowsPerWeek * 10) / 10,
      truncatedOutputWindowPercent,
      totalWindows: byWindow.length,
      recommendedPlan,
      currentPlanVerdict,
      usageIntensityTier,
      byAccount,
    };
  }

  // ── Context analysis ───────────────────────────────────────────────────
  const contextAnalysis = buildContextAnalysis(store, rows, sessionCostMap, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
  });

  // ── Spending breakdown ──────────────────────────────────────────────────
  const spending = buildSpendingSection(store, rows, sessionCostMap, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
  });

  // ── Energy dashboard ────────────────────────────────────────────────────
  const energy = buildEnergySection(store, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
    until: isCustomRange ? until : undefined,
    timezone: tz,
  });

  // ── Subscription-fee attribution ────────────────────────────────────────
  // Distribute each account's monthly fee across the projects it used in the
  // selected period, weighted by API-equivalent cost (sessionCostMap). Pure math
  // lives in fee-attribution.ts; here we only assemble its inputs from `rows`.
  let feeAttribution: FeeAttribution | null = null;
  {
    // Apply the same lone-"(unknown)" repair planUtilization uses, so the fee
    // tab and the plan tab attribute usage to the same account.
    const distinctKeys = new Set(rows.map(r => r.account_uuid ?? "(unknown)"));
    let repairUnknownTo: string | null = null;
    if (distinctKeys.size === 1 && distinctKeys.has("(unknown)")) {
      const claudeAcct = readClaudeAccount();
      if (claudeAcct) repairUnknownTo = claudeAcct.accountUuid;
    }
    const keyFor = (raw: string | null): string => {
      const k = raw ?? "(unknown)";
      return k === "(unknown)" && repairUnknownTo ? repairUnknownTo : k;
    };

    const costByAccountProject = new Map<string, { accountUuid: string; projectPath: string; cost: number }>();
    const subTypeByAccount = new Map<string, string | null>();
    for (const row of rows) {
      const acct = keyFor(row.account_uuid);
      if (row.subscription_type || !subTypeByAccount.has(acct)) {
        subTypeByAccount.set(acct, row.subscription_type ?? subTypeByAccount.get(acct) ?? null);
      }
      const cost = sessionCostMap.get(row.session_id)?.cost ?? 0;
      const mapKey = acct + "\u0000" + row.project_path;
      const existing = costByAccountProject.get(mapKey);
      if (existing) existing.cost += cost;
      else costByAccountProject.set(mapKey, { accountUuid: acct, projectPath: row.project_path, cost });
    }

    const accountCount = subTypeByAccount.size;
    const fees: Record<string, { monthlyFee: number; currency: string; label: string } | null> =
      Object.create(null) as Record<string, { monthlyFee: number; currency: string; label: string } | null>;
    for (const [acct, subType] of subTypeByAccount) {
      const resolved = resolveAccountFee(feeConfig, acct, subType, accountCount);
      fees[acct] = resolved
        ? { monthlyFee: resolved.monthlyFee, currency: resolved.currency, label: opts.accountFees?.[acct]?.label ?? "" }
        : null;
    }

    feeAttribution = buildFeeAttribution({
      costByAccountProject: Array.from(costByAccountProject.values()),
      fees,
      periodDays: daysInPeriod,
    });
  }

  // ── Actionable recommendations ─────────────────────────────────────────
  const recommendations = buildRecommendations({
    totalCost,
    totalPrompts,
    cacheEfficiency,
    planUtilization,
    modelEfficiency,
    contextAnalysis,
    spending,
    byConversationCost,
  });

  return {
    generated: new Date().toISOString(),
    period: isCustomRange ? "custom" : (opts.period ?? "all"),
    timezone: tz,
    sinceIso: since > 0 ? ymdInTz(since, tz) : null,
    // `until` is the exclusive upper boundary (midnight of the day *after*
    // the requested/effective end — see periodRange()/dayWindowInTz), but
    // untilIso is a user-facing display/echo field (e.g. the toolbar's
    // #until-date-input value) — subtract 1ms so it reports the inclusive
    // last calendar day, matching what a user actually requested.
    untilIso: ymdInTz(until - 1, tz),
    summary: {
      sessions: rows.length,
      prompts: totalPrompts,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreate,
      cacheEfficiency,
      estimatedCost: Math.round(totalCost * 100) / 100,
      anyFallbackRates,
      totalDurationMs,
      planFee,
      planMultiplier,
      costPerPrompt: Math.round(costPerPrompt * 10000) / 10000,
      costPerActiveHour: Math.round(costPerActiveHour * 100) / 100,
      dailyValueRate: Math.round(dailyValueRate * 100) / 100,
      tokensPerMinute,
      outputTokensPerPrompt,
      promptsPerHour,
      totalActiveHours: Math.round(totalActiveHours * 10) / 10,
      avgSessionDurationMinutes: Math.round(avgSessionDurationMinutes * 10) / 10,
      truncatedOutputs: totalThrottleEvents,
      currentWindowStart,
      currentWindowPrompts,
      currentWindowCost: Math.round(currentWindowCost * 100) / 100,
      subagentSessions: rows.filter(r => r.is_subagent === 1).length,
      parentSessionsWithChildren: new Set(
        rows.filter(r => r.parent_session_id != null).map(r => r.parent_session_id!)
      ).size,
    },
    byDay,
    byHour,
    byProject,
    byModel,
    byEntrypoint,
    stopReasons,
    byWindow,
    byConversationCost,
    byWeek,
    planUtilization,
    feeAttribution,
    modelEfficiency,
    contextAnalysis,
    spending,
    energy,
    costPerTask: null,
    calibration: null,
    experimentalSignalsEnabled: false,
    recommendations,
    availableAccounts: (() => {
      // Always list accounts using the unfiltered period so the dropdown can
      // offer all accounts regardless of the current account filter.
      const claudeAcct = readClaudeAccount();
      // Match the `rows` flip (includeCI/includeDeleted default true) so the
      // account selector lists exactly the accounts byAccount can show — else an
      // account whose only in-window sessions are CI/source-deleted would appear
      // in byAccount but be missing from the selector (Blocker 2).
      const list = store.listAccounts({
        since: since > 0 ? since : undefined,
        until: isCustomRange ? until : undefined,
        includeCI: opts.includeCI ?? true,
        includeDeleted: true,
      });
      const emailLabelByUuid = new Map(
        store.listAccountsFull().map((a) => [a.accountUuid, a.emailLabel ?? null] as const),
      );
      return list.map(a => ({
        accountUuid: a.accountUuid,
        emailAddress: claudeAcct?.accountUuid === a.accountUuid
          ? claudeAcct.emailAddress
          : (emailLabelByUuid.get(a.accountUuid) ?? null),
        subscriptionType: a.subscriptionType,
        sessionCount: a.sessionCount,
        isCurrent: claudeAcct?.accountUuid === a.accountUuid,
      }));
    })(),
    selectedAccountUuid: opts.accountUuid ?? null,
    insights: null,
  };
}

/**
 * Populate `data.insights` — the Insights tab's extra inputs.
 *
 * Synchronous (unlike {@link attachCostPerTask}): the ticket report is two
 * indexed store reads plus a pure aggregation, cheap enough to run on every
 * refresh. Separate from `buildDashboard` for a different reason — it needs
 * the user's `Config`, which the lightweight callers (status bar, MCP
 * `get_stats`) neither have nor want.
 *
 * Never throws. A store predating schema V19, or any other failure, leaves
 * `insights` null and the affected cards render their honest-unavailable
 * branch — the correct output for "not enabled yet", not a broken page.
 */
export function attachInsights(
  store: Store,
  data: DashboardData,
  opts: ReportOptions,
  config: Config,
): DashboardData {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currency = config.rate?.currency ?? "USD";
  const hourlyRate = config.rate?.hourly ?? null;
  const vocabulary = resolveDashboardCostVocabulary(data, config);

  let ticketCoverage: TicketCoverage | null = null;
  let topTicket: { key: string; cost: number } | null = null;
  let reconciliation: Reconciliation | null = null;
  try {
    const { since, until } = periodRange(opts, tz);
    const isCustomRange = Boolean(opts.since && opts.until);
    // The SAME window and filters `buildDashboard` used above — a coverage
    // denominator computed over a different window would silently disagree
    // with the headline cost it is a fraction of.
    const report = getTicketCostReport(store, {
      since: since > 0 ? since : undefined,
      until: isCustomRange ? until : undefined,
      projectPath: opts.projectPath,
      repoUrl: opts.repoUrl,
      accountUuid: opts.accountUuid,
      includeCI: opts.includeCI ?? true,
      includeDeleted: opts.includeDeleted ?? true,
    });
    ticketCoverage = report.coverage;
    const top = report.tickets[0];
    topTicket = top ? { key: top.ticketKey, cost: top.cost } : null;

    // `report.totalCost` is the SAME bottom-up figure `ticketCoverage`'s
    // denominator is derived from, over the SAME window — so the number
    // reconciliation compares against the invoice is never a different total
    // than the one the rest of the tab renders. Metered only: a plan
    // account's cost is equivalent-API-value, not money.
    if (vocabulary.vocabulary === "metered") {
      reconciliation = computeReconciliation({
        bottomUp: report.totalCost,
        invoiceTotal: config.reconciliation?.invoiceTotal ?? null,
        tolerance: config.reconciliation?.tolerancePercent != null ? config.reconciliation.tolerancePercent / 100 : undefined,
        unknownTokens: report.unknownTokens,
        anyFallbackRates: report.anyFallbackRates,
        scopeNote: config.reconciliation?.scopeNote ?? null,
      });
    }
  } catch {
    ticketCoverage = null;
    topTicket = null;
    reconciliation = null;
  }

  // Gathered in its OWN try: a pre-V19 store or a failed ticket report must not
  // also blank the calibration state, and vice versa. Sharing one catch would
  // make either failure look like the other's honest-empty answer.
  let attributionCalibration: CalibrationEstimate | null = null;
  try {
    attributionCalibration = buildAttributionCalibration(store).estimate;
  } catch {
    attributionCalibration = null;
  }

  data.insights = {
    vocabulary,
    ticketCoverage,
    topTicket,
    hourlyRate,
    currency,
    attributionCalibration,
    reconciliation,
  };
  return data;
}

/**
 * Populate `data.currentSessionTicket` — the link/negate card's input.
 * Synchronous and cheap: one indexed lookup for the most recent session id,
 * one indexed lookup for its links. Never throws — any failure (empty store,
 * pre-V19 schema) leaves the field null, which the card renders as its
 * honest empty state rather than omitting itself.
 */
export function attachTicketAttribution(store: Store, data: DashboardData): DashboardData {
  try {
    const sessionId = store.getMostRecentSessionId();
    if (!sessionId) {
      data.currentSessionTicket = null;
      return data;
    }
    const links = store.getTicketLinksForSession(sessionId).map((l) => ({
      ticketKey: l.ticket_key,
      source: l.source,
      confidence: l.confidence,
      granularity: l.granularity,
      negated: l.negated !== 0,
    }));
    data.currentSessionTicket = { sessionId, links };
  } catch {
    data.currentSessionTicket = null;
  }
  return data;
}

/**
 * Populate `data.costPerTask` for a dashboard, asynchronously.
 *
 * Kept separate from the synchronous {@link buildDashboard} because the metric
 * iterates the recap pipeline per day (async, git-enriched). Only the
 * full-dashboard renderers call this; lightweight callers leave it null.
 * Reuses the dashboard's period/account/project filters. Never throws — on any
 * failure the card is simply omitted (returns the data unchanged).
 */
export async function attachCostPerTask(
  store: Store,
  data: DashboardData,
  opts: ReportOptions,
  extra?: Pick<CostPerTaskOptions, "digestDeps" | "correctionsClient" | "tz" | "nowMs"> & {
    /**
     * Include the per-task labelling list. ONLY the VS Code webview sets this —
     * the list carries prompt text, so the `serve` LAN path and the CLI JSON
     * export leave it off. See {@link CostPerTaskOptions.includeTasks}.
     */
    includeTasks?: boolean;
    /**
     * Fold the experimental accuracy signals into the live outcome (config-gated
     * opt-in; off by default). The webview sets this from `config.experimentalSignals`.
     */
    experimentalSignals?: boolean;
  },
): Promise<DashboardData> {
  data.experimentalSignalsEnabled = extra?.experimentalSignals === true;
  try {
    const { buildCostPerTaskReport } = await import("../cost-per-task/index.js");
    // Cap the card to `month` when the dashboard is on `all` (or unset, which
    // defaults to `all`): an all-time window iterates the git-enriched recap
    // pipeline per day across the whole history — a multi-second hang on a cold
    // cache. The plan's mitigation: month default, all opt-in via the CLI.
    // An explicit custom since/until range is NOT capped this way — the user
    // already bounded it with two real dates, unlike the implicit/unbounded
    // "all" default, so no new hard cap is introduced for custom ranges.
    const isCustomRange = Boolean(opts.since && opts.until);
    const dashPeriod = opts.period ?? "all";
    const period = isCustomRange
      ? undefined
      : (dashPeriod === "all" ? "month" : dashPeriod) as CostPerTaskOptions["period"];
    const report = await buildCostPerTaskReport(store, {
      period,
      since: isCustomRange ? opts.since : undefined,
      until: isCustomRange ? opts.until : undefined,
      projectPath: opts.projectPath,
      accountUuid: opts.accountUuid,
      repoUrl: opts.repoUrl,
      includeCI: opts.includeCI,
      byModel: true,
      includeTasks: extra?.includeTasks ?? false,
      experimentalSignals: extra?.experimentalSignals === true,
      tz: extra?.tz ?? opts.timezone,
      nowMs: extra?.nowMs,
      digestDeps: extra?.digestDeps,
      correctionsClient: extra?.correctionsClient,
    });
    data.costPerTask = report;
  } catch {
    data.costPerTask = null;
  }
  return data;
}

/**
 * Populate `data.calibration` — how well the proxy/signals agree with the user's
 * labels — for the in-dashboard trust view (VS Code panel only). Never throws.
 *
 * Sync signals only (no `judgeProvider`): the panel auto-refreshes, and per-
 * refresh LLM-judge calls would be costly/slow. Evaluate the judge via the CLI
 * (`cost-per-task --calibrate --llm-judge`).
 */
export async function attachCalibration(
  store: Store,
  data: DashboardData,
  opts: ReportOptions,
  extra?: Pick<CostPerTaskOptions, "digestDeps" | "correctionsClient" | "tz" | "nowMs">,
): Promise<DashboardData> {
  try {
    const { buildCalibrationReport } = await import("../cost-per-task/index.js");
    // See attachCostPerTask's comment: same "all"→"month" perf cap, same
    // custom-range opt-out of that cap.
    const isCustomRange = Boolean(opts.since && opts.until);
    const dashPeriod = opts.period ?? "all";
    const period = isCustomRange
      ? undefined
      : (dashPeriod === "all" ? "month" : dashPeriod) as CostPerTaskOptions["period"];
    data.calibration = await buildCalibrationReport(store, {
      period,
      since: isCustomRange ? opts.since : undefined,
      until: isCustomRange ? opts.until : undefined,
      projectPath: opts.projectPath,
      accountUuid: opts.accountUuid,
      repoUrl: opts.repoUrl,
      includeCI: opts.includeCI,
      tz: extra?.tz ?? opts.timezone,
      nowMs: extra?.nowMs,
      digestDeps: extra?.digestDeps,
      correctionsClient: extra?.correctionsClient,
    });
  } catch {
    data.calibration = null;
  }
  return data;
}

const PLAN_LABELS: Record<string, string> = {
  pro: "Pro ($20/mo)",
  team_standard: "Team Standard ($25/mo)",
  max_5x: "Max 5x ($100/mo)",
  team_premium: "Team Premium ($125/mo)",
  max_20x: "Max 20x ($200/mo)",
  // No `$<digits>` token: buildRecommendations regex-parses `/\$(\d+)/` out of
  // this label to compute a suggested downgrade fee, and Enterprise is a
  // metered plan with no single seat fee to suggest.
  enterprise: "Enterprise (metered)",
};

function buildRecommendations(input: {
  totalCost: number;
  totalPrompts: number;
  cacheEfficiency: number;
  planUtilization: DashboardData["planUtilization"];
  modelEfficiency: ModelEfficiencyData | null;
  contextAnalysis: ContextAnalysis | null;
  spending: DashboardSpending | null;
  byConversationCost: DashboardData["byConversationCost"];
}): Recommendation[] {
  const out: Recommendation[] = [];
  const { totalCost, totalPrompts, cacheEfficiency, planUtilization, modelEfficiency, contextAnalysis, spending, byConversationCost } = input;

  // 1. Model tier waste — biggest actionable lever when present
  if (modelEfficiency && modelEfficiency.summary.potentialSavings >= 5) {
    const savings = modelEfficiency.summary.potentialSavings;
    const overuse = modelEfficiency.summary.overusePercent;
    out.push({
      id: "model-tier-waste",
      severity: savings >= 25 ? "critical" : "warning",
      title: "Route simpler prompts to cheaper models",
      body: `${overuse}% of your classified turns were sent to a pricier model than their complexity warranted. Check the Efficiency tab to see which prompts drove the overspend and consider using Haiku/Sonnet for the simpler ones.`,
      impact: `~$${savings.toFixed(2)} saveable`,
    });
  }

  // NOTE: no "consider upgrading" rule. We don't have a reliable signal for
  // Anthropic 5-hour rate-limit rejections — those never make it into the JSONL.
  // See `truncatedOutputs` and the note in DashboardSummary.

  // 2. Underusing plan — clearly spending far less than the plan fee.
  // Gate on totalWeeks >= 4 so a short period filter (e.g. "Day" or "Week",
  // which yield a single partial week) can't extrapolate one day's cost into
  // a full-month downgrade recommendation.
  if (planUtilization) {
    if (
      planUtilization.currentPlanVerdict === "underusing" &&
      planUtilization.weeklyPlanBudget > 0 &&
      planUtilization.totalWeeks >= 4 &&
      planUtilization.avgWeeklyCost < planUtilization.weeklyPlanBudget * 0.5 &&
      planUtilization.recommendedPlan &&
      planUtilization.recommendedPlan !== "enterprise"
    ) {
      const monthlyFee = Math.round(planUtilization.weeklyPlanBudget * 4.33);
      const monthlyUse = (planUtilization.avgWeeklyCost * 4.33).toFixed(0);
      const suggested = PLAN_LABELS[planUtilization.recommendedPlan] ?? planUtilization.recommendedPlan;
      // Only suggest downgrade if the suggested plan is actually cheaper
      const suggestedFeeMatch = suggested.match(/\$(\d+)/);
      const suggestedFee = suggestedFeeMatch ? parseInt(suggestedFeeMatch[1]!, 10) : monthlyFee;
      if (suggestedFee < monthlyFee) {
        out.push({
          id: "plan-underusing",
          severity: "info",
          title: `Consider downgrading to ${suggested}`,
          body: `Your average API-equivalent usage is only ~$${monthlyUse}/mo — well below your current ~$${monthlyFee}/mo plan fee. Downgrading would still cover your typical usage.`,
          impact: `~$${monthlyFee - suggestedFee}/mo`,
        });
      }
    }
  }

  // 4. Long sessions without compaction
  if (contextAnalysis && contextAnalysis.sessionsNeedingCompaction >= 3) {
    const n = contextAnalysis.sessionsNeedingCompaction;
    out.push({
      id: "context-compaction",
      severity: n >= 10 ? "warning" : "info",
      title: "Use /compact or /clear more aggressively",
      body: `${n} long sessions (15+ prompts) ran without compaction. Long uncompacted contexts re-send the entire history each turn, inflating input-token cost. Start a new conversation or run /compact for unrelated tasks.`,
    });
  }

  // 5. Low cache efficiency — only meaningful at volume
  if (cacheEfficiency < 30 && totalPrompts >= 50 && totalCost >= 10) {
    out.push({
      id: "cache-low-hit-rate",
      severity: "info",
      title: "Cache hit rate is low — restructure prompts",
      body: `Only ${cacheEfficiency.toFixed(0)}% of your input tokens hit the prompt cache. Keeping a stable prefix (system prompt, tool definitions, long context) at the start of each turn lets Anthropic reuse it at ~10% the price of fresh input tokens.`,
    });
  }

  // 6. One conversation dominates total cost — possible runaway agent or unbounded session
  if (byConversationCost && byConversationCost.length >= 5) {
    const costs = byConversationCost.map(c => c.estimatedCost).filter(c => c > 0);
    if (costs.length >= 5) {
      const sorted = [...costs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const top = byConversationCost[0]!;
      // Fire when the top conversation is both (a) substantial in absolute terms
      // and (b) dramatically larger than typical sessions
      if (top.estimatedCost >= 5 && median > 0 && top.estimatedCost >= median * 5) {
        const parts = (top.projectPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
        const projLabel = parts.length >= 2
          ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
          : (parts[parts.length - 1] || top.projectPath || "unknown");
        const ratio = (top.estimatedCost / median).toFixed(1);
        out.push({
          id: "runaway-conversation",
          severity: top.estimatedCost >= median * 10 ? "warning" : "info",
          title: "One conversation is dominating your spend",
          body: `Session in ${projLabel} cost $${top.estimatedCost.toFixed(2)} across ${top.promptCount} prompts — ${ratio}× the median session. Long single conversations grow their own context on every turn; consider splitting unrelated work into fresh sessions.`,
          impact: `$${top.estimatedCost.toFixed(2)}`,
        });
      }
    }
  }

  // 7. Average peak context tokens approaching the context-window ceiling
  if (contextAnalysis && contextAnalysis.avgPeakInputTokens >= 150_000) {
    const k = Math.round(contextAnalysis.avgPeakInputTokens / 1000);
    out.push({
      id: "context-near-limit",
      severity: contextAnalysis.avgPeakInputTokens >= 180_000 ? "warning" : "info",
      title: "Sessions are regularly filling the context window",
      body: `Your average peak input reaches ~${k}k tokens (out of a 200k ceiling). Near-full contexts are slower and more expensive per turn, and further prompts risk truncation. Run /compact earlier — or start a fresh session once a task is complete.`,
    });
  }

  // 8. Unusually expensive MCP server — possible misbehavior or runaway tool
  if (spending && spending.mcpServers && spending.mcpServers.length > 0 && totalCost > 0) {
    // Flag any MCP server whose cost exceeds 15% of total spend OR whose avg tokens/call
    // is >10× the median across MCP servers, provided it has meaningful invocation volume.
    const servers = spending.mcpServers.filter(s => s.totalCalls >= 5);
    if (servers.length > 0) {
      const avgs = servers.map(s => s.avgTokensPerCall).sort((a, b) => a - b);
      const median = avgs[Math.floor(avgs.length / 2)] ?? 0;
      for (const s of servers) {
        const costShare = s.estimatedCost / totalCost;
        const avgRatio = median > 0 ? s.avgTokensPerCall / median : 1;
        if (costShare >= 0.15 || (avgRatio >= 10 && s.estimatedCost >= 1)) {
          out.push({
            id: `mcp-heavy-${s.server}`,
            severity: costShare >= 0.3 ? "warning" : "info",
            title: `MCP server “${s.server}” is consuming an unusually large share`,
            body: `${(costShare * 100).toFixed(1)}% of your total spend (~$${s.estimatedCost.toFixed(2)}) went to this server across ${s.totalCalls} calls, averaging ${Math.round(s.avgTokensPerCall).toLocaleString()} tokens per call${median > 0 && avgRatio >= 2 ? ` (${avgRatio.toFixed(1)}× the median MCP server)` : ""}. Verify that it is returning the right amount of data and not looping or echoing large payloads.`,
            impact: `~$${s.estimatedCost.toFixed(2)}`,
          });
          break; // only flag the worst offender to avoid noise
        }
      }
    }
  }

  // ── Positive reinforcement — call out things the user is doing well ────
  // Keep thresholds strict so these stay meaningful and don't feel like participation trophies.

  // P1. Strong cache discipline on meaningful volume
  if (cacheEfficiency >= 75 && totalPrompts >= 100 && totalCost >= 5) {
    out.push({
      id: "good-cache",
      severity: "success",
      title: "Excellent cache discipline",
      body: `${cacheEfficiency.toFixed(0)}% of your input tokens are coming from the prompt cache — strong reuse of stable prefixes is saving you real money on every turn.`,
    });
  }

  // P2. Efficient model selection — low overuse on sufficient classified volume
  if (
    modelEfficiency &&
    modelEfficiency.summary.overusePercent <= 10 &&
    modelEfficiency.summary.potentialSavings < 2 &&
    modelEfficiency.summary.classifiedMessages >= 30
  ) {
    out.push({
      id: "good-model-routing",
      severity: "success",
      title: "You're picking the right model for the job",
      body: `Only ${modelEfficiency.summary.overusePercent}% of your classified turns used a pricier model than needed. You're matching prompt complexity to model tier well.`,
    });
  }

  // P3. Strong plan value — getting ≥3× out of the subscription
  if (planUtilization && planUtilization.weeklyPlanBudget > 0) {
    const monthlyFee = planUtilization.weeklyPlanBudget * 4.33;
    const monthlyUse = planUtilization.avgWeeklyCost * 4.33;
    const multiplier = monthlyFee > 0 ? monthlyUse / monthlyFee : 0;
    if (multiplier >= 3) {
      out.push({
        id: "good-plan-value",
        severity: "success",
        title: "Great value from your plan",
        body: `Your API-equivalent usage averages ~${multiplier.toFixed(1)}× your plan fee. The subscription is paying for itself several times over.`,
      });
    }
  }

  // P4. Active context management — actually using /compact
  if (contextAnalysis && contextAnalysis.compactionRate >= 30 && contextAnalysis.sessionsNeedingCompaction <= 2) {
    out.push({
      id: "good-compaction",
      severity: "success",
      title: "Good context hygiene",
      body: `${contextAnalysis.compactionRate.toFixed(0)}% of your sessions show compaction activity, and few long sessions went uncompacted. You're keeping context sizes in check.`,
    });
  }

  // NOTE: no "pacing your usage well" rule. The truncatedOutputs metric counts short
  // max_tokens responses, not real rate-limit events — those are rejected before a
  // response is written and never reach the JSONL. We can't assert "never throttled".

  // Sort by severity — actions first (critical → warning → info), positives last
  const rank: Record<Recommendation["severity"], number> = { critical: 0, warning: 1, info: 2, success: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}

function buildSpendingSection(
  store: Store,
  rows: SessionRow[],
  sessionCostMap: Map<string, { cost: number; topModel: string; topModelTokens: number }>,
  filters: { projectPath?: string; repoUrl?: string; accountUuid?: string; since?: number; until?: number },
): DashboardSpending | null {
  if (rows.length === 0) return null;

  const report = store.getSpendingReport({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    since: filters.since,
    until: filters.until,
    limit: 20,
  });

  // Top sessions by cost
  const topSessionsByCost = report.topSessions.slice(0, 10).map(s => {
    const costs = sessionCostMap.get(s.session_id);
    const dur = s.active_duration_ms ?? (s.last_timestamp && s.first_timestamp ? s.last_timestamp - s.first_timestamp : 0);
    const models: string[] = JSON.parse(s.models) as string[];
    return {
      sessionId: s.session_id,
      projectPath: s.project_path,
      estimatedCost: Math.round((costs?.cost ?? 0) * 100) / 100,
      promptCount: s.prompt_count,
      durationMs: dur ?? 0,
      dominantModel: costs?.topModel ?? models[0] ?? "unknown",
    };
  }).sort((a, b) => b.estimatedCost - a.estimatedCost);

  // Tool costs
  const toolCosts = attributeToolCosts(report.topMessages);
  const topToolsByCost = toolCosts.slice(0, 10).map(tc => ({
    tool: tc.tool,
    estimatedCost: Math.round(tc.estimatedCost * 100) / 100,
    invocationCount: tc.invocationCount,
    isMcp: tc.isMcp,
    mcpServer: tc.mcpServer,
  }));

  // Cost by model
  let grandTotal = 0;
  const modelCosts: Array<{ model: string; cost: number; input: number; output: number }> = [];
  for (const row of report.byModel) {
    const { cost } = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens);
    grandTotal += cost;
    modelCosts.push({ model: row.model, cost, input: row.input_tokens, output: row.output_tokens });
  }
  const costByModel = modelCosts.map(mc => ({
    model: mc.model,
    estimatedCost: Math.round(mc.cost * 100) / 100,
    inputTokens: mc.input,
    outputTokens: mc.output,
    percentage: grandTotal > 0 ? Math.round((mc.cost / grandTotal) * 1000) / 10 : 0,
  })).sort((a, b) => b.estimatedCost - a.estimatedCost);

  // Expensive prompts (anomalies)
  const anomalies = detectAnomalies(report.topMessages);
  const expensivePrompts = anomalies.map(a => {
    const { cost } = estimateCost(
      a.message.model ?? "unknown",
      a.message.input_tokens, a.message.output_tokens,
      a.message.cache_read_tokens, a.message.cache_creation_tokens,
    );
    const flags: string[] = [];
    if (a.timesAvg > 2) flags.push("OUTLIER");
    if (a.message.stop_reason === "max_tokens") flags.push("TRUNCATED");
    if (a.message.thinking_blocks > 0) {
      // Approximate: if thinking blocks exist and output is large, flag it
      flags.push("HIGH_THINKING");
    }
    const msgTools: string[] = JSON.parse(a.message.tools) as string[];
    if (msgTools.some(t => t.startsWith("mcp__"))) flags.push("MCP_HEAVY");

    return {
      uuid: a.message.uuid,
      sessionId: a.message.session_id,
      model: a.message.model ?? "unknown",
      totalTokens: a.totalTokens,
      estimatedCost: Math.round(cost * 100) / 100,
      promptPreview: decodeHtmlEntities(a.message.prompt_text).slice(0, 120),
      timesAvg: Math.round(a.timesAvg * 10) / 10,
      flags,
    };
  });

  // Cache efficiency
  let totalHits = 0, totalInput = 0;
  for (const ce of report.cacheEfficiency) {
    totalHits += ce.cache_hits;
    totalInput += ce.uncached_input;
  }
  const overallHitRate = (totalHits + totalInput) > 0
    ? Math.round((totalHits / (totalHits + totalInput)) * 1000) / 10
    : 0;
  let estimatedSavings = 0;
  for (const ce of report.cacheEfficiency) {
    estimatedSavings += (ce.cache_hits / 1_000_000) * 4.50;
  }

  // MCP servers
  const mcpServers = groupByMcpServer(toolCosts).map(s => ({
    server: s.server,
    estimatedCost: Math.round(s.estimatedCost * 100) / 100,
    totalCalls: s.totalCalls,
    avgTokensPerCall: s.avgTokensPerCall,
  }));

  // Subagent overhead
  let subagentTotalCost = 0, subagentCount = 0;
  for (const sc of report.subagentCosts) {
    // Rough cost estimate from tokens
    subagentTotalCost += (sc.subagent_tokens / 1_000_000) * 10; // avg model price
    subagentCount += sc.subagent_count;
  }

  // Full MCP server breakdown from all messages
  const mcpMessages = store.getMcpMessages({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    since: filters.since,
  });
  const mcpServerUsage = aggregateMcpServerUsage(mcpMessages).map(s => ({
    ...s,
    estimatedCost: Math.round(s.estimatedCost * 100) / 100,
  }));

  return {
    topSessionsByCost,
    topToolsByCost,
    costByModel,
    expensivePrompts,
    cacheEfficiency: {
      overallHitRate,
      estimatedSavings: Math.round(estimatedSavings * 100) / 100,
    },
    mcpServers,
    mcpServerUsage,
    subagentOverhead: {
      totalCost: Math.round(subagentTotalCost * 100) / 100,
      agentCount: subagentCount,
    },
  };
}

function buildModelEfficiency(
  store: Store,
  filters: { projectPath?: string; repoUrl?: string; since?: number; until?: number },
): ModelEfficiencyData | null {
  // `Store.getMessagesForEfficiency` has no `until` param (out of this task's
  // file allowlist to add one) — bound the upper edge here instead. Keep
  // null-timestamp rows (no basis to exclude them, matches how `since` never
  // excluded them either).
  let msgRows = store.getMessagesForEfficiency(filters);
  if (filters.until !== undefined) {
    msgRows = msgRows.filter(r => r.timestamp == null || r.timestamp <= filters.until!);
  }
  if (msgRows.length === 0) return null;

  // Group messages into "turns": each turn starts with a prompt-bearing message
  // and includes all subsequent tool-continuation messages until the next prompt.
  // This way we classify the whole turn (user request + agent loop) as one unit.
  interface Turn {
    promptText: string | null;
    model: string;
    sessionId: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    allTools: string[];
    totalThinkingBlocks: number;
    messageCount: number;
  }

  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const row of msgRows) {
    const tools: string[] = JSON.parse(row.tools || "[]");

    if (row.prompt_text) {
      // New user-initiated turn — finalize previous turn and start a new one
      if (current) turns.push(current);
      current = {
        promptText: row.prompt_text,
        model: row.model,
        sessionId: row.session_id,
        totalInputTokens: row.input_tokens,
        totalOutputTokens: row.output_tokens,
        totalCacheReadTokens: row.cache_read_tokens,
        totalCacheCreationTokens: row.cache_creation_tokens,
        allTools: [...tools],
        totalThinkingBlocks: row.thinking_blocks,
        messageCount: 1,
      };
    } else if (current && row.session_id === current.sessionId) {
      // Tool-continuation turn — aggregate into the current turn
      current.totalInputTokens += row.input_tokens;
      current.totalOutputTokens += row.output_tokens;
      current.totalCacheReadTokens += row.cache_read_tokens;
      current.totalCacheCreationTokens += row.cache_creation_tokens;
      current.allTools.push(...tools);
      current.totalThinkingBlocks += row.thinking_blocks;
      current.messageCount++;
    } else {
      // Orphan continuation (no prompt) or different session — skip classification
      // but still count its cost
      if (current) turns.push(current);
      current = null;
    }
  }
  if (current) turns.push(current);

  if (turns.length === 0) return null;

  // Classify each turn
  const byModelTier = new Map<string, { count: number; totalCost: number; tierCost: number }>();
  const opusScores: number[] = [];
  const overuseList: ModelEfficiencyData["topOveruse"] = [];
  let totalCostAll = 0;
  let totalTierCost = 0;
  let overuseCount = 0;
  let classifiedCount = 0;

  for (const turn of turns) {
    const score = scoreComplexity({
      outputTokens: turn.totalOutputTokens,
      inputTokens: turn.totalInputTokens,
      tools: turn.allTools,
      thinkingBlocks: turn.totalThinkingBlocks,
      promptText: turn.promptText,
    });
    const tier = scoreToTier(score);
    const tierModel = tierToModel(tier);

    const { cost: actualCost } = estimateCost(
      turn.model, turn.totalInputTokens, turn.totalOutputTokens,
      turn.totalCacheReadTokens, turn.totalCacheCreationTokens,
    );
    const { cost: tierCost } = estimateCost(
      tierModel, turn.totalInputTokens, turn.totalOutputTokens,
      turn.totalCacheReadTokens, turn.totalCacheCreationTokens,
    );

    totalCostAll += actualCost;
    totalTierCost += tierCost;
    classifiedCount++;

    // Group by model + tier
    const key = `${turn.model}::${tier}`;
    const entry = byModelTier.get(key) ?? { count: 0, totalCost: 0, tierCost: 0 };
    entry.count++;
    entry.totalCost += actualCost;
    entry.tierCost += tierCost;
    byModelTier.set(key, entry);

    // Track opus-specific analysis
    const isOpus = turn.model.startsWith("claude-opus");
    if (isOpus) {
      opusScores.push(score);
      if (tier !== "opus") {
        overuseCount++;
        const savings = actualCost - tierCost;
        if (savings > 0.001) {
          overuseList.push({
            sessionId: turn.sessionId,
            promptPreview: promptPreviewOf(turn.promptText),
            model: turn.model,
            tier,
            cost: Math.round(actualCost * 10000) / 10000,
            tierCost: Math.round(tierCost * 10000) / 10000,
            savings: Math.round(savings * 10000) / 10000,
          });
        }
      }
    } else {
      // Check non-opus overuse (e.g., Sonnet used for Haiku-level tasks)
      const isSonnet = turn.model.startsWith("claude-sonnet") || turn.model.startsWith("claude-3-5-sonnet");
      if (isSonnet && tier === "haiku") {
        overuseCount++;
        const savings = actualCost - tierCost;
        if (savings > 0.001) {
          overuseList.push({
            sessionId: turn.sessionId,
            promptPreview: promptPreviewOf(turn.promptText),
            model: turn.model,
            tier,
            cost: Math.round(actualCost * 10000) / 10000,
            tierCost: Math.round(tierCost * 10000) / 10000,
            savings: Math.round(savings * 10000) / 10000,
          });
        }
      }
    }
  }

  // Build byModelAndTier array
  const byModelAndTier: ModelEfficiencyData["byModelAndTier"] = [];
  for (const [key, entry] of byModelTier) {
    const [model, tier] = key.split("::");
    byModelAndTier.push({
      model: model!,
      tier: tier as ComplexityTier,
      count: entry.count,
      totalCost: Math.round(entry.totalCost * 10000) / 10000,
      tierCost: Math.round(entry.tierCost * 10000) / 10000,
    });
  }
  byModelAndTier.sort((a, b) => b.totalCost - a.totalCost);

  // Build opus score distribution (10-point buckets)
  const opusScoreDistribution: ModelEfficiencyData["opusScoreDistribution"] = [];
  if (opusScores.length > 0) {
    for (let i = 0; i < 100; i += 10) {
      const lo = i;
      const hi = i + 10;
      const count = opusScores.filter(s => s >= lo && s < hi).length;
      opusScoreDistribution.push({ bucket: `${lo}-${hi}`, count });
    }
  }

  // Top overuse sorted by savings
  overuseList.sort((a, b) => b.savings - a.savings);
  const topOveruse = overuseList.slice(0, 15);

  // Only sum savings from overuse cases (where a cheaper model would suffice)
  const potentialSavings = Math.round(
    overuseList.reduce((sum, o) => sum + o.savings, 0) * 100
  ) / 100;
  const overusePercent = classifiedCount > 0
    ? Math.round((overuseCount / classifiedCount) * 1000) / 10
    : 0;

  return {
    byModelAndTier,
    summary: {
      totalMessages: msgRows.length,
      classifiedMessages: classifiedCount,
      totalCost: Math.round(totalCostAll * 100) / 100,
      potentialSavings: potentialSavings > 0 ? potentialSavings : 0,
      overusePercent,
    },
    opusScoreDistribution,
    topOveruse,
  };
}

// ── Context analysis builder ──────────────────────────────────────────────────

function buildContextAnalysis(
  store: Store,
  rows: SessionRow[],
  sessionCostMap: Map<string, { cost: number; topModel: string; topModelTokens: number }>,
  filters: { projectPath?: string; repoUrl?: string; since?: number; until?: number },
): ContextAnalysis | null {
  if (rows.length === 0) return null;

  // `Store.getMessagesForContext` has no `until` param (out of this task's
  // file allowlist to add one) — bound the upper edge here instead.
  let contextMsgs = store.getMessagesForContext(filters);
  if (filters.until !== undefined) {
    contextMsgs = contextMsgs.filter(m => m.timestamp == null || m.timestamp <= filters.until!);
  }
  if (contextMsgs.length === 0) return null;

  // getMessagesForContext only filters by project/repo/period — it ignores the
  // account/entrypoint/includeCI scoping that getSessions (and therefore `rows`)
  // applies. Restrict the message set to the same sessions as `rows` so the
  // numerator of compactionRate can never exceed its denominator (and so every
  // context metric below stays consistent with the dashboard's scope). Without
  // this, e.g. a second account's compactions inflate the rate past 100%.
  const rowSessionIds = new Set(rows.map(r => r.session_id));

  // Group messages by session
  const bySession = new Map<string, Array<{ inputTokens: number; cacheRead: number; cacheCreate: number }>>();
  for (const msg of contextMsgs) {
    if (!rowSessionIds.has(msg.session_id)) continue;
    const arr = bySession.get(msg.session_id) ?? [];
    arr.push({
      inputTokens: msg.input_tokens,
      cacheRead: msg.cache_read_tokens,
      cacheCreate: msg.cache_creation_tokens,
    });
    bySession.set(msg.session_id, arr);
  }

  // ── Detect compaction events (>40% input token drop between consecutive messages)
  const compactionEvents: ContextAnalysis["compactionEvents"] = [];
  const sessionsWithCompaction = new Set<string>();

  for (const [sessionId, msgs] of bySession) {
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1]!.inputTokens;
      const curr = msgs[i]!.inputTokens;
      if (prev > 10_000 && curr < prev * 0.6) {
        const reduction = Math.round(((prev - curr) / prev) * 100);
        compactionEvents.push({
          sessionId,
          promptPosition: i + 1,
          tokensBefore: prev,
          tokensAfter: curr,
          reductionPercent: reduction,
        });
        sessionsWithCompaction.add(sessionId);
      }
    }
  }

  // ── Conversation length distribution
  const promptCounts = rows.map(r => r.prompt_count).sort((a, b) => a - b);
  const lengthBuckets = [
    { label: "1-5", min: 1, max: 5 },
    { label: "6-10", min: 6, max: 10 },
    { label: "11-20", min: 11, max: 20 },
    { label: "21-50", min: 21, max: 50 },
    { label: "51-100", min: 51, max: 100 },
    { label: "100+", min: 101, max: Infinity },
  ];
  const lengthDistribution = lengthBuckets.map(b => ({
    bucket: b.label,
    count: promptCounts.filter(p => p >= b.min && p <= b.max).length,
  }));

  // ── Context growth curve: average input tokens at each prompt position
  const maxPosition = 50; // cap to avoid noise from very long sessions
  const positionSums = new Map<number, { total: number; count: number }>();
  for (const msgs of bySession.values()) {
    for (let i = 0; i < Math.min(msgs.length, maxPosition); i++) {
      const pos = i + 1;
      const entry = positionSums.get(pos) ?? { total: 0, count: 0 };
      entry.total += msgs[i]!.inputTokens;
      entry.count++;
      positionSums.set(pos, entry);
    }
  }
  const contextGrowthCurve: ContextAnalysis["contextGrowthCurve"] = [];
  for (let pos = 1; pos <= maxPosition; pos++) {
    const entry = positionSums.get(pos);
    if (!entry || entry.count < 3) break; // stop when we have too few sessions
    contextGrowthCurve.push({
      promptNumber: pos,
      avgInputTokens: Math.round(entry.total / entry.count),
      sessionCount: entry.count,
    });
  }

  // ── Long sessions that may need better context management
  const LONG_THRESHOLD = 15; // prompts
  const longSessions: ContextAnalysis["longSessions"] = rows
    .filter(r => r.prompt_count >= LONG_THRESHOLD)
    .map(r => {
      const msgs = bySession.get(r.session_id) ?? [];
      const peakInput = msgs.length > 0
        ? Math.max(...msgs.map(m => m.inputTokens))
        : 0;
      const cost = sessionCostMap.get(r.session_id)?.cost ?? 0;
      const durationMs = r.active_duration_ms ?? (
        r.first_timestamp != null && r.last_timestamp != null
          ? r.last_timestamp - r.first_timestamp : 0
      );
      return {
        sessionId: r.session_id,
        projectPath: r.project_path,
        promptCount: r.prompt_count,
        durationMinutes: Math.round(durationMs / 60_000),
        peakInputTokens: peakInput,
        compacted: sessionsWithCompaction.has(r.session_id),
        estimatedCost: Math.round(cost * 100) / 100,
      };
    })
    .sort((a, b) => b.peakInputTokens - a.peakInputTokens)
    .slice(0, 20);

  // ── Cache efficiency by conversation length
  const cacheLengthBuckets = [
    { label: "1-5 prompts", min: 1, max: 5 },
    { label: "6-15 prompts", min: 6, max: 15 },
    { label: "16-30 prompts", min: 16, max: 30 },
    { label: "30+ prompts", min: 31, max: Infinity },
  ];
  const cacheByLength: ContextAnalysis["cacheByLength"] = cacheLengthBuckets.map(b => {
    const matching = rows.filter(r => r.prompt_count >= b.min && r.prompt_count <= b.max);
    if (matching.length === 0) return { bucket: b.label, cacheEfficiency: 0, sessionCount: 0 };
    let totalInput = 0, totalCacheRead = 0, totalCacheCreate = 0;
    for (const r of matching) {
      totalInput += r.input_tokens;
      totalCacheRead += r.cache_read_tokens;
      totalCacheCreate += r.cache_creation_tokens;
    }
    const logical = totalInput + totalCacheRead + totalCacheCreate;
    const eff = logical > 0 ? Math.round((totalCacheRead / logical) * 1000) / 10 : 0;
    return { bucket: b.label, cacheEfficiency: eff, sessionCount: matching.length };
  });

  // ── Summary metrics
  const medianIdx = Math.floor(promptCounts.length / 2);
  const medianPrompts = promptCounts.length % 2 === 0
    ? Math.round((promptCounts[medianIdx - 1]! + promptCounts[medianIdx]!) / 2)
    : promptCounts[medianIdx]!;
  const avgPrompts = Math.round(
    (promptCounts.reduce((s, p) => s + p, 0) / promptCounts.length) * 10
  ) / 10;

  const peakTokens: number[] = [];
  for (const msgs of bySession.values()) {
    if (msgs.length > 0) {
      peakTokens.push(Math.max(...msgs.map(m => m.inputTokens)));
    }
  }
  const avgPeakInput = peakTokens.length > 0
    ? Math.round(peakTokens.reduce((s, t) => s + t, 0) / peakTokens.length)
    : 0;

  const compactionRate = rows.length > 0
    ? Math.round((sessionsWithCompaction.size / rows.length) * 1000) / 10
    : 0;

  // Sessions with 15+ prompts and no detected compaction
  const sessionsNeedingCompaction = rows.filter(
    r => r.prompt_count >= LONG_THRESHOLD && !sessionsWithCompaction.has(r.session_id)
  ).length;

  return {
    avgPromptsPerSession: avgPrompts,
    medianPromptsPerSession: medianPrompts,
    compactionRate,
    avgPeakInputTokens: avgPeakInput,
    sessionsNeedingCompaction,
    lengthDistribution,
    contextGrowthCurve,
    longSessions,
    cacheByLength,
    compactionEvents,
  };
}

// ── Energy section builder ────────────────────────────────────────────────────

/**
 * In-DB-aggregated energy section. Output-preserving refactor of the former
 * per-message estimateEnergy + Intl date-format loop: replaces it with GROUP BY
 * rollups (Store.getEnergyAggregates), then applies the SAME
 * estimateEnergy/aggregateEnergy arithmetic over the grouped token sums.
 * (Parity vs. the per-message implementation is locked by the reference-output
 * test in __tests__/energy.test.ts.)
 *
 * Safe because estimateEnergy is linear in the four token counts at fixed
 * per-model-class rates and a fixed section-level {region, gridIntensity}
 * (per-message inference_geo does NOT override the section config — see the
 * `!config.gridIntensity` guards in core/energy.ts), so SUM(tokens) GROUP BY
 * model → estimate equals the per-message sum to display-rounding precision.
 */
export function buildEnergySection(
  store: Store,
  filters: { projectPath?: string; repoUrl?: string; accountUuid?: string; since?: number; until?: number; timezone: string },
): DashboardEnergy | null {
  const agg = store.getEnergyAggregates({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    since: filters.since,
    until: filters.until,
  });

  if (agg.totalMessages === 0) return null;

  let effectiveSince = filters.since && filters.since > 0 ? filters.since : Date.now();
  if (!(filters.since && filters.since > 0)) {
    // Legacy: min over non-null message timestamps, floored at Date.now().
    if (agg.minTimestamp != null && agg.minTimestamp < effectiveSince) effectiveSince = agg.minTimestamp;
  }
  const effectiveUntil = filters.until ?? Date.now();
  const daysInPeriod = Math.max(1, (effectiveUntil - effectiveSince) / (24 * 60 * 60 * 1000));

  // ── Region detection (must run first: sets gridIntensity used by all sums) ──
  // geoCount counts per non-null geo. Build it in first-seen (earliest-
  // timestamp) order — the same insertion order the legacy per-message loop
  // produced — so Object.entries iteration (used for dominantGeo's tiebreak)
  // matches the legacy exactly. Counts come from the byGeo histogram.
  const byGeoCounts = new Map<string, number>();
  for (const g of agg.byGeo) {
    if (g.inference_geo) byGeoCounts.set(g.inference_geo, g.msgs);
  }
  const geoCount: Record<string, number> = {};
  let geoMessages = 0;
  for (const g of agg.geoByEarliest) {
    if (geoCount[g.inference_geo] !== undefined) continue;
    const cnt = byGeoCounts.get(g.inference_geo) ?? 0;
    geoCount[g.inference_geo] = cnt;
    geoMessages += cnt;
  }
  // Geos appearing only on null-timestamp messages aren't in geoByEarliest;
  // append them so coverage/counts match the legacy (which counts all geos).
  for (const [geo, cnt] of byGeoCounts) {
    if (geoCount[geo] === undefined) {
      geoCount[geo] = cnt;
      geoMessages += cnt;
    }
  }
  const coveragePct = agg.totalMessages > 0 ? (geoMessages / agg.totalMessages) * 100 : 0;

  // Dominant geo: first geo with a strictly-greater count over Object.entries
  // (first-seen) order — identical to the legacy loop.
  let dominantGeo: string | null = null;
  let maxCount = 0;
  for (const [geo, cnt] of Object.entries(geoCount)) {
    if (cnt > maxCount) { maxCount = cnt; dominantGeo = geo; }
  }

  const localeRegion = localeToRegion(
    new Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US",
  );
  const regionKey = (() => {
    if (dominantGeo) {
      const probe = estimateEnergy({
        model: "claude-sonnet",
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
        inferenceGeo: dominantGeo,
      });
      return probe.detectedRegion ?? localeRegion;
    }
    return localeRegion;
  })();

  const regionInfo = REGIONS[regionKey];
  const gridIntensity = regionInfo?.gridIntensity ?? 436;

  // detectedRegion for equivalents = region of the earliest in-period message
  // with a non-null MAPPABLE inference_geo (matches aggregateEnergy's
  // estimates.find(e => e.detectedRegion) over ORDER BY timestamp ASC, which
  // skips messages whose geo does not map to a region). geoByEarliest is sorted
  // by earliest timestamp, so the first mappable geo is the winner.
  let earliestMappableGeo: string | null = null;
  let detectedRegion: string | null = null;
  for (const g of agg.geoByEarliest) {
    const region = estimateEnergy({
      model: "claude-sonnet",
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
      inferenceGeo: g.inference_geo,
    }).detectedRegion;
    if (region) { earliestMappableGeo = g.inference_geo; detectedRegion = region; break; }
  }

  // Estimate energy for a summed-token group using the section config.
  const estimateGroup = (g: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }) =>
    estimateEnergy({
      model: g.model,
      inputTokens: g.input_tokens,
      outputTokens: g.output_tokens,
      cacheCreationTokens: g.cache_creation_tokens,
      cacheReadTokens: g.cache_read_tokens,
      ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
      // inferenceGeo intentionally omitted: section passes {region, gridIntensity}
      // to every estimate, and per-message geo never overrode it (guards above).
    }, { region: regionKey, gridIntensity });

  // ── Totals via per-model estimates → aggregateEnergy (exact reuse of math) ──
  // aggregateEnergy picks detectedRegion via estimates.find(e => e.detectedRegion);
  // none of these per-model estimates carry a geo, so we inject the earliest
  // mappable geo's region by passing it through a leading zero-token estimate,
  // reproducing the legacy aggregate's detectedRegion → equivalents region.
  const modelEstimates = agg.byModel.map(estimateGroup);
  // Prepend a zero-token estimate carrying detectedRegion so aggregateEnergy
  // resolves the same equivalents region as the legacy per-message aggregate.
  const aggInput = (detectedRegion && earliestMappableGeo)
    ? [estimateEnergy({
        model: "claude-sonnet",
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
        inferenceGeo: earliestMappableGeo,
      }, { region: regionKey, gridIntensity }), ...modelEstimates]
    : modelEstimates;
  const aggregated = aggregateEnergy(aggInput);
  const totalEnergyWh = aggregated.totalEnergyWh;

  // ── byModel ──
  const byModelEntries = agg.byModel.map((g, i) => ({
    model: g.model,
    energyWh: modelEstimates[i]!.totalEnergyWh,
    co2Grams: modelEstimates[i]!.co2Grams,
    minTs: g.min_ts ?? Number.POSITIVE_INFINITY,
  }));
  // Legacy pre-sort order = first-seen (timestamp ASC) Map insertion; stable
  // sort by energyWh desc preserves that for ties.
  byModelEntries.sort((a, b) => a.minTs - b.minTs);
  const byModel: DashboardEnergy["byModel"] = byModelEntries
    .slice()
    .sort((a, b) => b.energyWh - a.energyWh)
    .map(e => ({
      model: e.model,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
      pct: totalEnergyWh > 0 ? Math.round((e.energyWh / totalEnergyWh) * 1000) / 10 : 0,
    }));

  // ── byProject (sum per-(project,model) estimates into project totals) ──
  const projectMap = new Map<string, { energyWh: number; co2Grams: number; minTs: number }>();
  for (const g of agg.byProjectModel) {
    const est = estimateGroup(g);
    const entry = projectMap.get(g.project_path) ?? { energyWh: 0, co2Grams: 0, minTs: Number.POSITIVE_INFINITY };
    entry.energyWh += est.totalEnergyWh;
    entry.co2Grams += est.co2Grams;
    const ts = g.min_ts ?? Number.POSITIVE_INFINITY;
    if (ts < entry.minTs) entry.minTs = ts;
    projectMap.set(g.project_path, entry);
  }
  const byProject: DashboardEnergy["byProject"] = Array.from(projectMap.entries())
    .sort(([, a], [, b]) => a.minTs - b.minTs) // first-seen order pre-sort
    .sort(([, a], [, b]) => b.energyWh - a.energyWh)
    .map(([project, e]) => ({
      project,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
    }));

  // ── byDay: re-bucket (UTC hour, model) groups to local day in JS ──
  // The legacy loop formats each message's exact instant to a local day. Here
  // we format each UTC-hour-START instant. Hour grain is EXACT for integer-
  // offset timezones (every local day boundary falls on a UTC-hour boundary).
  // ACCEPTED DEVIATION: for fractional-offset zones (e.g. Asia/Kolkata, +5:30),
  // a local-midnight instant falls mid-UTC-hour, so messages in that boundary
  // hour can be misattributed by one local-day bucket. Callers needing exact
  // byDay in fractional-offset zones must use the legacy per-message path.
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: filters.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dayEnergyMap = new Map<string, { energyWh: number; co2Grams: number }>();
  for (const g of agg.byHourModel) {
    const est = estimateGroup(g);
    const dateStr = g.hour_bucket != null
      ? dayFmt.format(new Date(g.hour_bucket * 3600000))
      : "unknown";
    const dayEntry = dayEnergyMap.get(dateStr) ?? { energyWh: 0, co2Grams: 0 };
    dayEntry.energyWh += est.totalEnergyWh;
    dayEntry.co2Grams += est.co2Grams;
    dayEnergyMap.set(dateStr, dayEntry);
  }
  const byDay: DashboardEnergy["byDay"] = Array.from(dayEnergyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      date,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
    }));

  // ── byClass (model → class, re-sum token totals; rawEnergyWh = pre-PUE) ──
  const emptyClass = () => ({ msgs: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, rawEnergyWh: 0 });
  const classAccum: Record<ModelClass, ReturnType<typeof emptyClass>> = {
    haiku: emptyClass(), sonnet: emptyClass(), opus: emptyClass(),
  };
  agg.byModel.forEach((g, i) => {
    const cls = modelClass(g.model);
    const acc = classAccum[cls];
    acc.msgs += g.msgs;
    acc.inputTokens += g.input_tokens;
    acc.outputTokens += g.output_tokens;
    acc.cacheWriteTokens += g.cache_creation_tokens;
    acc.cacheReadTokens += g.cache_read_tokens;
    acc.rawEnergyWh += modelEstimates[i]!.energyWh;
  });

  // ── cacheImpact ──
  let totalCacheReadTokens = 0;
  let totalInputTokens = 0;
  for (const g of agg.byModel) {
    totalCacheReadTokens += g.cache_read_tokens;
    totalInputTokens += g.input_tokens;
  }
  const { inputWhPer1K, outputWhPer1K } = MODEL_ENERGY.sonnet;
  const pue = 1.2;
  const cacheEnergySavedWh = (totalCacheReadTokens / 1000) * (inputWhPer1K - outputWhPer1K * 0.03) * pue;
  const cacheCO2SavedGrams = (cacheEnergySavedWh / 1000) * gridIntensity;
  const logicalInput = totalInputTokens + totalCacheReadTokens;
  const cacheEfficiencyPct = logicalInput > 0
    ? Math.round((totalCacheReadTokens / logicalInput) * 1000) / 10
    : 0;

  // ── thinkingImpact ──
  let thinkingEnergy = 0;
  for (const g of agg.thinkingByModel) {
    thinkingEnergy += estimateGroup(g).totalEnergyWh * 0.3;
  }
  const pctEnergyFromThinking = totalEnergyWh > 0
    ? Math.round((thinkingEnergy / totalEnergyWh) * 1000) / 10
    : 0;

  return {
    totalEnergyWh: Math.round(aggregated.totalEnergyWh * 10000) / 10000,
    totalCO2Grams: Math.round(aggregated.co2Grams * 1000) / 1000,
    co2GramsLow: Math.round(aggregated.co2GramsLow * 1000) / 1000,
    co2GramsHigh: Math.round(aggregated.co2GramsHigh * 1000) / 1000,
    equivalents: {
      treesYears: Math.round(aggregated.equivalents.treesYears * 10000) / 10000,
      carKm: Math.round(aggregated.equivalents.carKm * 100) / 100,
      transitKm: Math.round(aggregated.equivalents.transitKm * 100) / 100,
      solarPanelM2: Math.round(((aggregated.totalEnergyWh / 1000) / (REGIONS[aggregated.equivalents.solarRegionKey]!.solarYield * (daysInPeriod / 365))) * 10000) / 10000,
      solarRegionKey: aggregated.equivalents.solarRegionKey,
      naturalGasM3: Math.round(aggregated.equivalents.naturalGasM3 * 100000) / 100000,
      trainKm: Math.round(aggregated.equivalents.trainKm * 100) / 100,
      nuclearWasteMl: Math.round(aggregated.equivalents.nuclearWasteMl * 10000) / 10000,
      windRotations: Math.round(aggregated.equivalents.windRotations * 10) / 10,
      hydroTurbineLiters: Math.round(aggregated.equivalents.hydroTurbineLiters * 100) / 100,
    },
    journeyAnchor: nearestJourneyAnchor(aggregated.equivalents.carKm),
    periodStartIso: ymdInTz(effectiveSince, filters.timezone),
    // See the untilIso comment above: effectiveUntil is an exclusive
    // boundary; -1ms reports the inclusive last day for display.
    periodEndIso: ymdInTz(effectiveUntil - 1, filters.timezone),
    periodDays: Math.round(daysInPeriod),
    byDay,
    byModel,
    byProject,
    cacheImpact: {
      energySavedWh: Math.round(cacheEnergySavedWh * 10000) / 10000,
      co2SavedGrams: Math.round(cacheCO2SavedGrams * 1000) / 1000,
      cacheEfficiencyPct,
    },
    thinkingImpact: {
      sessionsWithThinking: agg.sessionsWithThinking,
      pctEnergyFromThinking,
    },
    inferenceGeo: {
      detected: geoCount,
      coveragePct: Math.round(coveragePct * 10) / 10,
    },
    region: regionKey,
    gridIntensity,
    pue: aggregated.config.pue,
    byClass: (["opus", "sonnet", "haiku"] as const)
      .map(cls => ({
        cls,
        msgs: classAccum[cls].msgs,
        inputTokens: classAccum[cls].inputTokens,
        outputTokens: classAccum[cls].outputTokens,
        cacheWriteTokens: classAccum[cls].cacheWriteTokens,
        cacheReadTokens: classAccum[cls].cacheReadTokens,
        rawEnergyWh: Math.round(classAccum[cls].rawEnergyWh * 100) / 100,
        inputWhPer1K: MODEL_ENERGY[cls].inputWhPer1K,
        outputWhPer1K: MODEL_ENERGY[cls].outputWhPer1K,
      }))
      .filter(c => c.msgs > 0),
  };
}
