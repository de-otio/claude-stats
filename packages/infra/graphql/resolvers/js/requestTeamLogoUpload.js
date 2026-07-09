/**
 * Mutation.requestTeamLogoUpload — Generate a presigned S3 PUT URL for logo upload.
 * Admin-only: caller must be an admin of the team (or a superadmin).
 *
 * This is a Lambda-data-source resolver. Presigned URL generation cannot be
 * done in an AppSync JS resolver, so request() validates + admin-checks and
 * delegates to the request-logo-upload Lambda via an Invoke.
 *
 * Flow:
 *   1. This resolver invokes the Lambda with { teamId }
 *   2. The Lambda returns { uploadUrl, logoUrl } (presigned S3 PUT + CDN URL)
 *   3. Client PUTs the PNG directly to S3 via uploadUrl
 *   4. The S3 ObjectCreated event triggers validate-logo, which validates the
 *      object and sets Teams.logoUrl to the CDN URL.
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

  return {
    operation: "Invoke",
    payload: { teamId },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  // The Lambda returns { uploadUrl, logoUrl }.
  return ctx.result;
}
