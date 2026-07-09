/**
 * Mutation.leaveTeam — Pipeline Step 2 (TeamMemberships).
 * Step 1 verified membership + last-admin safety and stashed teamId + userId.
 * Delete the caller's own membership. Step 3 decrements memberCount.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.remove({
    key: { teamId: ctx.stash.teamId, userId: ctx.stash.userId },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
