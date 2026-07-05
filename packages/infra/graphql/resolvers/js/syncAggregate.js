/**
 * Mutation.syncAggregate — Batch conditional writes of the client-computed
 * aggregate projection. Aggregate-only, by construction (review F9/S6):
 * there is no per-session or per-message write path in this schema at all
 * (`syncSessions`/`syncMessages`/`SyncSessionInput`/`SyncMessageInput` are
 * deleted, not gated) — this is the only sync mutation, and its input type
 * cannot carry prompt_text, file_paths, or transcript content.
 *
 * Ownership enforced: userId is always ctx.identity.sub (never from client
 * input). `toolUseCounts` is defense-in-depth-validated (see
 * assertShallowCountMap) because AWSJSON is an untyped scalar — the schema
 * type alone cannot stop a client from stuffing a string blob into it, so
 * the resolver rejects anything that isn't a flat {toolName: count} map.
 *
 * Uses DynamoDB TransactWriteItems for atomicity with _version conditional
 * writes. Max 25 items per call. Returns SyncResult { itemsWritten,
 * itemsSkipped, conflicts[] }.
 */
import { util } from "@aws-appsync/utils";

const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TOOL_ENTRIES = 64;
const MAX_MODEL_NAME_LENGTH = 128;
const MAX_MODELS = 32;

/**
 * Reject any toolUseCounts value that isn't a flat map of short tool names
 * to small non-negative numbers. This is the resolver-side backstop for the
 * AWSJSON scalar's lack of structural typing (review F9).
 */
function assertShallowCountMap(value) {
  if (value === null || value === undefined) {
    return;
  }
  const obj = typeof value === "string" ? JSON.parse(value) : value;
  const keys = Object.keys(obj);
  if (keys.length > MAX_TOOL_ENTRIES) {
    util.error("toolUseCounts has too many entries", "ValidationError");
  }
  for (const key of keys) {
    if (key.length > MAX_TOOL_NAME_LENGTH) {
      util.error("toolUseCounts key too long", "ValidationError");
    }
    const v = obj[key];
    if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) {
      util.error(
        "toolUseCounts values must be non-negative numbers",
        "ValidationError",
      );
    }
  }
}

function assertModelsList(models) {
  if (!models) {
    return;
  }
  if (models.length > MAX_MODELS) {
    util.error("models list too long", "ValidationError");
  }
  for (const m of models) {
    if (typeof m !== "string" || m.length > MAX_MODEL_NAME_LENGTH) {
      util.error("model name too long", "ValidationError");
    }
  }
}

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
    assertShallowCountMap(item.toolUseCounts);
    assertModelsList(item.models);

    const record = {
      userId,
      period: item.period,
      projectId: item.projectId,
      sessionCount: item.sessionCount,
      subagentSessionCount: item.subagentSessionCount,
      promptCount: item.promptCount,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      activeMinutes: item.activeMinutes,
      toolUseCounts: item.toolUseCounts,
      models: item.models,
      accountId: item.accountId,
      estimatedCost: item.estimatedCost,
      _version: item._version + 1,
      updatedAt: now,
    };

    return {
      table: "UserAggregates",
      operation: "PutItem",
      key: util.dynamodb.toMapValues({ userId, period: item.period }),
      attributeValues: util.dynamodb.toMapValues(record),
      condition: {
        expression: "attribute_not_exists(#period) OR #v = :expectedVersion",
        expressionNames: { "#period": "period", "#v": "_version" },
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
            key: items[i].period,
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
