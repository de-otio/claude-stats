/**
 * Mutation.removeMember — Pipeline Step 2 (TeamMemberships).
 * Step 1 verified the caller is an admin and stashed teamId + targetUserId.
 * Delete the target member. Step 3 (shared leaveTeamStep3) decrements memberCount.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.remove({
    key: { teamId: ctx.stash.teamId, userId: ctx.stash.targetUserId },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
