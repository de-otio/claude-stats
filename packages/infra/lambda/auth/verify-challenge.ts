import type {
  VerifyAuthChallengeResponseTriggerEvent,
  VerifyAuthChallengeResponseTriggerHandler,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { KMSClient, GenerateMacCommand } from "@aws-sdk/client-kms";

const ddb = new DynamoDBClient({});
const kmsClient = new KMSClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const KMS_KEY_ID = process.env.KMS_KEY_ID!;

/** 30-second grace period for clock skew tolerance */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Cognito VerifyAuthChallengeResponse trigger.
 *
 * Validates the magic link token by:
 * 1. Computing HMAC-SHA-256 of the submitted token
 * 2. Looking up the stored hash in DynamoDB
 * 3. Checking token is not expired and not already used
 * 4. Marking the token as used with a conditional write (replay prevention)
 */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (
  event: VerifyAuthChallengeResponseTriggerEvent,
) => {
  const email = event.request.userAttributes.email?.toLowerCase().trim();
  const submittedToken = event.request.challengeAnswer;

  if (!email || !submittedToken) {
    event.response.answerCorrect = false;
    return event;
  }

  try {
    // Compute HMAC of the submitted token
    const tokenHashBuffer = await computeHmac(submittedToken);
    const tokenHash = Buffer.from(tokenHashBuffer).toString("base64");

    // Look up the stored token
    const result = await ddb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          email: { S: email },
          sk: { S: "TOKEN" },
        },
      }),
    );

    const item = result.Item;
    if (!item) {
      event.response.answerCorrect = false;
      return event;
    }

    const storedHash = item.tokenHash?.S;
    const expiresAt = Number(item.expiresAt?.N ?? "0");
    const used = item.used?.BOOL ?? true;
    const now = Math.floor(Date.now() / 1000);

    // Validate: hash matches, not expired, not already used
    if (storedHash !== tokenHash) {
      event.response.answerCorrect = false;
      return event;
    }

    if (now > expiresAt + CLOCK_TOLERANCE_SECONDS) {
      event.response.answerCorrect = false;
      return event;
    }

    if (used) {
      event.response.answerCorrect = false;
      return event;
    }

    // Mark token as used with conditional write to prevent replay
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          email: { S: email },
          sk: { S: "TOKEN" },
        },
        UpdateExpression: "SET used = :true, usedAt = :now",
        ConditionExpression:
          "attribute_exists(tokenHash) AND used = :false",
        ExpressionAttributeValues: {
          ":true": { BOOL: true },
          ":false": { BOOL: false },
          ":now": { N: String(now) },
        },
      }),
    );

    event.response.answerCorrect = true;
  } catch (err: unknown) {
    // ConditionalCheckFailedException means a concurrent request already
    // used this token — treat as invalid (replay prevention)
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      event.response.answerCorrect = false;
      return event;
    }

    // Log the error for debugging but return a generic failure
    console.error("VerifyAuthChallenge error:", err);
    event.response.answerCorrect = false;
  }

  return event;
};

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
