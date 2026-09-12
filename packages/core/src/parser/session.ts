/**
 * Session JSONL parser.
 *
 * Defensive parsing rules (see doc/analysis/08-resilience.md):
 * - Every field is optional — use optional chaining, never direct access
 * - Parse each line independently; one bad line must not abort the rest
 * - Discard the last line if it fails JSON parsing (likely a partial write)
 * - Use message uuid as the idempotency key for upserts
 */
import fs from "fs";
import crypto from "crypto";
import readline from "readline";
import { dirname } from "node:path";
import type {
  RawSessionEntry,
  MessageRecord,
  SessionRecord,
  ToolUseCount,
  ParseError,
  ApiErrorEvent,
} from "../types.js";
import { sanitizePromptText } from "../sanitize.js";

export interface ParseResult {
  session: SessionRecord | null;
  messages: MessageRecord[];
  errors: ParseError[];
  /** byte offset after the last successfully parsed line */
  lastGoodOffset: number;
  /** SHA-256 hex of the first 1 KB of the file */
  firstKbHash: string;
  /** The parentUuid extracted from JSONL entries (for subagent → parent linking) */
  parentUuid: string | null;
  /** Structured API-error/retry signals found in this range — see
   *  `ApiErrorEvent`'s doc comment (`../types.ts`) for the two mechanisms. */
  apiErrorEvents: ApiErrorEvent[];
}

/** Classify a terminal `isApiErrorMessage` entry's short error string, or a
 *  retry-ladder entry's HTTP status, into the two-way vocabulary this module
 *  cares about. Anything else (a future error family, a missing field) is
 *  "unknown" rather than guessed into one of the two — an unrecognised
 *  condition must never silently inflate the throttle-specific count. */
function classifyApiErrorKind(
  errorString: string | undefined,
  status: number | null,
): ApiErrorEvent["kind"] {
  if (errorString === "rate_limit") return "rate_limit";
  if (errorString === "server_error") return "server_error";
  if (status === 429) return "rate_limit";
  if (status != null && status >= 500) return "server_error";
  return "unknown";
}

/** Compute SHA-256 of the first `maxBytes` bytes of a file (default 1024). */
export function hashFirstKb(filePath: string, maxBytes: number = 1024): string {
  const buf = Buffer.alloc(maxBytes);
  const fd = fs.openSync(filePath, "r");
  const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
  fs.closeSync(fd);
  return crypto
    .createHash("sha256")
    .update(buf.subarray(0, bytesRead))
    .digest("hex");
}

/**
 * Cheaply scan a session JSONL file for its first cwd-bearing entry, without
 * a full parse. Used by the project-path repair backfill, which only needs
 * ground truth for project_path — not full session/message parsing. Gives up
 * after `maxLines` lines: `cwd` appears on the large majority of lines in a
 * real session file, always within the first handful, so scanning the whole
 * file is unnecessary.
 */
export async function extractCwdFromSessionFile(
  filePath: string,
  maxLines: number = 200,
): Promise<string | null> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let lineCount = 0;
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as RawSessionEntry;
          if (typeof entry.cwd === "string" && entry.cwd.length > 0) {
            return entry.cwd;
          }
        } catch {
          // skip malformed line — not this function's concern to report it
        }
      }
      lineCount++;
      if (lineCount >= maxLines) break;
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Yield every processable line of a session file from `startOffset`, one at a
 * time, buffering exactly ONE line.
 *
 * The rule this exists to serve is small — "discard the LAST line if it fails
 * JSON parsing (a partial write)" — and the previous implementation paid for it
 * by accumulating every line of the range in an array first. That is fine for a
 * tail and fatal at offset 0: the largest transcript on one contributor's
 * machine is 994 MB, and a full re-parse from 0 is exactly the remedy users are
 * told to run after this release. One line of lookahead is all the rule needs.
 *
 * Blank lines are skipped (they still advance the offset), so "the last line"
 * means the last NON-BLANK one — same as before.
 */
async function* streamProcessableLines(
  filePath: string,
  startOffset: number,
): AsyncGenerator<{ raw: string; offset: number }> {
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: startOffset,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let pending: { raw: string; offset: number } | null = null;
  let currentOffset = startOffset;
  try {
    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
      if (line.trim()) {
        if (pending) yield pending;
        pending = { raw: line, offset: currentOffset };
      }
      currentOffset += lineBytes;
    }
    // Rule 6: discard the last line if it fails JSON parsing (partial write)
    if (pending && isValidJson(pending.raw)) yield pending;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Shape check for a short lowercase token (`effort`, `speed`).
 *
 * A SHAPE check, not an enum: `xhigh` arrived unannounced once already, so a
 * closed list would drop the next real value on the floor while a shape keeps
 * it. What it must exclude is free text — `getSessionMessages` is `SELECT *`
 * and feeds the personal-plane export, so any column added to `messages`
 * enrols itself in an export automatically, and validation therefore happens
 * where the value ENTERS.
 */
const SHORT_TOKEN_RE = /^[a-z]{1,10}$/;
/** Shape check for `message.id` (`msg_01ABC…`). */
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validShape(value: unknown, re: RegExp): string | null {
  return typeof value === "string" && re.test(value) ? value : null;
}

/**
 * A non-negative, finite, integral token count, or null. Anything else — a
 * string, a float, a negative, NaN — is "not reported", never coerced to 0:
 * `thinking_tokens` is absent on ~32% of history and a fabricated 0 there reads
 * as a measured 0% thinking share.
 */
function validTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Total billable token volume on a record — the usage-carrier tiebreak. */
function usageMagnitude(m: MessageRecord): number {
  return (
    m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens
  );
}

/**
 * Strip the REPEATED usage from every non-carrier entry of a `message.id` group.
 *
 * One API response is written as N transcript entries — one per content block —
 * and each entry repeats the WHOLE response's usage. Measured over 12,899
 * groups: 84% are multi-entry, at 2.03 entries per response, which is where the
 * 1.94x cache-read and 2.60x output over-count come from.
 *
 * The rows are KEPT. `toolUseCounts`, `filePaths`, `thinkingBlocks` and
 * `toolErrorCount` are accumulated per ENTRY and 9,955 groups carry a
 * `tool_use` block on a NON-FIRST entry, so deleting non-carriers would destroy
 * ~92% of tool-use records to fix a token count. Only the usage is zeroed.
 *
 * The carrier is the MAX-usage entry in the group (it differs from first-wins
 * in only 18 of 10,554 groups, but MAX is the prior set's verified choice);
 * ties resolve to the earliest entry, so the choice is deterministic and a
 * re-parse of the same bytes reaches the same answer.
 *
 * This can only see the entries in THIS parse range. A group straddling a
 * collect checkpoint is split across two invocations and no parser-local state
 * can join them — which is why the rule is ALSO enforced at the store.
 */
function markUsageCarriers(messages: MessageRecord[]): void {
  const groups = new Map<string, MessageRecord[]>();
  for (const m of messages) {
    if (!m.messageId) continue; // no id → its own group of one, stays a carrier
    const existing = groups.get(m.messageId);
    if (existing) existing.push(m);
    else groups.set(m.messageId, [m]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let carrier = group[0]!;
    for (const m of group) {
      if (usageMagnitude(m) > usageMagnitude(carrier)) carrier = m;
    }
    for (const m of group) {
      if (m === carrier) continue;
      m.usageCounted = false;
      m.inputTokens = 0;
      m.outputTokens = 0;
      m.cacheCreationTokens = 0;
      m.cacheReadTokens = 0;
      m.ephemeral5mCacheTokens = 0;
      m.ephemeral1hCacheTokens = 0;
      m.webSearchRequests = 0;
      m.webFetchRequests = 0;
      m.thinkingTokens = null;
      // A truncation is a property of the RESPONSE, so counting it on every
      // entry of the group inflates throttle_events by the same factor the
      // tokens were inflated by. `thinkingBlocks`, `tools`, `filePaths` and
      // `toolErrorCount` are per-ENTRY data and are deliberately left intact.
      m.isThrottled = false;
    }
  }
}

/** Parse a session JSONL file from the given byte offset onward.
 *  Reads incrementally — only processes new lines since the last run. */
export async function parseSessionFile(
  filePath: string,
  projectPath: string,
  startOffset: number = 0
): Promise<ParseResult> {
  const firstKbHash = hashFirstKb(filePath);
  const messages: MessageRecord[] = [];
  const errors: ParseError[] = [];

  let lastGoodOffset = startOffset;

  // Session-level accumulators
  let sessionId: string | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let claudeVersion: string | null = null;
  let entrypoint: string | null = null;
  let gitBranch: string | null = null;
  let permissionMode: string | null = null;
  // Ground-truth project path from the session content itself. Preferred
  // over the caller-supplied `projectPath` (decoded from the directory
  // name), which is lossy for any path with a literal hyphen in a
  // directory name — Claude Code's own encoding can't distinguish a
  // hyphen from an encoded '/'.
  let cwdFromContent: string | null = null;
  let hasQueueOperation = false;
  let promptCount = 0;
  let assistantMessageCount = 0;
  // Usage from assistant entries carrying NO uuid. Those produce no `messages`
  // row, so they cannot be deduped and cannot be summed back out of `messages`
  // afterwards — they are accumulated here and added to the carrier totals at
  // the end, exactly as they were counted before. Every uuid-bearing entry's
  // usage is derived from the message records AFTER the carrier pass, so the
  // session totals and the rows they summarise can never disagree.
  let unkeyedInputTokens = 0;
  let unkeyedOutputTokens = 0;
  let unkeyedCacheCreationTokens = 0;
  let unkeyedCacheReadTokens = 0;
  let unkeyedWebSearchRequests = 0;
  let unkeyedWebFetchRequests = 0;
  let unkeyedThrottleEvents = 0;
  let totalThinkingBlocks = 0;
  const toolUseCounts = new Map<string, number>();
  const modelsSet = new Set<string>();
  /** Assistant uuids already accumulated — see the dedupe note in the loop. */
  const seenAssistantUuids = new Set<string>();
  /** Set by a real user prompt, consumed by the assistant message that answers it. */
  let pendingTurnStart = false;

  // Subagent parent linkage
  let parentUuid: string | null = null;

  // New accumulators for usage analysis
  const allTimestamps: number[] = [];     // for active duration
  const responseTimes: number[] = [];     // assistant_ts - user_ts pairs
  let lastUserTimestamp: number | null = null;
  let lastPromptText: string | null = null;
  const apiErrorEvents: ApiErrorEvent[] = [];

  let lineNumber = 0;
  for await (const { raw, offset } of streamProcessableLines(filePath, startOffset)) {
    lineNumber++;
    let entry: RawSessionEntry;

    try {
      entry = JSON.parse(raw) as RawSessionEntry;
    } catch (err) {
      errors.push({
        filePath,
        lineNumber,
        rawLine: raw,
        error: String(err),
        timestamp: Date.now(),
        claudeVersion: claudeVersion ?? undefined,
      });
      continue;
    }

    // Update last good offset after each successfully parsed line
    lastGoodOffset = offset + Buffer.byteLength(raw, "utf8") + 1;

    // Extract common envelope fields
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.parentUuid && !parentUuid) parentUuid = entry.parentUuid;
    if (entry.version && !claudeVersion) claudeVersion = entry.version;
    if (entry.entrypoint && !entrypoint) entrypoint = entry.entrypoint;
    if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
    if (entry.permissionMode && !permissionMode)
      permissionMode = entry.permissionMode;
    if (entry.cwd && !cwdFromContent) cwdFromContent = entry.cwd;

    const ts = toEpochMs(entry.timestamp);
    if (ts !== null) {
      if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts;
      if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts;
    }

    const type = entry.type;

    if (ts !== null) allTimestamps.push(ts);

    if (type === "queue-operation") {
      hasQueueOperation = true;
    } else if (type === "user") {
      // Tool results are echoed back as a user turn; a tool_result flagged
      // is_error means that tool call failed. Attribute it to the assistant
      // message that issued the call (the previously-pushed record) so the
      // per-message tool_error_count reflects failed work. Additive — never
      // changes existing fields. (Not gated on isMeta: a tool_result is real.)
      const uContent = entry.message?.content;
      if (Array.isArray(uContent) && messages.length > 0) {
        let errs = 0;
        for (const block of uContent) {
          if (block.type === "tool_result" && block.is_error === true) errs++;
        }
        if (errs > 0) {
          const prev = messages[messages.length - 1]!;
          prev.toolErrorCount = (prev.toolErrorCount ?? 0) + errs;
        }
      }
      // A `type: "user"` entry is only a real PROMPT if the human wrote it.
      // Tool results are delivered as user entries too, so counting every
      // non-meta user entry counts each tool call as a prompt — a tool-heavy
      // session reported 227 "prompts" for ~4 actual ones. An entry carrying any
      // tool_result block is the transcript echoing our own tool output back.
      const isToolResultCarrier =
        Array.isArray(uContent) && uContent.some(b => b.type === "tool_result");

      if (!entry.isMeta) {
        if (!isToolResultCarrier) {
          promptCount++;
          // Flag the NEXT assistant message as answering a real prompt, so a
          // per-period prompt count can be derived from `messages` alone.
          pendingTurnStart = true;
        }
        if (ts !== null) lastUserTimestamp = ts;
        // Extract user prompt text for the next assistant message
        lastPromptText = extractPromptText(entry.message?.content);
        // Detect IDE entrypoint from system-injected tags in user messages
        if (!entrypoint) {
          entrypoint = detectIdeEntrypoint(entry.message?.content);
        }
      }
    } else if (
      type === "system" &&
      entry.subtype === "api_error" &&
      (entry.source === "request_retry" || entry.source === "connection_retry")
    ) {
      // The client's own retry-ladder log for one attempt — see
      // `ApiErrorEvent`'s doc comment. Only entries carrying a real
      // `retryInMs` are a genuine "the client is about to sleep this long"
      // signal; a malformed/partial line without one is dropped rather than
      // counted with a fabricated zero.
      if (entry.uuid && typeof entry.retryInMs === "number") {
        const errObj = typeof entry.error === "object" ? entry.error : undefined;
        const status = typeof errObj?.status === "number" ? errObj.status : null;
        apiErrorEvents.push({
          uuid: entry.uuid,
          sessionId: entry.sessionId ?? sessionId ?? "",
          timestamp: ts,
          terminal: false,
          kind: classifyApiErrorKind(undefined, status),
          status,
          retryInMs: entry.retryInMs,
          retryAttempt: entry.retryAttempt ?? null,
          isNetworkDown: errObj?.isNetworkDown === true,
        });
      }
    } else if (type === "assistant") {
      // A transcript can contain the SAME assistant message more than once:
      // resumes and compaction replay earlier turns verbatim (one real file was
      // measured carrying 2571 repeated uuids, one of them 6 times). The
      // `messages` table collapses those through its `uuid` PRIMARY KEY, which
      // is the correct billing semantics — one API call was charged once. The
      // session accumulators below must therefore skip repeats too, or they
      // over-report by the duplication factor (2.9x on that file) and can never
      // reconcile with the message rows they are supposed to summarise.
      //
      // Entries with no uuid cannot be deduped and also produce no message row,
      // so they stay counted exactly as before.
      //
      // This is only HALF the rule. It collapses the same ENTRY appearing
      // twice; `markUsageCarriers` (below) collapses the N DISTINCT entries one
      // API response is written as. The two are independent — 59% of
      // multi-entry response groups repeat no uuid at all, which is why this
      // guard never noticed the 1.94x.
      const assistantUuid = entry.uuid;
      if (assistantUuid) {
        if (seenAssistantUuids.has(assistantUuid)) continue;
        seenAssistantUuids.add(assistantUuid);
      }

      // A terminal, user-visible API rejection — see `ApiErrorEvent`'s doc
      // comment. Recorded ADDITIVELY alongside the existing (unrelated)
      // per-message accumulation below; this branch never changes what that
      // accumulation does with a zero-usage entry, only adds the event.
      if (entry.isApiErrorMessage === true && assistantUuid) {
        const errorString = typeof entry.error === "string" ? entry.error : undefined;
        const status = typeof entry.apiErrorStatus === "number" ? entry.apiErrorStatus : null;
        apiErrorEvents.push({
          uuid: assistantUuid,
          sessionId: entry.sessionId ?? sessionId ?? "",
          timestamp: ts,
          terminal: true,
          kind: classifyApiErrorKind(errorString, status),
          status,
          retryInMs: null,
          retryAttempt: null,
          isNetworkDown: false,
        });
      }

      assistantMessageCount++;
      const usage = entry.message?.usage;
      const model = entry.message?.model;

      if (model) modelsSet.add(model);

      // Compute response time for this assistant message
      if (ts !== null && lastUserTimestamp !== null) {
        responseTimes.push(ts - lastUserTimestamp);
        lastUserTimestamp = null;
      }

      const msgOutputTokens = usage?.output_tokens ?? 0;
      const msgStopReason = entry.message?.stop_reason;

      // This message answers a real user prompt iff one is pending. Consume the
      // flag so a follow-up assistant message in the same turn isn't also
      // counted as a new prompt.
      const msgIsTurnStart = pendingTurnStart;
      pendingTurnStart = false;

      // Throttle heuristic: truncated at suspiciously low output
      const msgIsThrottled = msgStopReason === "max_tokens" && msgOutputTokens < 200;

      // Only entries that produce no `messages` row are accumulated here; see
      // the `unkeyed*` declarations. Everything else is summed from the message
      // records after the usage-carrier pass.
      if (!assistantUuid) {
        if (msgIsThrottled) unkeyedThrottleEvents++;
        if (usage) {
          unkeyedInputTokens += usage.input_tokens ?? 0;
          unkeyedOutputTokens += msgOutputTokens;
          unkeyedCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          unkeyedCacheReadTokens += usage.cache_read_input_tokens ?? 0;
          unkeyedWebSearchRequests += usage.server_tool_use?.web_search_requests ?? 0;
          unkeyedWebFetchRequests += usage.server_tool_use?.web_fetch_requests ?? 0;
        }
      }

      // Extract tool usage and thinking blocks from content blocks
      const content = entry.message?.content;
      const contentArr = Array.isArray(content) ? content : [];
      const msgTools: string[] = [];
      const msgFilePathsSet = new Set<string>();
      let thinkingBlockCount = 0;
      let toolErrorCount = 0;
      for (const block of contentArr) {
        // A tool_result flagged is_error means the tool call failed (non-zero
        // Bash exit, failed Edit, etc). Additive capture — existing fields untouched.
        if (block.type === "tool_result" && block.is_error === true) {
          toolErrorCount++;
        }
        if (block.type === "tool_use" && block.name) {
          toolUseCounts.set(
            block.name,
            (toolUseCounts.get(block.name) ?? 0) + 1
          );
          msgTools.push(block.name);

          // Extract file paths from tool_use block.input (defensive)
          try {
            const input = block.input as Record<string, unknown> | undefined;
            if (input != null && typeof input === "object") {
              const name = block.name as string;
              if (
                name === "Read" ||
                name === "Edit" ||
                name === "Write" ||
                name === "MultiEdit"
              ) {
                const fp = input["file_path"];
                if (typeof fp === "string" && fp.length > 0) {
                  msgFilePathsSet.add(fp);
                }
              } else if (name === "Glob") {
                const pattern = input["pattern"];
                if (typeof pattern === "string" && pattern.includes("/")) {
                  const dir = dirname(pattern);
                  if (dir.length > 0) msgFilePathsSet.add(dir);
                }
              } else if (name === "Bash") {
                const cwd = input["cwd"];
                if (typeof cwd === "string" && cwd.length > 0) {
                  msgFilePathsSet.add(cwd);
                }
              }
              // All other tools: no path contribution
            }
          } catch {
            // Defensive: never throw on malformed input
          }
        }
        if (block.type === "thinking") {
          thinkingBlockCount++;
        }
      }
      totalThinkingBlocks += thinkingBlockCount;
      const msgFilePaths = Array.from(msgFilePathsSet);

      // Store per-message record for detailed analysis.
      //
      // The three V23 dimensions are shape-validated HERE, where they enter —
      // see `validShape`. `effort` sits at the ENTRY ROOT (not under `message`);
      // `speed` and `output_tokens_details` sit inside `usage`.
      const msgUuid = entry.uuid;
      if (msgUuid) {
        const messageId = validShape(entry.message?.id, MESSAGE_ID_RE);
        const msgInputTokens = usage?.input_tokens ?? 0;
        const msgCacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
        const msgCacheReadTokens = usage?.cache_read_input_tokens ?? 0;
        // A row with no `message.id` cannot be joined to its siblings, so this
        // parser cannot promise its usage is counted once per response — unless
        // it reports no usage at all, which nothing can inflate.
        const hasUsage =
          msgInputTokens + msgOutputTokens + msgCacheCreationTokens + msgCacheReadTokens > 0;
        messages.push({
          uuid: msgUuid,
          sessionId: entry.sessionId ?? sessionId ?? "",
          timestamp: ts,
          claudeVersion: entry.version ?? claudeVersion,
          model: model ?? null,
          stopReason: entry.message?.stop_reason ?? null,
          inputTokens: msgInputTokens,
          outputTokens: msgOutputTokens,
          cacheCreationTokens: msgCacheCreationTokens,
          cacheReadTokens: msgCacheReadTokens,
          tools: msgTools,
          filePaths: msgFilePaths,
          thinkingBlocks: thinkingBlockCount,
          serviceTier: usage?.service_tier ?? null,
          inferenceGeo: usage?.inference_geo ?? null,
          ephemeral5mCacheTokens: usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          ephemeral1hCacheTokens: usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          promptText: lastPromptText,
          toolErrorCount,
          isTurnStart: msgIsTurnStart,
          webSearchRequests: usage?.server_tool_use?.web_search_requests ?? 0,
          webFetchRequests: usage?.server_tool_use?.web_fetch_requests ?? 0,
          isThrottled: msgIsThrottled,
          messageId,
          // Every entry starts as a carrier; `markUsageCarriers` demotes the
          // non-winners once the whole range has been read.
          usageCounted: true,
          effort: validShape(entry.effort, SHORT_TOKEN_RE),
          speed: validShape(usage?.speed, SHORT_TOKEN_RE),
          thinkingTokens: validTokenCount(usage?.output_tokens_details?.thinking_tokens),
          costBasis: messageId !== null || !hasUsage ? "per-response" : "pre-dedupe",
        });
      }
      lastPromptText = null;
    }
  }

  // One API response = one charge. Strip the repeated usage off every
  // non-carrier entry BEFORE the session totals are derived from the records,
  // so `ParseResult.session` and `ParseResult.messages` state the same number.
  markUsageCarriers(messages);

  let inputTokens = unkeyedInputTokens;
  let outputTokens = unkeyedOutputTokens;
  let cacheCreationTokens = unkeyedCacheCreationTokens;
  let cacheReadTokens = unkeyedCacheReadTokens;
  let webSearchRequests = unkeyedWebSearchRequests;
  let webFetchRequests = unkeyedWebFetchRequests;
  let throttleEvents = unkeyedThrottleEvents;
  for (const m of messages) {
    // Non-carriers are already zeroed, so this is a sum over carriers.
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    cacheCreationTokens += m.cacheCreationTokens;
    cacheReadTokens += m.cacheReadTokens;
    webSearchRequests += m.webSearchRequests ?? 0;
    webFetchRequests += m.webFetchRequests ?? 0;
    if (m.isThrottled) throttleEvents++;
  }

  const toolUseCountsArr: ToolUseCount[] = Array.from(
    toolUseCounts.entries()
  ).map(([name, count]) => ({ name, count }));

  // Compute active session duration, excluding idle gaps > 30 minutes
  let activeDurationMs: number | null = null;
  if (allTimestamps.length >= 2) {
    const sorted = allTimestamps.slice().sort((a, b) => a - b);
    let active = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!;
      if (gap < 30 * 60_000) active += gap;
    }
    activeDurationMs = active;
  }

  // Compute median response time (assistant latency after user prompt)
  let medianResponseTimeMs: number | null = null;
  if (responseTimes.length > 0) {
    const sorted = responseTimes.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianResponseTimeMs = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
      : sorted[mid]!;
  }

  const session: SessionRecord | null = sessionId
    ? {
        sessionId,
        projectPath: cwdFromContent ?? projectPath,
        sourceFile: filePath,
        firstTimestamp,
        lastTimestamp,
        claudeVersion,
        entrypoint: entrypoint ?? "cli",
        gitBranch,
        permissionMode,
        isInteractive: hasQueueOperation,
        promptCount,
        assistantMessageCount,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        webSearchRequests,
        webFetchRequests,
        toolUseCounts: toolUseCountsArr,
        models: Array.from(modelsSet),
        repoUrl: null,
        accountUuid: null,
        organizationUuid: null,
        subscriptionType: null,
        thinkingBlocks: totalThinkingBlocks,
        parentSessionId: null, // resolved by aggregator from parentUuid
        isSubagent: false,     // set by aggregator from scanner flag
        sourceDeleted: false,
        throttleEvents,
        activeDurationMs,
        medianResponseTimeMs,
      }
    : null;

  return { session, messages, errors, lastGoodOffset, firstKbHash, parentUuid, apiErrorEvents };
}

/**
 * Extract the user-typed prompt text from a message content field.
 * Strips system/IDE tags and tool_result blocks, keeping only actual user text.
 * Returns null if no meaningful text is found.
 *
 * Security: delegates to {@link sanitizePromptText} which performs
 * strip-AND-escape before the length cap, so an attacker cannot smuggle a
 * late-opening system tag past the cap. See sanitize.ts for rationale.
 */
function extractPromptText(content: string | import("../types.js").ContentBlock[] | undefined): string | null {
  if (!content) return null;

  let texts: string[];
  if (typeof content === "string") {
    texts = [content];
  } else if (Array.isArray(content)) {
    texts = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!);
  } else {
    return null;
  }

  return sanitizePromptText(texts.join("\n"));
}

/**
 * Detect IDE entrypoint from user message content.
 * VS Code / IDE sessions include system-injected tags like ide_selection,
 * ide_opened_file, or "VSCode Extension Context" in the prompt content.
 * Returns "vscode" when IDE signals are found, null otherwise.
 */
function detectIdeEntrypoint(content: string | import("../types.js").ContentBlock[] | undefined): string | null {
  if (!content) return null;

  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text" && b.text) texts.push(b.text);
    }
  }

  const raw = texts.join("\n");

  if (
    raw.includes("<ide_selection") ||
    raw.includes("<ide_opened_file") ||
    raw.includes("<ide_diagnostics") ||
    raw.includes("VSCode Extension Context") ||
    raw.includes("VSCode native extension")
  ) {
    return "vscode";
  }

  return null;
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise a raw timestamp value to epoch-milliseconds.
 * Modern Claude Code emits ISO-8601 strings; older versions emitted numbers.
 * Returns null for missing, non-finite, or unparseable values.
 */
export function toEpochMs(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  return isFinite(ms) ? ms : null;
}
