/**
 * User.achievements — nested field resolver.
 * Queries the Achievements table (PK userId) for the parent User.
 * Applies to any User-typed field (e.g. `me { achievements }`).
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const userId = ctx.source.userId;
  if (!userId) {
    runtime.earlyReturn([]);
  }
  return ddb.query({ query: { userId: { eq: userId } } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items || [];
}
