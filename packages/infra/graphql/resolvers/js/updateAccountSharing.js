/**
 * Mutation.updateAccountSharing — Update sharing flags on a linked account.
 * Fetches user profile, finds the account index, and updates the flags.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  if (!ctx.args.accountId) {
    util.error("accountId is required", "ValidationError");
  }

  // Get the current user profile to find the account index
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

  // Apply updates to the found account. Prompt-sharing is not a supported
  // flag (review S6): there is no per-session/per-message content on the
  // org backend to gate, so `sharePrompts` is deleted, not just unused.
  const account = { ...accounts[index] };
  if (ctx.args.shareWithTeams !== undefined) {
    account.shareWithTeams = ctx.args.shareWithTeams;
  }

  // Store updated account for pipeline second step
  ctx.stash.accountIndex = index;
  ctx.stash.updatedAccount = account;
  return account;
}
