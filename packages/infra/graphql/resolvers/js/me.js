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
  if (!ctx.result) {
    util.error("User profile not found", "NotFoundError");
  }
  return ctx.result;
}
