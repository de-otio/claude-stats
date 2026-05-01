/**
 * Query.myAchievements — Get all achievements for the authenticated user.
 * Queries the Achievements table with PK = userId (ctx.identity.sub).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.query({
    query: { userId: { eq: ctx.identity.sub } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items || [];
}
