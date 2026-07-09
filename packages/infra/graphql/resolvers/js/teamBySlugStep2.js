/**
 * Query.teamBySlug — Pipeline Step 2.
 * The TeamsBySlug GSI (KEYS_ONLY) gave Step 1 only the teamId; fetch the
 * full Team from the base table here. Reveal the invite code only to admins
 * or superadmins of this team.
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const teamId = ctx.stash.teamId;
  if (!teamId) {
    // Slug not found. This step is bound to a DynamoDB data source, so a
    // `{payload}` return is invalid; earlyReturn skips the get.
    runtime.earlyReturn(null);
  }
  return ddb.get({ key: { teamId } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const team = ctx.result;
  if (!team) {
    return null;
  }
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin =
    groups.includes(`team:${team.teamId}:admin`) ||
    groups.includes("superadmin");
  if (!isAdmin) {
    team.inviteCode = null;
  }
  return team;
}
