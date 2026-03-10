/**
 * Dashboard — builds pre-aggregated JSON for visualization tools.
 * See plans/11-dashboard-export.md for design.
 */
import type { Store, SessionRow } from "../store/index.js";
import type { ReportOptions } from "../reporter/index.js";
import { periodStart } from "../reporter/index.js";
import { estimateCost } from "../pricing.js";
import type { UsageWindow } from "../types.js";

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
  throttleEvents: number;
  // Current window
  currentWindowStart: string | null;
  currentWindowPrompts: number;
  currentWindowCost: number;
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
  let totalActiveDurationMs = 0;
  let totalThrottleEvents = 0;
  for (const row of rows) {
    if (row.active_duration_ms != null) totalActiveDurationMs += row.active_duration_ms;
    totalThrottleEvents += row.throttle_events ?? 0;
  }
  const totalActiveHours = totalActiveDurationMs / 3_600_000;
  const avgSessionDurationMinutes = rows.length > 0
    ? (totalActiveDurationMs / rows.length) / 60_000
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
      };
    })
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
    .slice(0, 20);

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
      throttleEvents: totalThrottleEvents,
      currentWindowStart,
      currentWindowPrompts,
      currentWindowCost: Math.round(currentWindowCost * 100) / 100,
    },
    byDay,
    byHour,
    byProject,
    byModel,
    byEntrypoint,
    stopReasons,
    byWindow,
    byConversationCost,
  };
}
