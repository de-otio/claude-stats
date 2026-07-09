/**
 * Mutation.updateAccountSharing — Pipeline Step 2.
 * Step 1 fetched the profile (ctx.prev.result). Apply the sharing flag to the
 * matching account, write the whole list back, return the updated LinkedAccount.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const profile = ctx.prev.result || {};
  const accounts = (profile.accounts || []).map((a) => {
    if (a.accountId !== ctx.args.accountId) {
      return a;
    }
    const next = { ...a };
    if (ctx.args.shareWithTeams !== undefined && ctx.args.shareWithTeams !== null) {
      next.shareWithTeams = ctx.args.shareWithTeams;
    }
    return next;
  });
  ctx.stash.updated = accounts.find((a) => a.accountId === ctx.args.accountId);
  return ddb.update({
    key: { userId: ctx.identity.sub },
    update: { accounts, updatedAt: util.time.nowEpochMilliSeconds() },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.stash.updated;
}
