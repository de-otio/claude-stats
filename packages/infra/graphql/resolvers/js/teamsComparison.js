/**
 * Query.teamsComparison — Cross-team comparison page.
 * Returns all teams with crossTeamVisibility = PUBLIC_STATS or PUBLIC_DASHBOARD.
 * For each visible team, fetches the latest TeamStats aggregate for the requested period.
 *
 * This is a pipeline resolver:
 *   Step 1 (this file): Query TeamsByVisibility GSI for public_stats teams
 *   Step 2: Query TeamsByVisibility GSI for public_dashboard teams
 *   Step 3: Batch-get TeamStats aggregates for each visible team
 *
 * For a JS resolver, we combine the GSI queries via two sequential DynamoDB calls.
 * Since JS resolvers support only one DynamoDB call per function, this uses
 * a BatchGetItem to fetch aggregates after collecting teamIds from both visibility levels.
 *
 * NOTE: In practice this resolver is backed by a Lambda (see resolver strategy in 05-api-design.md).
 * This JS resolver handles the simpler case where the GSI results include
 * enough data and the aggregate is embedded in the team record.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { period } = ctx.args;
  if (!period) {
    util.error("period is required", "ValidationError");
  }

  // Caller must be authenticated (any user)
  if (!ctx.identity || !ctx.identity.sub) {
    util.unauthorized();
  }

  ctx.stash.period = period;

  // Query TeamsByVisibility GSI for PUBLIC_STATS teams.
  // The GSI has PK = crossTeamVisibility.
  // We query for PUBLIC_STATS first; pipeline step 2 handles PUBLIC_DASHBOARD.
  return ddb.query({
    query: { crossTeamVisibility: { eq: "PUBLIC_STATS" } },
    index: "TeamsByVisibility",
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  // Collect PUBLIC_STATS teams from this step
  const publicStatsTeams = ctx.result.items || [];

  // Stash for the next pipeline step
  ctx.stash.publicStatsTeams = publicStatsTeams;

  return publicStatsTeams;
}
