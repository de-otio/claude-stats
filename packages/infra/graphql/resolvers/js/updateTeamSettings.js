/**
 * Mutation.updateTeamSettings — Update team settings (admin only).
 * Verifies admin role against TeamMemberships table (not just JWT).
 *
 * Pipeline resolver:
 *   Step 1: Get caller's membership to verify admin role (this function)
 *   Step 2: Update the Team's settings
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, input } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // Validate input limits
  if (input.minMembersForAggregates !== undefined) {
    if (input.minMembersForAggregates < 2 || input.minMembersForAggregates > 10) {
      util.error("minMembersForAggregates must be between 2 and 10", "ValidationError");
    }
  }

  // JWT group pre-check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  // DB-level admin verification (stale JWT protection)
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
    util.error("Only team admins can update settings", "UnauthorizedError");
  }

  // Stash input for pipeline step 2 (update Team settings)
  ctx.stash.teamId = ctx.args.teamId;
  ctx.stash.settingsInput = ctx.args.input;
  return membership;
}
