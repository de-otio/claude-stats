/**
 * Mutation.joinInterTeamChallenge — Pipeline Step 1 (TeamMemberships).
 * A team's admin joins an existing inter-team challenge via its inviteCode.
 *
 * Steps:
 *   Step 1 (TeamMemberships):     validate args + verify caller is admin of teamId.
 *   Step 2 (Teams):               hydrate the joining team's name/slug/logoUrl.
 *   Step 3 (InterTeamChallenges): find the challenge by inviteCode (scan).
 *   Step 4 (InterTeamChallenges): append the team to the teams map.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, inviteCode } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }
  if (!inviteCode || inviteCode.length === 0) {
    util.error("inviteCode is required", "ValidationError");
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
      "Only team admins can join inter-team challenges",
      "UnauthorizedError",
    );
  }

  ctx.stash.teamId = ctx.args.teamId;
  ctx.stash.inviteCode = ctx.args.inviteCode;
  return membership;
}
