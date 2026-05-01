/**
 * Aggregator — orchestrates collection: scan → parse → schema check → store.
 *
 * Implements incremental collection with crash-safe checkpoints.
 * See doc/analysis/02-collection-strategy.md.
 */
import { discoverSessionFiles, getFileStats } from "../scanner/index.js";
import { getGitRemoteUrl } from "../git.js";
import { parseSessionFile, hashFirstKb } from "@claude-stats/core/parser/session";
import { collectAccountMap } from "@claude-stats/core/parser/telemetry";
import { readClaudeAccount } from "../account.js";
import { checkSchema } from "../schema/monitor.js";
import { estimateCost } from "@claude-stats/core/pricing";
import type { Store } from "../store/index.js";
import type { RawSessionEntry, UsageWindow } from "@claude-stats/core/types";

export interface CollectOptions {
  verbose?: boolean;
}

export interface CollectResult {
  filesProcessed: number;
  filesSkipped: number;
  filesDeleted: number;
  sessionsUpserted: number;
  messagesUpserted: number;
  accountsMatched: number;
  parseErrors: number;
  schemaChanges: string[];
}

export async function collect(
  store: Store,
  opts: CollectOptions = {}
): Promise<CollectResult> {
  const result: CollectResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    sessionsUpserted: 0,
    messagesUpserted: 0,
    accountsMatched: 0,
    parseErrors: 0,
    schemaChanges: [],
  };

  const sessionFiles = discoverSessionFiles();

  // Best-effort: build session → account mapping from telemetry
  const accountMap = collectAccountMap();

  // Fallback: current logged-in account from ~/.claude.json
  // Only used when telemetry doesn't provide account info for a session.
  // Safe for reparse: the store uses COALESCE(sessions.account_uuid, excluded.account_uuid)
  // so an existing DB value is never overwritten.
  const currentAccount = readClaudeAccount();

  // Accumulate entries per version for schema fingerprinting
  const entriesByVersion = new Map<string, RawSessionEntry[]>();
  // Cache repo URLs per project path to avoid re-reading .git/config for each session file
  const repoUrlCache = new Map<string, string | null>();

  for (const sf of sessionFiles) {
    const fileStats = getFileStats(sf.filePath);

    if (!fileStats) {
      // File has been deleted since discovery
      store.markSourceDeleted(sf.filePath);
      result.filesDeleted++;
      continue;
    }

    const checkpoint = store.getCheckpoint(sf.filePath);

    // Determine if file needs processing
    let startOffset = 0;

    if (checkpoint) {
      if (
        checkpoint.lastMtime === fileStats.mtime &&
        checkpoint.fileSize === fileStats.size
      ) {
        result.filesSkipped++;
        continue; // File unchanged
      }

      // File changed — check if it's an append or a rewrite.
      // Compare only the bytes that existed at checkpoint time (up to 1KB)
      // so that appended content within the first 1KB doesn't trigger rewrite.
      const compareBytes = Math.min(checkpoint.fileSize, 1024);
      const currentHash = hashFirstKb(sf.filePath, compareBytes);
      if (
        currentHash === checkpoint.firstKbHash &&
        fileStats.size >= checkpoint.fileSize
      ) {
        // Append-only — seek to last processed offset
        startOffset = checkpoint.lastByteOffset;
      } else {
        // File was rewritten — reprocess from the beginning
        startOffset = 0;
        if (opts.verbose) {
          console.log(`[rewrite detected] ${sf.filePath}`);
        }
      }
    }

    const parsed = await parseSessionFile(
      sf.filePath,
      sf.projectPath,
      startOffset
    );

    result.filesProcessed++;
    result.parseErrors += parsed.errors.length;

    // Store everything in a single transaction for crash safety
    // Resolve repo URL once per project path
    if (parsed.session && !repoUrlCache.has(sf.projectPath)) {
      repoUrlCache.set(sf.projectPath, getGitRemoteUrl(sf.projectPath));
    }
    if (parsed.session) {
      parsed.session.repoUrl = repoUrlCache.get(sf.projectPath) ?? null;

      // Set subagent flag from scanner; resolve parentUuid → parentSessionId
      parsed.session.isSubagent = sf.isSubagent;
      if (parsed.parentUuid) {
        parsed.session.parentSessionId = store.resolveParentSessionId(parsed.parentUuid);
      }

      // Best-effort account enrichment from telemetry
      const acct = accountMap.get(parsed.session.sessionId);
      if (acct) {
        parsed.session.accountUuid = acct.accountUuid;
        parsed.session.organizationUuid = acct.organizationUuid;
        parsed.session.subscriptionType = acct.subscriptionType;
      } else if (currentAccount) {
        // Fallback to currently logged-in account from ~/.claude.json.
        // The store's COALESCE preserves existing DB values, so this
        // won't overwrite accounts stamped by a previous parse.
        parsed.session.accountUuid = currentAccount.accountUuid;
        parsed.session.organizationUuid = currentAccount.organizationUuid;
      }
    }

    store.transaction(() => {
      if (parsed.session) {
        if (startOffset > 0) {
          store.upsertSessionIncremental(parsed.session);
        } else {
          store.upsertSession(parsed.session);
        }
        result.sessionsUpserted++;
      }

      if (parsed.messages.length > 0) {
        store.upsertMessages(parsed.messages);
        result.messagesUpserted += parsed.messages.length;
      }

      if (parsed.errors.length > 0) {
        store.addToQuarantine(parsed.errors);
      }

      store.upsertCheckpoint({
        filePath: sf.filePath,
        fileSize: fileStats.size,
        lastByteOffset: parsed.lastGoodOffset,
        lastMtime: fileStats.mtime,
        firstKbHash: parsed.firstKbHash,
        sourceDeleted: false,
      });
    });

    // Collect entries for schema fingerprinting (sample: assistant messages only)
    if (parsed.session?.claudeVersion) {
      const version = parsed.session.claudeVersion;
      if (!entriesByVersion.has(version)) {
        entriesByVersion.set(version, []);
      }
    }

    if (opts.verbose && parsed.session) {
      console.log(
        `[ok] ${sf.filePath} — session ${parsed.session.sessionId.slice(0, 8)}… ` +
          `${parsed.session.promptCount} prompts, ` +
          `${parsed.session.inputTokens.toLocaleString()} input tokens`
      );
    }
  }

  // Reconcile: mark checkpointed files that are no longer on disk as source_deleted.
  // This handles clean deletions (not just race conditions).
  const discoveredPaths = new Set(sessionFiles.map((sf) => sf.filePath));
  for (const cp of store.getAllCheckpoints()) {
    if (!discoveredPaths.has(cp.filePath) && !getFileStats(cp.filePath)) {
      store.markSourceDeleted(cp.filePath);
      result.filesDeleted++;
    }
  }

  // Best-effort: backfill account info for previously-collected sessions
  if (accountMap.size > 0) {
    result.accountsMatched = store.updateSessionAccounts(accountMap);
  }

  // Schema check: sample stored sessions per version
  // (skipped for brevity in initial implementation — triggered by diagnose command)

  // Recompute usage windows for the past 2 days to catch any in-progress windows
  const windowSince = Date.now() - 2 * 24 * 60 * 60 * 1000;
  computeAndUpsertWindows(store, windowSince);

  return result;
}

const WINDOW_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours
const IDLE_GAP_MS = 30 * 60 * 1000;             // 30 min gap = session boundary

/**
 * Compute 5-hour usage windows from recent sessions and upsert them.
 *
 * Sessions are sorted by first_timestamp. Greedy assignment: each session
 * joins the current window if it starts within 5h of that window's start;
 * otherwise a new window begins.
 */
function computeAndUpsertWindows(store: Store, since: number): void {
  const sessions = store.getSessions({ since, includeCI: true, includeDeleted: true });
  if (sessions.length === 0) return;

  const sorted = sessions
    .filter(s => s.first_timestamp != null)
    .sort((a, b) => a.first_timestamp! - b.first_timestamp!);

  if (sorted.length === 0) return;

  // Get per-session message totals for cost computation
  const sessionIds = sorted.map(s => s.session_id);
  const msgTotals = store.getMessageTotalsBySession(sessionIds);

  // Build a map: sessionId → estimated cost + tokensByModel
  const sessionCostMap = new Map<string, { cost: number; tokensByModel: Record<string, number> }>();
  for (const row of msgTotals) {
    const entry = sessionCostMap.get(row.session_id) ?? { cost: 0, tokensByModel: {} };
    const { cost } = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens);
    entry.cost += cost;
    entry.tokensByModel[row.model] = (entry.tokensByModel[row.model] ?? 0) + row.input_tokens + row.output_tokens;
    sessionCostMap.set(row.session_id, entry);
  }

  // Group sessions into 5-hour windows
  const windows: UsageWindow[] = [];
  let windowStart: number | null = null;
  let currentWindow: UsageWindow | null = null;

  for (const session of sorted) {
    const ts = session.first_timestamp!;

    if (windowStart === null || ts >= windowStart + WINDOW_DURATION_MS) {
      // Start a new window
      windowStart = ts;
      currentWindow = {
        windowStart: ts,
        windowEnd: ts + WINDOW_DURATION_MS,
        accountUuid: session.account_uuid,
        totalCostEquivalent: 0,
        promptCount: 0,
        tokensByModel: {},
        throttled: false,
      };
      windows.push(currentWindow);
    }

    const costs = sessionCostMap.get(session.session_id);
    if (costs) {
      currentWindow!.totalCostEquivalent += costs.cost;
      for (const [model, tokens] of Object.entries(costs.tokensByModel)) {
        currentWindow!.tokensByModel[model] = (currentWindow!.tokensByModel[model] ?? 0) + tokens;
      }
    }
    currentWindow!.promptCount += session.prompt_count;
    if (session.throttle_events > 0) currentWindow!.throttled = true;
  }

  // Upsert all computed windows
  for (const w of windows) {
    w.totalCostEquivalent = Math.round(w.totalCostEquivalent * 10000) / 10000;
    store.upsertUsageWindow(w);
  }
}
