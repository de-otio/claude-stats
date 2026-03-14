/**
 * Query.allTeams — Scan the Teams table and return all teams.
 * Superadmin only: checks for "superadmin" in ctx.identity.groups.
 *
 * Note: This is an admin-only operation. The Teams table is expected to be
 * small enough for a scan (team count in the hundreds at most).
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  // Superadmin authorization check
  const groups = ctx.identity.groups || [];
  if (!groups.includes("superadmin")) {
    util.error("Not authorized. Superadmin access required.", "UnauthorizedError");
  }

  return ddb.scan({
    limit: 1000,
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result.items || [];
}
