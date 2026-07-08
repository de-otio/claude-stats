/**
 * Query.me — Get current user's profile.
 * Returns the full User object (including accounts, preferences) for the authenticated user.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.get({
    key: { userId: ctx.identity.sub },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  if (ctx.result) {
    return ctx.result;
  }
  // A newly-authenticated user has a Cognito account but no userProfiles row
  // yet (the row is persisted on first updateProfile). Synthesize a default
  // profile from the JWT claims so `me` never hard-fails for a valid session.
  const claims = ctx.identity.claims ?? {};
  const email = claims.email ?? "";
  return {
    userId: ctx.identity.sub,
    email,
    displayName: claims.name ?? email,
    avatarUrl: null,
    accounts: [],
    preferences: {
      timezone: "UTC",
      weekStartDay: 1,
      defaultShareLevel: "SUMMARY",
      streakWeekendGrace: false,
    },
    personalityType: null,
    streak: {
      currentStreak: 0,
      longestStreak: 0,
      weekendGraceEnabled: false,
      freezeTokensRemaining: 0,
      lastActiveDate: null,
    },
    achievements: [],
  };
}
