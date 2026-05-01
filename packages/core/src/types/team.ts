/**
 * Team-app domain types — Teams, memberships, stats, gamification.
 * Derived from doc/analysis/team-app/04-data-model.md and 05-api-design.md.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export type TeamRole = "admin" | "member";
export type ShareLevel = "full" | "summary" | "minimal";
export type ChallengeStatus = "active" | "completed";
export type InterTeamChallengeStatus = "pending" | "active" | "completed";
export type CrossTeamVisibility = "private" | "public_stats" | "public_dashboard";
export type AchievementCategory = "productivity" | "efficiency" | "team" | "milestones" | "fun";

// ── Teams ──────────────────────────────────────────────────────────────────

export interface TeamSettings {
  leaderboardEnabled: boolean;
  leaderboardCategories: string[];
  challengesEnabled: boolean;
  minMembersForAggregates: number;
  crossTeamVisibility: CrossTeamVisibility;
}

export interface Team {
  teamId: string;
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  createdBy: string;
  createdAt: number;
  inviteCode: string;
  inviteCodeExpiresAt: number;
  settings: TeamSettings;
  dashboardReaders: string[];
  memberCount: number;
  updatedAt: number;
}

export interface TeamMembership {
  teamId: string;
  userId: string;
  role: TeamRole;
  joinedAt: number;
  displayName: string;
  shareLevel: ShareLevel;
  sharedAccounts: string[];
  updatedAt: number;
}

// ── Stats ──────────────────────────────────────────────────────────────────

export interface ProjectBreakdownEntry {
  projectId: string | null;
  sessions: number;
  prompts: number;
  estimatedCost: number;
}

export interface TeamMemberStats {
  sessions: number;
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  activeMinutes: number;
  modelsUsed: Record<string, number> | null;
  topTools: string[] | null;
  streakDays: number;
  achievements: string[];
  velocityTokensPerMin: number;
  subagentRatio: number;
  projectBreakdown: ProjectBreakdownEntry[] | null;
}

export interface TeamStatsRecord {
  teamId: string;
  period: string;
  userId: string;
  displayName: string;
  shareLevel: ShareLevel;
  stats: TeamMemberStats;
  computedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface TeamAggregate {
  totalSessions: number;
  totalPrompts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCost: number;
  activeMemberCount: number;
  avgSessionsPerMember: number;
  avgCostPerMember: number;
}

// ── Leaderboard ────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  value: number;
  formattedValue: string;
}

export interface LeaderboardCategory {
  name: string;
  awardName: string;
  rankings: LeaderboardEntry[];
}

// ── Gamification ───────────────────────────────────────────────────────────

export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  weekendGraceEnabled: boolean;
  freezeTokensRemaining: number;
  lastActiveDate: string | null;
}

export interface Achievement {
  achievementId: string;
  name: string;
  description: string;
  category: AchievementCategory;
  icon: string;
  unlockedAt: number;
  shared: boolean;
  context: Record<string, unknown> | null;
}

export interface AchievementDefinition {
  achievementId: string;
  name: string;
  description: string;
  category: AchievementCategory;
  icon: string;
  threshold: Record<string, unknown>;
  hidden: boolean;
}

export interface Challenge {
  challengeId: string;
  teamId: string;
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
  createdBy: string;
  participants: Record<string, { score: number; rank: number }>;
  status: ChallengeStatus;
  updatedAt: number;
  expiresAt: number;
}

export interface InterTeamChallengeTeam {
  teamId: string;
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  score: number;
  rank: number;
}

export interface InterTeamChallenge {
  challengeId: string;
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
  createdBy: string;
  creatingTeamId: string;
  teams: Record<string, InterTeamChallengeTeam>;
  status: InterTeamChallengeStatus;
  inviteCode: string;
  inviteCodeExpiresAt: number;
  updatedAt: number;
  expiresAt: number;
}

// ── Dashboard composites ───────────────────────────────────────────────────

export interface TeamChemistry {
  score: number;
  breakdown: {
    diversityBonus: number;
    coverageBonus: number;
    syncBonus: number;
    streakBonus: number;
    challengeBonus: number;
    balancePenalty: number;
  };
}

export interface Superlative {
  label: string;
  displayName: string;
  value: string;
}

export interface MemberCard {
  userId: string;
  displayName: string;
  personalityType: string | null;
  streak: StreakInfo | null;
  stats: TeamMemberStats | null;
  recentAchievements: Achievement[];
}

export interface TeamComparisonEntry {
  teamId: string;
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  memberCount: number;
  aggregate: TeamAggregate | null;
}

// ── Project insights ───────────────────────────────────────────────────────

export interface ProjectContributor {
  displayName: string;
  sessions: number;
  prompts: number;
}

export interface ProjectTrendPoint {
  date: string;
  sessions: number;
  prompts: number;
  estimatedCost: number;
}

export interface ProjectInsights {
  projectId: string;
  period: string;
  totalSessions: number;
  totalPrompts: number;
  totalTokens: number;
  estimatedCost: number;
  contributors: ProjectContributor[];
  modelsUsed: Record<string, number> | null;
  trend: ProjectTrendPoint[];
}
