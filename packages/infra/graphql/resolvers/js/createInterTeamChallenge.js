/**
 * Mutation.createInterTeamChallenge — Pipeline Step 1 (TeamMemberships).
 * Create an inter-team challenge owned by `teamId`. Admin of teamId only.
 *
 * Split across three single-table steps so each binds to a data source with
 * the grants it needs:
 *   Step 1 (TeamMemberships): validate input + verify caller is an admin.
 *   Step 2 (Teams):           hydrate the creating team's name/slug/logoUrl.
 *   Step 3 (InterTeamChallenges): write the challenge row.
 *
 * Status/metric are stored LOWERCASE (matches the inter-team-scoring worker,
 * which transitions "pending" -> "active" at startTime and reads status in
 * lowercase). The InterTeamChallengeStatus enum is uppercased at the response
 * boundary in Step 3.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, input } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }
  if (!input || !input.name || input.name.trim().length === 0) {
    util.error("name is required", "ValidationError");
  }
  if (!input.metric || input.metric.trim().length === 0) {
    util.error("metric is required", "ValidationError");
  }
  if (input.endTime <= input.startTime) {
    util.error("endTime must be after startTime", "ValidationError");
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
  const isSuperadmin = (ctx.identity.claims["cognito:groups"] || []).includes(
    "superadmin",
  );
  if (!membership && !isSuperadmin) {
    util.error("You are not a member of this team", "UnauthorizedError");
  }
  if (membership && membership.role !== "admin" && !isSuperadmin) {
    util.error(
      "Only team admins can create inter-team challenges",
      "UnauthorizedError",
    );
  }

  // Stash the validated inputs for Step 2 (team hydrate) + Step 3 (write).
  ctx.stash.teamId = ctx.args.teamId;
  ctx.stash.name = ctx.args.input.name.trim();
  ctx.stash.metric = ctx.args.input.metric.trim();
  ctx.stash.startTime = ctx.args.input.startTime;
  ctx.stash.endTime = ctx.args.input.endTime;
  return membership;
}
