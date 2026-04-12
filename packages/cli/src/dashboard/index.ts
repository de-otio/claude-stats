/**
 * Dashboard — builds pre-aggregated JSON for visualization tools.
 * See plans/11-dashboard-export.md for design.
 */
import type { Store, SessionRow } from "../store/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { periodStart } from "../reporter/index.js";
import { estimateCost, lookupPlanFee } from "@claude-stats/core/pricing";
import type { UsageWindow } from "@claude-stats/core/types";
import { readClaudeAccount } from "../account.js";
import {
  scoreComplexity,
  scoreToTier,
  tierToModel,
  type ComplexityTier,
  type ModelEfficiencyData,
} from "../classifier.js";
import { attributeToolCosts, groupByMcpServer, detectAnomalies, aggregateMcpServerUsage } from "../spending.js";
import { estimateEnergy, aggregateEnergy, localeToRegion, REGIONS, MODEL_ENERGY, nearestJourneyAnchor, modelClass } from "@claude-stats/core/energy";
import type { ModelClass } from "@claude-stats/core/energy";

export interface DashboardSummary {
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheEfficiency: number;
  estimatedCost: number;
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
    recommendedPlan: string | null;  // "pro", "max_5x", "max_20x", "team_standard", "team_premium", or null
    currentPlanVerdict: string;      // "good-value" | "underusing" | "no-plan"
    // Per-account breakdown (always populated when planUtilization is present)
    byAccount: Array<{
      accountId: string;             // truncated UUID for display
      emailAddress: string | null;   // from ~/.claude.json oauthAccount
      subscriptionType: string | null;
      detectedPlanFee: number | null;
      sessions: number;
      estimatedCost: number;
      planVerdict: string;
    }>;
  } | null;
  modelEfficiency: ModelEfficiencyData | null;
  contextAnalysis: ContextAnalysis | null;
  spending: DashboardSpending | null;
  energy: DashboardEnergy | null;
  recommendations: Recommendation[];
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
    gasolineLiters: number;
    trainKm: number;
    nuclearWasteMl: number;
    windRotations: number;
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


export function buildDashboard(store: Store, opts: ReportOptions): DashboardData {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = periodStart(opts.period, tz);

  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    since: since > 0 ? since : undefined,
    includeCI: opts.includeCI ?? false,
  });

  // ── Summary aggregation ──────────────────────────────────────────────────
  let totalPrompts = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
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

  // Accumulators for grouping
  const dayMap = new Map<string, { sessions: number; prompts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>();
  const hourMap = new Map<number, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>();
  const projectMap = new Map<string, { sessions: number; prompts: number; inputTokens: number; outputTokens: number }>();
  const entrypointMap = new Map<string, number>();

  for (const row of rows) {
    totalPrompts += row.prompt_count;
    totalInput += row.input_tokens;
    totalOutput += row.output_tokens;
    totalCacheRead += row.cache_read_tokens;
    totalCacheCreate += row.cache_creation_tokens;
    if (row.first_timestamp != null && row.last_timestamp != null) {
      totalDurationMs += Math.abs(row.last_timestamp - row.first_timestamp);
    }

    // byDay
    const dateStr = row.first_timestamp != null
      ? dayFmt.format(new Date(row.first_timestamp))
      : "unknown";
    const dayEntry = dayMap.get(dateStr) ?? { sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    dayEntry.sessions++;
    dayEntry.prompts += row.prompt_count;
    dayEntry.inputTokens += row.input_tokens;
    dayEntry.outputTokens += row.output_tokens;
    dayEntry.cacheReadTokens += row.cache_read_tokens;
    dayEntry.cacheCreationTokens += row.cache_creation_tokens;
    dayMap.set(dateStr, dayEntry);

    // byHour (only for "day" period)
    if (opts.period === "day" && row.first_timestamp != null) {
      const h = parseInt(hourFmt.format(new Date(row.first_timestamp)), 10) % 24;
      const hourEntry = hourMap.get(h) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      hourEntry.inputTokens += row.input_tokens;
      hourEntry.outputTokens += row.output_tokens;
      hourEntry.cacheReadTokens += row.cache_read_tokens;
      hourEntry.cacheCreationTokens += row.cache_creation_tokens;
      hourMap.set(h, hourEntry);
    }

    // byProject
    const projEntry = projectMap.get(row.project_path) ?? { sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0 };
    projEntry.sessions++;
    projEntry.prompts += row.prompt_count;
    projEntry.inputTokens += row.input_tokens;
    projEntry.outputTokens += row.output_tokens;
    projectMap.set(row.project_path, projEntry);

    // byEntrypoint
    const ep = row.entrypoint ?? "unknown";
    entrypointMap.set(ep, (entrypointMap.get(ep) ?? 0) + 1);
  }

  // ── Cost from per-message model data ─────────────────────────────────────
  const messageTotals = store.getMessageTotals({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
  });

  let totalCost = 0;
  const byModel: DashboardData["byModel"] = [];
  for (const mt of messageTotals) {
    const result = estimateCost(
      mt.model,
      mt.input_tokens,
      mt.output_tokens,
      mt.cache_read_tokens,
      mt.cache_creation_tokens,
    );
    totalCost += result.cost;
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
    const todayStr = dayFmt.format(new Date());
    let cursor = new Date(since);
    for (let i = 0; i < 400; i++) { // safety cap
      const dateStr = dayFmt.format(cursor);
      if (dateStr > todayStr) break;
      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, { sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // ── Compute per-day cost from byModel is impractical without per-day messages,
  //    so we distribute total cost proportionally by output tokens per day ────
  const totalOutputForCost = totalOutput || 1; // avoid division by zero
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
      estimatedCost: Math.round((d.outputTokens / totalOutputForCost) * totalCost * 100) / 100,
    }));

  // ── Per-project cost: distribute proportionally by output tokens ──────────
  const byProject: DashboardData["byProject"] = Array.from(projectMap.entries())
    .sort(([, a], [, b]) => b.inputTokens - a.inputTokens)
    .map(([projectPath, p]) => ({
      projectPath,
      sessions: p.sessions,
      prompts: p.prompts,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      estimatedCost: Math.round((p.outputTokens / totalOutputForCost) * totalCost * 100) / 100,
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

  // ── Hourly breakdown (day period only) ───────────────────────────────────
  const byHour: DashboardData["byHour"] = opts.period === "day"
    ? Array.from({ length: 24 }, (_, h) => {
        const e = hourMap.get(h) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        return { hour: String(h).padStart(2, "0"), ...e };
      })
    : [];

  // ── Plan ROI metrics ─────────────────────────────────────────────────────
  const planFee = opts.planFee ?? 0;
  const planMultiplier = planFee > 0 ? Math.round((totalCost / planFee) * 10) / 10 : 0;
  const costPerPrompt = totalPrompts > 0 ? totalCost / totalPrompts : 0;
  const daysInPeriod = since > 0 ? Math.max(1, (Date.now() - since) / (24 * 60 * 60 * 1000)) : 30;
  const dailyValueRate = totalCost / daysInPeriod;

  // ── Velocity + active hours ──────────────────────────────────────────────
  // Active time is derived from the merged timeline of all message timestamps in
  // the selected period. Gaps ≥ 30 min are treated as idle and excluded. We merge
  // across sessions first (rather than summing per-session durations) so that
  // overlapping parallel sessions — common when agents spawn subagents — don't
  // get double-counted.
  const mergedTimestamps = store.getMessageTimestamps({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
  });
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
  const msgTotalsBySession = store.getMessageTotalsBySession(sessionIds);
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
    const accountMap = new Map<string, { subscriptionType: string | null; sessions: number; cost: number }>();
    for (const row of rows) {
      const acctKey = row.account_uuid ?? "(unknown)";
      const entry = accountMap.get(acctKey) ?? { subscriptionType: row.subscription_type, sessions: 0, cost: 0 };
      entry.sessions++;
      // Pick the most recent subscription type seen for this account
      if (row.subscription_type) entry.subscriptionType = row.subscription_type;
      accountMap.set(acctKey, entry);
    }

    // Distribute cost to accounts proportionally by session output tokens
    // (we already have sessionCostMap from the conversation cost ranking)
    for (const row of rows) {
      const acctKey = row.account_uuid ?? "(unknown)";
      const entry = accountMap.get(acctKey);
      if (entry) {
        const sc = sessionCostMap.get(row.session_id);
        entry.cost += sc?.cost ?? 0;
      }
    }

    // Determine effective plan fee: use explicit --plan-fee, or auto-detect
    // from the dominant account's subscription type, or sum across accounts
    let effectivePlanFee = planFee;
    if (effectivePlanFee <= 0) {
      // Auto-detect: sum detected fees across all known accounts
      let detectedTotal = 0;
      for (const [, acct] of accountMap) {
        const detected = lookupPlanFee(acct.subscriptionType);
        if (detected) detectedTotal += detected;
      }
      if (detectedTotal > 0) effectivePlanFee = detectedTotal;
    }

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

    // Plan recommendation based on weekly API-equivalent cost
    const monthlyEquiv = avgWeeklyCost * 4.33;
    let recommendedPlan: string | null = null;
    let currentPlanVerdict = "no-plan";

    if (monthlyEquiv < 22.5) recommendedPlan = "pro";
    else if (monthlyEquiv < 62.5) recommendedPlan = "team_standard";
    else if (monthlyEquiv < 112.5) recommendedPlan = "max_5x";
    else if (monthlyEquiv < 162.5) recommendedPlan = "team_premium";
    else recommendedPlan = "max_20x";

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
    }
    const byAccount: DashboardData["planUtilization"] extends { byAccount: infer T } | null ? T : never =
      Array.from(accountMap.entries())
        .sort(([, a], [, b]) => b.cost - a.cost)
        .map(([acctKey, acct]) => {
          // Fall back to configured plan type when telemetry subscription_type is absent
          const subscriptionType = acct.subscriptionType ?? opts.planType ?? null;
          const detectedFee = lookupPlanFee(subscriptionType);
          let verdict = "no-plan";
          if (detectedFee && detectedFee > 0) {
            verdict = acct.cost >= detectedFee ? "good-value" : "underusing";
          } else if (effectivePlanFee > 0) {
            // Fall back to proportional share of explicit plan fee
            const share = effectivePlanFee * (acct.sessions / rows.length);
            verdict = acct.cost >= share ? "good-value" : "underusing";
          }
          const email = claudeAcct?.accountUuid === acctKey ? claudeAcct.emailAddress : null;
          return {
            accountId: acctKey === "(unknown)" ? "(unknown)" : acctKey.slice(0, 8) + "...",
            emailAddress: email,
            subscriptionType,
            detectedPlanFee: detectedFee,
            sessions: acct.sessions,
            estimatedCost: Math.round(acct.cost * 100) / 100,
            planVerdict: verdict,
          };
        });

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
      byAccount,
    };
  }

  // ── Context analysis ───────────────────────────────────────────────────
  const contextAnalysis = buildContextAnalysis(store, rows, sessionCostMap, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
  });

  // ── Spending breakdown ──────────────────────────────────────────────────
  const spending = buildSpendingSection(store, rows, sessionCostMap, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
  });

  // ── Energy dashboard ────────────────────────────────────────────────────
  const energy = buildEnergySection(store, {
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
    timezone: tz,
  });

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
    period: opts.period ?? "all",
    timezone: tz,
    sinceIso: since > 0 ? new Date(since).toISOString().slice(0, 10) : null,
    summary: {
      sessions: rows.length,
      prompts: totalPrompts,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreate,
      cacheEfficiency,
      estimatedCost: Math.round(totalCost * 100) / 100,
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
    modelEfficiency,
    contextAnalysis,
    spending,
    energy,
    recommendations,
  };
}

const PLAN_LABELS: Record<string, string> = {
  pro: "Pro ($20/mo)",
  team_standard: "Team Standard ($25/mo)",
  max_5x: "Max 5x ($100/mo)",
  team_premium: "Team Premium ($125/mo)",
  max_20x: "Max 20x ($200/mo)",
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

  // 2. Underusing plan — clearly spending far less than the plan fee
  if (planUtilization) {
    if (
      planUtilization.currentPlanVerdict === "underusing" &&
      planUtilization.weeklyPlanBudget > 0 &&
      planUtilization.avgWeeklyCost < planUtilization.weeklyPlanBudget * 0.5 &&
      planUtilization.recommendedPlan
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
  filters: { projectPath?: string; repoUrl?: string; accountUuid?: string; since?: number },
): DashboardSpending | null {
  if (rows.length === 0) return null;

  const report = store.getSpendingReport({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    since: filters.since,
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
      promptPreview: a.message.prompt_text?.slice(0, 120) ?? "",
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
  filters: { projectPath?: string; repoUrl?: string; since?: number },
): ModelEfficiencyData | null {
  const msgRows = store.getMessagesForEfficiency(filters);
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
            promptPreview: turn.promptText
              ? turn.promptText.slice(0, 120) + (turn.promptText.length > 120 ? "..." : "")
              : "(no prompt text)",
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
            promptPreview: turn.promptText
              ? turn.promptText.slice(0, 120) + (turn.promptText.length > 120 ? "..." : "")
              : "(no prompt text)",
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
  filters: { projectPath?: string; repoUrl?: string; since?: number },
): ContextAnalysis | null {
  if (rows.length === 0) return null;

  const contextMsgs = store.getMessagesForContext(filters);
  if (contextMsgs.length === 0) return null;

  // Group messages by session
  const bySession = new Map<string, Array<{ inputTokens: number; cacheRead: number; cacheCreate: number }>>();
  for (const msg of contextMsgs) {
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

function buildEnergySection(
  store: Store,
  filters: { projectPath?: string; repoUrl?: string; since?: number; timezone: string },
): DashboardEnergy | null {
  const messages = store.getMessagesForEnergy({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    since: filters.since,
  });

  if (messages.length === 0) return null;

  let effectiveSince = filters.since && filters.since > 0 ? filters.since : Date.now();
  if (!(filters.since && filters.since > 0)) {
    for (const m of messages) {
      if (m.timestamp != null && m.timestamp < effectiveSince) effectiveSince = m.timestamp;
    }
  }
  const daysInPeriod = Math.max(1, (Date.now() - effectiveSince) / (24 * 60 * 60 * 1000));

  // Determine grid region: prefer most common detected inferenceGeo, fall back to locale
  const geoCount: Record<string, number> = {};
  let geoMessages = 0;
  for (const m of messages) {
    if (m.inference_geo) {
      geoCount[m.inference_geo] = (geoCount[m.inference_geo] ?? 0) + 1;
      geoMessages++;
    }
  }
  const coveragePct = messages.length > 0 ? (geoMessages / messages.length) * 100 : 0;

  // Find dominant inferenceGeo for region detection
  let dominantGeo: string | null = null;
  let maxCount = 0;
  for (const [geo, cnt] of Object.entries(geoCount)) {
    if (cnt > maxCount) { maxCount = cnt; dominantGeo = geo; }
  }

  // Determine user locale-based region as fallback
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

  // Per-day and per-model accumulators
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: filters.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });

  const dayEnergyMap = new Map<string, { energyWh: number; co2Grams: number }>();
  const modelEnergyMap = new Map<string, { energyWh: number; co2Grams: number }>();
  const projectEnergyMap = new Map<string, { energyWh: number; co2Grams: number }>();

  const allEstimates = [];
  let thinkingEnergy = 0;
  let sessionsWithThinking = new Set<string>();

  const emptyClass = () => ({ msgs: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, rawEnergyWh: 0 });
  const classAccum: Record<ModelClass, ReturnType<typeof emptyClass>> = {
    haiku: emptyClass(), sonnet: emptyClass(), opus: emptyClass(),
  };

  // Cache impact: estimate energy saved by cache reads vs re-computing as input
  let cacheEnergySavedWh = 0;
  let cacheCO2SavedGrams = 0;
  let totalCacheReadTokens = 0;
  let totalInputTokens = 0;

  for (const m of messages) {
    const estimate = estimateEnergy({
      model: m.model,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      cacheCreationTokens: m.cache_creation_tokens,
      cacheReadTokens: m.cache_read_tokens,
      ephemeral5mCacheTokens: m.ephemeral_5m_cache_tokens,
      ephemeral1hCacheTokens: m.ephemeral_1h_cache_tokens,
      inferenceGeo: m.inference_geo,
    }, { region: regionKey, gridIntensity });

    allEstimates.push(estimate);

    // byClass accumulator for the calculation-transparency panel
    const cls = modelClass(m.model);
    const acc = classAccum[cls];
    acc.msgs += 1;
    acc.inputTokens += m.input_tokens;
    acc.outputTokens += m.output_tokens;
    acc.cacheWriteTokens += m.cache_creation_tokens;
    acc.cacheReadTokens += m.cache_read_tokens;
    acc.rawEnergyWh += estimate.energyWh;

    // byDay
    const dateStr = m.timestamp != null
      ? dayFmt.format(new Date(m.timestamp))
      : "unknown";
    const dayEntry = dayEnergyMap.get(dateStr) ?? { energyWh: 0, co2Grams: 0 };
    dayEntry.energyWh += estimate.totalEnergyWh;
    dayEntry.co2Grams += estimate.co2Grams;
    dayEnergyMap.set(dateStr, dayEntry);

    // byModel
    const modelEntry = modelEnergyMap.get(m.model) ?? { energyWh: 0, co2Grams: 0 };
    modelEntry.energyWh += estimate.totalEnergyWh;
    modelEntry.co2Grams += estimate.co2Grams;
    modelEnergyMap.set(m.model, modelEntry);

    // byProject
    const projEntry = projectEnergyMap.get(m.project_path) ?? { energyWh: 0, co2Grams: 0 };
    projEntry.energyWh += estimate.totalEnergyWh;
    projEntry.co2Grams += estimate.co2Grams;
    projectEnergyMap.set(m.project_path, projEntry);

    // Thinking impact
    if (m.thinking_blocks > 0) {
      sessionsWithThinking.add(m.session_id);
      // Thinking tokens are output tokens — estimate their energy fraction
      thinkingEnergy += estimate.totalEnergyWh * 0.3; // approximate thinking fraction
    }

    // Cache impact: energy cost of cache reads is ~3% of output rate.
    // Without cache, those tokens would be input (full input rate).
    // Saved = (cache_read / 1K) * (inputRate - outputRate * 0.03) * pue
    totalCacheReadTokens += m.cache_read_tokens;
    totalInputTokens += m.input_tokens;
  }

  const aggregated = aggregateEnergy(allEstimates);
  const totalEnergyWh = aggregated.totalEnergyWh;

  // Compute cache savings: each 1K cache-read token saved ~inputRate vs charged ~outputRate*0.03
  {
    // Use sonnet rates as representative for the aggregate cache savings estimate
    const { inputWhPer1K, outputWhPer1K } = MODEL_ENERGY.sonnet;
    const pue = 1.2;
    cacheEnergySavedWh = (totalCacheReadTokens / 1000) * (inputWhPer1K - outputWhPer1K * 0.03) * pue;
    cacheCO2SavedGrams = (cacheEnergySavedWh / 1000) * gridIntensity;
  }

  const logicalInput = totalInputTokens + totalCacheReadTokens;
  const cacheEfficiencyPct = logicalInput > 0
    ? Math.round((totalCacheReadTokens / logicalInput) * 1000) / 10
    : 0;

  const pctEnergyFromThinking = totalEnergyWh > 0
    ? Math.round((thinkingEnergy / totalEnergyWh) * 1000) / 10
    : 0;

  const byDay: DashboardEnergy["byDay"] = Array.from(dayEnergyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      date,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
    }));

  const byModel: DashboardEnergy["byModel"] = Array.from(modelEnergyMap.entries())
    .sort(([, a], [, b]) => b.energyWh - a.energyWh)
    .map(([model, e]) => ({
      model,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
      pct: totalEnergyWh > 0 ? Math.round((e.energyWh / totalEnergyWh) * 1000) / 10 : 0,
    }));

  const byProject: DashboardEnergy["byProject"] = Array.from(projectEnergyMap.entries())
    .sort(([, a], [, b]) => b.energyWh - a.energyWh)
    .map(([project, e]) => ({
      project,
      energyWh: Math.round(e.energyWh * 10000) / 10000,
      co2Grams: Math.round(e.co2Grams * 1000) / 1000,
    }));

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
      gasolineLiters: Math.round(aggregated.equivalents.gasolineLiters * 1000) / 1000,
      trainKm: Math.round(aggregated.equivalents.trainKm * 100) / 100,
      nuclearWasteMl: Math.round(aggregated.equivalents.nuclearWasteMl * 10000) / 10000,
      windRotations: Math.round(aggregated.equivalents.windRotations * 10) / 10,
    },
    journeyAnchor: nearestJourneyAnchor(aggregated.equivalents.carKm),
    periodStartIso: new Date(effectiveSince).toISOString().slice(0, 10),
    periodEndIso: new Date().toISOString().slice(0, 10),
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
      sessionsWithThinking: sessionsWithThinking.size,
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
