/**
 * Mutation.leaveTeam — Leave a team by deleting the user's membership.
 * Cannot leave if the user is the last admin (to prevent orphaned teams).
 *
 * Pipeline resolver:
 *   Step 1: Query TeamMemberships to check if user is the last admin
 *   Step 2: Delete the membership and decrement memberCount
 *
 * This file covers Step 1 — query memberships to verify safety.
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

export function request(ctx) {
  const { teamId } = ctx.args;
  if (!teamId) {
    util.error("teamId is required", "ValidationError");
  }

  // Query all memberships for this team to check admin count
  return ddb.query({
    query: { teamId: { eq: teamId } },
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const members = ctx.result.items || [];
  const userId = ctx.identity.sub;
  const teamId = ctx.args.teamId;

  // Find the caller's membership
  const myMembership = members.find((m) => m.userId === userId);
  if (!myMembership) {
    util.error("You are not a member of this team", "ValidationError");
  }

  // If the caller is an admin, check if they are the last admin
  if (myMembership.role === "admin") {
    const adminCount = members.filter((m) => m.role === "admin").length;
    if (adminCount <= 1) {
      util.error(
        "Cannot leave team as the last admin. Promote another member first or delete the team.",
        "ValidationError"
      );
    }
  }

  // Stash for pipeline step 2 (delete membership + decrement memberCount)
  ctx.stash.teamId = teamId;
  ctx.stash.userId = userId;
  return myMembership;
}
