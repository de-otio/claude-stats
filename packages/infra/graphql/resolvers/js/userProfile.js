/**
 * Query.userProfile — Get a user's public profile.
 * Returns UserPublicProfile (no sensitive fields like accounts, preferences, email).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  if (!ctx.args.userId) {
    util.error("userId is required", "ValidationError");
  }
  return ddb.get({
    key: { userId: ctx.args.userId },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  if (!ctx.result) {
    return null;
  }
  // Return only public fields — strip sensitive data
  const user = ctx.result;
  return {
    userId: user.userId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    personalityType: user.personalityType,
    streak: user.streak,
    recentAchievements: user.recentAchievements,
  };
}
