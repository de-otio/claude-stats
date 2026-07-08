/**
 * Query.myStats — Roll up aggregate rows for the authenticated user.
 * Filters by period (week/month) and returns MemberStats.
 *
 * Reads from the aggregate-only table (review F9): each item is a
 * client-computed, client-minimized period bucket — never a per-session or
 * per-message record — so this resolver can only ever sum counts/sums, not
 * touch content.
 *
 * Args:
 *   period: String! — "week" or "month"
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

/**
 * Compute the inclusive lower-bound period label for the requested window.
 * Period labels are ISO date strings (YYYY-MM-DD) so string comparison
 * sorts correctly.
 */
function periodStart(period) {
  const days = period === "week" ? 7 : period === "month" ? 30 : null;
  if (days === null) {
    util.error('Period must be "week" or "month"', "ValidationError");
    return null;
  }
  // APPSYNC_JS provides no Date object — compute the window with util.time.
  const fromMs = util.time.nowEpochMilliSeconds() - days * 24 * 60 * 60 * 1000;
  return util.time.epochMilliSecondsToFormatted(fromMs, "yyyy-MM-dd");
}

export function request(ctx) {
  const userId = ctx.identity.sub;
  const period = ctx.args.period;
  const from = periodStart(period);

  return ddb.query({
    query: {
      userId: { eq: userId },
      period: { ge: from },
    },
    limit: 10000, // Upper bound; typical users have far fewer buckets
    scanIndexForward: false,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const buckets = ctx.result.items ?? [];

  // Roll up aggregate buckets in the period
  let sessions = 0;
  let subagentSessions = 0;
  let prompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;
  let activeMinutes = 0;
  const modelsSet = {};
  const toolsMap = {};
  const projectMap = {};

  // APPSYNC_JS bans `for` loops and `++`; use forEach (closure `+=` is fine).
  buckets.forEach((b) => {
    sessions += b.sessionCount ?? 0;
    subagentSessions += b.subagentSessionCount ?? 0;
    prompts += b.promptCount ?? 0;
    inputTokens += b.inputTokens ?? 0;
    outputTokens += b.outputTokens ?? 0;
    estimatedCost += b.estimatedCost ?? 0;
    activeMinutes += b.activeMinutes ?? 0;

    // Track unique models
    if (b.models) {
      b.models.forEach((m) => {
        modelsSet[m] = (modelsSet[m] ?? 0) + 1;
      });
    }

    // Track tool usage from toolUseCounts (stored as AWSJSON)
    if (b.toolUseCounts) {
      const tools =
        typeof b.toolUseCounts === "string"
          ? JSON.parse(b.toolUseCounts)
          : b.toolUseCounts;
      Object.keys(tools).forEach((tool) => {
        toolsMap[tool] = (toolsMap[tool] ?? 0) + tools[tool];
      });
    }

    // Track project breakdown
    const pid = b.projectId ?? "(unlinked)";
    if (!projectMap[pid]) {
      projectMap[pid] = { projectId: pid, sessions: 0, prompts: 0, estimatedCost: 0 };
    }
    projectMap[pid].sessions += b.sessionCount ?? 0;
    projectMap[pid].prompts += b.promptCount ?? 0;
    projectMap[pid].estimatedCost += b.estimatedCost ?? 0;
  });

  // Tool names used. Ranking (top-N by count) is deferred to the client —
  // APPSYNC_JS bans comparator sort, and the dashboard does not rank tools.
  const topTools = Object.keys(toolsMap);

  // Velocity: total output tokens / active minutes
  const velocityTokensPerMin =
    activeMinutes > 0 ? Math.round((outputTokens / activeMinutes) * 100) / 100 : 0;

  // Subagent ratio: subagent sessions / total sessions
  const subagentRatio =
    sessions > 0 ? Math.round((subagentSessions / sessions) * 1000) / 1000 : 0;

  const projectBreakdown = Object.values(projectMap);

  return {
    sessions,
    prompts,
    inputTokens,
    outputTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    activeMinutes,
    modelsUsed: JSON.stringify(modelsSet),
    topTools,
    velocityTokensPerMin,
    subagentRatio,
    projectBreakdown,
  };
}
