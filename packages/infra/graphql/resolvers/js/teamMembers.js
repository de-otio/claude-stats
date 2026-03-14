/**
 * Query.teamMembers — List all members of a team.
 * Requires team membership (JWT group check).
 * Queries TeamMemberships table with PK = teamId.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // JWT group check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isMember =
    groups.includes(`team:${teamId}:member`) ||
    groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isMember && !isSuperadmin) {
    util.unauthorized();
  }

  return ddb.query({
    query: { teamId: { eq: teamId } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items || [];
}
