/**
 * Query.myAggregates — Query the UserAggregates table for the
 * authenticated user.
 *
 * Aggregate-only (review F9): the underlying table holds one row per
 * (userId, period) — never a per-session or per-message record — so this
 * resolver cannot return content, only the minimized counts/sums the client
 * computed and synced via `syncAggregate`.
 *
 * PK is always userId = ctx.identity.sub. Sort key is `period` (a client-
 * chosen bucket label, e.g. an ISO date — sorts correctly as a string).
 *
 * Args:
 *   from: String (optional) — inclusive lower bound on `period`
 *   to: String (optional) — inclusive upper bound on `period`
 *   limit: Int (optional) — max items to return
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const userId = ctx.identity.sub;
  const { from, to, limit } = ctx.args;

  const query = { userId: { eq: userId } };

  if (from !== undefined && to !== undefined) {
    query.period = { between: [from, to] };
  } else if (from !== undefined) {
    query.period = { ge: from };
  } else if (to !== undefined) {
    query.period = { le: to };
  }

  return ddb.query({
    query,
    limit: limit ? Math.min(limit, 1000) : 100,
    scanIndexForward: false, // Most recent first
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items;
}
