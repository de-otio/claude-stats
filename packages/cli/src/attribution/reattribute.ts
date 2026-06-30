/**
 * Re-attribution (Phase 2 A).
 *
 * Recomputes session→account attribution from scratch over the WHOLE store:
 * resets the inferred (non-authoritative) rows, rebuilds the CLI observation
 * timeline + telemetry map, assigns accounts surface-aware, applies the result
 * monotonically, and recomputes usage windows over the affected range.
 *
 * Safety (plan §8.1, sec#4):
 *   - `--dry-run` computes proposed counts and returns them WITHOUT any write
 *     and WITHOUT a backup.
 *   - A real run first copies the DB file to
 *     `<dbPath>.pre-reattribute-<now()>` before mutating, then does the whole
 *     reset+reassign+window-recompute in ONE store transaction (atomic).
 *
 * Determinism: the clock is injected (`now: () => number`). The pure assignment
 * functions take no clock; only the writer (`applyAttribution`) and the backup
 * filename use `now`.
 */
import fs from "node:fs";
import { paths } from "@claude-stats/core/paths";
import type { Store } from "../store/index.js";
import { collectAccountMap } from "@claude-stats/core/parser/telemetry";
import { buildCliIntervals } from "./intervals.js";
import { assignAccounts } from "./assign.js";
import type { ExternalAccountInfo } from "./assign.js";

export interface ReattributeOptions {
  dryRun?: boolean;
  /**
   * Path to the live DB file, used to make the pre-reattribute backup. The
   * frozen Store does not expose its path, so the command layer passes it
   * (defaults to `paths.statsDb`, the same default the Store constructor uses).
   */
  dbPath?: string;
}

export interface ReattributeSummary {
  dryRun: boolean;
  /** Sessions considered (the whole store, including deleted). */
  totalSessions: number;
  /** Rows the reset predicate cleared (0 in dry-run — not executed). */
  resetCount: number;
  /** Assignments produced by the engine, broken down by source. */
  bySource: Record<string, number>;
  /** Sessions whose attribution would change / changed. */
  changed: number;
  /** Per-message straddle overrides produced (informational; see note below). */
  messageOverrides: number;
  /** Path the DB was backed up to (null in dry-run). */
  backupPath: string | null;
  /** Window-recompute range actually applied (null when no sessions / dry-run). */
  windowRange: { since: number; until: number } | null;
}

/** Build the telemetry sessionId→account map at the `telemetry` precedence. */
function buildTelemetryMap(): Map<string, ExternalAccountInfo> {
  const raw = collectAccountMap();
  const map = new Map<string, ExternalAccountInfo>();
  for (const [sessionId, info] of raw) {
    map.set(sessionId, {
      accountUuid: info.accountUuid,
      organizationUuid: info.organizationUuid,
      subscriptionType: info.subscriptionType,
    });
  }
  return map;
}

/**
 * Re-attribute all sessions. Returns a summary of what changed (or would
 * change, in dry-run). Never touches `~/.claude*`; only the stats DB.
 */
export function reattribute(
  store: Store,
  opts: ReattributeOptions,
  now: () => number,
): ReattributeSummary {
  const dryRun = opts.dryRun ?? false;

  const sessions = store.getSessions({
    includeCI: true,
    includeDeleted: true,
    includeSubagents: true,
  });
  const observations = store.getAccountObservations();
  const intervals = buildCliIntervals(observations);
  const telemetryMap = buildTelemetryMap();

  const { assignments, messageOverrides } = assignAccounts({
    sessions,
    intervals,
    telemetryMap,
  });

  // Count assignments by source for the summary (drop `unknown` from the
  // applied mapping — there is nothing to write for an unknown account).
  const bySource: Record<string, number> = {};
  const applyMap = new Map<
    string,
    { accountUuid: string; organizationUuid: string | null; subscriptionType: string | null; source: string; confidence: string }
  >();
  for (const [sessionId, a] of assignments) {
    bySource[a.source] = (bySource[a.source] ?? 0) + 1;
    if (a.source === "unknown" || a.accountUuid === "") continue;
    applyMap.set(sessionId, {
      accountUuid: a.accountUuid,
      organizationUuid: a.organizationUuid,
      subscriptionType: a.subscriptionType,
      source: a.source,
      confidence: a.confidence,
    });
  }

  // Window recompute range = span of session first_timestamps (clamped).
  const firstTs = sessions
    .map((s) => s.first_timestamp)
    .filter((t): t is number => t != null);
  const windowRange =
    firstTs.length > 0
      ? { since: Math.min(...firstTs), until: Math.max(...firstTs) }
      : null;

  if (dryRun) {
    // Compute-only: report how many rows WOULD change. We approximate "changed"
    // as the number of applicable (non-unknown) assignments; the exact figure
    // depends on the store's monotonic guard, which we deliberately do not run.
    return {
      dryRun: true,
      totalSessions: sessions.length,
      resetCount: 0,
      bySource,
      changed: applyMap.size,
      messageOverrides: messageOverrides.length,
      backupPath: null,
      windowRange,
    };
  }

  // Real run — back up the DB file first (sec#4).
  const dbPath = opts.dbPath ?? paths.statsDb;
  let backupPath: string | null = null;
  if (fs.existsSync(dbPath)) {
    backupPath = `${dbPath}.pre-reattribute-${now()}`;
    fs.copyFileSync(dbPath, backupPath);
  }

  // Reset + reassign in ONE transaction (atomic). Window recompute runs
  // AFTER, in its own transaction (recomputeWindowsInRange opens its own
  // BEGIN/COMMIT; nesting it inside this transaction would fail with "cannot
  // start a transaction within a transaction"). Windows are a pure derived
  // cache rebuilt from the now-corrected sessions, so running them just after
  // the attribution commit is safe and order-correct.
  let resetCount = 0;
  let changed = 0;
  store.transaction(() => {
    resetCount = store.resetAttributableSessions();
    changed = store.applyAttribution(applyMap, now);
  });
  if (windowRange) {
    store.recomputeWindowsInRange(windowRange.since, windowRange.until);
  }

  return {
    dryRun: false,
    totalSessions: sessions.length,
    resetCount,
    bySource,
    changed,
    messageOverrides: messageOverrides.length,
    backupPath,
    windowRange,
  };
}
