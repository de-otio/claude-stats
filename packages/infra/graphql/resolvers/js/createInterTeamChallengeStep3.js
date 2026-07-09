/**
 * Mutation.createInterTeamChallenge — Pipeline Step 3 (InterTeamChallenges).
 * Write the challenge row and return it in GraphQL shape.
 *
 * Storage vs. GraphQL shape:
 *   - `teams` is stored as a MAP keyed by teamId ({ [teamId]: { teamName,
 *     teamSlug, logoUrl, score, rank, joinedAt } }) to match the
 *     inter-team-scoring worker, which reads/writes teams[teamId]. GraphQL
 *     exposes `teams` as an ARRAY of InterTeamChallengeTeam, so the response
 *     projects the map to an array.
 *   - `status` is stored lowercase and uppercased at the enum boundary.
 *
 * Times (startTime/endTime) are AWSTimestamp = epoch SECONDS, matching the
 * worker's `now = floor(Date.now()/1000)` comparisons. A future startTime is
 * created "pending"; the worker flips it to "active" at startTime.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

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
  const challengeId = util.autoId();
  const inviteCode = util.autoId().substring(0, 8);
  const status = ctx.stash.startTime <= now ? "active" : "pending";

  const teams = {};
  teams[ctx.stash.teamId] = {
    teamName: ctx.stash.teamName,
    teamSlug: ctx.stash.teamSlug,
    logoUrl: ctx.stash.logoUrl,
    score: 0,
    rank: 0,
    joinedAt: now,
  };

  const item = {
    challengeId,
    name: ctx.stash.name,
    metric: ctx.stash.metric,
    startTime: ctx.stash.startTime,
    endTime: ctx.stash.endTime,
    status,
    creatingTeamId: ctx.stash.teamId,
    inviteCode,
    teams,
    createdAt: now,
    updatedAt: now,
    // TTL: purge 90 days after the challenge ends (keeps it available for history).
    expiresAt: ctx.stash.endTime + 90 * 24 * 60 * 60,
  };

  return ddb.put({
    key: { challengeId },
    item,
    condition: { challengeId: { attributeExists: false } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return toGraphqlChallenge(ctx.result);
}
