/**
 * Core domain types for claude-stats.
 *
 * All fields from Claude Code session files are treated as optional — the
 * schema has no stability contract and fields have been observed missing.
 * See doc/analysis/07-schema-reference.md and doc/analysis/08-resilience.md.
 */

// ─── Raw session JSONL types ──────────────────────────────────────────────────

export type MessageType =
  | "user"
  | "assistant"
  | "system"
  | "progress"
  | "queue-operation"
  | "file-history-snapshot"
  | "last-prompt"
  | string; // unknown future types

export interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string;
  inference_geo?: string;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking" | string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // text
  text?: string;
  // tool_result
  tool_use_id?: string;
  content?: string | ContentBlock[];
  // thinking
  thinking?: string;
}

export interface MessagePayload {
  role?: "user" | "assistant";
  model?: string;
  id?: string;
  type?: string;
  content?: string | ContentBlock[];
  stop_reason?: string;
  stop_sequence?: string | null;
  usage?: UsageData;
}

/** A single line from a session JSONL file. All fields are optional. */
export interface RawSessionEntry {
  type?: MessageType;
  /** ISO-8601 string (e.g. "2026-03-10T09:46:58.588Z") in modern Claude Code;
   *  older versions may emit a numeric epoch-ms value. */
  timestamp?: string | number;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  entrypoint?: string;
  permissionMode?: string;
  isMeta?: boolean;
  message?: MessagePayload;
  requestId?: string;
  // queue-operation
  operation?: "enqueue" | "dequeue";
  // system
  subtype?: string;
  content?: string;
  level?: string;
  // progress
  data?: unknown;
  parentToolUseID?: string;
  toolUseID?: string;
  // last-prompt
  lastPrompt?: string;
}

// ─── Aggregated / processed types ────────────────────────────────────────────

export interface ToolUseCount {
  name: string;
  count: number;
}

export interface SessionRecord {
  sessionId: string;
  projectPath: string;
  sourceFile: string;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  claudeVersion: string | null;
  entrypoint: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  isInteractive: boolean;
  promptCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  toolUseCounts: ToolUseCount[];
  models: string[];
  repoUrl: string | null;
  accountUuid: string | null;
  organizationUuid: string | null;
  subscriptionType: string | null;
  thinkingBlocks: number;
  parentSessionId: string | null;
  isSubagent: boolean;
  sourceDeleted: boolean;
  throttleEvents: number;
  activeDurationMs: number | null;
  medianResponseTimeMs: number | null;
}

export interface MessageRecord {
  uuid: string;
  sessionId: string;
  timestamp: number | null;
  claudeVersion: string | null;
  model: string | null;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  tools: string[];
  thinkingBlocks: number;
  serviceTier: string | null;
  inferenceGeo: string | null;
  ephemeral5mCacheTokens: number;
  ephemeral1hCacheTokens: number;
  promptText: string | null;
}

// ─── Collection state ─────────────────────────────────────────────────────────

export interface FileCheckpoint {
  filePath: string;
  fileSize: number;
  lastByteOffset: number;
  lastMtime: number;
  firstKbHash: string;
  sourceDeleted: boolean;
}

// ─── Schema fingerprint ───────────────────────────────────────────────────────

export interface SchemaFingerprint {
  claudeVersion: string;
  capturedAt: number;
  messageTypes: string[];
  /** top-level field names per message type */
  fieldsByType: Record<string, string[]>;
  usageFields: string[];
}

// ─── Usage windows ────────────────────────────────────────────────────────────

export interface UsageWindow {
  windowStart: number;    // epoch-ms, when the first prompt in this window occurred
  windowEnd: number;      // epoch-ms, windowStart + 5 hours
  accountUuid: string | null;
  totalCostEquivalent: number;
  promptCount: number;
  tokensByModel: Record<string, number>;
  throttled: boolean;
}

// ─── Plan configuration ───────────────────────────────────────────────────────

export type PlanType = "pro" | "max_5x" | "max_20x" | "team_standard" | "team_premium" | "custom";

export interface PlanConfig {
  type: PlanType;
  monthlyFee: number;
}

// ─── Parse errors / quarantine ───────────────────────────────────────────────

export interface ParseError {
  filePath: string;
  lineNumber: number;
  rawLine: string;
  error: string;
  timestamp: number;
  claudeVersion?: string;
}
