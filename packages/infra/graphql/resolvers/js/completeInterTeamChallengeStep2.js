/**
 * Mutation.completeInterTeamChallenge — Pipeline Step 2 (TeamMemberships).
 * Verify the caller is an admin of the challenge's creatingTeamId. The JWT
 * group pre-check runs here (not in Step 1) because creatingTeamId is only
 * known after Step 1 read the challenge.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const creatingTeamId = ctx.stash.creatingTeamId;

  // JWT group pre-check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${creatingTeamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");
  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  // DB-level admin verification (stale JWT protection)
  return ddb.get({
    key: { teamId: creatingTeamId, userId: ctx.identity.sub },
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
    util.error("You are not a member of the creating team", "UnauthorizedError");
  }
  if (membership && membership.role !== "admin" && !isSuperadmin) {
    util.error(
      "Only admins of the creating team can complete this challenge",
      "UnauthorizedError",
    );
  }
  return membership;
}
