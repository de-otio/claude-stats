/**
 * Query.teamsComparison — Pipeline Step 3.
 * Batch-get the latest TeamStats aggregate for each visible team
 * and assemble the final [TeamComparisonEntry] response.
 *
 * TeamStats items have PK = teamId, SK = "stats#{period}".
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const visibleTeams = ctx.stash.visibleTeams || [];
  const period = ctx.stash.period;

  if (visibleTeams.length === 0) {
    // Nothing to fetch — short circuit
    return { payload: [] };
  }

  // Build BatchGetItem request for TeamStats table
  const keys = visibleTeams.map((team) => ({
    teamId: team.teamId,
    sk: `stats#${period}`,
  }));

  return {
    operation: "BatchGetItem",
    tables: {
      TeamStats: {
        keys: keys.map((k) =>
          util.dynamodb.toMapValues(k)
        ),
      },
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const visibleTeams = ctx.stash.visibleTeams || [];

  // Build a lookup map from teamId → aggregate stats
  const statsMap = {};
  const statsItems =
    (ctx.result && ctx.result.data && ctx.result.data.TeamStats) || [];
  for (const stat of statsItems) {
    statsMap[stat.teamId] = {
      totalSessions: stat.totalSessions || 0,
      totalPrompts: stat.totalPrompts || 0,
      totalInputTokens: stat.totalInputTokens || 0,
      totalOutputTokens: stat.totalOutputTokens || 0,
      totalEstimatedCost: stat.totalEstimatedCost || 0,
      activeMemberCount: stat.activeMemberCount || 0,
      avgSessionsPerMember: stat.avgSessionsPerMember || 0,
      avgCostPerMember: stat.avgCostPerMember || 0,
    };
  }

  // Assemble TeamComparisonEntry for each visible team
  return visibleTeams.map((team) => ({
    teamId: team.teamId,
    teamName: team.teamName,
    teamSlug: team.teamSlug,
    logoUrl: team.logoUrl || null,
    memberCount: team.memberCount || 0,
    aggregate: statsMap[team.teamId] || null,
  }));
}
