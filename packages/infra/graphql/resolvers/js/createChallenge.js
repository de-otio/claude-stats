/**
 * Mutation.createChallenge(teamId: ID!, input: ChallengeInput!): Challenge!
 * Admin-only (team:${teamId}:admin). Creates an ACTIVE intra-team challenge.
 *
 * Stored row shape is dictated by the challenge-scoring worker
 * (lambda/api/challenge-scoring.ts) which reads/writes this row:
 *   status is stored LOWERCASE ("active" | "completed");
 *   participants is a MAP keyed by userId -> { score, rank } (NOT an array);
 *   startTime/endTime/timestamps are epoch SECONDS.
 * The GraphQL Challenge.participants is an array + status is the uppercase
 * ChallengeStatus enum, so we transform at the response boundary (toChallenge).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

/**
 * Stored map { userId: { score, rank } } -> GraphQL [{userId,displayName,score,rank}].
 * displayName is NOT stored on the challenge row: the scoring worker persists
 * only { score, rank } per userId and OVERWRITES the whole participants map each
 * pass, so any displayName stored here would be wiped. Left null; hydration from
 * TeamMemberships belongs to a Challenge.participants field resolver / the client.
 */
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
  const { teamId, input } = ctx.args;

  const groups = ctx.identity.claims["cognito:groups"] || [];
  if (
    !groups.includes(`team:${teamId}:admin`) &&
    !groups.includes("superadmin")
  ) {
    util.unauthorized();
  }

  if (!input.name || input.name.trim().length === 0) {
    util.error("name is required", "ValidationError");
  }
  if (!input.metric || input.metric.trim().length === 0) {
    util.error("metric is required", "ValidationError");
  }
  if (input.endTime <= input.startTime) {
    util.error("endTime must be after startTime", "ValidationError");
  }

  const now = util.time.nowEpochSeconds();
  const challengeId = util.autoId();

  const item = {
    teamId,
    challengeId,
    name: input.name.trim(),
    metric: input.metric, // stored verbatim; must match the worker's metric keys
    startTime: input.startTime, // epoch seconds
    endTime: input.endTime, // epoch seconds
    status: "active",
    participants: {}, // empty MAP (present so joinChallenge's nested SET works)
    createdBy: ctx.identity.sub,
    createdAt: now,
    updatedAt: now,
    // TTL (epoch seconds): purge ~90d after the challenge ends.
    expiresAt: input.endTime + 90 * 24 * 60 * 60,
  };

  ctx.stash.item = item;
  return ddb.put({ key: { teamId, challengeId }, item });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return toChallenge(ctx.result || ctx.stash.item);
}
