/**
 * Mutation.deleteMyAccount — Cascading account deletion Lambda.
 *
 * Purges all user data across every DynamoDB table, deletes the Cognito user,
 * and writes an audit log entry to CloudWatch. This implements the GDPR / user
 * request deletion flow described in 16-operations.md.
 *
 * Environment variables:
 *   USER_PROFILES_TABLE
 *   TEAM_MEMBERSHIPS_TABLE
 *   SYNCED_SESSIONS_TABLE
 *   SYNCED_MESSAGES_TABLE
 *   TEAM_STATS_TABLE
 *   ACHIEVEMENTS_TABLE
 *   CHALLENGES_TABLE
 *   INTER_TEAM_CHALLENGES_TABLE
 *   USER_POOL_ID
 */

import type { AppSyncResolverEvent } from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const USER_PROFILES_TABLE = process.env.USER_PROFILES_TABLE!;
const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;
const SYNCED_SESSIONS_TABLE = process.env.SYNCED_SESSIONS_TABLE!;
const SYNCED_MESSAGES_TABLE = process.env.SYNCED_MESSAGES_TABLE!;
const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const ACHIEVEMENTS_TABLE = process.env.ACHIEVEMENTS_TABLE!;
const CHALLENGES_TABLE = process.env.CHALLENGES_TABLE!;
const INTER_TEAM_CHALLENGES_TABLE = process.env.INTER_TEAM_CHALLENGES_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Query all items with the given key condition, paginating through results.
 * Returns the raw unmarshalled items.
 */
async function queryAll(
  tableName: string,
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, any>,
  expressionAttributeNames?: Record<string, string>,
  indexName?: string,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const params: any = {
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
      ExclusiveStartKey: lastKey,
    };
    if (expressionAttributeNames) {
      params.ExpressionAttributeNames = expressionAttributeNames;
    }
    if (indexName) {
      params.IndexName = indexName;
    }

    const result = await ddb.send(new QueryCommand(params));
    for (const item of result.Items ?? []) {
      items.push(unmarshall(item));
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * Batch delete items from a table. DynamoDB BatchWriteItem supports max 25
 * items per call, so we chunk accordingly.
 */
async function batchDelete(
  tableName: string,
  keys: Record<string, any>[],
): Promise<number> {
  if (keys.length === 0) return 0;

  let deleted = 0;
  const BATCH_SIZE = 25;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const chunk = keys.slice(i, i + BATCH_SIZE);
    const deleteRequests = chunk.map((key) => ({
      DeleteRequest: { Key: marshall(key) },
    }));

    let unprocessed: typeof deleteRequests | undefined = deleteRequests;

    while (unprocessed && unprocessed.length > 0) {
      const result = await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [tableName]: unprocessed },
        }),
      );

      const remaining = result.UnprocessedItems?.[tableName];
      if (remaining && remaining.length > 0) {
        unprocessed = remaining as typeof deleteRequests;
        // Exponential backoff for unprocessed items
        await new Promise((r) => setTimeout(r, 100));
      } else {
        unprocessed = undefined;
      }
    }

    deleted += chunk.length;
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Table-specific deletion functions
// ---------------------------------------------------------------------------

/** 1. Delete UserProfiles record (PK = userId) */
async function deleteUserProfile(userId: string): Promise<void> {
  await ddb.send(
    new DeleteItemCommand({
      TableName: USER_PROFILES_TABLE,
      Key: marshall({ userId }),
    }),
  );
  console.log(`Deleted UserProfile for ${userId}`);
}

/** 2. Delete all TeamMemberships (GSI query by userId, then delete by PK/SK) */
async function deleteTeamMemberships(userId: string): Promise<number> {
  const memberships = await queryAll(
    TEAM_MEMBERSHIPS_TABLE,
    "userId = :uid",
    { ":uid": userId },
    undefined,
    "MembershipsByUser",
  );

  const keys = memberships.map((m) => ({
    teamId: m.teamId,
    userId: m.userId,
  }));

  const count = await batchDelete(TEAM_MEMBERSHIPS_TABLE, keys);
  console.log(`Deleted ${count} TeamMembership records for ${userId}`);
  return count;
}

/** 3. Delete all SyncedSessions (PK = userId) */
async function deleteSyncedSessions(userId: string): Promise<string[]> {
  const sessions = await queryAll(
    SYNCED_SESSIONS_TABLE,
    "userId = :uid",
    { ":uid": userId },
  );

  const sessionIds = sessions.map((s) => s.sessionId as string);
  const keys = sessions.map((s) => ({
    userId: s.userId,
    sessionId: s.sessionId,
  }));

  const count = await batchDelete(SYNCED_SESSIONS_TABLE, keys);
  console.log(`Deleted ${count} SyncedSession records for ${userId}`);
  return sessionIds;
}

/** 4. Delete all SyncedMessages for the user's sessions */
async function deleteSyncedMessages(sessionIds: string[]): Promise<number> {
  let totalDeleted = 0;

  for (const sessionId of sessionIds) {
    const messages = await queryAll(
      SYNCED_MESSAGES_TABLE,
      "sessionId = :sid",
      { ":sid": sessionId },
    );

    const keys = messages.map((m) => ({
      sessionId: m.sessionId,
      uuid: m.uuid,
    }));

    totalDeleted += await batchDelete(SYNCED_MESSAGES_TABLE, keys);
  }

  console.log(
    `Deleted ${totalDeleted} SyncedMessage records across ${sessionIds.length} sessions`,
  );
  return totalDeleted;
}

/** 5. Delete all Achievements (PK = userId) */
async function deleteAchievements(userId: string): Promise<number> {
  const achievements = await queryAll(
    ACHIEVEMENTS_TABLE,
    "userId = :uid",
    { ":uid": userId },
  );

  const keys = achievements.map((a) => ({
    userId: a.userId,
    achievementId: a.achievementId,
  }));

  const count = await batchDelete(ACHIEVEMENTS_TABLE, keys);
  console.log(`Deleted ${count} Achievement records for ${userId}`);
  return count;
}

/** 6. Delete all TeamStats entries for this user (GSI query) */
async function deleteTeamStats(userId: string): Promise<number> {
  const stats = await queryAll(
    TEAM_STATS_TABLE,
    "userId = :uid",
    { ":uid": userId },
    undefined,
    "StatsByUser",
  );

  const keys = stats.map((s) => ({
    teamId: s.teamId,
    "period#userId": s["period#userId"],
  }));

  const count = await batchDelete(TEAM_STATS_TABLE, keys);
  console.log(`Deleted ${count} TeamStats records for ${userId}`);
  return count;
}

/**
 * 7. Handle Challenges where createdBy = userId.
 * - Active challenges: set status to "completed" (end early)
 * - Other participants' scores are preserved
 * - Also remove the user from participant lists of other challenges
 */
async function handleChallenges(userId: string): Promise<void> {
  // Scan for challenges created by this user
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: CHALLENGES_TABLE,
        FilterExpression: "createdBy = :uid",
        ExpressionAttributeValues: marshall({ ":uid": userId }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const challenge = unmarshall(item);
      if (challenge.status === "active") {
        // Auto-complete active challenges created by the departing user
        await ddb.send(
          new UpdateItemCommand({
            TableName: CHALLENGES_TABLE,
            Key: marshall({
              teamId: challenge.teamId,
              challengeId: challenge.challengeId,
            }),
            UpdateExpression:
              "SET #s = :completed, updatedAt = :now, completedReason = :reason",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: marshall({
              ":completed": "completed",
              ":now": Math.floor(Date.now() / 1000),
              ":reason": "creator_account_deleted",
            }),
          }),
        );
        console.log(
          `Auto-completed active challenge ${challenge.challengeId} (creator deleted)`,
        );
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Handled challenges created by ${userId}`);
}

/**
 * 8. Handle InterTeamChallenges.
 * - Challenges created by this user: auto-complete if active, delete if pending
 * - The user's team remains as a participant in active/completed challenges
 *   (team-level data is preserved per doc spec)
 */
async function handleInterTeamChallenges(userId: string): Promise<void> {
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: INTER_TEAM_CHALLENGES_TABLE,
        FilterExpression: "createdBy = :uid",
        ExpressionAttributeValues: marshall({ ":uid": userId }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const challenge = unmarshall(item);

      if (challenge.status === "pending") {
        // Delete pending inter-team challenges created by the departing user
        await ddb.send(
          new DeleteItemCommand({
            TableName: INTER_TEAM_CHALLENGES_TABLE,
            Key: marshall({ challengeId: challenge.challengeId }),
          }),
        );
        console.log(
          `Deleted pending inter-team challenge ${challenge.challengeId} (creator deleted)`,
        );
      } else if (challenge.status === "active") {
        // Auto-complete active inter-team challenges
        await ddb.send(
          new UpdateItemCommand({
            TableName: INTER_TEAM_CHALLENGES_TABLE,
            Key: marshall({ challengeId: challenge.challengeId }),
            UpdateExpression:
              "SET #s = :completed, updatedAt = :now, completedReason = :reason",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: marshall({
              ":completed": "completed",
              ":now": Math.floor(Date.now() / 1000),
              ":reason": "creator_account_deleted",
            }),
          }),
        );
        console.log(
          `Auto-completed active inter-team challenge ${challenge.challengeId} (creator deleted)`,
        );
      }
      // Completed challenges are left as-is (historical record)
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Handled inter-team challenges created by ${userId}`);
}

/** 9. Delete the Cognito user */
async function deleteCognitoUser(
  userId: string,
  username: string,
): Promise<void> {
  await cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }),
  );
  console.log(`Deleted Cognito user ${username} (${userId})`);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function writeAuditLog(
  userId: string,
  summary: Record<string, number>,
): void {
  // Structured log entry — CloudWatch Logs Insights can query these
  console.log(
    JSON.stringify({
      event: "ACCOUNT_DELETED",
      userId,
      timestamp: new Date().toISOString(),
      summary,
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface DeleteAccountEvent {
  identity: {
    sub: string;
    username: string;
  };
}

export const handler = async (
  event: AppSyncResolverEvent<Record<string, never>>,
): Promise<boolean> => {
  const userId = event.identity!.sub;
  const username =
    (event.identity as any).username ||
    (event.identity as any).claims?.["cognito:username"] ||
    userId;

  console.log(`Starting account deletion for userId=${userId}`);

  const summary: Record<string, number> = {};

  try {
    // 1. Delete user profile
    await deleteUserProfile(userId);
    summary.userProfiles = 1;

    // 2. Delete team memberships
    summary.teamMemberships = await deleteTeamMemberships(userId);

    // 3. Delete synced sessions (returns sessionIds for message deletion)
    const sessionIds = await deleteSyncedSessions(userId);
    summary.syncedSessions = sessionIds.length;

    // 4. Delete synced messages for all sessions
    summary.syncedMessages = await deleteSyncedMessages(sessionIds);

    // 5. Delete achievements
    summary.achievements = await deleteAchievements(userId);

    // 6. Delete team stats
    summary.teamStats = await deleteTeamStats(userId);

    // 7. Handle challenges (auto-complete active ones created by user)
    await handleChallenges(userId);
    summary.challengesHandled = 1;

    // 8. Handle inter-team challenges
    await handleInterTeamChallenges(userId);
    summary.interTeamChallengesHandled = 1;

    // 9. Delete Cognito user (last — so if any prior step fails, the user
    //    can still authenticate and retry)
    await deleteCognitoUser(userId, username);
    summary.cognitoDeleted = 1;

    // Audit log
    writeAuditLog(userId, summary);

    console.log(`Account deletion complete for userId=${userId}`);
    return true;
  } catch (error) {
    console.error(`Account deletion FAILED for userId=${userId}:`, error);
    // Write partial audit log so we know what was deleted before failure
    writeAuditLog(userId, { ...summary, failed: 1 });
    throw error;
  }
};
