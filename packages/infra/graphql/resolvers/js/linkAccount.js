/**
 * Mutation.linkAccount — Add a linked account to the user's profile.
 * Appends to the accounts array on UserProfiles.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const input = ctx.args.input;

  if (!input.accountId || !input.label) {
    util.error("accountId and label are required", "ValidationError");
  }
  if (input.label.length > 30) {
    util.error("label must be 30 characters or less", "ValidationError");
  }

  const account = {
    accountId: input.accountId,
    label: input.label,
    shareWithTeams: input.shareWithTeams,
    sharePrompts: input.sharePrompts || false,
  };

  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ userId: ctx.identity.sub }),
    update: {
      expression: "SET #accounts = list_append(if_not_exists(#accounts, :empty), :newAccount), #updatedAt = :now",
      expressionNames: {
        "#accounts": "accounts",
        "#updatedAt": "updatedAt",
      },
      expressionValues: util.dynamodb.toMapValues({
        ":newAccount": [account],
        ":empty": [],
        ":now": util.time.nowEpochMilliSeconds(),
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // Return the newly linked account from the updated accounts array
  const accounts = ctx.result.accounts || [];
  const linked = accounts.find((a) => a.accountId === ctx.args.input.accountId);
  return linked || accounts[accounts.length - 1];
}
