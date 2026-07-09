/**
 * Mutation.deleteTeam — Pipeline Step 2 (TeamMemberships).
 * Step 1 verified admin and stashed teamId. Query all membership rows for the
 * team and stash their keys for the batch delete in Step 3.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  return ddb.query({ query: { teamId: { eq: ctx.stash.teamId } } });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const items = ctx.result.items || [];
  // BatchDeleteItem is capped at 25 keys per call and a function cannot loop
  // batches; refuse oversized teams rather than partial-delete. joinTeam caps
  // teams at 50, so a large team must shed members before deletion.
  if (items.length > 25) {
    util.error(
      "Team has too many members to delete in one operation; remove members until 25 or fewer remain.",
      "ValidationError",
    );
  }
  ctx.stash.memberKeys = items.map((m) => ({ teamId: m.teamId, userId: m.userId }));
  return true;
}
