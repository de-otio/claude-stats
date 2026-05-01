/**
 * Query.team — Get a team by teamId.
 * Requires team membership (JWT group check).
 * Filters inviteCode unless the caller is a team admin or superadmin.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // JWT group check for team membership
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isMember =
    groups.includes(`team:${teamId}:member`) ||
    groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isMember && !isSuperadmin) {
    util.unauthorized();
  }

  // Stash role info for response filtering
  ctx.stash.isAdmin =
    groups.includes(`team:${teamId}:admin`) || isSuperadmin;

  return ddb.get({
    key: { teamId },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  if (!ctx.result) {
    util.error("Team not found", "NotFoundError");
  }

  const team = ctx.result;

  // Only admins and superadmins can see the invite code
  if (!ctx.stash.isAdmin) {
    team.inviteCode = null;
  }

  return team;
}
