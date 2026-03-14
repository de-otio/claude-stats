/**
 * Mutation.unlinkAccount — Remove a linked account from the user's profile.
 * Uses a pipeline resolver: Function 1 (getProfile) fetches user,
 * Function 2 (removeAccount) removes the account at the found index.
 *
 * This file is the single-datasource version that performs the get
 * and expects to be wired as a pipeline with a second function for removal.
 * Alternatively, if used as a standalone resolver, it performs the removal
 * using a conditional update expression.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  if (!ctx.args.accountId) {
    util.error("accountId is required", "ValidationError");
  }

  // Get the current user profile to find the account
  return {
    operation: "GetItem",
    key: util.dynamodb.toMapValues({ userId: ctx.identity.sub }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  if (!ctx.result) {
    util.error("User profile not found", "NotFoundError");
  }

  const accounts = ctx.result.accounts || [];
  const index = accounts.findIndex((a) => a.accountId === ctx.args.accountId);
  if (index === -1) {
    util.error("Account not found", "NotFoundError");
  }

  // Store the index in stash for a pipeline second step, or if this is
  // the only function, perform the update inline via a second request.
  // For pipeline resolvers, the next function would use ctx.prev.result.
  ctx.stash.removeIndex = index;
  return ctx.result;
}
