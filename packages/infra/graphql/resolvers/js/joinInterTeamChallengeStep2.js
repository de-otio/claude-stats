/**
 * Mutation.joinInterTeamChallenge — Pipeline Step 2 (Teams).
 * Read the joining team so Step 4 can populate its teams-map entry with the
 * real teamName/teamSlug/logoUrl (the scoring worker preserves this metadata
 * verbatim on re-rank, so it must be correct at join time).
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
