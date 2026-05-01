/**
 * Query.mySessions — Query SyncedSessions for the authenticated user.
 * Uses SessionsByTimestamp GSI when from/to args are provided for time-range filtering.
 * PK is always userId = ctx.identity.sub.
 *
 * Args:
 *   from: AWSTimestamp (optional) — inclusive lower bound on lastTimestamp
 *   to: AWSTimestamp (optional) — inclusive upper bound on lastTimestamp
 *   limit: Int (optional) — max items to return
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const userId = ctx.identity.sub;
  const { from, to, limit } = ctx.args;

  // When time range is specified, use the SessionsByTimestamp GSI
  const useGsi = from !== undefined || to !== undefined;

  const query = {
    query: { userId: { eq: userId } },
    limit: limit ? Math.min(limit, 1000) : 100,
    scanIndexForward: false, // Most recent first
  };

  if (useGsi) {
    query.index = "SessionsByTimestamp";

    // Build sort key condition for lastTimestamp
    if (from !== undefined && to !== undefined) {
      query.query.lastTimestamp = { between: [from, to] };
    } else if (from !== undefined) {
      query.query.lastTimestamp = { ge: from };
    } else if (to !== undefined) {
      query.query.lastTimestamp = { le: to };
    }
  }

  return ddb.query(query);
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items;
}
