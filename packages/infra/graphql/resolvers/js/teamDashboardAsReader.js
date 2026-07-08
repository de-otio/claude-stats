/**
 * Query.teamDashboardAsReader — Read another team's dashboard.
 * Returns the same data as teamDashboard, but only if the caller's team
 * is listed in the target team's dashboardReaders array.
 *
 * Authorization flow:
 *   1. Get target team from Teams table
 *   2. Determine caller's teamId(s) from JWT groups
 *   3. Check if any of the caller's teamIds appear in target.dashboardReaders
 *   4. If authorized, return team dashboard data; otherwise return null
 *
 * This is a pipeline resolver:
 *   Step 1 (this file): Fetch the target team and check reader authorization
 *   Step 2: Fetch TeamStats aggregate for the period (same as teamDashboard)
 *
 * NOTE: Per resolver strategy, this is backed by a Lambda in production.
 * This JS resolver handles the authorization check and DynamoDB read.
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

  ctx.stash.targetTeamId = teamId;
  ctx.stash.period = period;

  // Extract caller's team memberships from JWT groups
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const callerTeamIds = [];
  groups.forEach((group) => {
    // Groups follow pattern: team:{teamId}:member or team:{teamId}:admin.
    // Parsed via split rather than a regex literal — the APPSYNC_JS runtime
    // bans regex literals (no-regex). teamId contains no ":", so a 3-part
    // split is equivalent to the original /^team:([^:]+):(member|admin)$/.
    const parts = group.split(":");
    if (
      parts.length === 3 &&
      parts[0] === "team" &&
      (parts[2] === "member" || parts[2] === "admin")
    ) {
      callerTeamIds.push(parts[1]);
    }
  });
  ctx.stash.callerTeamIds = callerTeamIds;

  // Fetch the target team to check dashboardReaders
  return ddb.get({
    key: { teamId },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  if (!ctx.result) {
    // Target team not found
    return null;
  }

  const targetTeam = ctx.result;
  const callerTeamIds = ctx.stash.callerTeamIds || [];

  // Check that the target team has PUBLIC_DASHBOARD visibility
  const visibility =
    targetTeam.settings && targetTeam.settings.crossTeamVisibility;
  if (visibility !== "PUBLIC_DASHBOARD") {
    return null;
  }

  // Check if any of the caller's teams are in dashboardReaders
  const readers = targetTeam.dashboardReaders || [];
  const isAuthorized = callerTeamIds.some((tid) => readers.includes(tid));

  if (!isAuthorized) {
    return null;
  }

  // Stash the team for downstream pipeline steps
  ctx.stash.targetTeam = targetTeam;

  return targetTeam;
}
