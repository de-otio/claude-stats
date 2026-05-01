/**
 * Query.myStats — Aggregate stats from SyncedSessions for the authenticated user.
 * Filters by period (week/month) and returns MemberStats.
 *
 * Args:
 *   period: String! — "week" or "month"
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

/**
 * Compute the epoch-millisecond start of the current period.
 */
function periodStart(period) {
  const now = util.time.nowEpochMilliSeconds();
  if (period === "week") {
    // 7 days ago
    return now - 7 * 24 * 60 * 60 * 1000;
  }
  if (period === "month") {
    // 30 days ago
    return now - 30 * 24 * 60 * 60 * 1000;
  }
  util.error(
    'Period must be "week" or "month"',
    "ValidationError"
  );
}

export function request(ctx) {
  const userId = ctx.identity.sub;
  const period = ctx.args.period;
  const from = periodStart(period);

  return ddb.query({
    index: "SessionsByTimestamp",
    query: {
      userId: { eq: userId },
      lastTimestamp: { ge: from },
    },
    limit: 10000, // Upper bound; typical users have far fewer
    scanIndexForward: false,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const sessions = ctx.result.items ?? [];

  // Aggregate stats across all sessions in the period
  let prompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;
  let activeMinutes = 0;
  const modelsSet = {};
  const toolsMap = {};
  const projectMap = {};

  for (const s of sessions) {
    prompts += s.promptCount ?? 0;
    inputTokens += s.inputTokens ?? 0;
    outputTokens += s.outputTokens ?? 0;
    estimatedCost += s.estimatedCost ?? 0;

    // Approximate active minutes from session duration
    if (s.firstTimestamp && s.lastTimestamp) {
      activeMinutes += Math.round(
        (s.lastTimestamp - s.firstTimestamp) / 60000
      );
    }

    // Track unique models
    if (s.models) {
      for (const m of s.models) {
        modelsSet[m] = (modelsSet[m] ?? 0) + 1;
      }
    }

    // Track tool usage from toolUseCounts (stored as AWSJSON)
    if (s.toolUseCounts) {
      const tools =
        typeof s.toolUseCounts === "string"
          ? JSON.parse(s.toolUseCounts)
          : s.toolUseCounts;
      for (const tool of Object.keys(tools)) {
        toolsMap[tool] = (toolsMap[tool] ?? 0) + tools[tool];
      }
    }

    // Track project breakdown
    const pid = s.projectId ?? "(unlinked)";
    if (!projectMap[pid]) {
      projectMap[pid] = { projectId: pid, sessions: 0, prompts: 0, estimatedCost: 0 };
    }
    projectMap[pid].sessions += 1;
    projectMap[pid].prompts += s.promptCount ?? 0;
    projectMap[pid].estimatedCost += s.estimatedCost ?? 0;
  }

  // Derive top tools (sorted by usage count, top 10)
  const topTools = Object.entries(toolsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map((entry) => entry[0]);

  // Velocity: total output tokens / active minutes
  const velocityTokensPerMin =
    activeMinutes > 0 ? Math.round((outputTokens / activeMinutes) * 100) / 100 : 0;

  // Subagent ratio: sessions flagged as subagent / total sessions
  const subagentCount = sessions.filter((s) => s.isSubagent).length;
  const subagentRatio =
    sessions.length > 0
      ? Math.round((subagentCount / sessions.length) * 1000) / 1000
      : 0;

  const projectBreakdown = Object.values(projectMap);

  return {
    sessions: sessions.length,
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
