/**
 * Team.members — nested field resolver.
 * Lists the membership rows for the parent Team (ctx.source.teamId).
 * Only members / admins / superadmins of the team see the roster; everyone
 * else gets an empty list (this also gates the reader-dashboard path, where
 * TeamDashboard.team is a Team but readers must not see individual members).
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const teamId = ctx.source.teamId;
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isMember =
    groups.includes(`team:${teamId}:member`) ||
    groups.includes(`team:${teamId}:admin`) ||
    groups.includes("superadmin");
  if (!isMember) {
    runtime.earlyReturn([]);
  }
  return ddb.query({ query: { teamId: { eq: teamId } } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // Storage is lowercase; the GraphQL TeamRole/ShareLevel enums are uppercase.
  return (ctx.result.items || []).map((m) => ({
    ...m,
    role: (m.role || "").toUpperCase(),
    shareLevel: (m.shareLevel || "").toUpperCase(),
  }));
}
