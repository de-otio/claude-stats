/**
 * Mutation.completeChallenge(challengeId: ID!): Challenge!
 * Admin-only. Marks the challenge COMPLETED (stored lowercase "completed").
 *
 * Like joinChallenge, this receives only challengeId while the row is keyed by
 * PK=teamId SK=challengeId, so teamId is derived from the caller's cognito:groups
 * (single team) — then admin membership is asserted on that derived team.
 */
import { util } from "@aws-appsync/utils";

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

/** Derive the caller's single team from cognito:groups (0 or >1 -> ambiguous). */
function deriveTeamId(ctx) {
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const ids = {};
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
      "You belong to multiple teams; completing a challenge by challengeId alone is ambiguous.",
      "ValidationError"
    );
  }
  return teamIds[0];
}

export function request(ctx) {
  const { challengeId } = ctx.args;
  const teamId = deriveTeamId(ctx);

  const groups = ctx.identity.claims["cognito:groups"] || [];
  if (
    !groups.includes(`team:${teamId}:admin`) &&
    !groups.includes("superadmin")
  ) {
    util.unauthorized();
  }

  const now = util.time.nowEpochSeconds();

  // Raw UpdateItem (status is a reserved word; condition prevents an upsert of a
  // non-existent challenge). Returns ALL_NEW attributes as ctx.result.
  return {
    operation: "UpdateItem",
    key: util.dynamodb.toMapValues({ teamId, challengeId }),
    update: {
      expression: "SET #s = :completed, updatedAt = :now",
      expressionNames: { "#s": "status" },
      expressionValues: util.dynamodb.toMapValues({
        ":completed": "completed",
        ":now": now,
      }),
    },
    condition: { expression: "attribute_exists(teamId)" },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return toChallenge(ctx.result);
}
