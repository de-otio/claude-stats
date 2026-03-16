import type {
  CreateAuthChallengeTriggerEvent,
  CreateAuthChallengeTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient, GenerateMacCommand } from "@aws-sdk/client-kms";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { randomUUID } from "node:crypto";

const ddb = new DynamoDBClient({});
const kmsClient = new KMSClient({});
const ses = new SESClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const KMS_KEY_ID = process.env.KMS_KEY_ID!;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL!;
const SES_CONFIGURATION_SET = process.env.SES_CONFIGURATION_SET;
const APP_URL = process.env.APP_URL!;
const MAGIC_LINK_TTL_MINUTES = Number(process.env.MAGIC_LINK_TTL_MINUTES ?? "15");
const MAX_REQUESTS_PER_HOUR = Number(process.env.MAX_REQUESTS_PER_HOUR ?? "3");

/**
 * Cognito CreateAuthChallenge trigger.
 *
 * Generates a magic link token, checks rate limits, and sends email via SES.
 * The token is stored as an HMAC-SHA-256 hash in DynamoDB.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (
  event: CreateAuthChallengeTriggerEvent,
) => {
  const email = event.request.userAttributes.email?.toLowerCase().trim();
  if (!email) {
    throw new Error("Email is required");
  }

  // ---------- Rate limiting ----------

  await checkRateLimit(email);

  // ---------- Generate token and HMAC ----------

  const token = randomUUID();
  const tokenHashBuffer = await computeHmac(token);
  const tokenHash = Buffer.from(tokenHashBuffer).toString("base64");

  // ---------- Store token in DynamoDB ----------

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + MAGIC_LINK_TTL_MINUTES * 60;

  // Overwrite any existing token for this email (one active link per email)
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: tokenHash },
        expiresAt: { N: String(expiresAt) },
        used: { BOOL: false },
        createdAt: { N: String(now) },
      },
    }),
  );

  // ---------- Send magic link email ----------

  const magicLinkUrl = `${APP_URL}/auth/verify?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

  await ses.send(
    new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      ConfigurationSetName: SES_CONFIGURATION_SET,
      Message: {
        Subject: { Data: "Sign in to Claude Stats" },
        Body: {
          Html: {
            Data: buildHtmlEmail(magicLinkUrl),
          },
          Text: {
            Data: `Sign in to Claude Stats by visiting this link:\n\n${magicLinkUrl}\n\nThis link expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`,
          },
        },
      },
    }),
  );

  // ---------- Return challenge metadata ----------

  // The publicChallengeParameters are sent back to the client.
  // Do NOT include the token — only indicate that an email was sent.
  event.response.publicChallengeParameters = {
    email,
    delivery: "EMAIL",
  };

  // privateChallengeParameters are used internally by VerifyAuthChallenge
  // but we validate via DynamoDB lookup, so we just pass a sentinel.
  event.response.privateChallengeParameters = {
    challenge: "MAGIC_LINK",
  };

  return event;
};

/**
 * Check per-email rate limit using a sliding window counter in DynamoDB.
 * Throws if the limit is exceeded.
 */
async function checkRateLimit(email: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 3600; // 1-hour window

  const result = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        email: { S: email },
        sk: { S: "RATE_LIMIT" },
      },
    }),
  );

  const item = result.Item;
  let requestCount = 0;
  let currentWindowStart = now;

  if (item) {
    const storedWindowStart = Number(item.requestWindowStart?.N ?? "0");

    if (storedWindowStart > windowStart) {
      // Within the current window
      requestCount = Number(item.requestCount?.N ?? "0");
      currentWindowStart = storedWindowStart;
    }
    // else: window has expired, reset counter
  }

  if (requestCount >= MAX_REQUESTS_PER_HOUR) {
    throw new Error("Please try again later");
  }

  // Update rate limit counter (overwrite — atomic increment not needed since
  // Cognito serialises challenge creation per user session)
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        email: { S: email },
        sk: { S: "RATE_LIMIT" },
        requestCount: { N: String(requestCount + 1) },
        requestWindowStart: { N: String(currentWindowStart) },
        expiresAt: { N: String(now + 7200) }, // TTL: 2 hours after last request
      },
    }),
  );
}

/**
 * Compute HMAC-SHA-256 of the token using the KMS key.
 */
async function computeHmac(token: string): Promise<Uint8Array> {
  const result = await kmsClient.send(
    new GenerateMacCommand({
      KeyId: KMS_KEY_ID,
      MacAlgorithm: "HMAC_SHA_256",
      Message: Buffer.from(token, "utf-8"),
    }),
  );

  if (!result.Mac) {
    throw new Error("KMS GenerateMac returned no Mac");
  }

  return result.Mac;
}

/**
 * Build a styled HTML email with a sign-in button.
 */
function buildHtmlEmail(magicLinkUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a2e;">Sign in to Claude Stats</h2>
  <p>Click the button below to sign in. This link expires in ${MAGIC_LINK_TTL_MINUTES} minutes.</p>
  <a href="${magicLinkUrl}"
     style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0;">
    Sign In
  </a>
  <p style="color: #666; font-size: 14px;">If you did not request this link, you can safely ignore this email.</p>
</body>
</html>`.trim();
}
