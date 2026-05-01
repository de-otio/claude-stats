/**
 * Mutation.deleteTeamLogo — Delete a team's logo from S3 and clear the logoUrl.
 * Admin-only: caller must be an admin of the team.
 *
 * This is a pipeline resolver:
 *   Step 1 (this file): Admin check + clear logoUrl from the Teams table
 *   Step 2: An HTTP resolver or Lambda to delete the S3 object
 *
 * For now, this resolver clears the Teams.logoUrl field in DynamoDB.
 * The S3 object deletion should be handled by a Lambda or S3 lifecycle rule.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const { teamId } = ctx.args;

  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // Admin check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isAdmin = groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isAdmin && !isSuperadmin) {
    util.unauthorized();
  }

  ctx.stash.teamId = teamId;

  // Clear the logoUrl field and set a deletedLogoAt timestamp
  // so that a downstream process (Lambda/EventBridge) can clean up the S3 object.
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId }),
    update: {
      expression:
        "REMOVE logoUrl SET deletedLogoAt = :now",
      expressionValues: util.dynamodb.toMapValues({
        ":now": util.time.nowEpochSeconds(),
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
