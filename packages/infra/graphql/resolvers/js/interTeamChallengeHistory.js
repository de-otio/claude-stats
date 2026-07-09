/**
 * Query.interTeamChallengeHistory — Completed inter-team challenges.
 * Queries the InterTeamChallengesByStatus GSI (PK status, SK endTime) for
 * status = "completed" (stored lowercase), capped by an optional `limit`.
 * Any authenticated user may read.
 *
 * Results are returned UNSORTED (the GSI orders by endTime; the client ranks /
 * orders as it sees fit — no comparator sort in-resolver per APPSYNC_JS rules).
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
  const query = {
    query: { status: { eq: "completed" } },
    index: "InterTeamChallengesByStatus",
    // GSI SK is endTime; scan descending so the most-recently-ended challenges
    // come first (matters once `limit` truncates the result).
    scanIndexForward: false,
  };
  if (ctx.args.limit) {
    query.limit = ctx.args.limit;
  }
  return ddb.query(query);
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return (ctx.result.items || []).map((item) => toGraphqlChallenge(item));
}
