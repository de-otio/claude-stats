/**
 * challenge-scoring Lambda
 *
 * EventBridge-triggered (hourly). Scores active intra-team challenges by
 * reading TeamStats for each participant, computing per-participant scores
 * based on the challenge metric, ranking participants, and updating the
 * Challenges table. Auto-completes challenges past their endTime.
 */

import type { ScheduledEvent } from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

const ddb = new DynamoDBClient({});

const CHALLENGES_TABLE = process.env.CHALLENGES_TABLE!;
const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Participant {
  userId: string;
  score: number;
  rank: number;
  joinedAt: number;
}

interface Challenge {
  teamId: string;
  challengeId: string;
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
  status: string;
  participants: Record<string, { score: number; rank: number }>;
}

interface TeamStatItem {
  userId: string;
  period: string;
  stats: {
    prompts: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    estimatedCost?: number;
    sessions: number;
    activeMinutes: number;
    modelsUsed?: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

/**
 * Return the ISO week string (e.g. "2026-W11") for a given epoch-seconds
 * timestamp.
 */
function isoWeekForTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  // Thursday of the current week determines the ISO year/week
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Return all distinct ISO week strings that overlap with [startEpoch, endEpoch].
 */
function isoWeeksInRange(startEpoch: number, endEpoch: number): string[] {
  const weeks = new Set<string>();
  // Step day-by-day from start to end to collect all weeks
  let cursor = startEpoch;
  while (cursor <= endEpoch) {
    weeks.add(isoWeekForTimestamp(cursor));
    cursor += 86400; // advance one day
  }
  // Always include the final timestamp's week
  weeks.add(isoWeekForTimestamp(endEpoch));
  return Array.from(weeks);
}

// ---------------------------------------------------------------------------
// DynamoDB queries
// ---------------------------------------------------------------------------

/**
 * Fetch all active challenges across all teams by scanning the Challenges
 * table with a status filter. (The Challenges table is small and has no
 * status GSI -- the scan is acceptable per the data model doc.)
 */
async function fetchActiveChallenges(): Promise<Challenge[]> {
  const challenges: Challenge[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: CHALLENGES_TABLE,
        FilterExpression: "#s = :active",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: marshall({ ":active": "active" }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const u = unmarshall(item) as Challenge;
      challenges.push(u);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return challenges;
}

/**
 * Fetch team memberships so we know each participant's joinedAt time (used
 * for tie-breaking).
 */
async function fetchMemberJoinTimes(
  teamId: string,
): Promise<Record<string, number>> {
  const joinTimes: Record<string, number> = {};
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TEAM_MEMBERSHIPS_TABLE,
        KeyConditionExpression: "teamId = :tid",
        ExpressionAttributeValues: marshall({ ":tid": teamId }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const u = unmarshall(item);
      joinTimes[u.userId as string] = u.joinedAt as number;
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return joinTimes;
}

/**
 * Fetch TeamStats rows for a given team and set of periods, returning only
 * the rows whose userId is in the provided participant set.
 */
async function fetchTeamStats(
  teamId: string,
  periods: string[],
  participantIds: Set<string>,
): Promise<Map<string, TeamStatItem[]>> {
  const statsByUser = new Map<string, TeamStatItem[]>();

  for (const period of periods) {
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: TEAM_STATS_TABLE,
          KeyConditionExpression:
            "teamId = :tid AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#sk": "period#userId" },
          ExpressionAttributeValues: marshall({
            ":tid": teamId,
            ":prefix": `${period}#`,
          }),
          ExclusiveStartKey: lastKey,
        }),
      );

      for (const item of result.Items ?? []) {
        const u = unmarshall(item) as any;
        const userId = u.userId as string;
        if (!participantIds.has(userId)) continue;

        const stat: TeamStatItem = {
          userId,
          period: u.period,
          stats: u.stats,
        };

        const existing = statsByUser.get(userId);
        if (existing) {
          existing.push(stat);
        } else {
          statsByUser.set(userId, [stat]);
        }
      }

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  return statsByUser;
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

/**
 * Compute a single numeric score for a participant given their aggregated
 * TeamStats rows and the challenge metric.
 *
 * Supported metrics:
 *   haiku_pct          - % of output tokens from Haiku models
 *   prompts            - total prompt count
 *   cache_rate         - cache read tokens / (input + cache read + cache creation)
 *   avg_session_length - average active minutes per session
 *   cost_per_prompt    - total cost / total prompts (lower is better, inverted for ranking)
 */
function computeScore(
  stats: TeamStatItem[],
  metric: string,
): number {
  if (stats.length === 0) return 0;

  switch (metric) {
    case "haiku_pct": {
      let haikuTokens = 0;
      let totalOutputTokens = 0;
      for (const s of stats) {
        totalOutputTokens += s.stats.outputTokens ?? 0;
        if (s.stats.modelsUsed) {
          for (const [model, count] of Object.entries(s.stats.modelsUsed)) {
            if (model.toLowerCase().includes("haiku")) {
              haikuTokens += count;
            }
          }
        }
      }
      return totalOutputTokens > 0 ? (haikuTokens / totalOutputTokens) * 100 : 0;
    }

    case "prompts": {
      let total = 0;
      for (const s of stats) {
        total += s.stats.prompts ?? 0;
      }
      return total;
    }

    case "cache_rate": {
      let cacheRead = 0;
      let totalInput = 0;
      for (const s of stats) {
        const cr = s.stats.cacheReadTokens ?? 0;
        const cc = s.stats.cacheCreationTokens ?? 0;
        const inp = s.stats.inputTokens ?? 0;
        cacheRead += cr;
        totalInput += inp + cr + cc;
      }
      return totalInput > 0 ? (cacheRead / totalInput) * 100 : 0;
    }

    case "avg_session_length": {
      let totalMinutes = 0;
      let totalSessions = 0;
      for (const s of stats) {
        totalMinutes += s.stats.activeMinutes ?? 0;
        totalSessions += s.stats.sessions ?? 0;
      }
      return totalSessions > 0 ? totalMinutes / totalSessions : 0;
    }

    case "cost_per_prompt": {
      let totalCost = 0;
      let totalPrompts = 0;
      for (const s of stats) {
        totalCost += s.stats.estimatedCost ?? 0;
        totalPrompts += s.stats.prompts ?? 0;
      }
      // Lower cost_per_prompt is better, so we invert: score = 1/cpp
      // Guard against division by zero
      if (totalPrompts === 0 || totalCost === 0) return 0;
      return 1 / (totalCost / totalPrompts);
    }

    default:
      console.warn(`Unknown challenge metric: ${metric}, defaulting to 0`);
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank participants by score descending. Ties broken by earliest joinedAt.
 */
function rankParticipants(
  scored: { userId: string; score: number }[],
  joinTimes: Record<string, number>,
): Participant[] {
  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Earlier join wins (lower timestamp)
    const aJoin = joinTimes[a.userId] ?? Number.MAX_SAFE_INTEGER;
    const bJoin = joinTimes[b.userId] ?? Number.MAX_SAFE_INTEGER;
    return aJoin - bJoin;
  });

  return sorted.map((entry, idx) => ({
    userId: entry.userId,
    score: Math.round(entry.score * 1000) / 1000, // 3 decimal places
    rank: idx + 1,
    joinedAt: joinTimes[entry.userId] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// DynamoDB update
// ---------------------------------------------------------------------------

/**
 * Write updated participant scores/ranks back to the Challenges table.
 */
async function updateChallengeScores(
  teamId: string,
  challengeId: string,
  ranked: Participant[],
): Promise<void> {
  const participantsMap: Record<string, { score: number; rank: number }> = {};
  for (const p of ranked) {
    participantsMap[p.userId] = { score: p.score, rank: p.rank };
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: CHALLENGES_TABLE,
      Key: marshall({ teamId, challengeId }),
      UpdateExpression: "SET participants = :p, updatedAt = :now",
      ExpressionAttributeValues: marshall({
        ":p": participantsMap,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

/**
 * Mark a challenge as completed.
 */
async function completeChallenge(
  teamId: string,
  challengeId: string,
): Promise<void> {
  await ddb.send(
    new UpdateItemCommand({
      TableName: CHALLENGES_TABLE,
      Key: marshall({ teamId, challengeId }),
      UpdateExpression: "SET #s = :completed, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: marshall({
        ":completed": "completed",
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: ScheduledEvent): Promise<void> => {
  console.log("challenge-scoring invoked", { time: event.time });

  const now = Math.floor(Date.now() / 1000);

  let challenges: Challenge[];
  try {
    challenges = await fetchActiveChallenges();
  } catch (err) {
    console.error("Failed to fetch active challenges", err);
    throw err;
  }

  if (challenges.length === 0) {
    console.log("No active challenges found, exiting.");
    return;
  }

  console.log(`Processing ${challenges.length} active challenge(s)`);

  for (const challenge of challenges) {
    try {
      // 1. Auto-complete if past endTime
      if (now >= challenge.endTime) {
        console.log(
          `Challenge ${challenge.challengeId} (team ${challenge.teamId}) ` +
            `past endTime, completing.`,
        );
        // Do a final scoring pass before completing
        await scoreChallenge(challenge, now);
        await completeChallenge(challenge.teamId, challenge.challengeId);
        console.log(`Challenge ${challenge.challengeId} marked completed.`);
        continue;
      }

      // 2. Score active challenge
      await scoreChallenge(challenge, now);
    } catch (err) {
      // Log and continue to next challenge -- don't let one failure block others
      console.error(
        `Error scoring challenge ${challenge.challengeId} ` +
          `(team ${challenge.teamId}):`,
        err,
      );
    }
  }

  console.log("challenge-scoring complete.");
};

/**
 * Score a single challenge: read stats, compute scores, rank, and persist.
 */
async function scoreChallenge(
  challenge: Challenge,
  now: number,
): Promise<void> {
  const participantIds = new Set(Object.keys(challenge.participants ?? {}));
  if (participantIds.size === 0) {
    console.log(
      `Challenge ${challenge.challengeId} has no participants, skipping.`,
    );
    return;
  }

  // Determine which ISO weeks overlap the challenge window
  const effectiveEnd = Math.min(now, challenge.endTime);
  const periods = isoWeeksInRange(challenge.startTime, effectiveEnd);

  // Fetch member join times for tie-breaking
  const joinTimes = await fetchMemberJoinTimes(challenge.teamId);

  // Fetch TeamStats for all overlapping periods
  const statsByUser = await fetchTeamStats(
    challenge.teamId,
    periods,
    participantIds,
  );

  // Compute scores
  const scored: { userId: string; score: number }[] = [];
  for (const userId of participantIds) {
    const userStats = statsByUser.get(userId) ?? [];
    const score = computeScore(userStats, challenge.metric);
    scored.push({ userId, score });
  }

  // Rank and persist
  const ranked = rankParticipants(scored, joinTimes);
  await updateChallengeScores(
    challenge.teamId,
    challenge.challengeId,
    ranked,
  );

  console.log(
    `Scored challenge ${challenge.challengeId}: ` +
      `${ranked.length} participants, metric=${challenge.metric}`,
  );
}
