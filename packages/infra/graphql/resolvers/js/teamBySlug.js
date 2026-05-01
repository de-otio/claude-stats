/**
 * Query.teamBySlug — Look up a team by its slug.
 * Queries the TeamsBySlug GSI (KEYS_ONLY) to get the teamId,
 * then fetches the full Team from the base table.
 *
 * Note: This is a pipeline resolver. Step 1 queries the GSI,
 * Step 2 fetches the full item. This file covers the GSI query step.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { slug } = ctx.args;
  if (!slug) {
    util.error("slug is required", "ValidationError");
  }

  return ddb.query({
    query: { teamSlug: { eq: slug } },
    index: "TeamsBySlug",
    limit: 1,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const items = ctx.result.items || [];
  if (items.length === 0) {
    return null;
  }

  // GSI is KEYS_ONLY — stash teamId for pipeline second step
  // to fetch full item from base table
  ctx.stash.teamId = items[0].teamId;
  return items[0];
}
