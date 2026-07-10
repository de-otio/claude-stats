/**
 * Query.teamsComparison — Pipeline Step 3.
 * Assemble the final [TeamComparisonEntry] for every visible team.
 *
 * TeamStats has NO team-level rollup row — it holds one row PER MEMBER, keyed
 * PK=teamId, SK "period#userId". A BatchGetItem (exact keys) therefore CANNOT
 * express "all members of team X for period P". Instead we query the
 * StatsByPeriod GSI (PK=period, SK=teamId#userId) ONCE for the period — that
 * returns every member row across every team — then group by teamId and sum
 * into a TeamAggregate, keeping only the visible teams.
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const visibleTeams = ctx.stash.visibleTeams || [];
  const period = ctx.stash.period;

  if (visibleTeams.length === 0) {
    // Nothing to fetch. This step is bound to a DynamoDB data source, so a
    // `{payload}` return is invalid ("$[operation] not found"); earlyReturn
    // skips the query and returns [] as the final result.
    runtime.earlyReturn([]);
  }

  // One query over the period partition of the StatsByPeriod GSI. The GSI
  // projects [stats, displayName, shareLevel]; the base-table key attribute
  // `teamId` is always projected too, so each item is attributable to a team.
  return ddb.query({
    query: { period: { eq: period } },
    index: "StatsByPeriod",
    limit: 1000,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const visibleTeams = ctx.stash.visibleTeams || [];
  const memberEntries = ctx.result.items ?? [];

  // Accumulate per-team totals from the member rows.
  const byTeam = {};
  memberEntries.forEach((entry) => {
    const teamId = entry.teamId;
    const stats = entry.stats;
    if (!teamId || !stats) {
      return;
    }
    if (!byTeam[teamId]) {
      byTeam[teamId] = {
        totalSessions: 0,
        totalPrompts: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        activeMemberCount: 0,
      };
    }
    const t = byTeam[teamId];
    t.activeMemberCount += 1;
    t.totalSessions += stats.sessions ?? 0;
    t.totalPrompts += stats.prompts ?? 0;
    t.totalInputTokens += stats.inputTokens ?? 0;
    t.totalOutputTokens += stats.outputTokens ?? 0;
    t.totalEstimatedCost += stats.estimatedCost ?? 0;
  });

  // Assemble one entry per visible team (null aggregate if it has no rows).
  return visibleTeams.map((team) => {
    const t = byTeam[team.teamId];
    const aggregate =
      t && t.activeMemberCount > 0
        ? {
            totalSessions: t.totalSessions,
            totalPrompts: t.totalPrompts,
            totalInputTokens: t.totalInputTokens,
            totalOutputTokens: t.totalOutputTokens,
            totalEstimatedCost: Math.round(t.totalEstimatedCost * 100) / 100,
            activeMemberCount: t.activeMemberCount,
            avgSessionsPerMember:
              Math.round((t.totalSessions / t.activeMemberCount) * 100) / 100,
            avgCostPerMember:
              Math.round((t.totalEstimatedCost / t.activeMemberCount) * 100) /
              100,
          }
        : null;

    return {
      teamId: team.teamId,
      teamName: team.teamName,
      teamSlug: team.teamSlug,
      logoUrl: team.logoUrl || null,
      memberCount: team.memberCount || 0,
      aggregate,
    };
  });
}
