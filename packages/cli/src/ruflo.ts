/**
 * Ruflo integration insights — detect ruflo MCP server usage and
 * compare ruflo-active sessions against baseline sessions.
 * See doc/analysis/12-ruflo-insights.md and plans/13-ruflo-insights.md.
 */
import type { McpMessageRow, SessionRow } from "./store/index.js";
import type { McpServerUsage } from "./spending.js";

/** Prefix used by ruflo MCP tools in session JSONL. */
export const RUFLO_MCP_PREFIX = "mcp__ruflo__";

/** Canonical server name as it appears in MCP grouping. */
export const RUFLO_SERVER_NAME = "ruflo";

export interface RufloInsights {
  detected: boolean;
  sessionCount: number;
  totalSessions: number;
  adoptionRate: number;
  serverUsage: McpServerUsage | null;
  topMethods: RufloMethodSummary[];
  costBreakdown: {
    rufloCost: number;
    totalCost: number;
    rufloSharePct: number;
  };
  comparison: RufloComparison | null;
}

export interface RufloMethodSummary {
  method: string;
  calls: number;
  estimatedCost: number;
}

export interface RufloComparison {
  rufloSessions: SessionCohortMetrics;
  baselineSessions: SessionCohortMetrics;
  deltas: SessionCohortDeltas;
}

export interface SessionCohortMetrics {
  count: number;
  avgTokensPerPrompt: number;
  avgCostPerSession: number;
  avgDurationMs: number;
  avgCacheHitRate: number;
  avgPromptsPerSession: number;
  truncationRate: number;
}

export interface SessionCohortDeltas {
  tokensPerPrompt: number;
  costPerSession: number;
  durationMs: number;
  cacheHitRate: number;
  promptsPerSession: number;
  truncationRate: number;
}

export function isRufloTool(toolName: string): boolean {
  return toolName.startsWith(RUFLO_MCP_PREFIX);
}

export function isRufloSession(tools: string[]): boolean {
  return tools.some(isRufloTool);
}

export function extractRufloMethod(toolName: string): string {
  const parts = toolName.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : toolName;
}

/**
 * Identify which sessions used at least one ruflo MCP tool.
 * Scans `McpMessageRow[]` for tools matching the ruflo prefix.
 */
export function findRufloSessionIds(mcpMessages: McpMessageRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of mcpMessages) {
    let tools: string[];
    try {
      tools = JSON.parse(row.tools) as string[];
    } catch {
      continue;
    }
    if (tools.some(isRufloTool)) {
      ids.add(row.session_id);
    }
  }
  return ids;
}

/**
 * Build ruflo insights from pre-computed MCP data.
 */
export function buildRufloInsights(
  mcpMessages: McpMessageRow[],
  mcpServerUsage: McpServerUsage[],
  allSessions: SessionRow[],
  totalCost: number,
): RufloInsights {
  const rufloUsage = mcpServerUsage.find(s => s.server === RUFLO_SERVER_NAME) ?? null;

  if (!rufloUsage) {
    return {
      detected: false,
      sessionCount: 0,
      totalSessions: allSessions.length,
      adoptionRate: 0,
      serverUsage: null,
      topMethods: [],
      costBreakdown: { rufloCost: 0, totalCost, rufloSharePct: 0 },
      comparison: null,
    };
  }

  const rufloSessionIds = findRufloSessionIds(mcpMessages);

  const adoptionRate = allSessions.length > 0
    ? rufloSessionIds.size / allSessions.length
    : 0;

  const topMethods: RufloMethodSummary[] = rufloUsage.tools.map(t => ({
    method: t.method,
    calls: t.calls,
    estimatedCost: rufloUsage.callCount > 0
      ? (t.calls / rufloUsage.callCount) * rufloUsage.estimatedCost
      : 0,
  }));

  const rufloSharePct = totalCost > 0
    ? (rufloUsage.estimatedCost / totalCost) * 100
    : 0;

  const comparison = buildRufloComparison(allSessions, rufloSessionIds);

  return {
    detected: true,
    sessionCount: rufloSessionIds.size,
    totalSessions: allSessions.length,
    adoptionRate,
    serverUsage: rufloUsage,
    topMethods,
    costBreakdown: {
      rufloCost: Math.round(rufloUsage.estimatedCost * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      rufloSharePct: Math.round(rufloSharePct * 10) / 10,
    },
    comparison,
  };
}

/** Minimum sessions per cohort required for a meaningful A/B comparison. */
const MIN_COHORT_SIZE = 3;

/**
 * Compare ruflo-active sessions against baseline sessions.
 * Returns null when either cohort is too small for meaningful comparison.
 */
export function buildRufloComparison(
  allSessions: SessionRow[],
  rufloSessionIds: Set<string>,
): RufloComparison | null {
  const rufloCohort: SessionRow[] = [];
  const baselineCohort: SessionRow[] = [];

  for (const s of allSessions) {
    if (rufloSessionIds.has(s.session_id)) {
      rufloCohort.push(s);
    } else {
      baselineCohort.push(s);
    }
  }

  if (rufloCohort.length < MIN_COHORT_SIZE || baselineCohort.length < MIN_COHORT_SIZE) {
    return null;
  }

  const rufloMetrics = computeCohortMetrics(rufloCohort);
  const baselineMetrics = computeCohortMetrics(baselineCohort);

  return {
    rufloSessions: rufloMetrics,
    baselineSessions: baselineMetrics,
    deltas: {
      tokensPerPrompt: rufloMetrics.avgTokensPerPrompt - baselineMetrics.avgTokensPerPrompt,
      costPerSession: rufloMetrics.avgCostPerSession - baselineMetrics.avgCostPerSession,
      durationMs: rufloMetrics.avgDurationMs - baselineMetrics.avgDurationMs,
      cacheHitRate: rufloMetrics.avgCacheHitRate - baselineMetrics.avgCacheHitRate,
      promptsPerSession: rufloMetrics.avgPromptsPerSession - baselineMetrics.avgPromptsPerSession,
      truncationRate: rufloMetrics.truncationRate - baselineMetrics.truncationRate,
    },
  };
}

function computeCohortMetrics(sessions: SessionRow[]): SessionCohortMetrics {
  const n = sessions.length;
  if (n === 0) {
    return {
      count: 0,
      avgTokensPerPrompt: 0,
      avgCostPerSession: 0,
      avgDurationMs: 0,
      avgCacheHitRate: 0,
      avgPromptsPerSession: 0,
      truncationRate: 0,
    };
  }

  let totalTokens = 0;
  let totalPrompts = 0;
  let totalDurationMs = 0;
  let cacheHitRateSum = 0;
  let truncatedCount = 0;

  for (const s of sessions) {
    totalTokens += s.input_tokens + s.output_tokens;
    totalPrompts += s.prompt_count;
    if (s.active_duration_ms != null) {
      totalDurationMs += s.active_duration_ms;
    } else if (s.first_timestamp != null && s.last_timestamp != null) {
      totalDurationMs += Math.abs(s.last_timestamp - s.first_timestamp);
    }
    const logicalInput = s.input_tokens + s.cache_creation_tokens + s.cache_read_tokens;
    cacheHitRateSum += logicalInput > 0 ? s.cache_read_tokens / logicalInput : 0;
    if ((s.throttle_events ?? 0) > 0) truncatedCount++;
  }

  // Cost per session: approximate from tokens (use avg model pricing)
  const AVG_INPUT_PER_MTK = 3.0;  // blended $/MTk
  const AVG_OUTPUT_PER_MTK = 15.0;
  let totalCost = 0;
  for (const s of sessions) {
    totalCost += (s.input_tokens / 1_000_000) * AVG_INPUT_PER_MTK
              + (s.output_tokens / 1_000_000) * AVG_OUTPUT_PER_MTK;
  }

  return {
    count: n,
    avgTokensPerPrompt: totalPrompts > 0 ? Math.round(totalTokens / totalPrompts) : 0,
    avgCostPerSession: Math.round((totalCost / n) * 100) / 100,
    avgDurationMs: Math.round(totalDurationMs / n),
    avgCacheHitRate: Math.round((cacheHitRateSum / n) * 1000) / 10,
    avgPromptsPerSession: Math.round((totalPrompts / n) * 10) / 10,
    truncationRate: Math.round((truncatedCount / n) * 1000) / 10,
  };
}
