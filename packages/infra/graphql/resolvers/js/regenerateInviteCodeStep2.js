/**
 * Mutation.regenerateInviteCode — Pipeline Step 2.
 * Step 1 verified admin and stashed teamId + inviteCode + expiry.
 * Write the new code and return it (String!).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.update({
    key: { teamId: ctx.stash.teamId },
    update: {
      inviteCode: ctx.stash.inviteCode,
      inviteCodeExpiresAt: ctx.stash.inviteCodeExpiresAt,
      updatedAt: util.time.nowEpochMilliSeconds(),
    },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.stash.inviteCode;
}
