/**
 * Mutation.grantDashboardAccess — Grant another team read access to this team's dashboard.
 * Admin-only: caller must be an admin of the team granting access.
 *
 * Adds readerTeamId to the Teams.dashboardReaders set (prevents duplicates via ADD operation).
 * The target team must have crossTeamVisibility = PUBLIC_DASHBOARD for the reader
 * to actually see the dashboard, but we allow pre-granting access regardless.
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
  if (teamId === readerTeamId) {
    util.error(
      "Cannot grant dashboard access to your own team",
      "ValidationError"
    );
  }

  // Admin check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  // Use UpdateItem with ADD to append to the dashboardReaders string set.
  // ADD on a set attribute creates it if missing, and is idempotent (no duplicates).
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId }),
    update: {
      expression: "ADD dashboardReaders :reader",
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
