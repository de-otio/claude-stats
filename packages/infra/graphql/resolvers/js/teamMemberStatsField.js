/**
 * TeamMember.stats(period) — nested field resolver.
 * Fetches the member's materialized stats snapshot from the TeamStats table.
 *
 * TeamStats layout: PK teamId, SK "period#userId". Each row's `stats`
 * attribute IS the MemberStats blob, written by the aggregate-stats worker
 * with the member's shareLevel already applied. Members sharing "minimal"
 * have no snapshot → null.
 *
 * NOTE: the aggregate-stats worker (P3) is the writer for TeamStats; until it
 * ships this returns null (no row), which is the correct empty-state answer.
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const teamId = ctx.source.teamId;
  const userId = ctx.source.userId;
  const period = ctx.args.period;
  // shareLevel may arrive uppercased (enum boundary) or lowercase (storage).
  if ((ctx.source.shareLevel || "").toUpperCase() === "MINIMAL" || !teamId || !userId) {
    runtime.earlyReturn(null);
  }
  return ddb.get({
    key: { teamId, ["period#userId"]: `${period}#${userId}` },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const row = ctx.result;
  if (!row || !row.stats) {
    return null;
  }
  return row.stats;
}
