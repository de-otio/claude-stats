/**
 * Mutation.syncAggregate — Batch conditional writes of the client-computed
 * aggregate projection. Aggregate-only, by construction (review F9/S6):
 * there is no per-session or per-message write path in this schema at all
 * (`syncSessions`/`syncMessages`/`SyncSessionInput`/`SyncMessageInput` are
 * deleted, not gated) — this is the only sync mutation, and its input type
 * cannot carry prompt_text, file_paths, or transcript content.
 *
 * Ownership enforced: userId is always ctx.identity.sub (never from client
 * input). `toolUseCounts` is defense-in-depth-validated AND redacted (see
 * bucketToolCounts) because AWSJSON is an untyped scalar — the schema
 * type alone cannot stop a client from stuffing a string blob into it, so
 * the resolver rejects anything that isn't a flat {toolName: count} map and
 * stores only built-in tool names, "mcp" and "custom" as keys.
 *
 * Uses DynamoDB TransactWriteItems for atomicity with _version conditional
 * writes. Max 25 items per call. Returns SyncResult { itemsWritten,
 * itemsSkipped, conflicts[] }.
 */
import { util } from "@aws-appsync/utils";

const MAX_TOOL_NAME_LENGTH = 64;
// Keys are bucketed to the closed built-in list, "mcp" and "custom" before this
// check, so it is a backstop, sized with room for the list to grow (a test pins
// the headroom: one key too many rejects the whole sync batch).
const MAX_TOOL_ENTRIES = 128;
const MAX_MODEL_NAME_LENGTH = 128;
const MAX_MODELS = 32;

/**
 * Claude Code's built-in tool names — an INLINED copy of `BUILT_IN_TOOL_NAMES`
 * in `packages/core/src/identifiers.ts`. AppSync JS resolvers are deployed
 * unbundled and can import only `@aws-appsync/utils`, so this is the one
 * accepted second copy; `lambda/api/__tests__/appsync-tool-redaction.test.ts`
 * pins it to the core list. Look a name up with `=== true` so inherited keys
 * (`constructor`, `__proto__`, `toString`) never read as built-in.
 */
const BUILT_IN_TOOLS = {
  Agent: true, Artifact: true, ArtifactComments: true, ArtifactData: true,
  AskUserQuestion: true, Bash: true, BashOutput: true, CronCreate: true,
  CronDelete: true, CronList: true, DesignSync: true, Edit: true,
  EnterPlanMode: true, EnterWorktree: true, ExitPlanMode: true,
  ExitWorktree: true, Glob: true, Grep: true, KillBash: true, KillShell: true,
  LS: true, LSP: true, ListAgents: true, ListMcpResourcesTool: true,
  Monitor: true, MultiEdit: true, NotebookEdit: true, NotebookRead: true,
  PowerShell: true, PushNotification: true, REPL: true, Read: true,
  ReadMcpResourceDirTool: true, ReadMcpResourceTool: true, ReportFindings: true,
  ScheduleWakeup: true, SendMessage: true, ShareOnboardingGuide: true,
  Skill: true, SlashCommand: true, Sleep: true, StructuredOutput: true,
  Task: true, TaskCreate: true, TaskGet: true, TaskList: true,
  TaskOutput: true, TaskStop: true, TaskUpdate: true, TeamCreate: true,
  TeamDelete: true, TodoRead: true, TodoWrite: true, ToolSearch: true,
  WebFetch: true, WebSearch: true, Workflow: true, Write: true,
};

/**
 * The org-plane form of a tool name (mirrors `bucketToolName` in core): a
 * built-in name as itself, any `mcp__<server>__<tool>` as "mcp", anything
 * else as "custom". A user-configured MCP server name is never stored.
 */
function bucketToolName(name) {
  if (BUILT_IN_TOOLS[name] === true) {
    return name;
  }
  return name.startsWith("mcp__") ? "mcp" : "custom";
}

/**
 * Validate toolUseCounts and return it with every key REWRITTEN to its bucket
 * (built-in name, "mcp" or "custom"), collisions summed. This is the
 * resolver-side backstop for the AWSJSON scalar's lack of structural typing
 * (review F9) and for clients that predate client-side redaction.
 *
 * Bucketing happens BEFORE the entry-count and key-length limits: an older
 * client's raw `mcp__…` names would otherwise exceed them and reject the
 * whole batch, stopping that user's org sync. Each raw value must still be a
 * non-negative finite number. The tally is a plain `{}` safely here only
 * because its keys are bucketed to the closed list, "mcp" or "custom" before
 * insertion — no user-authored key ever reaches it.
 *
 * APPSYNC_JS 1.0.0: no `for`/`while`, no `++`, no `new`, no regex, no Date,
 * no String()/Number() — Object.keys(...).forEach and startsWith only.
 */
function bucketToolCounts(value) {
  if (value === null || value === undefined) {
    return value;
  }
  const obj = typeof value === "string" ? JSON.parse(value) : value;
  if (obj === null || typeof obj !== "object") {
    util.error("toolUseCounts must be an object", "ValidationError");
  }
  const bucketed = {};
  Object.keys(obj).forEach((key) => {
    const v = obj[key];
    if (typeof v !== "number" || v < 0 || !Number.isFinite(v)) {
      util.error(
        "toolUseCounts values must be non-negative numbers",
        "ValidationError",
      );
    }
    const bucket = bucketToolName(key);
    bucketed[bucket] = (bucketed[bucket] ?? 0) + v;
  });
  const keys = Object.keys(bucketed);
  if (keys.length > MAX_TOOL_ENTRIES) {
    util.error("toolUseCounts has too many entries", "ValidationError");
  }
  keys.forEach((key) => {
    if (key.length > MAX_TOOL_NAME_LENGTH) {
      util.error("toolUseCounts key too long", "ValidationError");
    }
  });
  return bucketed;
}

function assertModelsList(models) {
  if (!models) {
    return;
  }
  if (models.length > MAX_MODELS) {
    util.error("models list too long", "ValidationError");
  }
  models.forEach((m) => {
    if (typeof m !== "string" || m.length > MAX_MODEL_NAME_LENGTH) {
      util.error("model name too long", "ValidationError");
    }
  });
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
    const toolUseCounts = bucketToolCounts(item.toolUseCounts);
    assertModelsList(item.models);

    const record = {
      userId,
      period: item.period,
      sessionCount: item.sessionCount,
      subagentSessionCount: item.subagentSessionCount,
      promptCount: item.promptCount,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      activeMinutes: item.activeMinutes,
      toolUseCounts,
      models: item.models,
      accountId: item.accountId,
      estimatedCost: item.estimatedCost,
      _version: item._version + 1,
      updatedAt: now,
    };

    // projectId is the AggregatesByProject GSI partition key. DynamoDB rejects
    // a NULL value for a GSI key attribute ("Type mismatch for Index Key
    // projectId Expected: S Actual: NULL"), so OMIT it entirely when the client
    // sends null (per-day totals) — a sparse-index write, not a NULL write.
    if (item.projectId !== null && item.projectId !== undefined) {
      record.projectId = item.projectId;
    }

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
      // APPSYNC_JS bans `for` and `++`; use forEach with the index arg.
      cancellationReasons.forEach((reason, i) => {
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
      });
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
