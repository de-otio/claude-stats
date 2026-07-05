/**
 * Phase D — APPLY merged winners into SQLite (imperative shell).
 *
 * The cross-device decision is already made in the pure {@link mergeRecords}
 * fold, off the origin logical clock (B2). By the time a {@link MergedSession}
 * reaches here it IS the convergent truth for that `session_id`, so applying it
 * is a plain idempotent upsert — the store's own `updated_at = Date.now()` stamp
 * is irrelevant to convergence and is never read as a clock.
 *
 * OWN-DEVICE ROWS ARE LEFT ALONE. A device's own locally-originated sessions are
 * authoritative in its local DB (and freshly re-collected there); merge only
 * IMPORTS other devices' sessions. So a row whose winning clock names THIS device
 * is skipped — otherwise a just-collected-but-not-yet-pushed local edit could be
 * clobbered by an older snapshot of itself round-tripped through a shard.
 */

import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";
import type { DeviceId } from "@claude-stats/core/types/shard";
import type { Store, MessageRow, SessionRow } from "../store/index.js";
import type { MergedSession } from "./merge.js";

function parseJsonArray<T>(json: string): T[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Project a merged {@link SessionRow} back into the store's write shape. */
export function rowToSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    sourceFile: row.source_file,
    firstTimestamp: row.first_timestamp,
    lastTimestamp: row.last_timestamp,
    claudeVersion: row.claude_version,
    entrypoint: row.entrypoint,
    gitBranch: row.git_branch,
    // permission_mode is not carried on SessionRow; upsert leaves it null.
    permissionMode: null,
    isInteractive: row.is_interactive !== 0,
    promptCount: row.prompt_count,
    assistantMessageCount: row.assistant_message_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    webSearchRequests: row.web_search_requests,
    webFetchRequests: row.web_fetch_requests,
    toolUseCounts: parseJsonArray(row.tool_use_counts),
    models: parseJsonArray<string>(row.models),
    repoUrl: row.repo_url,
    accountUuid: row.account_uuid,
    organizationUuid: row.organization_uuid,
    subscriptionType: row.subscription_type,
    thinkingBlocks: row.thinking_blocks,
    parentSessionId: row.parent_session_id,
    isSubagent: row.is_subagent !== 0,
    sourceDeleted: row.source_deleted !== 0,
    throttleEvents: row.throttle_events,
    activeDurationMs: row.active_duration_ms,
    medianResponseTimeMs: row.median_response_time_ms,
  };
}

/** Project a merged {@link MessageRow} back into the store's write shape. */
export function rowToMessageRecord(row: MessageRow): MessageRecord {
  return {
    uuid: row.uuid,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    claudeVersion: row.claude_version,
    model: row.model,
    stopReason: row.stop_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    tools: parseJsonArray<string>(row.tools),
    filePaths: parseJsonArray<string>(row.file_paths),
    thinkingBlocks: row.thinking_blocks,
    serviceTier: row.service_tier,
    inferenceGeo: row.inference_geo,
    ephemeral5mCacheTokens: row.ephemeral_5m_cache_tokens,
    ephemeral1hCacheTokens: row.ephemeral_1h_cache_tokens,
    promptText: row.prompt_text,
    toolErrorCount: row.tool_error_count ?? 0,
  };
}

export interface ApplyOptions {
  /**
   * This device's id. Merged sessions whose winning clock originates HERE are
   * skipped — the local DB already owns them (see file header). Omit to apply
   * every merged session (e.g. importing into a fresh device with no local data).
   */
  readonly selfDeviceId?: DeviceId;
}

export interface ApplyResult {
  readonly sessionsApplied: number;
  readonly messagesApplied: number;
  readonly skippedOwnDevice: number;
}

/**
 * Upsert the merged winners into the store, one transaction for the whole batch
 * (all-or-nothing, matching the store's crash-recovery model). Idempotent:
 * re-applying the same merged set is a no-op beyond re-stamping `updated_at`.
 */
export function applyMerged(
  store: Store,
  merged: readonly MergedSession[],
  options: ApplyOptions = {},
): ApplyResult {
  let sessionsApplied = 0;
  let messagesApplied = 0;
  let skippedOwnDevice = 0;

  store.transaction(() => {
    for (const m of merged) {
      if (options.selfDeviceId && m.clock.originDevice === options.selfDeviceId) {
        skippedOwnDevice++;
        continue;
      }
      store.upsertSession(rowToSessionRecord(m.session));
      if (m.messages.length > 0) {
        store.upsertMessages(m.messages.map(rowToMessageRecord));
        messagesApplied += m.messages.length;
      }
      sessionsApplied++;
    }
  });

  return { sessionsApplied, messagesApplied, skippedOwnDevice };
}
