/**
 * Mutation.completeInterTeamChallenge — Pipeline Step 3 (InterTeamChallenges).
 * Set status = "completed" (stored lowercase) and return the challenge in
 * GraphQL shape. A raw UpdateItem is used so the GSI (status) partition moves
 * to "completed"; the `<>` guard makes the transition idempotent.
 *
 * NOTE: final scoring/ranking + winner-badge award is the scoring worker's
 * job. This manual completion only flips status; the next worker run (or its
 * final pass) reconciles scores. Ranks already persisted on the row are
 * returned as-is.
 */
import { util } from "@aws-appsync/utils";

/** Storage teams-map -> GraphQL [InterTeamChallengeTeam!]! (+ enum uppercasing). */
function toGraphqlChallenge(item) {
  const teamsMap = item.teams || {};
  const teams = Object.keys(teamsMap).map((tid) => {
    const t = teamsMap[tid];
    return {
      teamId: tid,
      teamName: t.teamName,
      teamSlug: t.teamSlug,
      logoUrl: t.logoUrl || null,
      score: t.score,
      rank: t.rank,
    };
  });
  return {
    challengeId: item.challengeId,
    name: item.name,
    metric: item.metric,
    startTime: item.startTime,
    endTime: item.endTime,
    status: (item.status || "").toUpperCase(),
    creatingTeamId: item.creatingTeamId,
    inviteCode: item.inviteCode || null,
    teams,
  };
}

export function request(ctx) {
  const now = util.time.nowEpochSeconds();
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ challengeId: ctx.stash.challengeId }),
    update: {
      expression: "SET #s = :completed, #ua = :now",
      expressionNames: { "#s": "status", "#ua": "updatedAt" },
      expressionValues: util.dynamodb.toMapValues({
        ":completed": "completed",
        ":now": now,
      }),
    },
    condition: {
      expression: "#s <> :completed",
      expressionNames: { "#s": "status" },
      expressionValues: util.dynamodb.toMapValues({ ":completed": "completed" }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("Challenge is already completed", "ValidationError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return toGraphqlChallenge(ctx.result);
}
