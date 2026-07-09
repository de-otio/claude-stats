/**
 * request-logo-upload Lambda
 *
 * AppSync Lambda-data-source resolver behind Mutation.requestTeamLogoUpload.
 * The resolver has already validated teamId and enforced the admin check, so
 * this handler only generates a presigned S3 PUT URL for the team's logo.
 *
 * Flow:
 *   1. Generate a presigned PUT URL for s3://{LOGOS_BUCKET}/logos/{teamId}/logo
 *      (ContentType image/png, expires in 5 minutes)
 *   2. Return { uploadUrl, logoUrl } — the client PUTs the PNG to uploadUrl and
 *      the resulting S3 ObjectCreated event triggers validate-logo, which sets
 *      Teams.logoUrl to the CDN URL.
 *
 * Environment variables:
 *   LOGOS_BUCKET — S3 bucket for team logos
 *   CDN_URL      — CloudFront distribution URL (e.g. https://d1234.cloudfront.net)
 *
 * NOTE: @aws-sdk/s3-request-presigner is NOT part of the Lambda runtime and
 * MUST be bundled (listed in the chunk deps).
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

const LOGOS_BUCKET = process.env.LOGOS_BUCKET!;
const CDN_URL = process.env.CDN_URL!;

const CONTENT_TYPE = "image/png";
const EXPIRES_IN = 300; // 5 minutes

interface RequestLogoUploadEvent {
  teamId: string;
}

interface LogoUploadUrl {
  uploadUrl: string;
  logoUrl: string;
}

export async function handler(
  event: RequestLogoUploadEvent
): Promise<LogoUploadUrl> {
  const { teamId } = event;

  if (!teamId) {
    throw new Error("teamId is required");
  }

  // Extension required: validate-logo's KEY_PATTERN only matches
  // logos/{teamId}/logo.{png|svg|jpg|jpeg}. Keep in sync with CONTENT_TYPE.
  const key = `logos/${teamId}/logo.png`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: LOGOS_BUCKET,
      Key: key,
      ContentType: CONTENT_TYPE,
    }),
    { expiresIn: EXPIRES_IN }
  );

  const base = CDN_URL.replace(/\/$/, "");
  const logoUrl = `${base}/${key}`;

  return { uploadUrl, logoUrl };
}
