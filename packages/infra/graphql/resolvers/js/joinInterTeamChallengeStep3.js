/**
 * Mutation.joinInterTeamChallenge — Pipeline Step 3 (InterTeamChallenges).
 * Find the challenge by inviteCode. There is no GSI on inviteCode (the only
 * GSI is InterTeamChallengesByStatus), so use a filtered scan — mirrors the
 * joinTeam invite-code lookup on the Teams table (small table, acceptable).
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    operation: "Scan",
    filter: {
      expression: "#code = :code",
      expressionNames: { "#code": "inviteCode" },
      expressionValues: util.dynamodb.toMapValues({
        ":code": ctx.stash.inviteCode,
      }),
    },
    // NO `limit`: DynamoDB applies limit to items EXAMINED, not items MATCHED,
    // so `limit:1` + a filter examines one arbitrary row and usually misses the
    // target once the table has >1 row. Scan a full page and let the filter
    // select. (inviteCode has no GSI; the table is small + TTL'd.)
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const items = ctx.result.items || [];
  if (items.length === 0) {
    util.error("Invalid invite code", "ValidationError");
  }
  const challenge = items[0];
  if (challenge.status === "completed") {
    util.error("This challenge has already ended", "ValidationError");
  }
  ctx.stash.challengeId = challenge.challengeId;
  return challenge;
}
