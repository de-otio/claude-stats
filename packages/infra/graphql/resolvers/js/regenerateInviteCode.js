/**
 * Mutation.regenerateInviteCode — Generate a new invite code (admin only).
 * Verifies admin role against TeamMemberships table, then updates the
 * Teams table with a new invite code and expiry.
 *
 * Pipeline resolver:
 *   Step 1: Verify admin role (this function)
 *   Step 2: Update invite code on Teams table
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
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
    util.error("Only team admins can regenerate invite codes", "UnauthorizedError");
  }

  // Generate new invite code
  const newCode = util.autoId().substring(0, 12);
  ctx.stash.teamId = ctx.args.teamId;
  ctx.stash.inviteCode = newCode;
  ctx.stash.inviteCodeExpiresAt =
    Math.round(util.time.nowEpochMilliSeconds() / 1000) + 30 * 24 * 60 * 60;

  return newCode;
}
