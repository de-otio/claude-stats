import type { AppSyncResolverEvent } from "aws-lambda";
import {
  DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

// ---------------------------------------------------------------------------
// Environment & clients
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});

const TEAM_STATS_TABLE = process.env.TEAM_STATS_TABLE!;
const TEAM_MEMBERSHIPS_TABLE = process.env.TEAM_MEMBERSHIPS_TABLE!;
const ACHIEVEMENTS_TABLE = process.env.ACHIEVEMENTS_TABLE!;
const CHALLENGES_TABLE = process.env.CHALLENGES_TABLE!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamDashboardArgs {
  teamId: string;
  period: string; // e.g. "2026-W11", "2026-03", "2026-03-12"
}

/** Share levels in descending order of openness. */
type ShareLevel = "full" | "summary" | "minimal";
type TeamRole = "ADMIN" | "MEMBER";

interface Membership {
  userId: string;
  teamId: string;
  displayName: string;
  role: TeamRole;
  shareLevel: ShareLevel;
  joinedAt: number;
}

interface MemberStatRow {
  userId: string;
  period: string;
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  activeMinutes: number;
  modelsUsed: string[]; // stored as string set or JSON
  topTools: string[];
  velocityTokensPerMin: number;
  subagentRatio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  currentStreak: number;
  longestStreak: number;
  weekendGraceEnabled: boolean;
  freezeTokensRemaining: number;
  lastActiveDate: string | null;
  lastSyncedAt: number;
  activeHours: number[]; // 0-23 array of hours with activity
  longestConversationMinutes: number;
  longestConversationPrompts: number;
  mostExpensiveTurnCost: number;
  fastestSessionPrompts: number;
  fastestSessionMinutes: number;
  biggestCacheSavePercent: number;
  biggestCacheSaveDollars: number;
  maxToolsInOneTurn: number;
  projectBreakdown: ProjectStats[];
}

interface ProjectStats {
  projectId: string;
  sessions: number;
  prompts: number;
  estimatedCost: number;
}

interface TeamSettings {
  leaderboardEnabled: boolean;
  leaderboardCategories: string[];
  challengesEnabled: boolean;
  minMembersForAggregates: number;
  crossTeamVisibility: string;
}

// -- Response types (matching GraphQL schema) --

interface TeamDashboard {
  team: Team;
  period: string;
  aggregate: TeamAggregate | null;
  leaderboard: Leaderboard | null;
  memberCards: MemberCard[];
  chemistry: TeamChemistry | null;
  superlatives: Superlative[];
  projectSummary: ProjectStats[];
  computedAt: number;
}

interface Team {
  teamId: string;
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  memberCount: number;
  settings: TeamSettings;
  members: TeamMemberRef[];
  currentChallenge: Challenge | null;
}

interface TeamMemberRef {
  userId: string;
  displayName: string;
  role: TeamRole;
  shareLevel: ShareLevel;
  joinedAt: number;
}

interface TeamAggregate {
  totalSessions: number;
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  activeMemberCount: number;
  avgSessionsPerMember: number;
  avgCostPerMember: number;
}

interface Leaderboard {
  categories: LeaderboardCategory[];
}

interface LeaderboardCategory {
  name: string;
  awardName: string;
  rankings: LeaderboardEntry[];
}

interface LeaderboardEntry {
  rank: number;
  displayName: string;
  value: number;
  formattedValue: string;
}

interface MemberCard {
  userId: string;
  displayName: string;
  personalityType: string | null;
  streak: StreakInfo | null;
  stats: MemberStats | null;
  recentAchievements: Achievement[] | null;
}

interface MemberStats {
  sessions: number;
  prompts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  activeMinutes: number | null;
  modelsUsed: string | null; // JSON string
  topTools: string[] | null;
  velocityTokensPerMin: number | null;
  subagentRatio: number | null;
  projectBreakdown: ProjectStats[] | null;
}

interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  weekendGraceEnabled: boolean;
  freezeTokensRemaining: number;
  lastActiveDate: string | null;
}

interface TeamChemistry {
  score: number;
  breakdown: ChemistryBreakdown;
}

interface ChemistryBreakdown {
  diversityBonus: number;
  coverageBonus: number;
  syncBonus: number;
  streakBonus: number;
  challengeBonus: number;
  balancePenalty: number;
}

interface Superlative {
  label: string;
  displayName: string;
  value: string;
}

interface Achievement {
  achievementId: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  unlockedAt: number;
  shared: boolean;
  context: string | null;
}

interface Challenge {
  challengeId: string;
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
  status: string;
  participants: ChallengeParticipant[];
}

interface ChallengeParticipant {
  userId: string;
  displayName: string;
  score: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: AppSyncResolverEvent<TeamDashboardArgs>,
): Promise<TeamDashboard> => {
  const { teamId, period } = event.arguments;
  const callerId =
    (event.identity as { sub?: string } | undefined)?.sub ?? "";

  if (!callerId) {
    throw new Error("Unauthorized: missing caller identity");
  }

  // 1. Verify team membership
  const memberships = await queryAllMemberships(teamId);
  const callerMembership = memberships.find((m) => m.userId === callerId);
  if (!callerMembership) {
    throw new Error("Unauthorized: you are not a member of this team");
  }

  // Derive team metadata from membership records
  const teamMeta = await deriveTeamMeta(teamId, memberships);
  const settings = teamMeta.settings;

  // 2. Query TeamStats for the team and period
  const memberStats = await queryTeamStats(teamId, period);

  // Build a map of userId -> stat row
  const statsByUser = new Map<string, MemberStatRow>();
  for (const row of memberStats) {
    statsByUser.set(row.userId, row);
  }

  // Build a membership map for display name lookups
  const membershipMap = new Map<string, Membership>();
  for (const m of memberships) {
    membershipMap.set(m.userId, m);
  }

  // Active members = those with stats in this period
  const activeMembers = memberStats.filter((s) => s.sessions > 0);
  const activeMemberCount = activeMembers.length;
  const meetsMinMembers =
    activeMemberCount >= settings.minMembersForAggregates;

  // 3. Assemble TeamAggregate (only if >= minMembersForAggregates)
  const aggregate = meetsMinMembers
    ? computeAggregate(activeMembers)
    : null;

  // 4. Assemble Leaderboard (if enabled and meets min members)
  const leaderboard =
    settings.leaderboardEnabled && meetsMinMembers
      ? computeLeaderboard(activeMembers, membershipMap, settings)
      : null;

  // 5. Assemble MemberCards with share-level filtering
  const achievements = await queryTeamAchievements(
    memberships.map((m) => m.userId),
  );
  const memberCards = assembleMemberCards(
    memberships,
    statsByUser,
    achievements,
  );

  // 6. Compute TeamChemistry
  const activeChallenge = await queryActiveChallenge(teamId);
  const chemistry = meetsMinMembers
    ? computeChemistry(activeMembers, memberships, activeChallenge)
    : null;

  // 7. Compute Superlatives
  const superlatives = meetsMinMembers
    ? computeSuperlatives(activeMembers, membershipMap)
    : [];

  // 8. Project summary (aggregated across sharing members)
  const projectSummary = computeProjectSummary(activeMembers, membershipMap);

  return {
    team: {
      teamId,
      teamName: teamMeta.teamName,
      teamSlug: teamMeta.teamSlug,
      logoUrl: teamMeta.logoUrl,
      memberCount: memberships.length,
      settings,
      members: memberships.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        role: m.role,
        shareLevel: m.shareLevel,
        joinedAt: m.joinedAt,
      })),
      currentChallenge: activeChallenge,
    },
    period,
    aggregate,
    leaderboard,
    memberCards,
    chemistry,
    superlatives,
    projectSummary,
    computedAt: Math.floor(Date.now() / 1000),
  };
};

// ---------------------------------------------------------------------------
// DynamoDB queries
// ---------------------------------------------------------------------------

async function queryAllMemberships(teamId: string): Promise<Membership[]> {
  const params: QueryCommandInput = {
    TableName: TEAM_MEMBERSHIPS_TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: `TEAM#${teamId}` },
    },
  };

  const items: Membership[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const result = await ddb.send(new QueryCommand(params));
    for (const item of result.Items ?? []) {
      const u = unmarshall(item);
      items.push({
        userId: u.userId,
        teamId: u.teamId ?? teamId,
        displayName: u.displayName ?? "Unknown",
        role: u.role ?? "MEMBER",
        shareLevel: u.shareLevel ?? "summary",
        joinedAt: u.joinedAt ?? 0,
      });
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

async function queryTeamStats(
  teamId: string,
  period: string,
): Promise<MemberStatRow[]> {
  const params: QueryCommandInput = {
    TableName: TEAM_STATS_TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": { S: `TEAM#${teamId}` },
      ":sk": { S: `${period}#` },
    },
  };

  const items: MemberStatRow[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const result = await ddb.send(new QueryCommand(params));
    for (const item of result.Items ?? []) {
      const u = unmarshall(item);
      items.push(parseMemberStatRow(u));
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

function parseMemberStatRow(u: Record<string, any>): MemberStatRow {
  return {
    userId: u.userId ?? "",
    period: u.period ?? "",
    sessions: u.sessions ?? 0,
    prompts: u.prompts ?? 0,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    estimatedCost: u.estimatedCost ?? 0,
    activeMinutes: u.activeMinutes ?? 0,
    modelsUsed: parseJsonArray(u.modelsUsed),
    topTools: parseJsonArray(u.topTools),
    velocityTokensPerMin: u.velocityTokensPerMin ?? 0,
    subagentRatio: u.subagentRatio ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheCreationTokens: u.cacheCreationTokens ?? 0,
    currentStreak: u.currentStreak ?? 0,
    longestStreak: u.longestStreak ?? 0,
    weekendGraceEnabled: u.weekendGraceEnabled ?? false,
    freezeTokensRemaining: u.freezeTokensRemaining ?? 0,
    lastActiveDate: u.lastActiveDate ?? null,
    lastSyncedAt: u.lastSyncedAt ?? 0,
    activeHours: parseJsonArray(u.activeHours),
    longestConversationMinutes: u.longestConversationMinutes ?? 0,
    longestConversationPrompts: u.longestConversationPrompts ?? 0,
    mostExpensiveTurnCost: u.mostExpensiveTurnCost ?? 0,
    fastestSessionPrompts: u.fastestSessionPrompts ?? 0,
    fastestSessionMinutes: u.fastestSessionMinutes ?? 0,
    biggestCacheSavePercent: u.biggestCacheSavePercent ?? 0,
    biggestCacheSaveDollars: u.biggestCacheSaveDollars ?? 0,
    maxToolsInOneTurn: u.maxToolsInOneTurn ?? 0,
    projectBreakdown: parseProjectBreakdown(u.projectBreakdown),
  };
}

function parseJsonArray(val: unknown): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseProjectBreakdown(val: unknown): ProjectStats[] {
  const arr = parseJsonArray(val);
  return arr.map((p: any) => ({
    projectId: p.projectId ?? "",
    sessions: p.sessions ?? 0,
    prompts: p.prompts ?? 0,
    estimatedCost: p.estimatedCost ?? 0,
  }));
}

async function queryTeamAchievements(
  userIds: string[],
): Promise<Map<string, Achievement[]>> {
  const achievementsByUser = new Map<string, Achievement[]>();

  // Query achievements for each user (batched queries)
  // Limit to recent achievements (last 10 per user)
  for (const userId of userIds) {
    try {
      const result = await ddb.send(
        new QueryCommand({
          TableName: ACHIEVEMENTS_TABLE,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${userId}` },
          },
          ScanIndexForward: false,
          Limit: 10,
        }),
      );

      const achievements: Achievement[] = [];
      for (const item of result.Items ?? []) {
        const u = unmarshall(item);
        // Only include shared achievements for team view
        if (u.shared) {
          achievements.push({
            achievementId: u.achievementId ?? u.SK ?? "",
            name: u.name ?? "",
            description: u.description ?? "",
            category: u.category ?? "MILESTONES",
            icon: u.icon ?? "",
            unlockedAt: u.unlockedAt ?? 0,
            shared: true,
            context: u.context ? JSON.stringify(u.context) : null,
          });
        }
      }
      achievementsByUser.set(userId, achievements);
    } catch {
      // If achievements query fails for one user, continue
      achievementsByUser.set(userId, []);
    }
  }

  return achievementsByUser;
}

async function queryActiveChallenge(
  teamId: string,
): Promise<Challenge | null> {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: CHALLENGES_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": { S: `TEAM#${teamId}` },
          ":sk": { S: "CHALLENGE#" },
        },
        ScanIndexForward: false,
        Limit: 10,
      }),
    );

    const now = Math.floor(Date.now() / 1000);
    for (const item of result.Items ?? []) {
      const u = unmarshall(item);
      if (u.status === "ACTIVE" && u.endTime > now) {
        return {
          challengeId: u.challengeId ?? u.SK ?? "",
          name: u.name ?? "",
          metric: u.metric ?? "",
          startTime: u.startTime ?? 0,
          endTime: u.endTime ?? 0,
          status: "ACTIVE",
          participants: parseJsonArray(u.participants).map((p: any) => ({
            userId: p.userId ?? "",
            displayName: p.displayName ?? "",
            score: p.score ?? 0,
            rank: p.rank ?? 0,
          })),
        };
      }
    }
  } catch {
    // Challenge query failure is non-fatal
  }

  return null;
}

// ---------------------------------------------------------------------------
// Team metadata (derived from first membership record + team settings)
// ---------------------------------------------------------------------------

interface TeamMeta {
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  settings: TeamSettings;
}

async function deriveTeamMeta(
  teamId: string,
  memberships: Membership[],
): Promise<TeamMeta> {
  // Query the team record itself (stored with SK = "METADATA")
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TEAM_MEMBERSHIPS_TABLE,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": { S: `TEAM#${teamId}` },
          ":sk": { S: "METADATA" },
        },
        Limit: 1,
      }),
    );

    if (result.Items && result.Items.length > 0) {
      const u = unmarshall(result.Items[0]);
      return {
        teamName: u.teamName ?? teamId,
        teamSlug: u.teamSlug ?? teamId,
        logoUrl: u.logoUrl ?? null,
        settings: {
          leaderboardEnabled: u.leaderboardEnabled ?? true,
          leaderboardCategories: parseJsonArray(u.leaderboardCategories),
          challengesEnabled: u.challengesEnabled ?? true,
          minMembersForAggregates: u.minMembersForAggregates ?? 3,
          crossTeamVisibility: u.crossTeamVisibility ?? "PRIVATE",
        },
      };
    }
  } catch {
    // Fall through to defaults
  }

  return {
    teamName: teamId,
    teamSlug: teamId,
    logoUrl: null,
    settings: {
      leaderboardEnabled: true,
      leaderboardCategories: [
        "mostProductive",
        "fastest",
        "mostEfficient",
        "longestStreak",
        "bestCacheRate",
        "modelDiversity",
        "subagentMaster",
      ],
      challengesEnabled: true,
      minMembersForAggregates: 3,
      crossTeamVisibility: "PRIVATE",
    },
  };
}

// ---------------------------------------------------------------------------
// 3. TeamAggregate
// ---------------------------------------------------------------------------

function computeAggregate(activeMembers: MemberStatRow[]): TeamAggregate {
  const count = activeMembers.length;
  const totalSessions = sum(activeMembers, (m) => m.sessions);
  const totalPrompts = sum(activeMembers, (m) => m.prompts);
  const totalInputTokens = sum(activeMembers, (m) => m.inputTokens);
  const totalOutputTokens = sum(activeMembers, (m) => m.outputTokens);
  const totalEstimatedCost = sum(activeMembers, (m) => m.estimatedCost);

  return {
    totalSessions,
    totalPrompts,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCost: round2(totalEstimatedCost),
    activeMemberCount: count,
    avgSessionsPerMember: round2(totalSessions / count),
    avgCostPerMember: round2(totalEstimatedCost / count),
  };
}

// ---------------------------------------------------------------------------
// 4. Leaderboard — top 3 per category (anti-toxicity: only show top 3)
// ---------------------------------------------------------------------------

/** All possible leaderboard category definitions. */
const LEADERBOARD_CATEGORIES: {
  id: string;
  name: string;
  awardName: string;
  metric: (m: MemberStatRow) => number;
  format: (v: number) => string;
  ascending?: boolean; // true = lower is better
}[] = [
  {
    id: "mostProductive",
    name: "Most Productive",
    awardName: "The Machine",
    metric: (m) => m.prompts,
    format: (v) => `${formatNumber(v)} prompts`,
  },
  {
    id: "fastest",
    name: "Fastest",
    awardName: "Speed Demon",
    metric: (m) => m.velocityTokensPerMin,
    format: (v) => `${formatNumber(v)} tok/min`,
  },
  {
    id: "mostEfficient",
    name: "Most Efficient",
    awardName: "The Optimizer",
    metric: (m) => (m.prompts > 0 ? m.estimatedCost / m.prompts : Infinity),
    format: (v) => `$${v.toFixed(4)}/prompt`,
    ascending: true,
  },
  {
    id: "longestStreak",
    name: "Longest Streak",
    awardName: "Iron Will",
    metric: (m) => m.currentStreak,
    format: (v) => `${v} days`,
  },
  {
    id: "bestCacheRate",
    name: "Best Cache Rate",
    awardName: "Cache Money",
    metric: (m) => {
      const total = m.cacheReadTokens + m.cacheCreationTokens + m.inputTokens;
      return total > 0 ? (m.cacheReadTokens / total) * 100 : 0;
    },
    format: (v) => `${v.toFixed(1)}%`,
  },
  {
    id: "modelDiversity",
    name: "Model Diversity",
    awardName: "The Polyglot",
    metric: (m) => m.modelsUsed.length,
    format: (v) => `${v} models`,
  },
  {
    id: "subagentMaster",
    name: "Subagent Master",
    awardName: "The Delegator",
    metric: (m) => m.subagentRatio,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
];

function computeLeaderboard(
  activeMembers: MemberStatRow[],
  membershipMap: Map<string, Membership>,
  settings: TeamSettings,
): Leaderboard {
  const enabledCategories =
    settings.leaderboardCategories.length > 0
      ? settings.leaderboardCategories
      : LEADERBOARD_CATEGORIES.map((c) => c.id);

  const categories: LeaderboardCategory[] = [];

  for (const catDef of LEADERBOARD_CATEGORIES) {
    if (!enabledCategories.includes(catDef.id)) continue;

    // Score each active member
    const scored = activeMembers
      .map((m) => ({
        userId: m.userId,
        displayName: membershipMap.get(m.userId)?.displayName ?? "Unknown",
        value: catDef.metric(m),
      }))
      .filter((s) => isFinite(s.value));

    // Sort: ascending for "lower is better" metrics, descending otherwise
    scored.sort((a, b) =>
      catDef.ascending ? a.value - b.value : b.value - a.value,
    );

    // Top 3 only (anti-toxicity)
    const top3 = scored.slice(0, 3);

    categories.push({
      name: catDef.name,
      awardName: catDef.awardName,
      rankings: top3.map((entry, idx) => ({
        rank: idx + 1,
        displayName: entry.displayName,
        value: round2(entry.value),
        formattedValue: catDef.format(entry.value),
      })),
    });
  }

  return { categories };
}

// ---------------------------------------------------------------------------
// 5. MemberCards with share-level field filtering
// ---------------------------------------------------------------------------

function assembleMemberCards(
  memberships: Membership[],
  statsByUser: Map<string, MemberStatRow>,
  achievementsByUser: Map<string, Achievement[]>,
): MemberCard[] {
  return memberships.map((m) => {
    const row = statsByUser.get(m.userId);
    const achievements = achievementsByUser.get(m.userId) ?? [];

    return {
      userId: m.userId,
      displayName: m.displayName,
      personalityType: null, // computed separately if needed
      streak: row
        ? {
            currentStreak: row.currentStreak,
            longestStreak: row.longestStreak,
            weekendGraceEnabled: row.weekendGraceEnabled,
            freezeTokensRemaining: row.freezeTokensRemaining,
            lastActiveDate: row.lastActiveDate,
          }
        : null,
      stats: row ? filterStatsByShareLevel(row, m.shareLevel) : null,
      recentAchievements: achievements.length > 0 ? achievements : null,
    };
  });
}

/**
 * Defense-in-depth: filter member stats based on their share level.
 *
 * - full:    all fields visible
 * - summary: sessions, prompts, velocity visible; cost, models, tools, projects nulled
 * - minimal: only sessions and prompts visible; everything else nulled
 */
function filterStatsByShareLevel(
  row: MemberStatRow,
  shareLevel: ShareLevel,
): MemberStats {
  switch (shareLevel) {
    case "full":
      return {
        sessions: row.sessions,
        prompts: row.prompts,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        estimatedCost: row.estimatedCost,
        activeMinutes: row.activeMinutes,
        modelsUsed: JSON.stringify(row.modelsUsed),
        topTools: row.topTools,
        velocityTokensPerMin: row.velocityTokensPerMin,
        subagentRatio: row.subagentRatio,
        projectBreakdown: row.projectBreakdown,
      };

    case "summary":
      return {
        sessions: row.sessions,
        prompts: row.prompts,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        estimatedCost: null, // hidden at summary level
        activeMinutes: row.activeMinutes,
        modelsUsed: null, // hidden at summary level
        topTools: null, // hidden at summary level
        velocityTokensPerMin: row.velocityTokensPerMin,
        subagentRatio: row.subagentRatio,
        projectBreakdown: null, // hidden at summary level
      };

    case "minimal":
    default:
      return {
        sessions: row.sessions,
        prompts: row.prompts,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
        activeMinutes: null,
        modelsUsed: null,
        topTools: null,
        velocityTokensPerMin: null,
        subagentRatio: null,
        projectBreakdown: null,
      };
  }
}

// ---------------------------------------------------------------------------
// 6. Team Chemistry Score (0-100 composite)
// ---------------------------------------------------------------------------

/** Model tier classification for diversity bonus. */
function getModelTier(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return "other";
}

function computeChemistry(
  activeMembers: MemberStatRow[],
  allMemberships: Membership[],
  activeChallenge: Challenge | null,
): TeamChemistry {
  const count = activeMembers.length;

  // --- diversityBonus: +15 if team uses all model tiers ---
  const allTiers = new Set<string>();
  for (const m of activeMembers) {
    for (const model of m.modelsUsed) {
      allTiers.add(getModelTier(model));
    }
  }
  const knownTiers = ["opus", "sonnet", "haiku"];
  const tiersUsed = knownTiers.filter((t) => allTiers.has(t)).length;
  const diversityBonus =
    tiersUsed >= knownTiers.length ? 15 : Math.floor((tiersUsed / knownTiers.length) * 15);

  // --- coverageBonus: +12 if active across 18+ hours ---
  const allHours = new Set<number>();
  for (const m of activeMembers) {
    for (const h of m.activeHours) {
      allHours.add(h);
    }
  }
  const coverageBonus =
    allHours.size >= 18 ? 12 : Math.floor((allHours.size / 18) * 12);

  // --- syncBonus: +8 if all members synced today ---
  const todayStr = new Date().toISOString().slice(0, 10);
  const allSyncedToday = allMemberships.every((mem) => {
    const stat = activeMembers.find((s) => s.userId === mem.userId);
    if (!stat) return false;
    return stat.lastActiveDate === todayStr;
  });
  const syncBonus = allSyncedToday ? 8 : 0;

  // --- streakBonus: +10 if all streaks > 7 days ---
  const allStreaksAbove7 =
    activeMembers.length > 0 &&
    activeMembers.every((m) => m.currentStreak > 7);
  const streakBonus = allStreaksAbove7 ? 10 : 0;

  // --- challengeBonus: +5 if active challenge participation ---
  let challengeBonus = 0;
  if (activeChallenge && activeChallenge.participants.length > 0) {
    const participantRatio =
      activeChallenge.participants.length / allMemberships.length;
    // Full bonus if >50% participate, partial otherwise
    challengeBonus =
      participantRatio >= 0.5 ? 5 : Math.floor(participantRatio * 10);
  }

  // --- balancePenalty: -2 per member whose cost is 3x+ average ---
  let balancePenalty = 0;
  if (count > 0) {
    const avgCost =
      sum(activeMembers, (m) => m.estimatedCost) / count;
    if (avgCost > 0) {
      const outliers = activeMembers.filter(
        (m) => m.estimatedCost >= avgCost * 3,
      ).length;
      balancePenalty = outliers * -2;
    }
  }

  const rawScore =
    diversityBonus +
    coverageBonus +
    syncBonus +
    streakBonus +
    challengeBonus +
    balancePenalty;

  // Clamp to 0-100
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    score,
    breakdown: {
      diversityBonus,
      coverageBonus,
      syncBonus,
      streakBonus,
      challengeBonus,
      balancePenalty,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Superlatives (fun weekly stats)
// ---------------------------------------------------------------------------

function computeSuperlatives(
  activeMembers: MemberStatRow[],
  membershipMap: Map<string, Membership>,
): Superlative[] {
  const superlatives: Superlative[] = [];

  if (activeMembers.length === 0) return superlatives;

  const nameOf = (userId: string): string =>
    membershipMap.get(userId)?.displayName ?? "Unknown";

  // Longest conversation
  const longestConv = maxBy(
    activeMembers,
    (m) => m.longestConversationMinutes,
  );
  if (longestConv && longestConv.longestConversationMinutes > 0) {
    const hours = Math.floor(longestConv.longestConversationMinutes / 60);
    const mins = longestConv.longestConversationMinutes % 60;
    const duration =
      hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    superlatives.push({
      label: "Longest conversation",
      displayName: nameOf(longestConv.userId),
      value: `${duration}, ${longestConv.longestConversationPrompts} prompts`,
    });
  }

  // Most expensive turn
  const expensiveTurn = maxBy(
    activeMembers,
    (m) => m.mostExpensiveTurnCost,
  );
  if (expensiveTurn && expensiveTurn.mostExpensiveTurnCost > 0) {
    superlatives.push({
      label: "Most expensive turn",
      displayName: nameOf(expensiveTurn.userId),
      value: `$${expensiveTurn.mostExpensiveTurnCost.toFixed(2)} single prompt`,
    });
  }

  // Fastest session
  const fastest = maxBy(activeMembers, (m) =>
    m.fastestSessionMinutes > 0
      ? m.fastestSessionPrompts / m.fastestSessionMinutes
      : 0,
  );
  if (fastest && fastest.fastestSessionMinutes > 0) {
    superlatives.push({
      label: "Fastest session",
      displayName: nameOf(fastest.userId),
      value: `${fastest.fastestSessionPrompts} prompts in ${fastest.fastestSessionMinutes} min`,
    });
  }

  // Biggest cache save
  const cacheSave = maxBy(
    activeMembers,
    (m) => m.biggestCacheSaveDollars,
  );
  if (cacheSave && cacheSave.biggestCacheSaveDollars > 0) {
    superlatives.push({
      label: "Biggest cache save",
      displayName: nameOf(cacheSave.userId),
      value: `${cacheSave.biggestCacheSavePercent.toFixed(0)}% hits, saved ~$${cacheSave.biggestCacheSaveDollars.toFixed(2)}`,
    });
  }

  // Most tools in one go
  const mostTools = maxBy(activeMembers, (m) => m.maxToolsInOneTurn);
  if (mostTools && mostTools.maxToolsInOneTurn > 0) {
    superlatives.push({
      label: "Most tools in one go",
      displayName: nameOf(mostTools.userId),
      value: `${mostTools.maxToolsInOneTurn} different tools`,
    });
  }

  return superlatives;
}

// ---------------------------------------------------------------------------
// 8. Project Summary (aggregated across sharing members)
// ---------------------------------------------------------------------------

function computeProjectSummary(
  activeMembers: MemberStatRow[],
  membershipMap: Map<string, Membership>,
): ProjectStats[] {
  const projectMap = new Map<
    string,
    { sessions: number; prompts: number; estimatedCost: number }
  >();

  for (const member of activeMembers) {
    const membership = membershipMap.get(member.userId);
    // Only include project data from members at full or summary share level
    if (!membership || membership.shareLevel === "minimal") continue;

    for (const proj of member.projectBreakdown) {
      const existing = projectMap.get(proj.projectId);
      if (existing) {
        existing.sessions += proj.sessions;
        existing.prompts += proj.prompts;
        existing.estimatedCost += proj.estimatedCost;
      } else {
        projectMap.set(proj.projectId, {
          sessions: proj.sessions,
          prompts: proj.prompts,
          estimatedCost: proj.estimatedCost,
        });
      }
    }
  }

  return Array.from(projectMap.entries())
    .map(([projectId, stats]) => ({
      projectId,
      sessions: stats.sessions,
      prompts: stats.prompts,
      estimatedCost: round2(stats.estimatedCost),
    }))
    .sort((a, b) => b.prompts - a.prompts);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sum<T>(arr: T[], fn: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + fn(item), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function maxBy<T>(arr: T[], fn: (item: T) => number): T | undefined {
  if (arr.length === 0) return undefined;
  let best = arr[0];
  let bestVal = fn(best);
  for (let i = 1; i < arr.length; i++) {
    const val = fn(arr[i]);
    if (val > bestVal) {
      best = arr[i];
      bestVal = val;
    }
  }
  return best;
}
