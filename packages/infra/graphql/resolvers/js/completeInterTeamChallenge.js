/**
 * Mutation.completeInterTeamChallenge — Pipeline Step 1 (InterTeamChallenges).
 * Manually complete a challenge. Admin of the creatingTeamId only.
 *
 * The caller supplies only challengeId, so the creatingTeamId (needed for the
 * admin check) is unknown until the row is read. Steps:
 *   Step 1 (InterTeamChallenges): read the challenge, stash creatingTeamId.
 *   Step 2 (TeamMemberships):     verify caller is admin of creatingTeamId.
 *   Step 3 (InterTeamChallenges): set status = "completed".
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { challengeId } = ctx.args;
  if (!challengeId) {
    util.error("challengeId is required", "ValidationError");
  }
  return ddb.get({ key: { challengeId } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const challenge = ctx.result;
  if (!challenge) {
    util.error("Challenge not found", "ValidationError");
  }
  if (challenge.status === "completed") {
    util.error("Challenge is already completed", "ValidationError");
  }
  ctx.stash.challengeId = challenge.challengeId;
  ctx.stash.creatingTeamId = challenge.creatingTeamId;
  return challenge;
}
