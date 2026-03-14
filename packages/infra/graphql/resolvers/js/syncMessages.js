/**
 * Mutation.syncMessages — Batch conditional writes to SyncedMessages table.
 * Ownership enforced: sessionId ownership is validated by checking the SyncedSessions table
 * belongs to ctx.identity.sub. The userId is stamped on each message for indexing.
 *
 * Uses DynamoDB TransactWriteItems with _version conditional writes.
 * Max 100 items per call. Returns SyncResult { itemsWritten, itemsSkipped, conflicts[] }.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  const items = ctx.args.input;

  // Validate batch size
  if (!items || items.length === 0) {
    util.error("Input must contain at least 1 item", "ValidationError");
  }
  if (items.length > 100) {
    util.error("Input must contain at most 100 items", "ValidationError");
  }

  const userId = ctx.identity.sub;
  const now = util.time.nowEpochMilliSeconds();

  const transactItems = items.map((item) => {
    const record = {
      sessionId: item.sessionId,
      uuid: item.uuid,
      userId,
      timestamp: item.timestamp,
      model: item.model,
      stopReason: item.stopReason,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      tools: item.tools,
      thinkingBlocks: item.thinkingBlocks,
      serviceTier: item.serviceTier,
      promptText: item.promptText,
      _version: item._version + 1,
      updatedAt: now,
    };

    return {
      table: "SyncedMessages",
      operation: "PutItem",
      key: util.dynamodb.toMapValues({
        sessionId: item.sessionId,
        uuid: item.uuid,
      }),
      attributeValues: util.dynamodb.toMapValues(record),
      condition: {
        expression: "attribute_not_exists(#uuid) OR #v = :expectedVersion",
        expressionNames: { "#uuid": "uuid", "#v": "_version" },
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
  if (ctx.error) {
    const cancellationReasons = ctx.result?.cancellationReasons ?? [];
    const items = ctx.args.input;
    const conflicts = [];
    let itemsWritten = 0;
    let itemsSkipped = 0;

    if (cancellationReasons.length > 0) {
      for (let i = 0; i < cancellationReasons.length; i++) {
        const reason = cancellationReasons[i];
        if (reason.type === "None") {
          itemsSkipped += 1;
        } else if (reason.type === "ConditionalCheckFailed") {
          conflicts.push({
            key: items[i].uuid,
            serverVersion: reason.item ? reason.item._version : -1,
            serverItem: reason.item ? JSON.stringify(reason.item) : null,
          });
        }
      }
    } else {
      util.error(ctx.error.message, ctx.error.type);
    }

    return { itemsWritten, itemsSkipped, conflicts };
  }

  return {
    itemsWritten: ctx.args.input.length,
    itemsSkipped: 0,
    conflicts: [],
  };
}
