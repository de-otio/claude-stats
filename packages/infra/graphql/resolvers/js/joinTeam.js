/**
 * Mutation.joinTeam — Join a team using an invite code.
 * Validates the invite code, checks expiry, checks team size (max 50),
 * and creates a new TeamMembership.
 *
 * This is a pipeline resolver:
 *   Step 1: Scan Teams for matching inviteCode (this function)
 *   Step 2: Check memberCount and create membership
 *
 * For a single-datasource resolver, we scan for the invite code first.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const { inviteCode } = ctx.args;
  if (!inviteCode || inviteCode.length === 0) {
    util.error("inviteCode is required", "ValidationError");
  }

  // Scan for the team with this invite code
  // Teams table is small enough that a filtered scan is acceptable here
  return {
    operation: "Scan",
    filter: {
      expression: "#code = :code",
      expressionNames: { "#code": "inviteCode" },
      expressionValues: util.dynamodb.toMapValues({ ":code": inviteCode }),
    },
    limit: 1,
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const items = ctx.result.items || [];
  if (items.length === 0) {
    util.error("Invalid invite code", "ValidationError");
  }

  const team = items[0];

  // Check invite code expiry
  const nowSeconds = Math.round(util.time.nowEpochMilliSeconds() / 1000);
  if (team.inviteCodeExpiresAt && team.inviteCodeExpiresAt < nowSeconds) {
    util.error("Invite code has expired", "ValidationError");
  }

  // Check team size limit
  if (team.memberCount >= 50) {
    util.error("Team has reached the maximum of 50 members", "ValidationError");
  }

  // Stash team info for the pipeline second step (create membership)
  ctx.stash.team = team;
  ctx.stash.teamId = team.teamId;
  return team;
}
