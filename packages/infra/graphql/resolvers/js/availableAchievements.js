/**
 * Query.availableAchievements — Return all achievement definitions.
 * Static list hardcoded in the resolver. No DynamoDB call required.
 */
import { util } from "@aws-appsync/utils";

const ACHIEVEMENT_DEFINITIONS = [
  // --- Productivity ---
  {
    achievementId: "first-steps",
    name: "First Steps",
    description: "Complete your first Claude session",
    category: "PRODUCTIVITY",
    icon: "footprints",
    threshold: JSON.stringify({ metric: "sessions", value: 1 }),
    hidden: false,
  },
  {
    achievementId: "centurion",
    name: "Centurion",
    description: "Send 100 prompts",
    category: "PRODUCTIVITY",
    icon: "shield",
    threshold: JSON.stringify({ metric: "prompts", value: 100 }),
    hidden: false,
  },
  {
    achievementId: "marathon",
    name: "Marathon",
    description: "Send 1,000 prompts",
    category: "PRODUCTIVITY",
    icon: "trophy",
    threshold: JSON.stringify({ metric: "prompts", value: 1000 }),
    hidden: false,
  },
  {
    achievementId: "nightowl",
    name: "Nightowl",
    description: "Complete 10 sessions after midnight",
    category: "PRODUCTIVITY",
    icon: "moon",
    threshold: JSON.stringify({ metric: "midnight_sessions", value: 10 }),
    hidden: false,
  },

  // --- Efficiency ---
  {
    achievementId: "optimizer",
    name: "Optimizer",
    description: "Achieve an average cost per prompt under $0.01",
    category: "EFFICIENCY",
    icon: "chart-down",
    threshold: JSON.stringify({ metric: "avg_cost_per_prompt", value: 0.01, comparison: "lt" }),
    hidden: false,
  },
  {
    achievementId: "cache-master",
    name: "Cache Master",
    description: "Achieve a 90%+ cache hit rate",
    category: "EFFICIENCY",
    icon: "database",
    threshold: JSON.stringify({ metric: "cache_rate", value: 90 }),
    hidden: false,
  },
  {
    achievementId: "haiku-hero",
    name: "Haiku Hero",
    description: "Use Haiku for 50%+ of your prompts",
    category: "EFFICIENCY",
    icon: "feather",
    threshold: JSON.stringify({ metric: "haiku_pct", value: 50 }),
    hidden: false,
  },

  // --- Team ---
  {
    achievementId: "team-player",
    name: "Team Player",
    description: "Join a team",
    category: "TEAM",
    icon: "users",
    threshold: JSON.stringify({ metric: "teams_joined", value: 1 }),
    hidden: false,
  },
  {
    achievementId: "challenger",
    name: "Challenger",
    description: "Participate in 5 challenges",
    category: "TEAM",
    icon: "swords",
    threshold: JSON.stringify({ metric: "challenges_participated", value: 5 }),
    hidden: false,
  },
  {
    achievementId: "leader",
    name: "Leader",
    description: "Win a leaderboard category",
    category: "TEAM",
    icon: "crown",
    threshold: JSON.stringify({ metric: "leaderboard_wins", value: 1 }),
    hidden: false,
  },

  // --- Milestones ---
  {
    achievementId: "week-warrior",
    name: "Week Warrior",
    description: "Maintain a 7-day streak",
    category: "MILESTONES",
    icon: "flame",
    threshold: JSON.stringify({ metric: "streak_days", value: 7 }),
    hidden: false,
  },
  {
    achievementId: "month-master",
    name: "Month Master",
    description: "Maintain a 30-day streak",
    category: "MILESTONES",
    icon: "fire",
    threshold: JSON.stringify({ metric: "streak_days", value: 30 }),
    hidden: false,
  },
  {
    achievementId: "century-club",
    name: "Century Club",
    description: "Maintain a 100-day streak",
    category: "MILESTONES",
    icon: "star",
    threshold: JSON.stringify({ metric: "streak_days", value: 100 }),
    hidden: false,
  },
  {
    achievementId: "big-spender",
    name: "Big Spender",
    description: "Accumulate $100+ in total estimated cost",
    category: "MILESTONES",
    icon: "dollar",
    threshold: JSON.stringify({ metric: "total_cost", value: 100 }),
    hidden: false,
  },

  // --- Fun/Secret ---
  {
    achievementId: "the-delegator",
    name: "The Delegator",
    description: "???",
    category: "FUN",
    icon: "briefcase",
    threshold: JSON.stringify({ metric: "subagent_sessions_in_day", value: 10 }),
    hidden: true,
  },
  {
    achievementId: "polyglot",
    name: "Polyglot",
    description: "???",
    category: "FUN",
    icon: "globe",
    threshold: JSON.stringify({ metric: "models_in_week", value: 5 }),
    hidden: true,
  },
  {
    achievementId: "speed-demon",
    name: "Speed Demon",
    description: "???",
    category: "FUN",
    icon: "zap",
    threshold: JSON.stringify({ metric: "prompts_in_hour", value: 50 }),
    hidden: true,
  },
];

export function request(ctx) {
  // No DynamoDB call needed — return static data in the response handler
  return { payload: null };
}

export function response(ctx) {
  return ACHIEVEMENT_DEFINITIONS;
}
