import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";
import type { DynamoDBStreamEvent, DynamoDBRecord } from "aws-lambda";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;
const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;

const ddb = new DynamoDBClient({});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionRecord {
  userId: string;
  sessionId: string;
  accountId: string;
  projectId: string | null;
  firstTimestamp: number;
  lastTimestamp: number;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
  models: string[];
  isSubagent: boolean;
  toolUseCounts: Record<string, number>;
}

interface TeamMembership {
  teamId: string;
  userId: string;
  role: string;
  shareLevel: "full" | "summary" | "minimal";
  sharedAccounts: string[];
  displayName: string;
}

interface ProjectStats {
  projectId: string;
  sessions: number;
  prompts: number;
  estimatedCost: number;
}

interface AggregatedStats {
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
  activeMinutes: number;
  modelsUsed: Record<string, number>;
  topTools: string[];
  velocityTokensPerMin: number;
  subagentRatio: number;
  projectBreakdown: ProjectStats[];
}

interface StatsGroupKey {
  teamId: string;
  period: string;
  userId: string;
  shareLevel: "full" | "summary" | "minimal";
  displayName: string;
}

// ---------------------------------------------------------------------------
// ISO Week Helper
// ---------------------------------------------------------------------------

/**
 * Returns the ISO 8601 week string for a given epoch-millisecond timestamp.
 * Format: "YYYY-Www" (e.g. "2026-W11").
 *
 * ISO weeks start on Monday. Week 1 is the week containing the first Thursday
 * of the year (equivalently, the week containing January 4).
 */
function getISOWeek(epochMs: number): string {
  const date = new Date(epochMs);

  // Set to nearest Thursday: current date + 4 - day number (Mon=1..Sun=7)
  const dayOfWeek = date.getUTCDay(); // 0=Sun..6=Sat
  // Convert to ISO day number: Mon=1..Sun=7
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

  // Move to Thursday of the current ISO week
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - isoDay));

  // ISO year is the year of the Thursday
  const isoYear = thursday.getUTCFullYear();

  // Ordinal day of that Thursday within its year
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const ordinal =
    Math.floor(
      (thursday.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000),
    ) + 1;

  // ISO week number
  const weekNum = Math.floor((ordinal - 1) / 7) + 1;

  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// DynamoDB Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a DynamoDB Stream NewImage into a typed SessionRecord.
 * Returns null if the image is missing required fields.
 */
function parseSessionFromImage(
  image: Record<string, any>,
): SessionRecord | null {
  try {
    const item = unmarshall(image);
    return {
      userId: item.userId,
      sessionId: item.sessionId,
      accountId: item.accountId,
      projectId: item.projectId ?? null,
      firstTimestamp: item.firstTimestamp,
      lastTimestamp: item.lastTimestamp,
      promptCount: item.promptCount ?? 0,
      inputTokens: item.inputTokens ?? 0,
      outputTokens: item.outputTokens ?? 0,
      cacheCreationTokens: item.cacheCreationTokens ?? 0,
      cacheReadTokens: item.cacheReadTokens ?? 0,
      estimatedCost: item.estimatedCost ?? 0,
      models: item.models ?? [],
      isSubagent: item.isSubagent ?? false,
      toolUseCounts: item.toolUseCounts ?? {},
    };
  } catch (err) {
    console.error("Failed to parse session image", err);
    return null;
  }
}

/**
 * Look up all team memberships for a user via the MembershipsByUser GSI.
 * Returns full membership details including sharedAccounts and shareLevel
 * by fetching from the base table.
 */
async function getUserTeamMemberships(
  userId: string,
): Promise<TeamMembership[]> {
  // The GSI MembershipsByUser only projects role, joinedAt, displayName.
  // We need sharedAccounts and shareLevel, so query the GSI to get
  // (teamId, userId) pairs, then batch-fetch from the base table.
  // However, for simplicity and to avoid a second round-trip per team,
  // we query with a full projection request. Since the GSI projection
  // is INCLUDE [role, joinedAt, displayName], we must query the base
  // table instead — but we only have userId, not teamId.
  //
  // Strategy: Query the GSI to get teamId list, then query base table
  // for each teamId+userId to get full membership record.

  const gsiResult = await ddb.send(
    new QueryCommand({
      TableName: TEAM_MEMBERSHIPS_TABLE,
      IndexName: "MembershipsByUser",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  if (!gsiResult.Items || gsiResult.Items.length === 0) {
    return [];
  }

  // Fetch full records from base table for each membership
  const memberships: TeamMembership[] = [];

  for (const gsiItem of gsiResult.Items) {
    const { teamId } = unmarshall(gsiItem) as { teamId: string };

    try {
      const baseResult = await ddb.send(
        new QueryCommand({
          TableName: TEAM_MEMBERSHIPS_TABLE,
          KeyConditionExpression: "teamId = :tid AND userId = :uid",
          ExpressionAttributeValues: marshall({
            ":tid": teamId,
            ":uid": userId,
          }),
        }),
      );

      if (baseResult.Items && baseResult.Items.length > 0) {
        const item = unmarshall(baseResult.Items[0]);
        memberships.push({
          teamId: item.teamId,
          userId: item.userId,
          role: item.role,
          shareLevel: item.shareLevel ?? "summary",
          sharedAccounts: item.sharedAccounts ?? [],
          displayName: item.displayName ?? "",
        });
      }
    } catch (err) {
      console.error(
        `Failed to fetch membership for team=${teamId} user=${userId}`,
        err,
      );
    }
  }

  return memberships;
}

// ---------------------------------------------------------------------------
// Aggregation Logic
// ---------------------------------------------------------------------------

/**
 * Build a composite key for grouping sessions during aggregation.
 */
function groupKey(teamId: string, period: string, userId: string): string {
  return `${teamId}#${period}#${userId}`;
}

interface GroupedEntry {
  key: StatsGroupKey;
  sessions: SessionRecord[];
}

/**
 * Compute aggregate stats from a collection of sessions.
 */
function computeAggregates(
  sessions: SessionRecord[],
  shareLevel: "full" | "summary" | "minimal",
): AggregatedStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalPrompts = 0;
  let totalEstimatedCost = 0;
  let totalActiveMinutes = 0;
  let subagentCount = 0;
  const modelsUsed: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const projectMap = new Map<
    string,
    { sessions: number; prompts: number; estimatedCost: number }
  >();

  for (const session of sessions) {
    totalInputTokens += session.inputTokens;
    totalOutputTokens += session.outputTokens;
    totalCacheCreationTokens += session.cacheCreationTokens;
    totalCacheReadTokens += session.cacheReadTokens;
    totalPrompts += session.promptCount;
    totalEstimatedCost += session.estimatedCost;

    // Active minutes: duration of the session
    const durationMs = Math.max(0, session.lastTimestamp - session.firstTimestamp);
    totalActiveMinutes += durationMs / (1000 * 60);

    if (session.isSubagent) {
      subagentCount++;
    }

    // Model counts
    for (const model of session.models) {
      modelsUsed[model] = (modelsUsed[model] ?? 0) + 1;
    }

    // Tool counts
    for (const [tool, count] of Object.entries(session.toolUseCounts)) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }

    // Project breakdown
    const projectKey = session.projectId ?? "(unlinked)";
    const existing = projectMap.get(projectKey);
    if (existing) {
      existing.sessions += 1;
      existing.prompts += session.promptCount;
      existing.estimatedCost += session.estimatedCost;
    } else {
      projectMap.set(projectKey, {
        sessions: 1,
        prompts: session.promptCount,
        estimatedCost: session.estimatedCost,
      });
    }
  }

  // Top tools: sorted by total usage count, take top 10
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool]) => tool);

  const velocityTokensPerMin =
    totalActiveMinutes > 0
      ? Math.round(totalOutputTokens / totalActiveMinutes)
      : 0;

  const subagentRatio =
    sessions.length > 0
      ? Math.round((subagentCount / sessions.length) * 1000) / 1000
      : 0;

  const projectBreakdown: ProjectStats[] = [];
  for (const [projectId, stats] of projectMap) {
    projectBreakdown.push({
      projectId,
      sessions: stats.sessions,
      prompts: stats.prompts,
      estimatedCost: Math.round(stats.estimatedCost * 100) / 100,
    });
  }

  return {
    sessions: sessions.length,
    prompts: totalPrompts,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
    estimatedCost: Math.round(totalEstimatedCost * 100) / 100,
    activeMinutes: Math.round(totalActiveMinutes),
    modelsUsed,
    topTools,
    velocityTokensPerMin,
    subagentRatio,
    projectBreakdown,
  };
}

/**
 * Build the stats attribute map for DynamoDB, respecting shareLevel.
 *
 * - "full": all fields included
 * - "summary": all fields included (same as full for stats)
 * - "minimal": omit estimatedCost, modelsUsed, topTools, projectBreakdown
 */
function buildStatsAttribute(
  agg: AggregatedStats,
  shareLevel: "full" | "summary" | "minimal",
): Record<string, any> {
  const stats: Record<string, any> = {
    sessions: agg.sessions,
    prompts: agg.prompts,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    activeMinutes: agg.activeMinutes,
    velocityTokensPerMin: agg.velocityTokensPerMin,
    subagentRatio: agg.subagentRatio,
  };

  if (shareLevel !== "minimal") {
    stats.estimatedCost = agg.estimatedCost;
    stats.modelsUsed = agg.modelsUsed;
    stats.topTools = agg.topTools;
    stats.projectBreakdown = agg.projectBreakdown;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// TeamStats Write (Idempotent Upsert)
// ---------------------------------------------------------------------------

/**
 * Write or update the TeamStats item for a (teamId, period#userId) key.
 * Uses a conditional expression on computedAt for idempotency:
 * only overwrites if our computedAt is newer than what's already stored.
 */
async function writeTeamStats(
  entry: GroupedEntry,
  agg: AggregatedStats,
): Promise<boolean> {
  const { key } = entry;
  const now = Date.now();
  const sk = `${key.period}#${key.userId}`;
  const stats = buildStatsAttribute(agg, key.shareLevel);

  // Compute expiresAt: end of the ISO week + 1 year
  // Parse period like "2026-W11" to get end of week, then add 365 days
  const expiresAt = computeExpiresAt(key.period);

  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TEAM_STATS_TABLE,
        Key: marshall({ teamId: key.teamId, SK: sk }),
        UpdateExpression: `
          SET #period = :period,
              userId = :userId,
              displayName = :displayName,
              shareLevel = :shareLevel,
              stats = :stats,
              computedAt = :computedAt,
              updatedAt = :updatedAt,
              expiresAt = :expiresAt
        `,
        ConditionExpression:
          "attribute_not_exists(computedAt) OR computedAt < :computedAt",
        ExpressionAttributeNames: {
          "#period": "period",
        },
        ExpressionAttributeValues: marshall({
          ":period": key.period,
          ":userId": key.userId,
          ":displayName": key.displayName,
          ":shareLevel": key.shareLevel,
          ":stats": stats,
          ":computedAt": now,
          ":updatedAt": now,
          ":expiresAt": expiresAt,
        }),
      }),
    );
    return true;
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      // A newer computation already exists — this is expected, not an error
      console.log(
        `Skipping stale update for team=${key.teamId} period=${key.period} user=${key.userId}`,
      );
      return false;
    }
    throw err;
  }
}

/**
 * Compute TTL expiresAt (epoch seconds) for a given ISO week period.
 * Returns the epoch seconds for ~1 year after the end of that ISO week.
 */
function computeExpiresAt(period: string): number {
  // Parse "YYYY-Www"
  const match = period.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    // Fallback: 1 year from now
    return Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  }

  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);

  // Find the Monday of ISO week 1 for this year:
  // January 4 is always in week 1. Find the Monday of that week.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay(); // ISO day
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));

  // Monday of the target week
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  // End of week = Sunday 23:59:59 = Monday + 7 days
  const endOfWeek = new Date(targetMonday);
  endOfWeek.setUTCDate(targetMonday.getUTCDate() + 7);

  // Add 1 year (365 days)
  const expiresMs = endOfWeek.getTime() + 365 * 24 * 60 * 60 * 1000;
  return Math.floor(expiresMs / 1000);
}

// ---------------------------------------------------------------------------
// AppSync Subscription Notification
// ---------------------------------------------------------------------------

/**
 * Invoke the `refreshTeamStats` AppSync mutation using IAM SigV4 auth.
 * This triggers the `onTeamStatsUpdated` subscription for real-time updates.
 */
async function notifySubscribers(
  teamId: string,
  period: string,
): Promise<void> {
  if (!APPSYNC_ENDPOINT) {
    console.warn("APPSYNC_ENDPOINT not configured, skipping notification");
    return;
  }

  const mutation = `
    mutation RefreshTeamStats($teamId: ID!, $period: String!) {
      refreshTeamStats(teamId: $teamId, period: $period)
    }
  `;

  const body = JSON.stringify({
    query: mutation,
    variables: { teamId, period },
  });

  const url = new URL(APPSYNC_ENDPOINT);

  const request = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      host: url.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION ?? "us-east-1",
    service: "appsync",
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  const response = await fetch(
    `https://${signed.hostname}${signed.path}`,
    {
      method: signed.method,
      headers: signed.headers as Record<string, string>,
      body: signed.body as string,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `AppSync mutation failed: ${response.status} ${response.statusText}`,
      text,
    );
  }
}

// ---------------------------------------------------------------------------
// Stream Record Processing
// ---------------------------------------------------------------------------

/**
 * Extract valid session records from DynamoDB Stream event records.
 * Only processes INSERT and MODIFY events with a NewImage.
 */
function extractSessions(records: DynamoDBRecord[]): SessionRecord[] {
  const sessions: SessionRecord[] = [];

  for (const record of records) {
    if (
      record.eventName !== "INSERT" &&
      record.eventName !== "MODIFY"
    ) {
      continue;
    }

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) {
      continue;
    }

    const session = parseSessionFromImage(
      newImage as Record<string, any>,
    );
    if (session) {
      sessions.push(session);
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  console.log(
    `Processing ${event.Records.length} stream record(s)`,
  );

  // 1. Extract sessions from stream records
  const sessions = extractSessions(event.Records);
  if (sessions.length === 0) {
    console.log("No actionable session records in batch");
    return;
  }

  console.log(`Extracted ${sessions.length} session(s) to process`);

  // 2. Look up memberships for each distinct user
  const userIds = [...new Set(sessions.map((s) => s.userId))];
  const membershipsByUser = new Map<string, TeamMembership[]>();

  for (const userId of userIds) {
    try {
      const memberships = await getUserTeamMemberships(userId);
      membershipsByUser.set(userId, memberships);
    } catch (err) {
      console.error(`Failed to fetch memberships for user=${userId}`, err);
      // Continue processing other users — don't fail the whole batch
      membershipsByUser.set(userId, []);
    }
  }

  // 3. For each session, determine which teams it belongs to and group
  const groups = new Map<string, GroupedEntry>();

  for (const session of sessions) {
    const memberships = membershipsByUser.get(session.userId) ?? [];

    for (const membership of memberships) {
      // Check if session's accountId is in the membership's sharedAccounts
      if (!membership.sharedAccounts.includes(session.accountId)) {
        continue;
      }

      const period = getISOWeek(session.firstTimestamp);
      const gk = groupKey(membership.teamId, period, session.userId);

      let entry = groups.get(gk);
      if (!entry) {
        entry = {
          key: {
            teamId: membership.teamId,
            period,
            userId: session.userId,
            shareLevel: membership.shareLevel,
            displayName: membership.displayName,
          },
          sessions: [],
        };
        groups.set(gk, entry);
      }

      entry.sessions.push(session);
    }
  }

  if (groups.size === 0) {
    console.log("No sessions matched any team memberships");
    return;
  }

  console.log(
    `Grouped into ${groups.size} (teamId, period, userId) combination(s)`,
  );

  // 4. Compute aggregates and write TeamStats for each group
  // Track which (teamId, period) pairs were updated for subscription notification
  const updatedTeamPeriods = new Set<string>();

  for (const [gk, entry] of groups) {
    try {
      const agg = computeAggregates(entry.sessions, entry.key.shareLevel);
      const written = await writeTeamStats(entry, agg);

      if (written) {
        updatedTeamPeriods.add(
          `${entry.key.teamId}#${entry.key.period}`,
        );
        console.log(
          `Updated TeamStats: team=${entry.key.teamId} period=${entry.key.period} user=${entry.key.userId} sessions=${agg.sessions}`,
        );
      }
    } catch (err) {
      console.error(
        `Failed to write TeamStats for group=${gk}`,
        err,
      );
      // Continue processing other groups
    }
  }

  // 5. Notify AppSync subscribers for each updated (teamId, period)
  for (const tp of updatedTeamPeriods) {
    const [teamId, period] = tp.split("#", 2);
    try {
      await notifySubscribers(teamId, period);
    } catch (err) {
      // Subscription notification is best-effort — don't fail the batch
      console.error(
        `Failed to notify subscribers for team=${teamId} period=${period}`,
        err,
      );
    }
  }

  console.log(
    `Completed: ${groups.size} group(s) processed, ${updatedTeamPeriods.size} notification(s) sent`,
  );
};
