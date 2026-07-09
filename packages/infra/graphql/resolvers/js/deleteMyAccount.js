/**
 * Mutation.deleteMyAccount — invoke the cascading-deletion Lambda.
 *
 * Bound to a Lambda data source (`delete-account.ts`). The handler reads only
 * the caller identity (never client args) and purges every table + the Cognito
 * user, so the payload carries just `ctx.identity`. Returns Boolean.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "Invoke",
    payload: { identity: ctx.identity },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
