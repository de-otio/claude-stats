/**
 * Query.myProjects — Group aggregate rows by projectId for the authenticated user.
 * Filters by period (week/month) and returns [ProjectStats].
 *
 * Reads from the aggregate-only table (review F9) — one row per
 * (userId, period), never a per-session record.
 *
 * Args:
 *   period: String! — "week" or "month"
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

function periodStart(period) {
  const now = util.time.nowISO8601();
  const days = period === "week" ? 7 : period === "month" ? 30 : null;
  if (days === null) {
    util.error('Period must be "week" or "month"', "ValidationError");
    return null;
  }
  const nowMs = Date.parse(now);
  const fromMs = nowMs - days * 24 * 60 * 60 * 1000;
  return new Date(fromMs).toISOString().slice(0, 10);
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
    limit: 10000,
    scanIndexForward: false,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const buckets = ctx.result.items ?? [];
  const projectMap = {};

  for (const b of buckets) {
    const pid = b.projectId ?? "(unlinked)";
    if (!projectMap[pid]) {
      projectMap[pid] = {
        projectId: pid,
        sessions: 0,
        prompts: 0,
        estimatedCost: 0,
      };
    }
    projectMap[pid].sessions += b.sessionCount ?? 0;
    projectMap[pid].prompts += b.promptCount ?? 0;
    projectMap[pid].estimatedCost += b.estimatedCost ?? 0;
  }

  // Sort by session count descending
  const projects = Object.values(projectMap);
  projects.sort((a, b) => b.sessions - a.sessions);

  return projects;
}
