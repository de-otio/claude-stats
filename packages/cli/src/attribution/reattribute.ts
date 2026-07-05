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
import { resolveOwner } from "./ownership.js";

export interface ReattributeOptions {
  dryRun?: boolean;
  /**
   * Proceed even when the run would clear existing attributions while assigning
   * none (the "no observations yet → everything unknown" footgun). Without this,
   * a real run that would wipe-for-nothing is refused. Ignored in dry-run.
   */
  force?: boolean;
  /**
   * Path to the live DB file, used to make the pre-reattribute backup. The
   * Store does not expose its path back, so the command layer passes it
   * (defaults to `paths.statsDb`, the same default the Store constructor uses).
   */
  dbPath?: string;
}

export interface ReattributeSummary {
  dryRun: boolean;
  /**
   * True when the run was (or, in dry-run, would be) refused by the safety
   * guard: it would clear existing attributions while assigning none, and
   * `force` was not set. A refused run makes no backup and no writes.
   */
  refused: boolean;
  /** How many sessions are attributed (account_uuid set) BEFORE this run. */
  attributedBefore: number;
  /** Sessions considered (the whole store, including deleted). */
  totalSessions: number;
  /** Rows the reset predicate cleared (0 in dry-run — not executed). */
  resetCount: number;
  /** Assignments produced by the engine, broken down by source. */
  bySource: Record<string, number>;
  /** Sessions whose attribution would change / changed. */
  changed: number;
  /** Per-message straddle overrides produced by the engine (range count). */
  messageOverrides: number;
  /** Messages actually stamped with a straddle account (0 in dry-run/refused). */
  messagesStamped: number;
  /** Path the DB was backed up to (null in dry-run). */
  backupPath: string | null;
  /** Window-recompute range actually applied (null when no sessions / dry-run). */
  windowRange: { since: number; until: number } | null;
  /**
   * Number of sessions stamped with account_source='override' from owner rules
   * this run. In dry-run: would-be count (no writes). In real run: rows changed.
   * 0 when refused or when no account-target rules match.
   */
  ownerOverrides: number;
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

  // Anchor pins (doc 03 §B): durable live-session ground truth, applied above
  // observation. Because reattribute resets the inferred rows first, an anchor
  // correctly supersedes a prior `observation` assignment for the same session.
  const anchorMap = new Map<string, { accountUuid: string }>();
  for (const [sid, p] of store.getAnchorPins()) {
    anchorMap.set(sid, { accountUuid: p.accountUuid });
  }

  const { assignments, messageOverrides } = assignAccounts({
    sessions,
    intervals,
    telemetryMap,
    anchorMap,
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

  // Safety guard: a real run resets the inferred rows BEFORE reassigning, so if
  // the engine produced zero applicable assignments (e.g. no observations or
  // telemetry yet) while sessions are currently attributed, the run would wipe
  // attribution for nothing. Refuse unless forced — the fix is to run `collect`
  // first so observations accrue.
  const attributedBefore = sessions.filter((s) => s.account_uuid != null).length;
  const force = opts.force ?? false;
  const refused = applyMap.size === 0 && attributedBefore > 0 && !force;

  // Compute the would-be owner override mapping for dry-run reporting and real
  // run application. Done outside any transaction — resolveOwner is pure; the
  // map is built regardless of dryRun so the dry-run summary includes a count.
  const ownerRules = store.listOwnerRules();
  const ownerOverrideMap = new Map<string, string>(); // sessionId → accountUuid
  for (const s of sessions) {
    const target = resolveOwner(
      { projectPath: s.project_path, repoUrl: s.repo_url ?? null },
      ownerRules,
    );
    if (target !== null && target.kind === "account") {
      ownerOverrideMap.set(s.session_id, target.accountUuid);
    }
    // split target → no override; unmatched (null) → no override
  }

  if (dryRun) {
    // Compute-only: report how many rows WOULD change. We approximate "changed"
    // as the number of applicable (non-unknown) assignments; the exact figure
    // depends on the store's monotonic guard, which we deliberately do not run.
    return {
      dryRun: true,
      refused, // a real run with these same inputs would be refused
      attributedBefore,
      totalSessions: sessions.length,
      resetCount: 0,
      bySource,
      changed: applyMap.size,
      messageOverrides: messageOverrides.length,
      messagesStamped: 0,
      backupPath: null,
      windowRange,
      ownerOverrides: ownerOverrideMap.size,
    };
  }

  if (refused) {
    // Real run blocked by the guard — no backup, no writes.
    return {
      dryRun: false,
      refused: true,
      attributedBefore,
      totalSessions: sessions.length,
      resetCount: 0,
      bySource,
      changed: 0,
      messageOverrides: messageOverrides.length,
      messagesStamped: 0,
      backupPath: null,
      windowRange,
      ownerOverrides: 0,
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
  let messagesStamped = 0;
  store.transaction(() => {
    resetCount = store.resetAttributableSessions();
    // Message-level straddle splits are a pure function of the intervals too,
    // so clear and re-derive them alongside the session attribution in the same
    // atomic step.
    store.resetMessageAttribution();
    changed = store.applyAttribution(applyMap, now);
    messagesStamped = store.applyMessageOverrides(messageOverrides);
  });

  // Apply owner overrides AFTER the attribution transaction commits. Owner
  // rules are unconditional (override outranks otel/telemetry/anchor), so they
  // run after inference is settled. applyOwnerOverride opens its own
  // transaction internally — do NOT nest it inside the one above.
  // Only sessions with an account-target rule receive an override;
  // split-target and unmatched sessions are left on their inferred source.
  let ownerOverrides = 0;
  if (ownerOverrideMap.size > 0) {
    ownerOverrides = store.applyOwnerOverride(ownerOverrideMap, now);
  }

  if (windowRange) {
    store.recomputeWindowsInRange(windowRange.since, windowRange.until);
  }

  return {
    dryRun: false,
    refused: false,
    attributedBefore,
    totalSessions: sessions.length,
    resetCount,
    bySource,
    changed,
    messageOverrides: messageOverrides.length,
    messagesStamped,
    backupPath,
    windowRange,
    ownerOverrides,
  };
}
