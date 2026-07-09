/**
 * Mutation.createInterTeamChallenge — Pipeline Step 2 (Teams).
 * Read the creating team so Step 3 can populate the teams-map entry with the
 * real teamName/teamSlug/logoUrl. The inter-team-scoring worker PRESERVES this
 * metadata as-is when it re-ranks (it never re-derives names), so it must be
 * correct at creation time — hence the extra Teams read rather than a
 * placeholder name.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.get({ key: { teamId: ctx.stash.teamId } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const team = ctx.result;
  if (!team) {
    util.error("Team not found", "ValidationError");
  }
  ctx.stash.teamName = team.teamName;
  ctx.stash.teamSlug = team.teamSlug;
  ctx.stash.logoUrl = team.logoUrl || null;
  return team;
}
