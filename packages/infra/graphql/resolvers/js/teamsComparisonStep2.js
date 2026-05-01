/**
 * Query.teamsComparison — Pipeline Step 2.
 * Query TeamsByVisibility GSI for PUBLIC_DASHBOARD teams and merge with
 * PUBLIC_STATS results from Step 1.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.query({
    query: { crossTeamVisibility: { eq: "PUBLIC_DASHBOARD" } },
    index: "TeamsByVisibility",
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const publicDashboardTeams = ctx.result.items || [];
  const publicStatsTeams = ctx.stash.publicStatsTeams || [];

  // Merge and deduplicate by teamId
  const seen = new Set();
  const allTeams = [];

  for (const team of [...publicStatsTeams, ...publicDashboardTeams]) {
    if (!seen.has(team.teamId)) {
      seen.add(team.teamId);
      allTeams.push(team);
    }
  }

  ctx.stash.visibleTeams = allTeams;
  return allTeams;
}
