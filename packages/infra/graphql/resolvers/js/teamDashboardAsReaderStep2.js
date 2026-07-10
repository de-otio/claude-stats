/**
 * Query.teamDashboardAsReader — Pipeline Step 2.
 * Assemble the read-only TeamDashboard for an authorized dashboard reader.
 *
 * TeamStats has NO team-level rollup row — the aggregate-stats worker writes
 * one row PER MEMBER, keyed PK=teamId, SK (attribute "period#userId") =
 * "<period>#<userId>", each carrying a MemberStats `stats` blob. So we query
 * begins_with "<period>#" and SUM the members into a TeamAggregate here.
 *
 * The reader view is deliberately limited: no member list, no member cards,
 * no leaderboard/chemistry/superlatives (those need per-member identity the
 * reader isn't entitled to). It surfaces the team-wide totals + project roll-up.
 *
 * If the previous step returned null (not authorized), short-circuit.
 */
import { util, runtime } from "@aws-appsync/utils";

export function request(ctx) {
  // If authorization failed, short-circuit. This step is bound to a DynamoDB
  // data source, so a `{payload}` return is invalid ("$[operation] not found");
  // runtime.earlyReturn skips the data-source call and returns the value.
  if (!ctx.stash.targetTeam) {
    runtime.earlyReturn(null);
  }

  const teamId = ctx.stash.targetTeamId;
  const period = ctx.stash.period;

  // Fan out to every member row for this team + period. The sort key attribute
  // is literally named "period#userId"; the `ddb.query` sugar would emit the
  // invalid placeholder "#period#userId" (a second '#'), so use the raw Query
  // form with a clean "#sk" placeholder mapped to the real attribute name.
  return {
    operation: "Query",
    query: {
      expression: "#teamId = :teamId AND begins_with(#sk, :skPrefix)",
      expressionNames: { "#teamId": "teamId", "#sk": "period#userId" },
      expressionValues: util.dynamodb.toMapValues({
        ":teamId": teamId,
        ":skPrefix": `${period}#`,
      }),
    },
    limit: 1000,
  };
}

export function response(ctx) {
  if (!ctx.stash.targetTeam) {
    return null;
  }

  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const team = ctx.stash.targetTeam;
  const memberEntries = ctx.result.items ?? [];

  // Sum per-member MemberStats blobs into the team-wide TeamAggregate.
  let totalSessions = 0;
  let totalPrompts = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCost = 0;
  let activeMemberCount = 0;
  let latestComputedAt = 0;
  const projectMap = {};

  memberEntries.forEach((entry) => {
    const stats = entry.stats;
    if (!stats) {
      return;
    }
    activeMemberCount += 1;
    totalSessions += stats.sessions ?? 0;
    totalPrompts += stats.prompts ?? 0;
    totalInputTokens += stats.inputTokens ?? 0;
    totalOutputTokens += stats.outputTokens ?? 0;
    totalEstimatedCost += stats.estimatedCost ?? 0;

    if ((entry.computedAt ?? 0) > latestComputedAt) {
      latestComputedAt = entry.computedAt;
    }

    // Aggregate the project roll-up (members sharing "minimal" have none).
    if (stats.projectBreakdown) {
      stats.projectBreakdown.forEach((p) => {
        const pid = p.projectId ?? "(unlinked)";
        if (!projectMap[pid]) {
          projectMap[pid] = {
            projectId: pid,
            sessions: 0,
            prompts: 0,
            estimatedCost: 0,
          };
        }
        projectMap[pid].sessions += p.sessions ?? 0;
        projectMap[pid].prompts += p.prompts ?? 0;
        projectMap[pid].estimatedCost += p.estimatedCost ?? 0;
      });
    }
  });

  const projectSummary = Object.values(projectMap);
  projectSummary.forEach((p) => {
    p.estimatedCost = Math.round(p.estimatedCost * 100) / 100;
  });

  const aggregate =
    activeMemberCount > 0
      ? {
          totalSessions,
          totalPrompts,
          totalInputTokens,
          totalOutputTokens,
          totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100,
          activeMemberCount,
          avgSessionsPerMember:
            Math.round((totalSessions / activeMemberCount) * 100) / 100,
          avgCostPerMember:
            Math.round((totalEstimatedCost / activeMemberCount) * 100) / 100,
        }
      : null;

  // Assemble TeamDashboard response.
  // NOTE: As a reader, the dashboard is read-only — no inviteCode, no members.
  return {
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
    aggregate,
    leaderboard: null, // Reader view omits per-member identity
    memberCards: [],
    chemistry: null,
    superlatives: [],
    projectSummary,
    computedAt: latestComputedAt,
  };
}
