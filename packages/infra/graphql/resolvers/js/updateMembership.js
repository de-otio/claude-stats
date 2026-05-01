/**
 * Mutation.updateMembership — Update the caller's own membership in a team.
 * Can update displayName, shareLevel, and sharedAccounts.
 * Ownership enforced: always operates on ctx.identity.sub.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId, input } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // Validate input limits
  if (input.displayName && input.displayName.length > 50) {
    util.error("displayName must be 50 characters or less", "ValidationError");
  }

  // Build update expression from provided fields
  const update = { updatedAt: util.time.nowEpochMilliSeconds() };

  if (input.displayName !== undefined) update.displayName = input.displayName;
  if (input.shareLevel !== undefined) update.shareLevel = input.shareLevel;
  if (input.sharedAccounts !== undefined) update.sharedAccounts = input.sharedAccounts;

  return ddb.update({
    key: { teamId, userId: ctx.identity.sub },
    update,
    condition: {
      // Verify membership exists (stale JWT protection)
      teamId: { attributeExists: true },
    },
  });
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("You are not a member of this team", "UnauthorizedError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
