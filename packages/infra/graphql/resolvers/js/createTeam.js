/**
 * Mutation.createTeam — Create a new team and the creator's admin membership.
 * Generates teamId, inviteCode, teamSlug, and creates both the Team
 * and the first TeamMembership (admin role) via a BatchWriteItem.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const input = ctx.args.input;

  // Validate input
  if (!input.teamName || input.teamName.trim().length === 0) {
    util.error("teamName is required", "ValidationError");
  }
  if (input.teamName.length > 100) {
    util.error("teamName must be 100 characters or less", "ValidationError");
  }

  const now = util.time.nowEpochMilliSeconds();
  const teamId = util.autoId();
  const inviteCode = util.autoId().substring(0, 12);
  // Generate slug from team name: lowercase, replace spaces/special chars with hyphens
  const teamSlug = input.teamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const team = {
    teamId,
    teamName: input.teamName.trim(),
    teamSlug,
    logoUrl: input.logoUrl || null,
    createdBy: ctx.identity.sub,
    createdAt: now,
    inviteCode,
    inviteCodeExpiresAt: Math.round(now / 1000) + 30 * 24 * 60 * 60, // 30 days
    settings: {
      leaderboardEnabled: true,
      leaderboardCategories: ["prompts", "cost_per_prompt", "cache_rate"],
      challengesEnabled: true,
      minMembersForAggregates: 3,
      crossTeamVisibility: "PRIVATE",
    },
    dashboardReaders: [],
    memberCount: 1,
    updatedAt: now,
  };

  const membership = {
    teamId,
    userId: ctx.identity.sub,
    role: "admin",
    joinedAt: now,
    displayName: ctx.identity.claims.name || ctx.identity.claims.email || "Admin",
    shareLevel: "summary",
    sharedAccounts: [],
    updatedAt: now,
  };

  // Stash for response
  ctx.stash.team = team;

  return {
    operation: "BatchPutItem",
    tables: {
      Teams: [util.dynamodb.toMapValues(team)],
      TeamMemberships: [util.dynamodb.toMapValues(membership)],
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.stash.team;
}
