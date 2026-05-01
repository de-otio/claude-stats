/**
 * Mutation.requestTeamLogoUpload — Generate a presigned S3 PUT URL for logo upload.
 * Admin-only: caller must be an admin of the team.
 *
 * PLACEHOLDER: This mutation requires S3 presigned URL generation, which cannot
 * be done in an AppSync JS resolver. This will be replaced with a Lambda resolver
 * that uses the AWS SDK to generate the presigned PUT URL.
 *
 * The actual flow is:
 *   1. Lambda generates a presigned S3 PUT URL targeting: logos/{teamId}/logo.{ext}
 *   2. Client PUTs the image directly to S3 via the presigned URL
 *   3. S3 event triggers validate-logo Lambda which validates and updates Teams.logoUrl
 *
 * For now, this resolver validates the admin check and returns an error
 * indicating the Lambda resolver must be configured.
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

  // Placeholder — this must be replaced with a Lambda resolver that
  // generates a presigned S3 PUT URL using the AWS SDK.
  // The Lambda should:
  //   1. Verify team exists in DynamoDB
  //   2. Generate a presigned PUT URL for s3://{LOGOS_BUCKET}/logos/{teamId}/logo
  //      with conditions: Content-Type in [image/png, image/svg+xml, image/jpeg],
  //      Content-Length <= 262144 (256 KB), expires in 5 minutes
  //   3. Return { uploadUrl, logoUrl } where logoUrl is the CDN URL
  return {
    payload: {
      teamId,
      error: "Lambda resolver not yet configured for presigned URL generation",
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const result = ctx.result;

  if (result && result.error) {
    util.error(result.error, "NotImplementedError");
  }

  // When the Lambda resolver is wired up, it will return:
  // { uploadUrl: "https://s3...presigned", logoUrl: "https://cdn.../logos/{teamId}/logo" }
  return result;
}
