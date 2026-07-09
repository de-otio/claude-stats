/**
 * Mutation.createTeam — Pipeline Step 2: write the creator's admin membership.
 * Bound to the TeamMemberships data source. Returns the Team stashed by Step 1.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const m = ctx.stash.membership;
  return ddb.put({ key: { teamId: m.teamId, userId: m.userId }, item: m });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.stash.team;
}
