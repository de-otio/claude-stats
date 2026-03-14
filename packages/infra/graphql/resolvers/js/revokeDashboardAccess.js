/**
 * Mutation.revokeDashboardAccess — Revoke another team's read access to this team's dashboard.
 * Admin-only: caller must be an admin of the team revoking access.
 *
 * Removes readerTeamId from the Teams.dashboardReaders set (DELETE operation).
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const { teamId, readerTeamId } = ctx.args;

  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }
  if (!readerTeamId) {
    util.error("readerTeamId is required", "ValidationError");
  }

  // Admin check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  // Use UpdateItem with DELETE to remove from the dashboardReaders string set.
  // DELETE on a set is idempotent — no error if the value is not present.
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId }),
    update: {
      expression: "DELETE dashboardReaders :reader",
      expressionValues: util.dynamodb.toMapValues({
        ":reader": util.dynamodb.toStringSet([readerTeamId]),
      }),
    },
    condition: {
      expression: "attribute_exists(teamId)",
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    if (ctx.error.type === "ConditionalCheckFailedException") {
      util.error("Team not found", "NotFoundError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }

  return true;
}
