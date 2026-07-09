/**
 * Query.activeInterTeamChallenges — All currently-active inter-team challenges.
 * Queries the InterTeamChallengesByStatus GSI (PK status, SK endTime) for
 * status = "active" (stored lowercase). Any authenticated user may read.
 *
 * `teams` is stored as a MAP keyed by teamId; each item is projected to the
 * GraphQL ARRAY shape and status is uppercased at the enum boundary.
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
  return ddb.query({
    query: { status: { eq: "active" } },
    index: "InterTeamChallengesByStatus",
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return (ctx.result.items || []).map((item) => toGraphqlChallenge(item));
}
