/**
 * Mutation.unlinkAccount — Pipeline Step 2.
 * Step 1 fetched the profile (ctx.prev.result). Remove the target account and
 * write the pruned list back. Returns Boolean!.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const profile = ctx.prev.result || {};
  const accounts = (profile.accounts || []).filter(
    (a) => a.accountId !== ctx.args.accountId,
  );
  return ddb.update({
    key: { userId: ctx.identity.sub },
    update: { accounts, updatedAt: util.time.nowEpochMilliSeconds() },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
