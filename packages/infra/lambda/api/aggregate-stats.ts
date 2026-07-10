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
// aggregate-stats — org-plane fan-in worker.
//
// Trigger: the UserAggregates DynamoDB stream. Each changed row is one
// client-computed per-(userId, day) aggregate (the ONLY thing the org backend
// ever sees — see schema.graphql "Sync types"). This worker rolls those daily
// rows into WEEKLY per-member TeamStats rows so the team dashboards / project
// views / leaderboards have something to read.
//
// Design (fixes the three bugs the previous session-stream version had):
//   1. Consumes UserAggregates (not the dead SyncedSessions table).
//   2. Writes the TeamStats sort key under its REAL attribute name
//      "period#userId" (the old code wrote a bogus "SK" attribute).
//   3. READ-RECOMPUTE-WRITE: on any changed day-row we re-read the user's
//      whole ISO-week of day-rows and recompute the member snapshot from
//      scratch, so out-of-order / partial stream batches can't clobber a
//      week with only the current batch's slice.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const USER_AGGREGATES_TABLE = process.env.USER_AGGREGATES_TABLE!;
const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;
const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!;

const ddb = new DynamoDBClient({});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One client-computed per-(userId, day) aggregate row from UserAggregates. */
interface DailyAggregate {
  userId: string;
  period: string; // day bucket, "YYYY-MM-DD"
  accountId: string;
  projectId: string | null;
  sessionCount: number;
  subagentSessionCount: number;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  activeMinutes: number;
  estimatedCost: number;
  models: string[];
  toolUseCounts: Record<string, number>;
}

type ShareLevel = "full" | "summary" | "minimal";

interface TeamMembership {
  teamId: string;
  userId: string;
  role: string;
  shareLevel: ShareLevel;
  sharedAccounts: string[];
  displayName: string;
}

interface ProjectStats {
  projectId: string;
  sessions: number;
  prompts: number;
  estimatedCost: number;
}

interface MemberAggregate {
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

/** A (userId, ISO-week) recompute unit derived from the stream batch. */
interface AffectedWeek {
  userId: string;
  week: string; // "YYYY-Www"
}

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO day number (Mon=1..Sun=7) for a Date. */
function isoDayNum(date: Date): number {
  const d = date.getUTCDay(); // 0=Sun..6=Sat
  return d === 0 ? 7 : d;
}

/** Format a Date as a UTC "YYYY-MM-DD" day string. */
function dayStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * ISO 8601 week string ("YYYY-Www") for a UTC Date. Week 1 is the week
 * containing the first Thursday of the year (= the week containing Jan 4).
 */
function isoWeekOf(date: Date): string {
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - isoDayNum(date)));
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const ordinal =
    Math.floor((thursday.getTime() - jan1.getTime()) / MS_PER_DAY) + 1;
  const weekNum = Math.floor((ordinal - 1) / 7) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

/** Parse a "YYYY-MM-DD" day string to a UTC Date (midnight). Null if invalid. */
function parseDay(period: string): Date | null {
  const m = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Given a "YYYY-Www" ISO week, return the Monday and Sunday day-strings that
 * bound it (inclusive) — used to query the user's day-rows for that week.
 */
function weekDayBounds(week: string): { monday: string; sunday: string } | null {
  const m = week.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  // Monday of ISO week 1 = the Monday of the week containing Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (isoDayNum(jan4) - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (wk - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { monday: dayStr(monday), sunday: dayStr(sunday) };
}

/**
 * TTL for a TeamStats row: ~1 year after the end of the ISO week.
 */
function computeExpiresAt(week: string): number {
  const bounds = weekDayBounds(week);
  if (!bounds) {
    return Math.floor(Date.now() / 1000) + 365 * MS_PER_DAY / 1000;
  }
  const sunday = parseDay(bounds.sunday)!;
  const endMs = sunday.getTime() + MS_PER_DAY + 365 * MS_PER_DAY;
  return Math.floor(endMs / 1000);
}

// ---------------------------------------------------------------------------
// Stream parsing
// ---------------------------------------------------------------------------

/** Read a DynamoDB image into a typed DailyAggregate. Null if unusable. */
function parseAggregateFromImage(
  image: Record<string, any>,
): DailyAggregate | null {
  try {
    const item = unmarshall(image);
    if (!item.userId || !item.period) return null;
    return {
      userId: item.userId,
      period: item.period,
      accountId: item.accountId ?? "",
      projectId: item.projectId ?? null,
      sessionCount: item.sessionCount ?? 0,
      subagentSessionCount: item.subagentSessionCount ?? 0,
      promptCount: item.promptCount ?? 0,
      inputTokens: item.inputTokens ?? 0,
      outputTokens: item.outputTokens ?? 0,
      cacheCreationTokens: item.cacheCreationTokens ?? 0,
      cacheReadTokens: item.cacheReadTokens ?? 0,
      activeMinutes: item.activeMinutes ?? 0,
      estimatedCost: item.estimatedCost ?? 0,
      models: Array.isArray(item.models) ? item.models : [],
      toolUseCounts:
        item.toolUseCounts && typeof item.toolUseCounts === "object"
          ? item.toolUseCounts
          : {},
    };
  } catch (err) {
    console.error("Failed to parse aggregate image", err);
    return null;
  }
}

/**
 * Derive the distinct (userId, ISO-week) recompute units from a stream batch.
 * INSERT/MODIFY use NewImage; REMOVE uses OldImage (a deleted day still needs
 * its week recomputed to drop the subtracted totals).
 */
function affectedWeeks(records: DynamoDBRecord[]): AffectedWeek[] {
  const seen = new Set<string>();
  const out: AffectedWeek[] = [];

  for (const record of records) {
    const image =
      record.eventName === "REMOVE"
        ? record.dynamodb?.OldImage
        : record.dynamodb?.NewImage;
    if (!image) continue;

    const row = parseAggregateFromImage(image as Record<string, any>);
    if (!row) continue;

    const day = parseDay(row.period);
    if (!day) continue;

    const week = isoWeekOf(day);
    const key = `${row.userId}#${week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId: row.userId, week });
  }

  return out;
}

// ---------------------------------------------------------------------------
// DynamoDB reads
// ---------------------------------------------------------------------------

/** Read all of a user's day-rows within an ISO week. */
async function getUserWeekDays(
  userId: string,
  week: string,
): Promise<DailyAggregate[]> {
  const bounds = weekDayBounds(week);
  if (!bounds) return [];

  const rows: DailyAggregate[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: USER_AGGREGATES_TABLE,
        KeyConditionExpression:
          "userId = :uid AND #p BETWEEN :from AND :to",
        ExpressionAttributeNames: { "#p": "period" },
        ExpressionAttributeValues: marshall({
          ":uid": userId,
          ":from": bounds.monday,
          ":to": bounds.sunday,
        }),
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const row = parseAggregateFromImage(item);
      if (row) rows.push(row);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return rows;
}

/**
 * All of a user's team memberships, with sharedAccounts + shareLevel.
 * The MembershipsByUser GSI only projects (role, joinedAt, displayName), so
 * we get the teamId list from it then fetch each full base-table record.
 */
async function getUserTeamMemberships(
  userId: string,
): Promise<TeamMembership[]> {
  const gsiResult = await ddb.send(
    new QueryCommand({
      TableName: TEAM_MEMBERSHIPS_TABLE,
      IndexName: "MembershipsByUser",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  if (!gsiResult.Items || gsiResult.Items.length === 0) return [];

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
          shareLevel: (item.shareLevel ?? "summary") as ShareLevel,
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
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Roll a set of daily aggregate rows into a single member snapshot.
 * All inputs are already aggregates (counts / sums / minutes) — this is a
 * pure sum, never a per-session recomputation.
 */
function computeMemberAggregate(rows: DailyAggregate[]): MemberAggregate {
  let sessions = 0;
  let subagentSessions = 0;
  let prompts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let estimatedCost = 0;
  let activeMinutes = 0;
  const modelsUsed: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const projectMap = new Map<string, ProjectStats>();

  for (const r of rows) {
    sessions += r.sessionCount;
    subagentSessions += r.subagentSessionCount;
    prompts += r.promptCount;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheCreationTokens += r.cacheCreationTokens;
    cacheReadTokens += r.cacheReadTokens;
    estimatedCost += r.estimatedCost;
    activeMinutes += r.activeMinutes;

    // Daily rows carry a model UNION (no per-model counts); tally how many
    // day-rows each model appeared in — an honest usage proxy for AWSJSON.
    for (const model of r.models) {
      modelsUsed[model] = (modelsUsed[model] ?? 0) + 1;
    }

    for (const [tool, count] of Object.entries(r.toolUseCounts)) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }

    const pid = r.projectId ?? "(unlinked)";
    const existing = projectMap.get(pid);
    if (existing) {
      existing.sessions += r.sessionCount;
      existing.prompts += r.promptCount;
      existing.estimatedCost += r.estimatedCost;
    } else {
      projectMap.set(pid, {
        projectId: pid,
        sessions: r.sessionCount,
        prompts: r.promptCount,
        estimatedCost: r.estimatedCost,
      });
    }
  }

  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool]) => tool);

  const velocityTokensPerMin =
    activeMinutes > 0 ? Math.round(outputTokens / activeMinutes) : 0;
  const subagentRatio =
    sessions > 0 ? Math.round((subagentSessions / sessions) * 1000) / 1000 : 0;

  const projectBreakdown: ProjectStats[] = [];
  for (const p of projectMap.values()) {
    projectBreakdown.push({
      projectId: p.projectId,
      sessions: p.sessions,
      prompts: p.prompts,
      estimatedCost: Math.round(p.estimatedCost * 100) / 100,
    });
  }

  return {
    sessions,
    prompts,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    activeMinutes,
    modelsUsed,
    topTools,
    velocityTokensPerMin,
    subagentRatio,
    projectBreakdown,
  };
}

/**
 * Shape the `stats` attribute (a MemberStats blob), applying shareLevel.
 * "minimal" strips cost / models / tools / project breakdown.
 */
function buildStatsAttribute(
  agg: MemberAggregate,
  shareLevel: ShareLevel,
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
// TeamStats write
// ---------------------------------------------------------------------------

/**
 * Upsert the TeamStats member row for (teamId, week, userId). The sort key is
 * stored under its real attribute name "period#userId". Idempotent on
 * computedAt: an older recompute never overwrites a newer one.
 */
async function writeMemberStats(
  membership: TeamMembership,
  week: string,
  agg: MemberAggregate,
): Promise<boolean> {
  const now = Date.now();
  const sk = `${week}#${membership.userId}`;
  const stats = buildStatsAttribute(agg, membership.shareLevel);
  const expiresAt = computeExpiresAt(week);

  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TEAM_STATS_TABLE,
        Key: marshall({ teamId: membership.teamId, "period#userId": sk }),
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
          "attribute_not_exists(computedAt) OR computedAt <= :computedAt",
        ExpressionAttributeNames: { "#period": "period" },
        ExpressionAttributeValues: marshall({
          ":period": week,
          ":userId": membership.userId,
          ":displayName": membership.displayName,
          ":shareLevel": membership.shareLevel,
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
      console.log(
        `Skipping stale TeamStats update team=${membership.teamId} week=${week} user=${membership.userId}`,
      );
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// AppSync subscription notification
// ---------------------------------------------------------------------------

/**
 * Fire the `refreshTeamStats` AppSync mutation (IAM SigV4) to trigger the
 * `onTeamStatsUpdated` subscription. Best-effort — failures never fail the
 * stream batch.
 */
async function notifySubscribers(teamId: string, period: string): Promise<void> {
  if (!APPSYNC_ENDPOINT) {
    console.warn("APPSYNC_ENDPOINT not configured, skipping notification");
    return;
  }

  const mutation = `
    mutation RefreshTeamStats($teamId: ID!, $period: String!) {
      refreshTeamStats(teamId: $teamId, period: $period) { teamId period computedAt }
    }
  `;
  const body = JSON.stringify({ query: mutation, variables: { teamId, period } });
  const url = new URL(APPSYNC_ENDPOINT);

  const request = new HttpRequest({
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: { "Content-Type": "application/json", host: url.hostname },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION ?? "us-east-1",
    service: "appsync",
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  const response = await fetch(`https://${signed.hostname}${signed.path}`, {
    method: signed.method,
    headers: signed.headers as Record<string, string>,
    body: signed.body as string,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `AppSync refreshTeamStats failed: ${response.status} ${response.statusText}`,
      text,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  console.log(`Processing ${event.Records.length} stream record(s)`);

  // 1. Collapse the batch to distinct (userId, ISO-week) recompute units.
  const units = affectedWeeks(event.Records);
  if (units.length === 0) {
    console.log("No actionable aggregate rows in batch");
    return;
  }
  console.log(`Recomputing ${units.length} (user, week) unit(s)`);

  // 2. Cache memberships per user across this batch (one user, many weeks).
  const membershipsByUser = new Map<string, TeamMembership[]>();
  const getMemberships = async (userId: string): Promise<TeamMembership[]> => {
    const cached = membershipsByUser.get(userId);
    if (cached) return cached;
    let memberships: TeamMembership[] = [];
    try {
      memberships = await getUserTeamMemberships(userId);
    } catch (err) {
      console.error(`Failed to fetch memberships for user=${userId}`, err);
    }
    membershipsByUser.set(userId, memberships);
    return memberships;
  };

  const updatedTeamPeriods = new Set<string>();

  // 3. Recompute each unit: re-read the week, aggregate per team, upsert.
  for (const unit of units) {
    try {
      const memberships = await getMemberships(unit.userId);
      if (memberships.length === 0) continue;

      const weekDays = await getUserWeekDays(unit.userId, unit.week);

      for (const membership of memberships) {
        // Only the day-rows whose account this member shares with the team.
        const relevant = weekDays.filter((r) =>
          membership.sharedAccounts.includes(r.accountId),
        );
        if (relevant.length === 0) continue;

        const agg = computeMemberAggregate(relevant);
        const written = await writeMemberStats(membership, unit.week, agg);
        if (written) {
          updatedTeamPeriods.add(`${membership.teamId}#${unit.week}`);
          console.log(
            `Updated TeamStats team=${membership.teamId} week=${unit.week} user=${unit.userId} sessions=${agg.sessions}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `Failed to recompute user=${unit.userId} week=${unit.week}`,
        err,
      );
      // Continue with the other units.
    }
  }

  // 4. Notify subscribers per updated (teamId, week) — best-effort.
  for (const tp of updatedTeamPeriods) {
    const idx = tp.lastIndexOf("#");
    const teamId = tp.slice(0, idx);
    const period = tp.slice(idx + 1);
    try {
      await notifySubscribers(teamId, period);
    } catch (err) {
      console.error(
        `Failed to notify subscribers team=${teamId} period=${period}`,
        err,
      );
    }
  }

  console.log(
    `Completed: ${units.length} unit(s), ${updatedTeamPeriods.size} notification(s)`,
  );
};
