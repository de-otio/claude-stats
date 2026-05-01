/**
 * Mutation.removeMember — Remove a member from a team (admin only).
 * Verifies the caller is an admin via DB lookup, then deletes the
 * target user's membership.
 *
 * Pipeline resolver:
 *   Step 1: Verify caller's admin role (this function)
 *   Step 2: Delete target membership + decrement memberCount
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, userId } = ctx.args;
  if (!teamId || !userId) {
    util.error("teamId and userId are required", "ValidationError");
  }

  // Cannot remove yourself — use leaveTeam instead
  if (userId === ctx.identity.sub) {
    util.error("Cannot remove yourself. Use leaveTeam instead.", "ValidationError");
  }

  // JWT group pre-check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  // DB-level admin verification
  return ddb.get({
    key: { teamId, userId: ctx.identity.sub },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const membership = ctx.result;
  const isSuperadmin = (ctx.identity.claims["cognito:groups"] || []).includes("superadmin");

  if (!membership && !isSuperadmin) {
    util.error("You are not a member of this team", "UnauthorizedError");
  }
  if (membership && membership.role !== "admin" && !isSuperadmin) {
    util.error("Only team admins can remove members", "UnauthorizedError");
  }

  // Stash for pipeline step 2
  ctx.stash.teamId = ctx.args.teamId;
  ctx.stash.targetUserId = ctx.args.userId;
  return true;
}
