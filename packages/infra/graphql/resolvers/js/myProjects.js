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

  // APPSYNC_JS bans `for` loops and `++`; use forEach.
  buckets.forEach((b) => {
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
  });

  // Ranking is done client-side (useTopProjects sorts by prompts, top 5);
  // APPSYNC_JS bans sort-with-comparator, so return the buckets unsorted.
  return Object.values(projectMap);
}
