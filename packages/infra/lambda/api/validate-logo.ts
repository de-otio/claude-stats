/**
 * validate-logo Lambda
 *
 * Triggered by S3 PutObject events on the team-logos bucket.
 * Validates uploaded logo images and updates the Teams table with the CDN URL.
 *
 * Validation rules:
 *   - File size <= 256 KB (262,144 bytes)
 *   - Content-Type must be image/png, image/svg+xml, or image/jpeg
 *   - Image dimensions <= 512x512 (checked via HeadObject metadata)
 *
 * S3 key pattern: logos/{teamId}/logo.{ext}
 *
 * On success: Updates Teams.logoUrl with the CloudFront CDN URL.
 * On failure: Deletes the invalid S3 object.
 *
 * Environment variables:
 *   TEAMS_TABLE — DynamoDB table name for Teams
 *   CDN_URL     — CloudFront distribution URL (e.g., https://d1234.cloudfront.net)
 */

import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { S3Event } from "aws-lambda";

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const TEAMS_TABLE = process.env.TEAMS_TABLE!;
const CDN_URL = process.env.CDN_URL!;

const MAX_FILE_SIZE = 262_144; // 256 KB
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/svg+xml",
  "image/jpeg",
]);
const MAX_DIMENSION = 512;

// Regex to extract teamId from key pattern: logos/{teamId}/logo.{ext}
const KEY_PATTERN = /^logos\/([^/]+)\/logo\.(png|svg|jpg|jpeg)$/;

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Parse the S3 key to extract the teamId.
 */
function parseTeamId(key: string): string | null {
  const match = key.match(KEY_PATTERN);
  return match ? match[1] : null;
}

/**
 * Validate the uploaded S3 object using HeadObject metadata.
 */
async function validateObject(
  bucket: string,
  key: string
): Promise<ValidationResult> {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );

  // Check file size
  const contentLength = head.ContentLength ?? 0;
  if (contentLength > MAX_FILE_SIZE) {
    return {
      valid: false,
      reason: `File size ${contentLength} bytes exceeds maximum of ${MAX_FILE_SIZE} bytes (256 KB)`,
    };
  }

  if (contentLength === 0) {
    return {
      valid: false,
      reason: "File is empty",
    };
  }

  // Check content type
  const contentType = head.ContentType ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return {
      valid: false,
      reason: `Content-Type "${contentType}" is not allowed. Must be one of: ${[...ALLOWED_CONTENT_TYPES].join(", ")}`,
    };
  }

  // Check image dimensions from metadata (set by presigned URL conditions or client).
  // The presigned URL upload flow can require clients to set x-amz-meta-width and
  // x-amz-meta-height headers. If not present, we skip dimension check for SVGs
  // (which are vector and don't have pixel dimensions in the same sense).
  if (contentType !== "image/svg+xml") {
    const widthStr = head.Metadata?.["width"];
    const heightStr = head.Metadata?.["height"];

    if (widthStr && heightStr) {
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);

      if (isNaN(width) || isNaN(height)) {
        return {
          valid: false,
          reason: "Invalid dimension metadata: width and height must be integers",
        };
      }

      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        return {
          valid: false,
          reason: `Image dimensions ${width}x${height} exceed maximum of ${MAX_DIMENSION}x${MAX_DIMENSION}`,
        };
      }

      if (width <= 0 || height <= 0) {
        return {
          valid: false,
          reason: "Image dimensions must be positive integers",
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Delete an invalid S3 object.
 */
async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Update the Teams table with the new logo URL.
 */
async function updateTeamLogoUrl(
  teamId: string,
  logoUrl: string
): Promise<void> {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: TEAMS_TABLE,
      Key: {
        teamId: { S: teamId },
      },
      UpdateExpression:
        "SET logoUrl = :logoUrl, logoUpdatedAt = :now REMOVE deletedLogoAt",
      ExpressionAttributeValues: {
        ":logoUrl": { S: logoUrl },
        ":now": { N: String(Math.floor(Date.now() / 1000)) },
      },
      ConditionExpression: "attribute_exists(teamId)",
    })
  );
}

/**
 * Build the CDN URL for a given S3 key.
 */
function buildCdnUrl(key: string): string {
  // Ensure CDN_URL doesn't have trailing slash
  const base = CDN_URL.replace(/\/$/, "");
  return `${base}/${key}`;
}

export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(
      record.s3.object.key.replace(/\+/g, " ")
    );

    console.log(`Processing logo upload: bucket=${bucket}, key=${key}`);

    // Parse teamId from the S3 key
    const teamId = parseTeamId(key);
    if (!teamId) {
      console.error(
        `Invalid S3 key pattern: "${key}". Expected: logos/{teamId}/logo.{ext}`
      );
      // Delete the object since we can't associate it with a team
      await deleteObject(bucket, key);
      continue;
    }

    try {
      // Validate the uploaded object
      const result = await validateObject(bucket, key);

      if (!result.valid) {
        console.warn(
          `Validation failed for team ${teamId}: ${result.reason}`
        );
        await deleteObject(bucket, key);
        continue;
      }

      // Build the public CDN URL
      const logoUrl = buildCdnUrl(key);

      // Update the team record in DynamoDB
      await updateTeamLogoUrl(teamId, logoUrl);
      console.log(
        `Logo validated and Teams.logoUrl updated for team ${teamId}: ${logoUrl}`
      );
    } catch (error) {
      console.error(`Error processing logo for team ${teamId}:`, error);

      // On any unexpected error, delete the uploaded object to avoid
      // having an unvalidated logo in S3
      try {
        await deleteObject(bucket, key);
        console.log(`Deleted invalid/error logo for team ${teamId}`);
      } catch (deleteError) {
        console.error(
          `Failed to delete object after error for team ${teamId}:`,
          deleteError
        );
      }
    }
  }
}
