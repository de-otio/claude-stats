/**
 * Query.myTeams — Pipeline Step 2.
 * Batch-get the full Team records for the teamIds stashed by Step 1 and
 * return them as `[Team!]!`. Nested fields (Team.members, Team.currentChallenge)
 * are populated by their own field resolvers.
 *
 * BatchGetItem addresses tables by PHYSICAL name; CDK substitutes the
 * "__TABLE_TEAMS__" placeholder at synth (see api-stack loadCode subs), and
 * the result is keyed by that same physical name (read below).
 */
import { util, runtime } from "@aws-appsync/utils";

export function request(ctx) {
  const teamIds = ctx.stash.teamIds || [];
  if (teamIds.length === 0) {
    // No memberships. This step is bound to a DynamoDB data source, so a
    // `{payload}` return is invalid ("$[operation] not found"); earlyReturn
    // skips the BatchGetItem and returns [] as the final result.
    runtime.earlyReturn([]);
  }
  return {
    operation: "BatchGetItem",
    tables: {
      ["__TABLE_TEAMS__"]: {
        keys: teamIds.map((id) => util.dynamodb.toMapValues({ teamId: id })),
      },
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const teams =
    (ctx.result && ctx.result.data && ctx.result.data["__TABLE_TEAMS__"]) || [];
  // List view never exposes invite codes; the team-detail path reveals them
  // to admins only.
  teams.forEach((t) => {
    t.inviteCode = null;
  });
  return teams;
}
