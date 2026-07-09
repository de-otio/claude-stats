/**
 * Mutation.deleteTeam — Pipeline Step 4 (Teams).
 * Delete the team row and return Boolean!.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.remove({ key: { teamId: ctx.stash.teamId } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
