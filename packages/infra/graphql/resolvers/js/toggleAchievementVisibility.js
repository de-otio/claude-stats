/**
 * Mutation.toggleAchievementVisibility — Update the shared flag on an achievement.
 * Ownership enforced: PK = ctx.identity.sub ensures the user can only modify their own achievements.
 *
 * Args:
 *   achievementId: ID!
 *   shared: Boolean!
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const userId = ctx.identity.sub;
  const { achievementId, shared } = ctx.args;

  return ddb.update({
    key: { userId, achievementId },
    update: {
      shared,
      updatedAt: util.time.nowEpochSeconds(),
    },
    condition: {
      userId: { eq: userId },
    },
  });
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("Achievement not found or not owned by you", "NotFoundError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
