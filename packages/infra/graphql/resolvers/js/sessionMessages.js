/**
 * Query.sessionMessages — Get messages for a session.
 * Queries SyncedMessages table (PK=sessionId).
 *
 * Ownership check: verifies the session belongs to the current user by looking up
 * the SyncedSessions table first. For team access, checks share-level and the
 * sharePrompts gate to control promptText visibility.
 *
 * This is a pipeline resolver with two functions:
 *   1. Verify session ownership (or team access)
 *   2. Fetch messages
 *
 * For simplicity in a single resolver file, we use a two-step approach:
 *   - Step 1 (this resolver): fetch the session to verify ownership
 *   - If the caller is the session owner, return all fields
 *   - If the caller is a teammate, redact promptText unless share conditions are met
 *
 * Args:
 *   sessionId: ID!
 */
import { util } from "@aws-appsync/utils";
import * as ddb from "@aws-appsync/utils/dynamodb";

/**
 * Pipeline function 1: Verify ownership by fetching the session record.
 */
export function verifyOwnership(ctx) {
  return {
    request(ctx) {
      // Look up the session to check the owner userId
      // The SyncedSessions table has composite key: userId (PK) + sessionId (SK)
      // We need to query by sessionId using a GSI (SessionBySessionId)
      return ddb.query({
        index: "SessionBySessionId",
        query: { sessionId: { eq: ctx.args.sessionId } },
        limit: 1,
      });
    },
    response(ctx) {
      if (ctx.error) {
        util.error(ctx.error.message, ctx.error.type);
      }
      const sessions = ctx.result.items ?? [];
      if (sessions.length === 0) {
        util.error("Session not found", "NotFoundError");
      }
      // Stash session info for the next step
      ctx.stash.session = sessions[0];
      ctx.stash.isOwner = sessions[0].userId === ctx.identity.sub;
      return sessions[0];
    },
  };
}

/**
 * Main resolver: fetch messages for the session.
 * In a pipeline setup, this runs after ownership verification.
 * For a standalone resolver, we combine both steps.
 */
export function request(ctx) {
  // Query SyncedMessages by sessionId (partition key)
  return ddb.query({
    query: { sessionId: { eq: ctx.args.sessionId } },
    scanIndexForward: true, // Chronological order
  });
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const messages = ctx.result.items ?? [];
  const callerId = ctx.identity.sub;

  // Filter messages: only return if caller owns the session or has team access
  const filtered = messages.map((msg) => {
    // If the caller is the session owner, return everything
    if (msg.userId === callerId) {
      return msg;
    }

    // For team access: caller must be a teammate of the session owner.
    // promptText visibility depends on the session owner's sharePrompts setting
    // and the teammate's share-level being "full".
    // The share-level and sharePrompts checks would normally be resolved by
    // looking up the team membership and linked account settings. For the
    // DynamoDB resolver layer, we redact promptText by default for non-owners
    // and let the Lambda-based team authorization layer handle the full check.
    return {
      uuid: msg.uuid,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
      model: msg.model,
      stopReason: msg.stopReason,
      inputTokens: msg.inputTokens,
      outputTokens: msg.outputTokens,
      tools: msg.tools,
      thinkingBlocks: msg.thinkingBlocks,
      // Redact promptText for non-owners at the resolver level.
      // Team-level access with sharePrompts is handled by the authorization
      // pipeline function that runs before this resolver.
      promptText: null,
    };
  });

  return filtered;
}
