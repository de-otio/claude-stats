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

export function request(ctx) {
  const teamId = ctx.stash.teamId;
  const period = ctx.stash.period;

  // Query every member row for this team + period. The sort key is the
  // attribute literally named "period#userId"; the `ddb.query` sugar would
  // generate the placeholder "#period#userId" (a second '#') which DynamoDB
  // rejects as a syntax error — so build the raw Query with a clean "#sk"
  // placeholder mapped to the real attribute name.
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
    limit: 1000, // Upper bound — typical team has far fewer members
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const memberEntries = ctx.result.items ?? [];
  const projectMap = {};

  memberEntries.forEach((entry) => {
    // Skip members with "minimal" share level — they have no projectBreakdown
    if (entry.shareLevel === "minimal") {
      return;
    }

    const stats = entry.stats;
    if (!stats || !stats.projectBreakdown) {
      return;
    }

    // Aggregate each project entry from this member
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
  });

  // Round cost values
  const projects = Object.values(projectMap);
  projects.forEach((p) => {
    p.estimatedCost = Math.round(p.estimatedCost * 100) / 100;
  });

  // Ordering left to the client: the APPSYNC_JS runtime bans comparator
  // sorts (no-function-passing). The full deduplicated project list is
  // returned intact, so the client sorts by session count descending.
  return projects;
}
