/**
 * Mutation.updateTeamSettings — Pipeline Step 2.
 * Step 1 verified the caller is an admin and stashed teamId + settingsInput.
 * Apply the provided settings fields via a nested UpdateExpression and return
 * the Team.
 *
 * NOTE: the `ddb.update` helper does NOT treat a dotted key ("settings.foo")
 * as a document path — it writes a literal attribute with a dot in its name.
 * Nested updates must use a raw UpdateItem with `#s.#field` paths (the Team's
 * `settings` map always exists, created by createTeam).
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const input = ctx.stash.settingsInput || {};
  const now = util.time.nowEpochMilliSeconds();
  const sets = ["#updatedAt = :now"];
  const names = { "#s": "settings", "#updatedAt": "updatedAt" };
  const values = { ":now": now };

  if (input.leaderboardEnabled !== undefined) {
    sets.push("#s.#le = :le");
    names["#le"] = "leaderboardEnabled";
    values[":le"] = input.leaderboardEnabled;
  }
  if (input.leaderboardCategories !== undefined) {
    sets.push("#s.#lc = :lc");
    names["#lc"] = "leaderboardCategories";
    values[":lc"] = input.leaderboardCategories;
  }
  if (input.challengesEnabled !== undefined) {
    sets.push("#s.#ce = :ce");
    names["#ce"] = "challengesEnabled";
    values[":ce"] = input.challengesEnabled;
  }
  if (input.minMembersForAggregates !== undefined) {
    sets.push("#s.#mm = :mm");
    names["#mm"] = "minMembersForAggregates";
    values[":mm"] = input.minMembersForAggregates;
  }
  if (input.crossTeamVisibility !== undefined) {
    sets.push("#s.#cv = :cv");
    names["#cv"] = "crossTeamVisibility";
    values[":cv"] = input.crossTeamVisibility;
  }

  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId: ctx.stash.teamId }),
    update: {
      expression: "SET " + sets.join(", "),
      expressionNames: names,
      expressionValues: util.dynamodb.toMapValues(values),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
