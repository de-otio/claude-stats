/**
 * Achievement definitions — static registry of all achievements.
 *
 * Achievements are computed locally during `collect` and synced to the cloud.
 * This file is the source of truth for achievement metadata used by both the
 * client (via availableAchievements query) and the unlockAchievement mutation.
 */

export interface AchievementDefinition {
  achievementId: string;
  name: string;
  description: string;
  category: AchievementCategory;
  icon: string;
  threshold: AchievementThreshold;
  hidden: boolean;
}

export type AchievementCategory =
  | "PRODUCTIVITY"
  | "EFFICIENCY"
  | "TEAM"
  | "MILESTONES"
  | "FUN";

export interface AchievementThreshold {
  metric: string;
  value: number;
  /** Comparison operator. Defaults to "gte" (greater than or equal). */
  comparison?: "gte" | "lte" | "lt" | "gt" | "eq";
}

// ---------------------------------------------------------------------------
// Productivity achievements
// ---------------------------------------------------------------------------

const PRODUCTIVITY: AchievementDefinition[] = [
  {
    achievementId: "first-steps",
    name: "First Steps",
    description: "Complete your first Claude session",
    category: "PRODUCTIVITY",
    icon: "footprints",
    threshold: { metric: "sessions", value: 1 },
    hidden: false,
  },
  {
    achievementId: "centurion",
    name: "Centurion",
    description: "Send 100 prompts",
    category: "PRODUCTIVITY",
    icon: "shield",
    threshold: { metric: "prompts", value: 100 },
    hidden: false,
  },
  {
    achievementId: "marathon",
    name: "Marathon",
    description: "Send 1,000 prompts",
    category: "PRODUCTIVITY",
    icon: "trophy",
    threshold: { metric: "prompts", value: 1000 },
    hidden: false,
  },
  {
    achievementId: "nightowl",
    name: "Nightowl",
    description: "Complete 10 sessions after midnight",
    category: "PRODUCTIVITY",
    icon: "moon",
    threshold: { metric: "midnight_sessions", value: 10 },
    hidden: false,
  },
];

// ---------------------------------------------------------------------------
// Efficiency achievements
// ---------------------------------------------------------------------------

const EFFICIENCY: AchievementDefinition[] = [
  {
    achievementId: "optimizer",
    name: "Optimizer",
    description: "Achieve an average cost per prompt under $0.01",
    category: "EFFICIENCY",
    icon: "chart-down",
    threshold: { metric: "avg_cost_per_prompt", value: 0.01, comparison: "lt" },
    hidden: false,
  },
  {
    achievementId: "cache-master",
    name: "Cache Master",
    description: "Achieve a 90%+ cache hit rate",
    category: "EFFICIENCY",
    icon: "database",
    threshold: { metric: "cache_rate", value: 90 },
    hidden: false,
  },
  {
    achievementId: "haiku-hero",
    name: "Haiku Hero",
    description: "Use Haiku for 50%+ of your prompts",
    category: "EFFICIENCY",
    icon: "feather",
    threshold: { metric: "haiku_pct", value: 50 },
    hidden: false,
  },
];

// ---------------------------------------------------------------------------
// Team achievements
// ---------------------------------------------------------------------------

const TEAM: AchievementDefinition[] = [
  {
    achievementId: "team-player",
    name: "Team Player",
    description: "Join a team",
    category: "TEAM",
    icon: "users",
    threshold: { metric: "teams_joined", value: 1 },
    hidden: false,
  },
  {
    achievementId: "challenger",
    name: "Challenger",
    description: "Participate in 5 challenges",
    category: "TEAM",
    icon: "swords",
    threshold: { metric: "challenges_participated", value: 5 },
    hidden: false,
  },
  {
    achievementId: "leader",
    name: "Leader",
    description: "Win a leaderboard category",
    category: "TEAM",
    icon: "crown",
    threshold: { metric: "leaderboard_wins", value: 1 },
    hidden: false,
  },
];

// ---------------------------------------------------------------------------
// Milestone achievements
// ---------------------------------------------------------------------------

const MILESTONES: AchievementDefinition[] = [
  {
    achievementId: "week-warrior",
    name: "Week Warrior",
    description: "Maintain a 7-day streak",
    category: "MILESTONES",
    icon: "flame",
    threshold: { metric: "streak_days", value: 7 },
    hidden: false,
  },
  {
    achievementId: "month-master",
    name: "Month Master",
    description: "Maintain a 30-day streak",
    category: "MILESTONES",
    icon: "fire",
    threshold: { metric: "streak_days", value: 30 },
    hidden: false,
  },
  {
    achievementId: "century-club",
    name: "Century Club",
    description: "Maintain a 100-day streak",
    category: "MILESTONES",
    icon: "star",
    threshold: { metric: "streak_days", value: 100 },
    hidden: false,
  },
  {
    achievementId: "big-spender",
    name: "Big Spender",
    description: "Accumulate $100+ in total estimated cost",
    category: "MILESTONES",
    icon: "dollar",
    threshold: { metric: "total_cost", value: 100 },
    hidden: false,
  },
];

// ---------------------------------------------------------------------------
// Fun/Secret achievements
// ---------------------------------------------------------------------------

const FUN: AchievementDefinition[] = [
  {
    achievementId: "the-delegator",
    name: "The Delegator",
    description: "Launch 10+ subagent sessions in a single day",
    category: "FUN",
    icon: "briefcase",
    threshold: { metric: "subagent_sessions_in_day", value: 10 },
    hidden: true,
  },
  {
    achievementId: "polyglot",
    name: "Polyglot",
    description: "Use 5+ distinct models in a single week",
    category: "FUN",
    icon: "globe",
    threshold: { metric: "models_in_week", value: 5 },
    hidden: true,
  },
  {
    achievementId: "speed-demon",
    name: "Speed Demon",
    description: "Send 50+ prompts in a single hour",
    category: "FUN",
    icon: "zap",
    threshold: { metric: "prompts_in_hour", value: 50 },
    hidden: true,
  },
];

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  ...PRODUCTIVITY,
  ...EFFICIENCY,
  ...TEAM,
  ...MILESTONES,
  ...FUN,
];

/** Lookup map by achievementId for O(1) validation. */
export const ACHIEVEMENT_BY_ID: Record<string, AchievementDefinition> =
  Object.fromEntries(
    ACHIEVEMENT_DEFINITIONS.map((a) => [a.achievementId, a]),
  );
