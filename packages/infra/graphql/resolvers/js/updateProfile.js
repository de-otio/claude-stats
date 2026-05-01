/**
 * Mutation.updateProfile — Update the authenticated user's own profile.
 * Ownership enforced: always operates on ctx.identity.sub.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const input = ctx.args.input;

  // Validate input limits
  if (input.displayName && input.displayName.length > 50) {
    util.error("displayName must be 50 characters or less", "ValidationError");
  }
  if (input.weekStartDay !== undefined && (input.weekStartDay < 0 || input.weekStartDay > 1)) {
    util.error("weekStartDay must be 0 (Sun) or 1 (Mon)", "ValidationError");
  }

  // Build update expression from provided fields
  const update = { updatedAt: util.time.nowEpochMilliSeconds() };

  if (input.displayName !== undefined) update.displayName = input.displayName;
  if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;
  if (input.personalityType !== undefined) update.personalityType = input.personalityType;

  // Nested preferences updates
  if (input.timezone !== undefined) update["preferences.timezone"] = input.timezone;
  if (input.weekStartDay !== undefined) update["preferences.weekStartDay"] = input.weekStartDay;
  if (input.defaultShareLevel !== undefined) update["preferences.defaultShareLevel"] = input.defaultShareLevel;
  if (input.streakWeekendGrace !== undefined) update["preferences.streakWeekendGrace"] = input.streakWeekendGrace;

  return ddb.update({
    key: { userId: ctx.identity.sub },
    update,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
