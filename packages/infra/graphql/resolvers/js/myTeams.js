/**
 * Query.myTeams — Pipeline Step 1.
 * Query the MembershipsByUser GSI (PK userId) for every team the caller
 * belongs to, and stash the teamIds for Step 2 to batch-get full Team items.
 *
 * The membership rows do NOT carry teamName/settings/memberCount, so a
 * single-function resolver cannot satisfy `[Team!]!` — Step 2 hydrates the
 * full Team records from the base Teams table.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.query({
    query: { userId: { eq: ctx.identity.sub } },
    index: "MembershipsByUser",
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const memberships = ctx.result.items || [];
  ctx.stash.teamIds = memberships.map((m) => m.teamId);
  return memberships;
}
