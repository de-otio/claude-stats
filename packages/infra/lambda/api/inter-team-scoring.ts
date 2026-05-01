/**
 * inter-team-scoring Lambda
 *
 * EventBridge-triggered (hourly). Scores active inter-team challenges by
 * reading TeamStats for each participating team, computing team-level metrics
 * normalized per active member count, ranking teams, and updating the
 * InterTeamChallenges table. Handles status transitions:
 *   "pending" -> "active" at startTime
 *   "active"  -> "completed" at endTime
 * Awards team-level achievement badges on completion.
 *
 * DynamoDB stores status in lowercase ("pending", "active", "completed").
 * GraphQL resolvers convert to UPPERCASE ("PENDING", "ACTIVE", "COMPLETED").
 */

import type { ScheduledEvent } from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

const ddb = new DynamoDBClient({});

const INTER_TEAM_CHALLENGES_TABLE = process.env.INTER_TEAM_CHALLENGES_TABLE!;
const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamEntry {
  teamName: string;
  teamSlug: string;
  logoUrl?: string;
  score: number;
  rank: number;
  joinedAt: number;
}

interface InterTeamChallenge {
  challengeId: string;
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
  status: string; // "pending" | "active" | "completed"
  creatingTeamId: string;
  teams: Record<string, TeamEntry>;
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
    streakDays?: number;
  };
}

// Achievement badge name for each metric
const ACHIEVEMENT_BADGES: Record<string, string> = {
  prompts_per_member: "Prompt Champions",
  cost_efficiency: "Efficiency Kings",
  cache_rate: "Cache Masters",
  streak_strength: "Streak Warriors",
  model_diversity: "Model Explorers",
};

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

function isoWeekForTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function isoWeeksInRange(startEpoch: number, endEpoch: number): string[] {
  const weeks = new Set<string>();
  let cursor = startEpoch;
  while (cursor <= endEpoch) {
    weeks.add(isoWeekForTimestamp(cursor));
    cursor += 86400;
  }
  weeks.add(isoWeekForTimestamp(endEpoch));
  return Array.from(weeks);
}

// ---------------------------------------------------------------------------
// DynamoDB queries
// ---------------------------------------------------------------------------

/**
 * Query InterTeamChallenges GSI (InterTeamChallengesByStatus) for a given
 * status value. GSI PK = status, SK = endTime.
 */
async function fetchChallengesByStatus(
  status: string,
): Promise<InterTeamChallenge[]> {
  const challenges: InterTeamChallenge[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: INTER_TEAM_CHALLENGES_TABLE,
        IndexName: "InterTeamChallengesByStatus",
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: marshall({ ":status": status }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      challenges.push(unmarshall(item) as InterTeamChallenge);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return challenges;
}

/**
 * Count active members for a team (all members in TeamMemberships).
 */
async function countTeamMembers(teamId: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TEAM_MEMBERSHIPS_TABLE,
        KeyConditionExpression: "teamId = :tid",
        ExpressionAttributeValues: marshall({ ":tid": teamId }),
        Select: "COUNT",
        ExclusiveStartKey: lastKey,
      }),
    );

    count += result.Count ?? 0;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/**
 * Fetch the joinedAt timestamp for the team's entry in the inter-team
 * challenge (from the teams map). Used for tie-breaking.
 */
function getTeamJoinedAt(
  challenge: InterTeamChallenge,
  teamId: string,
): number {
  return challenge.teams[teamId]?.joinedAt ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Fetch all TeamStats rows for a team across the given periods.
 */
async function fetchTeamStats(
  teamId: string,
  periods: string[],
): Promise<TeamStatItem[]> {
  const allStats: TeamStatItem[] = [];

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
        allStats.push({
          userId: u.userId,
          period: u.period,
          stats: u.stats,
        });
      }

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  return allStats;
}

// ---------------------------------------------------------------------------
// Metric computation (team-level, normalized per active member)
// ---------------------------------------------------------------------------

/**
 * Compute a team-level score from all members' TeamStats, normalized by
 * active member count.
 *
 * Supported metrics:
 *   prompts_per_member  - total prompts / active members
 *   cost_efficiency     - total prompts / total cost (prompts per dollar)
 *   cache_rate          - avg cache hit % across members
 *   streak_strength     - avg streak days across members
 *   model_diversity     - distinct models used / member count
 */
function computeTeamScore(
  stats: TeamStatItem[],
  memberCount: number,
  metric: string,
): number {
  if (stats.length === 0 || memberCount === 0) return 0;

  // Determine distinct active members who have stats
  const activeUserIds = new Set(stats.map((s) => s.userId));
  const activeMemberCount = Math.max(activeUserIds.size, 1);

  switch (metric) {
    case "prompts_per_member": {
      let totalPrompts = 0;
      for (const s of stats) {
        totalPrompts += s.stats.prompts ?? 0;
      }
      return totalPrompts / activeMemberCount;
    }

    case "cost_efficiency": {
      let totalPrompts = 0;
      let totalCost = 0;
      for (const s of stats) {
        totalPrompts += s.stats.prompts ?? 0;
        totalCost += s.stats.estimatedCost ?? 0;
      }
      // Prompts per dollar -- higher is better
      return totalCost > 0 ? totalPrompts / totalCost : 0;
    }

    case "cache_rate": {
      // Compute per-user cache rate, then average across active members
      const userCacheRates = new Map<string, { cacheRead: number; total: number }>();
      for (const s of stats) {
        const cr = s.stats.cacheReadTokens ?? 0;
        const cc = s.stats.cacheCreationTokens ?? 0;
        const inp = s.stats.inputTokens ?? 0;
        const existing = userCacheRates.get(s.userId) ?? {
          cacheRead: 0,
          total: 0,
        };
        existing.cacheRead += cr;
        existing.total += inp + cr + cc;
        userCacheRates.set(s.userId, existing);
      }

      let sumRates = 0;
      for (const { cacheRead, total } of userCacheRates.values()) {
        sumRates += total > 0 ? (cacheRead / total) * 100 : 0;
      }
      return sumRates / activeMemberCount;
    }

    case "streak_strength": {
      // Average streak days across active members.
      // Take the max streak per user (across periods).
      const userMaxStreak = new Map<string, number>();
      for (const s of stats) {
        const streak = s.stats.streakDays ?? 0;
        const current = userMaxStreak.get(s.userId) ?? 0;
        if (streak > current) {
          userMaxStreak.set(s.userId, streak);
        }
      }
      let totalStreak = 0;
      for (const streak of userMaxStreak.values()) {
        totalStreak += streak;
      }
      return totalStreak / activeMemberCount;
    }

    case "model_diversity": {
      // Count distinct models across all members, normalized by member count
      const allModels = new Set<string>();
      for (const s of stats) {
        if (s.stats.modelsUsed) {
          for (const model of Object.keys(s.stats.modelsUsed)) {
            allModels.add(model);
          }
        }
      }
      return allModels.size / activeMemberCount;
    }

    default:
      console.warn(
        `Unknown inter-team challenge metric: ${metric}, defaulting to 0`,
      );
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

interface ScoredTeam {
  teamId: string;
  score: number;
}

function rankTeams(
  scored: ScoredTeam[],
  challenge: InterTeamChallenge,
): { teamId: string; score: number; rank: number }[] {
  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Ties broken by earlier joinedAt
    const aJoin = getTeamJoinedAt(challenge, a.teamId);
    const bJoin = getTeamJoinedAt(challenge, b.teamId);
    return aJoin - bJoin;
  });

  return sorted.map((entry, idx) => ({
    teamId: entry.teamId,
    score: Math.round(entry.score * 1000) / 1000,
    rank: idx + 1,
  }));
}

// ---------------------------------------------------------------------------
// DynamoDB updates
// ---------------------------------------------------------------------------

/**
 * Update the teams map with new scores and ranks.
 */
async function updateChallengeTeamScores(
  challengeId: string,
  ranked: { teamId: string; score: number; rank: number }[],
  existingTeams: Record<string, TeamEntry>,
): Promise<void> {
  // Rebuild the teams map preserving existing metadata (teamName, teamSlug, logoUrl, joinedAt)
  const updatedTeams: Record<string, TeamEntry> = {};
  for (const r of ranked) {
    const existing = existingTeams[r.teamId];
    updatedTeams[r.teamId] = {
      teamName: existing?.teamName ?? "",
      teamSlug: existing?.teamSlug ?? "",
      logoUrl: existing?.logoUrl,
      score: r.score,
      rank: r.rank,
      joinedAt: existing?.joinedAt ?? 0,
    };
  }

  await ddb.send(
    new UpdateItemCommand({
      TableName: INTER_TEAM_CHALLENGES_TABLE,
      Key: marshall({ challengeId }),
      UpdateExpression: "SET teams = :t, updatedAt = :now",
      ExpressionAttributeValues: marshall({
        ":t": updatedTeams,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

/**
 * Transition challenge status.
 */
async function updateChallengeStatus(
  challengeId: string,
  newStatus: string,
): Promise<void> {
  await ddb.send(
    new UpdateItemCommand({
      TableName: INTER_TEAM_CHALLENGES_TABLE,
      Key: marshall({ challengeId }),
      UpdateExpression: "SET #s = :status, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: marshall({
        ":status": newStatus,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Achievement badges
// ---------------------------------------------------------------------------

/**
 * Award a team-level achievement badge to the winning team of a completed
 * inter-team challenge. The badge name is derived from the challenge metric.
 */
async function awardWinnerBadge(
  challenge: InterTeamChallenge,
): Promise<void> {
  const badge = ACHIEVEMENT_BADGES[challenge.metric];
  if (!badge) {
    console.warn(
      `No achievement badge defined for metric: ${challenge.metric}`,
    );
    return;
  }

  // Find the rank-1 team
  let winnerTeamId: string | undefined;
  for (const [teamId, entry] of Object.entries(challenge.teams)) {
    if (entry.rank === 1) {
      winnerTeamId = teamId;
      break;
    }
  }

  if (!winnerTeamId) {
    console.warn(
      `No rank-1 team found for challenge ${challenge.challengeId}`,
    );
    return;
  }

  console.log(
    `Awarding "${badge}" badge to team ${winnerTeamId} ` +
      `for challenge ${challenge.challengeId}`,
  );

  // Store the badge as a team-level field on the inter-team challenge record
  // (the GraphQL layer can also propagate this to the Teams table)
  await ddb.send(
    new UpdateItemCommand({
      TableName: INTER_TEAM_CHALLENGES_TABLE,
      Key: marshall({ challengeId: challenge.challengeId }),
      UpdateExpression:
        "SET winnerTeamId = :wt, winnerBadge = :badge, updatedAt = :now",
      ExpressionAttributeValues: marshall({
        ":wt": winnerTeamId,
        ":badge": badge,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: ScheduledEvent): Promise<void> => {
  console.log("inter-team-scoring invoked", { time: event.time });

  const now = Math.floor(Date.now() / 1000);

  // ---- Phase 1: Activate pending challenges whose startTime has arrived ----
  try {
    const pendingChallenges = await fetchChallengesByStatus("pending");
    for (const challenge of pendingChallenges) {
      if (now >= challenge.startTime) {
        console.log(
          `Activating pending challenge ${challenge.challengeId} ` +
            `(startTime=${challenge.startTime})`,
        );
        await updateChallengeStatus(challenge.challengeId, "active");
      }
    }
  } catch (err) {
    console.error("Failed to process pending challenges", err);
    // Continue to active challenge scoring -- don't block on pending transition errors
  }

  // ---- Phase 2: Score active challenges ----
  let activeChallenges: InterTeamChallenge[];
  try {
    activeChallenges = await fetchChallengesByStatus("active");
  } catch (err) {
    console.error("Failed to fetch active inter-team challenges", err);
    throw err;
  }

  if (activeChallenges.length === 0) {
    console.log("No active inter-team challenges found, exiting.");
    return;
  }

  console.log(
    `Processing ${activeChallenges.length} active inter-team challenge(s)`,
  );

  for (const challenge of activeChallenges) {
    try {
      await scoreInterTeamChallenge(challenge, now);

      // ---- Phase 3: Complete challenges past endTime ----
      if (now >= challenge.endTime) {
        console.log(
          `Inter-team challenge ${challenge.challengeId} past endTime, completing.`,
        );
        await updateChallengeStatus(challenge.challengeId, "completed");

        // Award achievement badge to the winning team
        await awardWinnerBadge(challenge);

        console.log(
          `Inter-team challenge ${challenge.challengeId} marked completed.`,
        );
      }
    } catch (err) {
      console.error(
        `Error scoring inter-team challenge ${challenge.challengeId}:`,
        err,
      );
    }
  }

  console.log("inter-team-scoring complete.");
};

/**
 * Score a single inter-team challenge: for each team, aggregate TeamStats,
 * compute normalized score, rank, and persist.
 */
async function scoreInterTeamChallenge(
  challenge: InterTeamChallenge,
  now: number,
): Promise<void> {
  const teamIds = Object.keys(challenge.teams ?? {});
  if (teamIds.length === 0) {
    console.log(
      `Inter-team challenge ${challenge.challengeId} has no teams, skipping.`,
    );
    return;
  }

  const effectiveEnd = Math.min(now, challenge.endTime);
  const periods = isoWeeksInRange(challenge.startTime, effectiveEnd);

  const scored: ScoredTeam[] = [];

  for (const teamId of teamIds) {
    try {
      // Fetch member count for normalization
      const memberCount = await countTeamMembers(teamId);

      // Fetch all TeamStats for this team across relevant periods
      const stats = await fetchTeamStats(teamId, periods);

      // Compute normalized team-level score
      const score = computeTeamScore(stats, memberCount, challenge.metric);

      scored.push({ teamId, score });
    } catch (err) {
      console.error(
        `Error computing score for team ${teamId} in challenge ` +
          `${challenge.challengeId}:`,
        err,
      );
      // Include team with 0 score so they still appear in rankings
      scored.push({ teamId, score: 0 });
    }
  }

  // Rank teams
  const ranked = rankTeams(scored, challenge);

  // Persist updated scores and ranks
  await updateChallengeTeamScores(
    challenge.challengeId,
    ranked,
    challenge.teams,
  );

  console.log(
    `Scored inter-team challenge ${challenge.challengeId}: ` +
      `${ranked.length} teams, metric=${challenge.metric}`,
  );
}
