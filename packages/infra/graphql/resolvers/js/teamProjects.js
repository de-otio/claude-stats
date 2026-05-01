/**
 * Query.teamProjects — Pipeline Step 1: Verify team membership.
 * Checks that the caller is a member of the requested team via DB lookup
 * on the TeamMemberships table (PK = teamId, SK = userId).
 *
 * Pipeline:
 *   Step 1 (this file): Verify team membership
 *   Step 2: Query TeamStats, aggregate projectBreakdown, return [ProjectStats]
 *
 * Args:
 *   teamId: ID!
 *   period: String!  — ISO week e.g. "2026-W11" or "week"/"month"
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, period } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }
  if (!period) {
    util.error("period is required", "ValidationError");
  }

  if (!ctx.identity || !ctx.identity.sub) {
    util.unauthorized();
  }

  // JWT group pre-check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isMember =
    groups.includes(`team:${teamId}:member`) ||
    groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isMember && !isSuperadmin) {
    util.unauthorized();
  }

  // Stash args for pipeline step 2
  ctx.stash.teamId = teamId;
  ctx.stash.period = period;

  // DB-level membership verification
  return ddb.get({
    key: { teamId, userId: ctx.identity.sub },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const membership = ctx.result;
  const isSuperadmin = (ctx.identity.claims["cognito:groups"] || []).includes(
    "superadmin"
  );

  if (!membership && !isSuperadmin) {
    util.error("You are not a member of this team", "UnauthorizedError");
  }

  // Stash caller's membership for context
  ctx.stash.callerMembership = membership;
  return membership;
}
