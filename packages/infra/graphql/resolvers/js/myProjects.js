/**
 * Query.myProjects — Group SyncedSessions by projectId for the authenticated user.
 * Filters by period (week/month) and returns [ProjectStats].
 *
 * Args:
 *   period: String! — "week" or "month"
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

function periodStart(period) {
  const now = util.time.nowEpochMilliSeconds();
  if (period === "week") {
    return now - 7 * 24 * 60 * 60 * 1000;
  }
  if (period === "month") {
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
    limit: 10000,
    scanIndexForward: false,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const sessions = ctx.result.items ?? [];
  const projectMap = {};

  for (const s of sessions) {
    const pid = s.projectId ?? "(unlinked)";
    if (!projectMap[pid]) {
      projectMap[pid] = {
        projectId: pid,
        sessions: 0,
        prompts: 0,
        estimatedCost: 0,
      };
    }
    projectMap[pid].sessions += 1;
    projectMap[pid].prompts += s.promptCount ?? 0;
    projectMap[pid].estimatedCost += s.estimatedCost ?? 0;
  }

  // Sort by session count descending
  const projects = Object.values(projectMap);
  projects.sort((a, b) => b.sessions - a.sessions);

  return projects;
}
