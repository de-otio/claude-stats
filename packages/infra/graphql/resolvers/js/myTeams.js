/**
 * Query.myTeams — Get all teams the current user belongs to.
 * Queries the MembershipsByUser GSI to get teamIds, then batch-gets Teams.
 *
 * Note: This resolver queries the GSI. A pipeline resolver would then
 * batch-get the full Team items. For a single-function resolver, the
 * membership records include enough data (role, displayName) and the
 * teamIds can be resolved by a field-level resolver on Team.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.query({
    query: { userId: { eq: ctx.identity.sub } },
    index: "MembershipsByUser",
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // Returns membership records; a pipeline second step or field resolver
  // would batch-get full Team objects from the Teams table.
  // Each item contains: teamId, userId, role, joinedAt, displayName
  return ctx.result.items || [];
}
