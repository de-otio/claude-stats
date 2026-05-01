/**
 * Query.teamProjectInsights — Pipeline Step 2.
 * Query TeamStats for the team and period, filter entries matching the
 * requested projectId, and aggregate across team members into a
 * ProjectInsights response.
 *
 * TeamStats table layout:
 *   PK: teamId
 *   SK: period#userId  (e.g. "2026-W11#user-abc")
 *   Attributes: period, userId, displayName, shareLevel, stats { ... projectBreakdown [...] }
 *
 * Members with shareLevel = "minimal" have no projectBreakdown — skip them.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const teamId = ctx.stash.teamId;
  const period = ctx.stash.period;

  // Query all member stat entries for this team + period
  // SK begins_with "period#" to get all members for this period
  return ddb.query({
    query: {
      teamId: { eq: teamId },
      sk: { beginsWith: `${period}#` },
    },
    limit: 1000, // Upper bound — typical team has far fewer members
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const projectId = ctx.stash.projectId;
  const period = ctx.stash.period;
  const memberEntries = ctx.result.items ?? [];

  // Aggregates
  let totalSessions = 0;
  let totalPrompts = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  const contributors = [];
  const modelsMap = {};
  const trendMap = {}; // date string → { sessions, prompts, estimatedCost }

  for (const entry of memberEntries) {
    // Skip members with "minimal" share level — they have no projectBreakdown
    if (entry.shareLevel === "minimal") {
      continue;
    }

    const stats = entry.stats;
    if (!stats || !stats.projectBreakdown) {
      continue;
    }

    // Find matching project entries for this member
    const projectEntries = stats.projectBreakdown.filter(
      (p) => p.projectId === projectId
    );

    if (projectEntries.length === 0) {
      continue;
    }

    // Aggregate this member's contribution to the project
    let memberSessions = 0;
    let memberPrompts = 0;

    for (const p of projectEntries) {
      memberSessions += p.sessions ?? 0;
      memberPrompts += p.prompts ?? 0;
      estimatedCost += p.estimatedCost ?? 0;
    }

    totalSessions += memberSessions;
    totalPrompts += memberPrompts;

    // Accumulate tokens from the member's overall stats (proportional to
    // project share) — projectBreakdown does not include token counts,
    // so we estimate based on session ratio
    const memberTotalSessions = stats.sessions ?? 0;
    if (memberTotalSessions > 0) {
      const ratio = memberSessions / memberTotalSessions;
      totalTokens += Math.round(
        ((stats.inputTokens ?? 0) + (stats.outputTokens ?? 0)) * ratio
      );
    }

    // Build contributor entry
    contributors.push({
      displayName: entry.displayName ?? "Unknown",
      sessions: memberSessions,
      prompts: memberPrompts,
    });

    // Collect models used (from member's overall modelsUsed)
    if (stats.modelsUsed) {
      const models =
        typeof stats.modelsUsed === "string"
          ? JSON.parse(stats.modelsUsed)
          : stats.modelsUsed;
      for (const model of Object.keys(models)) {
        modelsMap[model] = (modelsMap[model] ?? 0) + models[model];
      }
    }

    // Build trend data — use computedAt date as a data point per member.
    // Each TeamStats entry represents a member's stats for the period.
    // We use the entry's computedAt timestamp to create daily trend points.
    if (entry.computedAt) {
      const date = util.time
        .epochMilliSecondsToFormatted(
          entry.computedAt * 1000,
          "yyyy-MM-dd",
          "+00:00"
        )
        .substring(0, 10);
      if (!trendMap[date]) {
        trendMap[date] = { date, sessions: 0, prompts: 0, estimatedCost: 0 };
      }
      trendMap[date].sessions += memberSessions;
      trendMap[date].prompts += memberPrompts;
      for (const p of projectEntries) {
        trendMap[date].estimatedCost += p.estimatedCost ?? 0;
      }
    }
  }

  // Sort contributors by sessions descending
  contributors.sort((a, b) => b.sessions - a.sessions);

  // Sort trend data by date ascending
  const trend = Object.values(trendMap);
  trend.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Round cost values for cleanliness
  estimatedCost = Math.round(estimatedCost * 100) / 100;
  for (const t of trend) {
    t.estimatedCost = Math.round(t.estimatedCost * 100) / 100;
  }

  return {
    projectId,
    period,
    totalSessions,
    totalPrompts,
    totalTokens,
    estimatedCost,
    contributors,
    modelsUsed: Object.keys(modelsMap).length > 0
      ? JSON.stringify(modelsMap)
      : null,
    trend,
  };
}
