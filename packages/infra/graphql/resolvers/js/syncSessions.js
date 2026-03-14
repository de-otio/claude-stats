/**
 * Mutation.syncSessions — Batch conditional writes to SyncedSessions table.
 * Ownership enforced: userId is always ctx.identity.sub (never from client input).
 *
 * Uses DynamoDB TransactWriteItems for atomicity with _version conditional writes.
 * Max 25 items per call. Returns SyncResult { itemsWritten, itemsSkipped, conflicts[] }.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const items = ctx.args.input;

  // Validate batch size
  if (!items || items.length === 0) {
    util.error("Input must contain at least 1 item", "ValidationError");
  }
  if (items.length > 25) {
    util.error("Input must contain at most 25 items", "ValidationError");
  }

  const userId = ctx.identity.sub;
  const now = util.time.nowEpochMilliSeconds();

  const transactItems = items.map((item) => {
    const record = {
      userId,
      sessionId: item.sessionId,
      projectId: item.projectId,
      projectPathHash: item.projectPathHash,
      firstTimestamp: item.firstTimestamp,
      lastTimestamp: item.lastTimestamp,
      claudeVersion: item.claudeVersion,
      entrypoint: item.entrypoint,
      promptCount: item.promptCount,
      assistantMessageCount: item.assistantMessageCount,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      toolUseCounts: item.toolUseCounts,
      models: item.models,
      accountId: item.accountId,
      isSubagent: item.isSubagent,
      parentSessionId: item.parentSessionId,
      thinkingBlocks: item.thinkingBlocks,
      estimatedCost: item.estimatedCost,
      _version: item._version + 1,
      updatedAt: now,
    };

    return {
      table: "SyncedSessions",
      operation: "PutItem",
      key: util.dynamodb.toMapValues({ userId, sessionId: item.sessionId }),
      attributeValues: util.dynamodb.toMapValues(record),
      condition: {
        expression: "attribute_not_exists(sessionId) OR #v = :expectedVersion",
        expressionNames: { "#v": "_version" },
        expressionValues: util.dynamodb.toMapValues({
          ":expectedVersion": item._version,
        }),
      },
    };
  });

  return {
    version: "2018-05-29",
    operation: "TransactWriteItems",
    transactItems,
  };
}

export function response(ctx) {
  // TransactWriteItems returns cancellation reasons on partial failure
  if (ctx.error) {
    // If the entire transaction failed due to conditional check failures,
    // parse the cancellation reasons to build the conflicts array.
    const cancellationReasons = ctx.result?.cancellationReasons ?? [];
    const items = ctx.args.input;
    const conflicts = [];
    let itemsWritten = 0;
    let itemsSkipped = 0;

    if (cancellationReasons.length > 0) {
      for (let i = 0; i < cancellationReasons.length; i++) {
        const reason = cancellationReasons[i];
        if (reason.type === "None") {
          // This item would have succeeded
          itemsSkipped += 1;
        } else if (reason.type === "ConditionalCheckFailed") {
          conflicts.push({
            key: items[i].sessionId,
            serverVersion: reason.item ? reason.item._version : -1,
            serverItem: reason.item ? JSON.stringify(reason.item) : null,
          });
        }
      }
    } else {
      // Non-conditional error — propagate
      util.error(ctx.error.message, ctx.error.type);
    }

    return { itemsWritten, itemsSkipped, conflicts };
  }

  // Full success — all items written
  return {
    itemsWritten: ctx.args.input.length,
    itemsSkipped: 0,
    conflicts: [],
  };
}
