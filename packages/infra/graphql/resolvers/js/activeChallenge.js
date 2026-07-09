/**
 * Query.activeChallenge(teamId: ID!): Challenge
 * Returns the current ACTIVE challenge for the team, or null. Team-scoped read:
 * only members/admins/superadmins see it (mirrors Team.members gating).
 *
 * The Challenges table is small and per-team (PK=teamId, TTL'd), so we query the
 * partition and filter for status "active" in the response. We do not sort.
 */
import { util, runtime } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

function toChallenge(item) {
  const p = item.participants || {};
  const participants = Object.keys(p).map((userId) => ({
    userId,
    displayName: null,
    score: p[userId].score,
    rank: p[userId].rank,
  }));
  return {
    ...item,
    status: (item.status || "").toUpperCase(),
    participants,
  };
}

export function request(ctx) {
  const { teamId } = ctx.args;
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const isMember =
    groups.includes(`team:${teamId}:member`) ||
    groups.includes(`team:${teamId}:admin`) ||
    groups.includes("superadmin");
  if (!isMember) {
    runtime.earlyReturn(null);
  }
  return ddb.query({ query: { teamId: { eq: teamId } } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const active = (ctx.result.items || []).filter((c) => c.status === "active");
  if (active.length === 0) {
    return null;
  }
  return toChallenge(active[0]);
}
