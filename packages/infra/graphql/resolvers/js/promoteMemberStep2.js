/**
 * Mutation.promoteMember — Pipeline Step 2.
 * Step 1 verified the caller is an admin and stashed teamId + targetUserId.
 * Promote the target to admin (must already be a member) and return the
 * updated TeamMember, uppercasing role/shareLevel for the GraphQL enums.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.update({
    key: { teamId: ctx.stash.teamId, userId: ctx.stash.targetUserId },
    update: { role: "admin", updatedAt: util.time.nowEpochMilliSeconds() },
    // Guard against upserting a partial membership row for a non-member.
    condition: { displayName: { attributeExists: true } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const m = ctx.result;
  if (!m) {
    util.error("Member not found", "NotFoundError");
  }
  return {
    ...m,
    role: (m.role || "").toUpperCase(),
    shareLevel: (m.shareLevel || "").toUpperCase(),
  };
}
