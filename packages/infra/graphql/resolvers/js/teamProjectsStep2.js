/**
 * Query.teamProjects — Pipeline Step 2.
 * Query TeamStats for the team and period, aggregate projectBreakdown
 * across all sharing members, and return a deduplicated [ProjectStats] list.
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

  const memberEntries = ctx.result.items ?? [];
  const projectMap = {};

  for (const entry of memberEntries) {
    // Skip members with "minimal" share level — they have no projectBreakdown
    if (entry.shareLevel === "minimal") {
      continue;
    }

    const stats = entry.stats;
    if (!stats || !stats.projectBreakdown) {
      continue;
    }

    // Aggregate each project entry from this member
    for (const p of stats.projectBreakdown) {
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
    }
  }

  // Round cost values
  const projects = Object.values(projectMap);
  for (const p of projects) {
    p.estimatedCost = Math.round(p.estimatedCost * 100) / 100;
  }

  // Sort by session count descending
  projects.sort((a, b) => b.sessions - a.sessions);

  return projects;
}
