/**
 * Mutation.joinInterTeamChallenge — Pipeline Step 4 (InterTeamChallenges).
 * Append the joining team to the challenge's teams map and return the updated
 * challenge in GraphQL shape.
 *
 * `teams` is a MAP keyed by teamId. A nested SET on a dynamic key cannot use
 * the ddb.update helper (a dotted key is written as a LITERAL attribute name),
 * so this uses a raw UpdateItem with a `#teams.#tid` path. The `teams` map
 * always exists (created with the founding team), so the parent-map guard is
 * satisfied. The `attribute_not_exists(#teams.#tid)` condition makes the join
 * idempotent-safe: a team already in the challenge is rejected.
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
  const entry = {
    teamName: ctx.stash.teamName,
    teamSlug: ctx.stash.teamSlug,
    logoUrl: ctx.stash.logoUrl,
    score: 0,
    rank: 0,
    joinedAt: now,
  };

  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ challengeId: ctx.stash.challengeId }),
    update: {
      expression: "SET #teams.#tid = :entry, #ua = :now",
      expressionNames: {
        "#teams": "teams",
        "#tid": ctx.stash.teamId,
        "#ua": "updatedAt",
      },
      expressionValues: util.dynamodb.toMapValues({ ":entry": entry, ":now": now }),
    },
    condition: {
      expression: "attribute_not_exists(#teams.#tid)",
      expressionNames: { "#teams": "teams", "#tid": ctx.stash.teamId },
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("This team has already joined the challenge", "ValidationError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return toGraphqlChallenge(ctx.result);
}
