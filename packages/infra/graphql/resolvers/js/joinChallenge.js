/**
 * Mutation.joinChallenge(challengeId: ID!): Boolean!
 * Team member joins an active challenge (adds themselves to participants at
 * score/rank 0; the scoring worker fills real values later).
 *
 * KEY PROBLEM: the Challenges table is PK=teamId SK=challengeId, but this
 * mutation receives only challengeId — we cannot locate the row without teamId.
 * We derive teamId from the caller's cognito:groups (see deriveTeamId). This is
 * the same trick completeChallenge uses. Cross-team lookup by challengeId alone
 * is out of scope.
 */
import { util } from "@aws-appsync/utils";

/**
 * Derive the caller's single team from cognito:groups. Team groups look like
 * `team:${teamId}:admin` / `team:${teamId}:member`. If the caller has 0 or >1
 * distinct team groups the challenge's team is ambiguous -> error.
 */
function deriveTeamId(ctx) {
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const ids = {}; // plain object used as a set (new Set() is banned)
  groups.forEach((g) => {
    if (g.indexOf("team:") === 0) {
      const parts = g.split(":");
      if (parts.length >= 3 && parts[1].length > 0) {
        ids[parts[1]] = true;
      }
    }
  });
  const teamIds = Object.keys(ids);
  if (teamIds.length === 0) {
    util.error(
      "You are not a member of any team; cannot resolve the challenge's team.",
      "Unauthorized"
    );
  }
  if (teamIds.length > 1) {
    util.error(
      "You belong to multiple teams; joining a challenge by challengeId alone is ambiguous.",
      "ValidationError"
    );
  }
  return teamIds[0];
}

export function request(ctx) {
  const { challengeId } = ctx.args;
  const teamId = deriveTeamId(ctx);
  const userId = ctx.identity.sub;

  // Nested SET participants.<userId> — must be a raw UpdateItem: ddb.update with
  // a dotted/computed key is a literal attribute name (silent no-op). The parent
  // `participants` map is always present (createChallenge seeds it to {}).
  // Condition: challenge exists, is active, and the caller has not already joined
  // (attribute_not_exists guards against clobbering a scored entry back to 0).
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId, challengeId }),
    update: {
      expression: "SET #p.#uid = :entry",
      expressionNames: { "#p": "participants", "#uid": userId },
      expressionValues: util.dynamodb.toMapValues({
        ":entry": { score: 0, rank: 0 },
      }),
    },
    condition: {
      expression:
        "attribute_exists(teamId) AND #s = :active AND attribute_not_exists(#p.#uid)",
      expressionNames: { "#s": "status", "#p": "participants", "#uid": userId },
      expressionValues: util.dynamodb.toMapValues({ ":active": "active" }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    // A conditional-check failure means: no such challenge, not active, or
    // already joined.
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
