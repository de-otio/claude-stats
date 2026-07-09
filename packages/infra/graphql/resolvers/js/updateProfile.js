/**
 * Mutation.updateProfile — Pipeline Step 1 (UserProfiles).
 * Validate and fetch the current profile so Step 2 can merge nested
 * `preferences` safely (the ddb.update helper cannot do dotted-path nested
 * updates, and a nested SET fails if the preferences map doesn't exist yet).
 * Ownership enforced: always ctx.identity.sub.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const input = ctx.args.input;
  if (input.displayName && input.displayName.length > 50) {
    util.error("displayName must be 50 characters or less", "ValidationError");
  }
  if (
    input.weekStartDay !== undefined &&
    (input.weekStartDay < 0 || input.weekStartDay > 1)
  ) {
    util.error("weekStartDay must be 0 (Sun) or 1 (Mon)", "ValidationError");
  }
  return ddb.get({ key: { userId: ctx.identity.sub } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result || {};
}
