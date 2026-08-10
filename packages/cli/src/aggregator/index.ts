/**
 * Aggregator — orchestrates collection: scan → parse → schema check → store.
 *
 * Implements incremental collection with crash-safe checkpoints.
 * See doc/analysis/02-collection-strategy.md.
 */
import { discoverSessionFiles, getFileStats } from "../scanner/index.js";
import { getGitRemoteUrl } from "../git.js";
import { parseSessionFile, hashFirstKb } from "@claude-stats/core/parser/session";
import { checkSchema } from "../schema/monitor.js";
import { estimateCost } from "@claude-stats/core/pricing";
import { collectAccountMap } from "@claude-stats/core/parser/telemetry";
import type { Store } from "../store/index.js";
import type { RawSessionEntry, UsageWindow } from "@claude-stats/core/types";
import { readClaudeAccount } from "../account.js";
import { writeObservation } from "../attribution/observer.js";
import { buildCliIntervals } from "../attribution/intervals.js";
import { assignAccounts } from "../attribution/assign.js";
import type { ExternalAccountInfo } from "../attribution/assign.js";
import { collectLiveSessionPins } from "../attribution/anchors.js";
import { resolveOwner } from "../attribution/ownership.js";
import { runTicketExtraction } from "../ticketing/index.js";
import { createCommitSubjectsCache } from "../recap/git.js";

export interface CollectOptions {
  verbose?: boolean;
  /**
   * `config.tickets.projectKeys` (ticket-attribution/01 §1.1). Threaded
   * through explicitly, like the `now` clock below, rather than `collect`
   * calling `loadConfig()` itself — keeps this function's behavior fully
   * determined by its arguments, which is what makes it testable without a
   * config file on disk. Callers: `loadConfig().tickets?.projectKeys` (or
   * `ticketProjectKeys(loadConfig())` from `../config.js`).
   */
  ticketAllowlist?: readonly string[];
}

export interface CollectResult {
  filesProcessed: number;
  filesSkipped: number;
  filesDeleted: number;
  sessionsUpserted: number;
  messagesUpserted: number;
  accountsMatched: number;
  /** Messages stamped with a straddle-split account this run (see assign.ts). */
  messagesStamped: number;
  /**
   * Sessions stamped with account_source='override' from owner rules this run.
   * Freshly-collected sessions under an owned project path or remote are
   * overridden immediately so they appear attributed without a full reattribute.
   */
  ownerOverrides: number;
  parseErrors: number;
  schemaChanges: string[];
}

export async function collect(
  store: Store,
  opts: CollectOptions = {},
  now: () => number = Date.now
): Promise<CollectResult> {
  const result: CollectResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    sessionsUpserted: 0,
    messagesUpserted: 0,
    accountsMatched: 0,
    messagesStamped: 0,
    ownerOverrides: 0,
    parseErrors: 0,
    schemaChanges: [],
  };

  const sessionFiles = discoverSessionFiles();

  // Phase-2 (A) seam 1 — observation writer (once per collect): record the
  // current CLI account as an observation iff it changed since the last CLI
  // sighting, and refresh the accounts metadata row. Surface-aware assignment
  // happens after the file loop (seam 2). The injected `now` clock keeps the
  // observation timestamp deterministic in tests.
  const currentAccount = readClaudeAccount();
  writeObservation(store, currentAccount, now);

  // Phase-2 (B) seam 1b — live-session anchor pins (doc 03 §B). For each
  // CLI-surface session currently active under the read account, persist a pin
  // so reattribute can apply it at `anchor` precedence after the (ephemeral)
  // session file is gone. currentIntervalStart = start of the current account's
  // open interval (the recency guard against stale session files).
  if (currentAccount) {
    const nowMs = now();
    const intervals = buildCliIntervals(store.getAccountObservations());
    const currentIntervalStart = intervals.length > 0 ? intervals[intervals.length - 1]!.start : nowMs;
    for (const pin of collectLiveSessionPins(currentAccount.accountUuid, currentIntervalStart, nowMs)) {
      store.recordAnchorPin(pin);
    }
  }

  // Track the session ids upserted in THIS collect run so seam 2 only assigns
  // accounts to sessions we just touched (the incremental path).
  const upsertedSessionIds = new Set<string>();

  // Accumulate entries per version for schema fingerprinting
  const entriesByVersion = new Map<string, RawSessionEntry[]>();
  // Cache repo URLs per project path to avoid re-reading .git/config for each session file
  const repoUrlCache = new Map<string, string | null>();
  // A3: memoize the ticket-extraction commit-subject `git log` lookups across
  // this whole run — see `CommitSubjectsCache`'s doc comment in recap/git.ts.
  // Without this, `backfill` (which re-collects every session) spawns one
  // blocking `git log` subprocess PER SESSION FILE with no reuse.
  const ticketCommitCache = createCommitSubjectsCache();

  // Accumulate the set of message_hourly hour buckets touched by this collect, so
  // we can incrementally recompute only those partitions (DELETE+INSERT) instead
  // of rebuilding the whole rollup. The bucket expression mirrors the store's
  // recomputeMessageHourly: COALESCE(floor(timestamp/3600000), -1). For positive
  // timestamps floor() matches SQLite's CAST(... AS INTEGER) truncation exactly.
  // This covers both append (parsed.messages = new lines only) and rewrite
  // (parsed.messages = the whole file from offset 0): every upserted message's
  // bucket is added, so any partition that could have changed is recomputed.
  const touchedHours = new Set<number>();

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
    // Resolve repo URL once per project path. Use the parser's corrected
    // path (preferring the session's own `cwd`) — not the scanner's
    // directory-decoded `sf.projectPath`, which is lossy for hyphenated
    // directory names and would point getGitRemoteUrl at a nonexistent path.
    if (parsed.session) {
      const resolvedProjectPath = parsed.session.projectPath;
      if (!repoUrlCache.has(resolvedProjectPath)) {
        repoUrlCache.set(resolvedProjectPath, getGitRemoteUrl(resolvedProjectPath));
      }
      parsed.session.repoUrl = repoUrlCache.get(resolvedProjectPath) ?? null;

      // Set subagent flag from scanner; resolve parentUuid → parentSessionId
      parsed.session.isSubagent = sf.isSubagent;
      if (parsed.parentUuid) {
        parsed.session.parentSessionId = store.resolveParentSessionId(parsed.parentUuid);
      }

      // Surface-aware assignment runs once after the file loop (seam 2); no
      // per-session account stamping here. Record the id so seam 2 only
      // considers sessions touched by this run.
      upsertedSessionIds.add(parsed.session.sessionId);
    }

    store.transaction(() => {
      // Compare-and-swap against the checkpoint we planned this parse from.
      // `getCheckpoint` above ran OUTSIDE any transaction and the parse is async,
      // so a second collector (VS Code extension, MCP server, CLI — all of which
      // can run concurrently) may have processed this same range meanwhile. Its
      // work is a superset of ours, so ours is pure waste: re-parsing lines into
      // quarantine twice and re-writing rows we already have.
      //
      // Correctness no longer DEPENDS on this — the session counters are a
      // projection of the uuid-keyed `messages` table now, so applying a delta
      // twice is a no-op. This is the cheap guard that stops the duplicate work,
      // not the thing that makes the numbers right.
      const fresh = store.getCheckpoint(sf.filePath);
      if (fresh && fresh.lastByteOffset >= parsed.lastGoodOffset && startOffset > 0) {
        result.filesSkipped++;
        return;
      }

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
        // Record the hour bucket of every upserted message for incremental
        // message_hourly maintenance (recomputed once after the file loop).
        for (const m of parsed.messages) {
          touchedHours.add(
            m.timestamp == null ? -1 : Math.floor(m.timestamp / 3600000)
          );
        }
      }

      if (parsed.apiErrorEvents.length > 0) {
        store.upsertApiErrorEvents(parsed.apiErrorEvents);
      }

      if (parsed.errors.length > 0) {
        store.addToQuarantine(parsed.errors);
      }

      // Re-derive this session's counters from `messages` rather than trusting
      // the additive delta that `upsertSessionIncremental` just applied.
      //
      // The additive path is not idempotent: nothing guards read-checkpoint →
      // parse → add against a second collector (extension, MCP server, CLI)
      // processing the same byte range, so a delta could be added twice and
      // stayed added forever. `messages` is uuid-keyed and therefore immune, so
      // projecting the counters off it makes them immune too — measured
      // inflation before this was 14x on a real session. Runs inside the same
      // transaction as the upserts, so a crash can't leave the two disagreeing.
      if (parsed.session) {
        store.recomputeSessionAggregates([parsed.session.sessionId]);

        // Ticket extraction (ticket-attribution/02 §2.4) — runs per upserted
        // session, after aggregates so `first/last_timestamp` and `git_branch`
        // reflect the full session rather than just this parse's slice. Reads
        // back the fresh row rather than reusing `parsed.session`, which for
        // the incremental (append) path only carries THIS run's delta.
        const freshSession = store.findSession(parsed.session.sessionId);
        if (freshSession) {
          runTicketExtraction(store, freshSession, {
            allowlist: opts.ticketAllowlist,
            commitCache: ticketCommitCache,
          });
        }
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

  // Phase-2 (A) seam 2 — surface-aware assignment for this run's sessions.
  // Build the CLI observation timeline + telemetry map, assign accounts
  // surface-aware (CLI surfaces → observation interval; otel/telemetry any
  // surface; everything else → unknown), and apply monotonically. Only the
  // sessions upserted in THIS run are considered; `applyAttribution`'s guard
  // ensures a stronger source is never overwritten by a weaker one. Uses the
  // injected `now` clock so attribution writes are deterministic in tests.
  if (upsertedSessionIds.size > 0) {
    const allSessions = store.getSessions({
      includeCI: true,
      includeDeleted: true,
      includeSubagents: true,
    });
    const runSessions = allSessions.filter((s) => upsertedSessionIds.has(s.session_id));

    const intervals = buildCliIntervals(store.getAccountObservations());

    const rawTelemetry = collectAccountMap();
    const telemetryMap = new Map<string, ExternalAccountInfo>();
    for (const [sessionId, info] of rawTelemetry) {
      telemetryMap.set(sessionId, {
        accountUuid: info.accountUuid,
        organizationUuid: info.organizationUuid,
        subscriptionType: info.subscriptionType,
      });
    }

    // Anchor pins (doc 03 §B) — sessionId → account, applied above observation.
    const anchorMap = new Map<string, { accountUuid: string }>();
    for (const [sid, p] of store.getAnchorPins()) {
      anchorMap.set(sid, { accountUuid: p.accountUuid });
    }

    const { assignments, messageOverrides } = assignAccounts({
      sessions: runSessions,
      intervals,
      telemetryMap,
      anchorMap,
    });

    const applyMap = new Map<
      string,
      { accountUuid: string; organizationUuid: string | null; subscriptionType: string | null; source: string; confidence: string }
    >();
    for (const [sessionId, a] of assignments) {
      if (a.source === "unknown" || a.accountUuid === "") continue;
      applyMap.set(sessionId, {
        accountUuid: a.accountUuid,
        organizationUuid: a.organizationUuid,
        subscriptionType: a.subscriptionType,
        source: a.source,
        confidence: a.confidence,
      });
    }

    result.accountsMatched = store.applyAttribution(applyMap, now);
    // Persist per-message straddle splits for this run's sessions. The
    // incremental path does not reset (reattribute is the authoritative full
    // recompute); the bounded ranges make re-applying on a later collect
    // idempotent for unchanged intervals.
    result.messagesStamped = store.applyMessageOverrides(messageOverrides);

    // Phase-3 (F) seam 2 — apply owner overrides for freshly-collected sessions.
    // Load the current owner rules and stamp each run session whose project path
    // or remote matches an account-target rule. applyOwnerOverride is
    // unconditional (override outranks otel/telemetry/anchor), so it runs after
    // applyAttribution. split-target and unmatched sessions keep their inferred
    // source. applyOwnerOverride opens its own transaction internally.
    const ownerRules = store.listOwnerRules();
    if (ownerRules.length > 0) {
      const ownerOverrideMap = new Map<string, string>(); // sessionId → accountUuid
      for (const s of runSessions) {
        const target = resolveOwner(
          { projectPath: s.project_path, repoUrl: s.repo_url ?? null },
          ownerRules,
        );
        if (target !== null && target.kind === "account") {
          ownerOverrideMap.set(s.session_id, target.accountUuid);
        }
      }
      if (ownerOverrideMap.size > 0) {
        result.ownerOverrides = store.applyOwnerOverride(ownerOverrideMap, now);
      }
    }
  }

  // Schema check: sample stored sessions per version
  // (skipped for brevity in initial implementation — triggered by diagnose command)

  // Incrementally maintain the message_hourly rollup: recompute exactly the hour
  // partitions touched by the messages upserted above. Must run AFTER all message
  // upserts are committed, since recomputeMessageHourly reads the messages table.
  // One call per collect (not per file). Empty set → no-op (nothing changed).
  //
  // markSourceDeleted is deliberately NOT a trigger here: the raw reads (and the
  // rollup's EXISTS predicate) don't filter on source_deleted, and markSourceDeleted
  // leaves the message rows and the session row in place — so EXISTS stays true and
  // the rollup value for those hours is unchanged. Recomputing on deletion would be
  // wasted work that produces a byte-identical table.
  if (touchedHours.size > 0) {
    store.recomputeMessageHourly([...touchedHours]);
  }

  // Recompute usage windows for the past 2 days to catch any in-progress
  // windows. Uses the injected `now` clock (threaded through collect) for
  // determinism in tests.
  const windowSince = now() - 2 * 24 * 60 * 60 * 1000;
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
    const { cost } = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens, undefined, {
      ephemeral5mCacheTokens: row.ephemeral_5m_cache_tokens,
      ephemeral1hCacheTokens: row.ephemeral_1h_cache_tokens,
    });
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
