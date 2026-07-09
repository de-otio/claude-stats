/**
 * Mutation.joinTeam — Pipeline Step 3 (Teams).
 * Increment memberCount and return the Team. Non-atomic w.r.t. Step 2 (the
 * membership write); a failure here can leave the count stale — acceptable.
 * The joiner is a member (not admin), so the invite code is hidden.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId: ctx.stash.teamId }),
    update: {
      expression: "SET #mc = #mc + :one, #ua = :now",
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
  const team = ctx.result;
  if (team) {
    team.inviteCode = null;
  }
  return team;
}
