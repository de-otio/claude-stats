/**
 * Mutation.leaveTeam — Pipeline Step 3 (Teams).
 * Decrement memberCount and return Boolean!.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId: ctx.stash.teamId }),
    update: {
      expression: "SET #mc = #mc - :one, #ua = :now",
      expressionNames: { "#mc": "memberCount", "#ua": "updatedAt" },
      expressionValues: util.dynamodb.toMapValues({
        ":one": 1,
        ":now": util.time.nowEpochMilliSeconds(),
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
