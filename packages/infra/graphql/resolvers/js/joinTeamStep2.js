/**
 * Mutation.joinTeam — Pipeline Step 2 (TeamMemberships).
 * Step 1 validated the invite code and stashed the team. Create the caller's
 * membership (role "member"), refusing a duplicate join via a not-exists
 * condition. Step 3 bumps memberCount.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const now = util.time.nowEpochMilliSeconds();
  const m = {
    teamId: ctx.stash.teamId,
    userId: ctx.identity.sub,
    role: "member",
    joinedAt: now,
    displayName: ctx.identity.claims.name || ctx.identity.claims.email || "Member",
    shareLevel: "summary",
    sharedAccounts: [],
    updatedAt: now,
  };
  return ddb.put({
    key: { teamId: m.teamId, userId: m.userId },
    item: m,
    condition: { userId: { attributeExists: false } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("You are already a member of this team", "ValidationError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.stash.team;
}
