/**
 * Mutation.unlockAchievement — Write an achievement record for the authenticated user.
 * PK = userId (ctx.identity.sub), SK = achievementId.
 * Ownership enforced: always writes to the caller's own userId.
 * Uses a condition expression to prevent duplicate unlocks.
 *
 * Args:
 *   achievementId: ID!
 *   context: AWSJSON (optional) — e.g. { "prompts": 1000 }
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

// Achievement definitions for validation and metadata lookup
const VALID_ACHIEVEMENTS = {
  "first-steps":   { name: "First Steps",    description: "Complete your first Claude session",               category: "PRODUCTIVITY", icon: "footprints" },
  "centurion":     { name: "Centurion",       description: "Send 100 prompts",                                category: "PRODUCTIVITY", icon: "shield" },
  "marathon":      { name: "Marathon",        description: "Send 1,000 prompts",                              category: "PRODUCTIVITY", icon: "trophy" },
  "nightowl":      { name: "Nightowl",        description: "Complete 10 sessions after midnight",              category: "PRODUCTIVITY", icon: "moon" },
  "optimizer":     { name: "Optimizer",        description: "Achieve an average cost per prompt under $0.01",   category: "EFFICIENCY",   icon: "chart-down" },
  "cache-master":  { name: "Cache Master",     description: "Achieve a 90%+ cache hit rate",                    category: "EFFICIENCY",   icon: "database" },
  "haiku-hero":    { name: "Haiku Hero",       description: "Use Haiku for 50%+ of your prompts",               category: "EFFICIENCY",   icon: "feather" },
  "team-player":   { name: "Team Player",      description: "Join a team",                                      category: "TEAM",         icon: "users" },
  "challenger":    { name: "Challenger",        description: "Participate in 5 challenges",                      category: "TEAM",         icon: "swords" },
  "leader":        { name: "Leader",            description: "Win a leaderboard category",                       category: "TEAM",         icon: "crown" },
  "week-warrior":  { name: "Week Warrior",      description: "Maintain a 7-day streak",                          category: "MILESTONES",   icon: "flame" },
  "month-master":  { name: "Month Master",      description: "Maintain a 30-day streak",                         category: "MILESTONES",   icon: "fire" },
  "century-club":  { name: "Century Club",      description: "Maintain a 100-day streak",                        category: "MILESTONES",   icon: "star" },
  "big-spender":   { name: "Big Spender",       description: "Accumulate $100+ in total estimated cost",         category: "MILESTONES",   icon: "dollar" },
  "the-delegator": { name: "The Delegator",     description: "Launch 10+ subagent sessions in a single day",     category: "FUN",          icon: "briefcase" },
  "polyglot":      { name: "Polyglot",          description: "Use 5+ distinct models in a single week",          category: "FUN",          icon: "globe" },
  "speed-demon":   { name: "Speed Demon",       description: "Send 50+ prompts in a single hour",                category: "FUN",          icon: "zap" },
};

export function request(ctx) {
  const userId = ctx.identity.sub;
  const { achievementId, context: achievementContext } = ctx.args;

  // Validate achievementId
  const definition = VALID_ACHIEVEMENTS[achievementId];
  if (!definition) {
    util.error(`Unknown achievementId: ${achievementId}`, "ValidationError");
  }

  const now = util.time.nowEpochSeconds();

  return ddb.put({
    key: { userId, achievementId },
    item: {
      userId,
      achievementId,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      icon: definition.icon,
      unlockedAt: now,
      shared: true, // Default to visible to teammates
      context: achievementContext || null,
    },
    condition: {
      achievementId: { attributeExists: false },
    },
  });
}

export function response(ctx) {
  if (ctx.error) {
    // ConditionalCheckFailed means achievement was already unlocked
    if (ctx.error.type === "DynamoDB:ConditionalCheckFailedException") {
      util.error("Achievement already unlocked", "ConflictError");
    }
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
