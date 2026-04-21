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
import type {
  RawSessionEntry,
  MessageRecord,
  SessionRecord,
  ToolUseCount,
  ParseError,
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

  // Collect all raw lines from startOffset
  const lines: Array<{ raw: string; offset: number }> = [];
  let currentOffset = startOffset;

  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: startOffset,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
    if (line.trim()) {
      lines.push({ raw: line, offset: currentOffset });
    }
    currentOffset += lineBytes;
  }

  // Rule 6: discard the last line if it fails JSON parsing (partial write)
  let lastGoodOffset = startOffset;
  const linesToProcess =
    lines.length > 0 && !isValidJson(lines[lines.length - 1]!.raw)
      ? lines.slice(0, -1)
      : lines;

  // Session-level accumulators
  let sessionId: string | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let claudeVersion: string | null = null;
  let entrypoint: string | null = null;
  let gitBranch: string | null = null;
  let permissionMode: string | null = null;
  let hasQueueOperation = false;
  let promptCount = 0;
  let assistantMessageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  let totalThinkingBlocks = 0;
  const toolUseCounts = new Map<string, number>();
  const modelsSet = new Set<string>();

  // Subagent parent linkage
  let parentUuid: string | null = null;

  // New accumulators for usage analysis
  let throttleEvents = 0;
  const allTimestamps: number[] = [];     // for active duration
  const responseTimes: number[] = [];     // assistant_ts - user_ts pairs
  let lastUserTimestamp: number | null = null;
  let lastPromptText: string | null = null;

  let lineNumber = 0;
  for (const { raw, offset } of linesToProcess) {
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
      if (!entry.isMeta) {
        promptCount++;
        if (ts !== null) lastUserTimestamp = ts;
        // Extract user prompt text for the next assistant message
        lastPromptText = extractPromptText(entry.message?.content);
        // Detect IDE entrypoint from system-injected tags in user messages
        if (!entrypoint) {
          entrypoint = detectIdeEntrypoint(entry.message?.content);
        }
      }
    } else if (type === "assistant") {
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

      // Throttle heuristic: truncated at suspiciously low output
      if (msgStopReason === "max_tokens" && msgOutputTokens < 200) {
        throttleEvents++;
      }

      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += msgOutputTokens; // msgOutputTokens = usage.output_tokens ?? 0
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0;
        webFetchRequests += usage.server_tool_use?.web_fetch_requests ?? 0;
      }

      // Extract tool usage and thinking blocks from content blocks
      const content = entry.message?.content;
      const contentArr = Array.isArray(content) ? content : [];
      const msgTools: string[] = [];
      let thinkingBlockCount = 0;
      for (const block of contentArr) {
        if (block.type === "tool_use" && block.name) {
          toolUseCounts.set(
            block.name,
            (toolUseCounts.get(block.name) ?? 0) + 1
          );
          msgTools.push(block.name);
        }
        if (block.type === "thinking") {
          thinkingBlockCount++;
        }
      }
      totalThinkingBlocks += thinkingBlockCount;

      // Store per-message record for detailed analysis
      const msgUuid = entry.uuid;
      if (msgUuid) {
        messages.push({
          uuid: msgUuid,
          sessionId: entry.sessionId ?? sessionId ?? "",
          timestamp: ts,
          claudeVersion: entry.version ?? claudeVersion,
          model: model ?? null,
          stopReason: entry.message?.stop_reason ?? null,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: msgOutputTokens,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          tools: msgTools,
          thinkingBlocks: thinkingBlockCount,
          serviceTier: usage?.service_tier ?? null,
          inferenceGeo: usage?.inference_geo ?? null,
          ephemeral5mCacheTokens: usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          ephemeral1hCacheTokens: usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          promptText: lastPromptText,
        });
      }
      lastPromptText = null;
    }
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
        projectPath,
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

  return { session, messages, errors, lastGoodOffset, firstKbHash, parentUuid };
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
