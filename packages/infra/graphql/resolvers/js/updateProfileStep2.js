/**
 * Mutation.updateProfile — Pipeline Step 2 (UserProfiles).
 * Merge the provided fields into the profile from Step 1 and write. Top-level
 * fields SET directly; `preferences` is merged with the existing map and the
 * whole map is SET (avoids the dotted-path helper bug + the missing-map case).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const input = ctx.args.input;
  const prev = ctx.prev.result || {};
  const update = { updatedAt: util.time.nowEpochMilliSeconds() };

  if (input.displayName !== undefined) update.displayName = input.displayName;
  if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;
  if (input.personalityType !== undefined)
    update.personalityType = input.personalityType;

  const prefProvided =
    input.timezone !== undefined ||
    input.weekStartDay !== undefined ||
    input.defaultShareLevel !== undefined ||
    input.streakWeekendGrace !== undefined;

  if (prefProvided) {
    const prefs = { ...(prev.preferences || {}) };
    if (input.timezone !== undefined) prefs.timezone = input.timezone;
    if (input.weekStartDay !== undefined) prefs.weekStartDay = input.weekStartDay;
    if (input.defaultShareLevel !== undefined)
      prefs.defaultShareLevel = input.defaultShareLevel;
    if (input.streakWeekendGrace !== undefined)
      prefs.streakWeekendGrace = input.streakWeekendGrace;
    // `ddb.update` treats a nested-object value as nested-path SETs
    // (SET preferences.timezone = ...), which fails when the preferences map
    // doesn't exist yet (new user). `replace` forces SET of the whole map.
    update.preferences = ddb.operations.replace(prefs);
  }

  return ddb.update({ key: { userId: ctx.identity.sub }, update });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
