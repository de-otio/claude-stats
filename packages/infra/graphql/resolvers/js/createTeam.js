/**
 * Mutation.createTeam — Pipeline Step 1: create the Team row.
 * Step 2 (createTeamStep2) writes the creator's admin membership. Split into
 * two single-table steps (Teams, then TeamMemberships) so each binds to a data
 * source that already has write grants — no cross-table BatchPutItem/IAM.
 *
 * Role/shareLevel are stored LOWERCASE (the internal convention: pre-token
 * builds `team:{teamId}:{role}` group claims and every resolver auth-check is
 * lowercase). The GraphQL TeamRole/ShareLevel enums are uppercased at the
 * TeamMember response boundary (teamMembers / Team.members / updateMembership).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

/** Slug: lowercase, non-alphanumeric runs → single "-", trimmed. No regex
 * (APPSYNC_JS bans regex literals), no for/while (also banned). */
function slugify(name) {
  let out = "";
  let prevDash = false;
  name
    .toLowerCase()
    .split("")
    .forEach((ch) => {
      const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
      if (ok) {
        out += ch;
        prevDash = false;
      } else if (!prevDash && out.length > 0) {
        out += "-";
        prevDash = true;
      }
    });
  return out
    .split("-")
    .filter((p) => p.length > 0)
    .join("-");
}

export function request(ctx) {
  const input = ctx.args.input;
  if (!input.teamName || input.teamName.trim().length === 0) {
    util.error("teamName is required", "ValidationError");
  }
  if (input.teamName.length > 100) {
    util.error("teamName must be 100 characters or less", "ValidationError");
  }

  const now = util.time.nowEpochMilliSeconds();
  const teamId = util.autoId();
  const inviteCode = util.autoId().substring(0, 12);
  const teamSlug = slugify(input.teamName);

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

  ctx.stash.team = team;
  ctx.stash.membership = membership;

  return ddb.put({ key: { teamId }, item: team });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // Team returned after Step 2 writes the membership.
  return ctx.stash.team;
}
