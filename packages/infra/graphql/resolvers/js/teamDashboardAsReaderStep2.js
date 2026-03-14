/**
 * Query.teamDashboardAsReader — Pipeline Step 2.
 * Fetch TeamStats aggregate for the authorized team and assemble the
 * TeamDashboard response. This is the same data shape as teamDashboard.
 *
 * If the previous step returned null (not authorized), short-circuit.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  // If authorization failed, short-circuit
  if (!ctx.stash.targetTeam) {
    return { payload: null };
  }

  const teamId = ctx.stash.targetTeamId;
  const period = ctx.stash.period;

  // Fetch the TeamStats aggregate for this team + period
  return ddb.get({
    key: {
      teamId,
      sk: `stats#${period}`,
    },
  });
}

export function response(ctx) {
  if (!ctx.stash.targetTeam) {
    return null;
  }

  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const team = ctx.stash.targetTeam;
  const stats = ctx.result;

  // Assemble TeamDashboard response
  // NOTE: As a reader, the dashboard is read-only — no inviteCode, no raw session data
  const dashboard = {
    team: {
      teamId: team.teamId,
      teamName: team.teamName,
      teamSlug: team.teamSlug,
      logoUrl: team.logoUrl || null,
      inviteCode: null, // Readers cannot see invite codes
      memberCount: team.memberCount || 0,
      settings: team.settings || {},
      members: [], // Readers do not see individual members
      currentChallenge: team.currentChallenge || null,
    },
    period: ctx.stash.period,
    aggregate: stats
      ? {
          totalSessions: stats.totalSessions || 0,
          totalPrompts: stats.totalPrompts || 0,
          totalInputTokens: stats.totalInputTokens || 0,
          totalOutputTokens: stats.totalOutputTokens || 0,
          totalEstimatedCost: stats.totalEstimatedCost || 0,
          activeMemberCount: stats.activeMemberCount || 0,
          avgSessionsPerMember: stats.avgSessionsPerMember || 0,
          avgCostPerMember: stats.avgCostPerMember || 0,
        }
      : null,
    leaderboard: stats ? stats.leaderboard || null : null,
    memberCards: [], // Readers do not see individual member cards
    chemistry: stats ? stats.chemistry || null : null,
    superlatives: stats ? stats.superlatives || [] : [],
    projectSummary: stats ? stats.projectSummary || [] : [],
    computedAt: stats ? stats.computedAt || 0 : 0,
  };

  return dashboard;
}
