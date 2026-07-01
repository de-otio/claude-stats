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
  /** Set on a tool_result when the tool call failed (non-zero exit / error). */
  is_error?: boolean;
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
  filePaths?: string[];   // file paths extracted from tool_use block.input; optional for backward compat
  thinkingBlocks: number;
  serviceTier: string | null;
  inferenceGeo: string | null;
  ephemeral5mCacheTokens: number;
  ephemeral1hCacheTokens: number;
  promptText: string | null;
  /**
   * Count of tool_result blocks in this message flagged `is_error` (a tool call
   * that failed — e.g. a non-zero Bash exit, a failed Edit). Optional for
   * back-compat: records/rows written before this field default to 0/undefined.
   */
  toolErrorCount?: number;
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

// ─── Account attribution ──────────────────────────────────────────────────────

/**
 * Precedence (strongest → weakest):
 *   override > otel > telemetry > anchor > observation > backfill > unknown
 * The attribution engine never overwrites a stronger source with a weaker one.
 */
export type AttributionSource =
  | "override"
  | "otel"
  | "telemetry"
  | "anchor"
  | "observation"
  | "backfill"
  | "unknown";

export type AttributionConfidence =
  | "authoritative"
  | "high"
  | "medium"
  | "low"
  | "none";

/** A session entrypoint value (`cli`, `claude`, `claude-vscode`, …). */
export type Surface = string;

/**
 * Surfaces eligible for the observation-interval assignment path. ALLOWLIST,
 * not denylist: any entrypoint not in this set falls through to `unknown`
 * unless otel/telemetry/anchor supplies an account.
 */
export const CLI_SURFACES = ["cli", "claude"] as const;

/** One append-only observation of an account being active on a surface. */
export interface AccountObservation {
  accountUuid: string;
  observedAt: number;
  source: string;
  surface: string | null;
  rateLimitTier: string | null;
  billingType: string | null;
}

/** A row in the `accounts` table — the latest known metadata for an account. */
export interface AccountRecord {
  accountUuid: string;
  organizationUuid: string | null;
  emailHash: string | null;
  emailLabel: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
  userRateLimitTier: string | null;
  seatTier: string | null;
  billingType: string | null;
  subscriptionType: string | null;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
}

// ─── Cost-ownership rules (doc 10) ───────────────────────────────────────────
// A per-project COST policy: which subscription owns a project's spend,
// regardless of which account was logged in. `split` = no owner; defer to the
// measured account so cost divides by actual usage. See
// doc/analysis/account-attribution/10-cost-ownership-guided-classification.md.

/** Target of an owner rule: a specific account, or "split by actual usage". */
export type OwnerTarget =
  | { kind: "account"; accountUuid: string }
  | { kind: "split" };

/**
 * A durable owner rule. Matches a session when `pathGlob` matches its
 * project_path OR `remoteGlob` matches the parsed owner of its repo_url. At
 * least one matcher is non-null (enforced at write time). Stored in the local
 * `account_owner_rules` table (never in the repo).
 */
export interface OwnerRule {
  id: number;
  pathGlob: string | null;
  remoteGlob: string | null;
  target: OwnerTarget;
  createdAt: number;
}

/** A cost-ranked cluster of projects for the guided classifier. */
export interface ProjectCluster {
  /** Stable identity of the cluster (the shared path root or remote owner). */
  key: string;
  kind: "path" | "remote";
  /** Human label (the path root or `host/org`). */
  label: string;
  projectPaths: string[];
  sessionCount: number;
  estimatedCost: number;
  /** A matcher that would classify the whole cluster in one rule. */
  suggestedMatcher: { pathGlob?: string; remoteGlob?: string };
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
