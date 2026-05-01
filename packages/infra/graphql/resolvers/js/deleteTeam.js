/**
 * Mutation.deleteTeam — Delete a team (admin only).
 * Verifies admin role against TeamMemberships table.
 * Cascading delete: removes team, all memberships, and related data.
 *
 * Pipeline resolver:
 *   Step 1: Verify admin role via DB lookup (this function)
 *   Step 2: Delete team and memberships (batch delete)
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
    util.error("Only team admins can delete a team", "UnauthorizedError");
  }

  // Stash teamId for pipeline step 2 (cascading delete)
  ctx.stash.teamId = ctx.args.teamId;
  return true;
}
