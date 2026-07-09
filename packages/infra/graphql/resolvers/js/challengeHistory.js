/**
 * Query.challengeHistory(teamId: ID!, limit: Int): [Challenge!]!
 * Completed challenges for the team, newest-first. Per the resolver rules we do
 * NOT comparator-sort in-resolver (banned) — we return the completed set
 * unsorted and let the client rank newest-first. Team-scoped read like
 * activeChallenge / Team.members.
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
    runtime.earlyReturn([]);
  }
  return ddb.query({ query: { teamId: { eq: teamId } } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const completed = (ctx.result.items || []).filter(
    (c) => c.status === "completed"
  );
  // No comparator sort: if a limit is given, return a plain slice of the
  // unsorted set (the client sorts newest-first). A DDB-side sort/limit would
  // require ordering the partition, which we intentionally leave to the client.
  const limit = ctx.args.limit;
  const out = limit && limit > 0 ? completed.slice(0, limit) : completed;
  return out.map((c) => toChallenge(c));
}
