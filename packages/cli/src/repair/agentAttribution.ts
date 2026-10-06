/**
 * Agent-attribution backfill (schema V25): re-parse every session whose
 * transcript survives so existing sessions gain `agent_type` / `spawn_depth` /
 * `spawn_tool_use_id` and existing messages gain `skill`.
 *
 * Shape and safety follow `repair/dedupe.ts`, whose machinery is reused where
 * it is exported (`RepairLockHeldError`, the lock key, `withBusyRetry`,
 * `REPAIR_BUSY_TIMEOUT_MS`) and mirrored where it is private (the lock
 * claim/release, a dozen lines). Why it is safe:
 *
 *  - **Scanner-driven only.** The files re-parsed are the ones
 *    `discoverSessionFiles` finds. `sessions.source_file` is never opened —
 *    it can arrive from peers via sync. It is only compared, as a string,
 *    against the scanner's own paths to decide which files are candidates.
 *    The `.meta.json` sibling is therefore read from the scanner path by the
 *    collector's own derived-path rule, unchanged.
 *  - **The same collector path.** Candidates' checkpoints are reset to byte 0
 *    and `collect()` does the parse, so carrier election, the aggregate
 *    recompute and every other rule apply exactly as in normal collection.
 *    Rows key on `uuid`, so the re-parse upserts in place: no row is added or
 *    removed, and the new columns only ever fill from NULL (the store
 *    COALESCEs them). Nothing about cost is touched: usage columns come out of
 *    the same parse that produced them, which the cost-neutral test pins.
 *  - **Quarantine is not duplicated.** `Store#addToQuarantine` is a plain
 *    INSERT, so a byte-0 re-parse would write every unparseable line a second
 *    time. During the pass the method is wrapped so a line already quarantined
 *    for the same file (same error and bytes, as a multiset — line numbers
 *    differ between an incremental and a full parse) is skipped.
 *  - **Advisory lock** shared with the dedupe repair (same metadata key): both
 *    do byte-0 re-parses that bypass the collector's concurrent-parse guard,
 *    so they must exclude each other as well as themselves.
 *  - **Resumable.** The gate key `agent_attribution_backfill = v25` is set only
 *    after a complete pass. Arming the checkpoints is recorded in a second key
 *    so an interrupted pass, re-run, continues with the files not yet parsed
 *    instead of starting over; a pass that completed clears it.
 *
 * `--dry-run` writes nothing and takes no lock: it parses the candidate files
 * read-only and reports COUNTS only (never agent-type or skill names).
 */
import { DatabaseSync } from "node:sqlite";
import { validIdentifier } from "@claude-stats/core/identifiers";
import { parseSessionFile } from "@claude-stats/core/parser/session";
import type { ParseError } from "@claude-stats/core/types";
import { discoverSessionFiles } from "../scanner/index.js";
import type { SessionFile } from "../scanner/index.js";
import { collect } from "../aggregator/index.js";
import { readSubagentMeta } from "../aggregator/subagentMetaFile.js";
import { backupDatabase } from "./backup.js";
import {
  REPAIR_BUSY_TIMEOUT_MS,
  REPAIR_DEDUPE_LOCK_KEY,
  RepairLockHeldError,
  withBusyRetry,
} from "./dedupe.js";
import type { RepairLock } from "./dedupe.js";
import type { SessionRow, Store } from "../store/index.js";

/** Gate: set to {@link AGENT_ATTRIBUTION_BACKFILL_VALUE} once a pass completed. */
export const AGENT_ATTRIBUTION_BACKFILL_KEY = "agent_attribution_backfill";
export const AGENT_ATTRIBUTION_BACKFILL_VALUE = "v25";
/** Set when the checkpoints were armed; cleared when the pass completes. */
export const AGENT_ATTRIBUTION_ARMED_KEY = "agent_attribution_backfill_armed";

export interface RepairAgentAttributionOptions {
  dryRun?: boolean;
  /** Path to back up before writing. Defaults to the store's own file. */
  dbPath?: string;
  /** `config.tickets.projectKeys`, threaded through to `collect()`. */
  ticketAllowlist?: readonly string[];
  /** Age after which a lock is stale even if its process cannot be probed. Default 6h. */
  lockTtlMs?: number;
  onBusyRetry?: (attempt: number, delayMs: number) => void;
  /** Identity of THIS process, for the lock. Defaults to `process.pid`. */
  pid?: number;
}

export interface RepairAgentAttributionSummary {
  dryRun: boolean;
  /** The gate key was already set: nothing was done. */
  alreadyDone: boolean;
  /** Transcript files that are (or would be) re-parsed. */
  files: number;
  /** Sessions that gained (dry run: would gain) an agent type. */
  sessionsGainingAgentType: number;
  /** Messages that gained (dry run: would gain) a skill. */
  messagesGainingSkill: number;
  /** Path the DB was backed up to (null in a dry run, or when nothing was re-parsed). */
  backupPath: string | null;
  /** Parse errors the collector reported during the re-parse (dry run: 0). */
  parseErrors: number;
}

const DEFAULT_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

function readLock(store: Store): RepairLock | null {
  const raw = store.getMeta(REPAIR_DEDUPE_LOCK_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<RepairLock>;
    if (typeof v.pid === "number" && typeof v.startedAt === "number") {
      return { pid: v.pid, startedAt: v.startedAt };
    }
  } catch {
    /* malformed → treated as absent */
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimLock(store: Store, pid: number, now: () => number, ttlMs: number): void {
  store.transaction(() => {
    const held = readLock(store);
    if (held && held.pid !== pid) {
      const fresh = now() - held.startedAt < ttlMs;
      if (fresh && processAlive(held.pid)) throw new RepairLockHeldError(held);
    }
    store.setMeta(REPAIR_DEDUPE_LOCK_KEY, JSON.stringify({ pid, startedAt: now() } satisfies RepairLock));
  });
}

function releaseLock(store: Store, pid: number): void {
  const held = readLock(store);
  if (held && held.pid === pid) store.setMeta(REPAIR_DEDUPE_LOCK_KEY, "");
}

/** The agent type the collector would store for a scanned file (mirrors `collect`). */
function derivedAgentType(sf: SessionFile, parsedAgentType: string | null | undefined): string | null {
  if (!sf.isSubagent) return null;
  const fallback = validIdentifier(parsedAgentType ?? null);
  if (!sf.parentSessionId) return fallback;
  return readSubagentMeta(sf.filePath).agentType ?? fallback;
}

/**
 * Run `fn` with `store.addToQuarantine` filtered so an entry already in the
 * `quarantine` table (same file, error and raw bytes, counted as a multiset)
 * is not inserted again. Existing rows are read through a separate read-only
 * connection, lazily and once per file.
 */
async function withQuarantineDedupe<T>(store: Store, dbPath: string, fn: () => Promise<T>): Promise<T> {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  reader.exec("PRAGMA busy_timeout = 30000");
  const select = reader.prepare("SELECT raw_line, error FROM quarantine WHERE file_path = ?");
  // Existing rows per (error, raw bytes) for one file, as a multiset. The line
  // NUMBER is not part of the identity: a row written by an incremental parse
  // numbers lines from the start of the appended slice, while this byte-0
  // re-parse numbers them from the top of the file, so the same bad line
  // arrives with a different number.
  const keyOf = (raw: string, error: string) => `${error}\u0000${raw}`;
  const existing = new Map<string, Map<string, number>>();
  const forFile = (filePath: string): Map<string, number> => {
    let m = existing.get(filePath);
    if (!m) {
      m = new Map();
      for (const r of select.all(filePath) as Array<{ raw_line: string; error: string }>) {
        const k = keyOf(r.raw_line, r.error);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      existing.set(filePath, m);
    }
    return m;
  };
  const hadOwn = Object.prototype.hasOwnProperty.call(store, "addToQuarantine");
  const previous = store.addToQuarantine;
  store.addToQuarantine = (errors: ParseError[]): void => {
    // One call is one parse of one file, so occurrences are tallied per call:
    // a retried parse (busy abort, rolled-back transaction) starts from zero.
    const seenThisCall = new Map<string, Map<string, number>>();
    const fresh = errors.filter((e) => {
      const have = forFile(e.filePath);
      let seen = seenThisCall.get(e.filePath);
      if (!seen) seenThisCall.set(e.filePath, (seen = new Map()));
      const k = keyOf(e.rawLine, e.error);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      // The n-th occurrence is new only when the table holds fewer than n.
      return n > (have.get(k) ?? 0);
    });
    if (fresh.length > 0) previous.call(store, fresh);
  };
  try {
    return await fn();
  } finally {
    if (hadOwn) store.addToQuarantine = previous;
    else delete (store as Partial<Pick<Store, "addToQuarantine">>).addToQuarantine;
    reader.close();
  }
}

function countSkillRows(store: Store, sessionIds: readonly string[]): number {
  let n = 0;
  for (const id of sessionIds) {
    for (const m of store.getSessionMessages(id)) if (m.skill != null) n++;
  }
  return n;
}

export async function repairAgentAttribution(
  store: Store,
  opts: RepairAgentAttributionOptions,
  now: () => number,
): Promise<RepairAgentAttributionSummary> {
  const dryRun = opts.dryRun ?? false;
  const pid = opts.pid ?? process.pid;

  if (store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY) === AGENT_ATTRIBUTION_BACKFILL_VALUE) {
    return {
      dryRun,
      alreadyDone: true,
      files: 0,
      sessionsGainingAgentType: 0,
      messagesGainingSkill: 0,
      backupPath: null,
      parseErrors: 0,
    };
  }

  // ── candidates: files first, sessions derived from them ──────────────────
  const filesByPath = new Map(discoverSessionFiles().map((sf) => [sf.filePath, sf]));
  const sessions = store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true });
  const sessionsByFile = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    // String comparison only — `source_file` is never opened.
    if (!filesByPath.has(s.source_file)) continue;
    const list = sessionsByFile.get(s.source_file);
    if (list) list.push(s);
    else sessionsByFile.set(s.source_file, [s]);
  }
  const candidateFiles = [...sessionsByFile.keys()];
  const candidateSessions = [...sessionsByFile.values()].flat();

  if (dryRun) {
    let sessionsGaining = 0;
    let messagesGaining = 0;
    for (const filePath of candidateFiles) {
      const sf = filesByPath.get(filePath)!;
      const parsed = await parseSessionFile(sf.filePath, sf.projectPath);
      const agentType = derivedAgentType(sf, parsed.session?.agentType);
      const rows = sessionsByFile.get(filePath)!;
      if (agentType !== null) {
        for (const r of rows) if (r.agent_type == null) sessionsGaining++;
      }
      const skillByUuid = new Map<string, string | null>();
      for (const r of rows) {
        for (const m of store.getSessionMessages(r.session_id)) skillByUuid.set(m.uuid, m.skill ?? null);
      }
      for (const m of parsed.messages) {
        if (m.skill != null && skillByUuid.has(m.uuid) && skillByUuid.get(m.uuid) == null) messagesGaining++;
      }
    }
    return {
      dryRun: true,
      alreadyDone: false,
      files: candidateFiles.length,
      sessionsGainingAgentType: sessionsGaining,
      messagesGainingSkill: messagesGaining,
      backupPath: null,
      parseErrors: 0,
    };
  }

  if (candidateFiles.length === 0) {
    // Nothing to re-parse: sessions collected from now on get the V25 capture.
    store.setMeta(AGENT_ATTRIBUTION_BACKFILL_KEY, AGENT_ATTRIBUTION_BACKFILL_VALUE);
    return {
      dryRun: false,
      alreadyDone: false,
      files: 0,
      sessionsGainingAgentType: 0,
      messagesGainingSkill: 0,
      backupPath: null,
      parseErrors: 0,
    };
  }

  // ── the write path ───────────────────────────────────────────────────────
  claimLock(store, pid, now, opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS);
  store.setBusyTimeout(REPAIR_BUSY_TIMEOUT_MS);
  try {
    const dbPath = opts.dbPath ?? store.dbPath;
    const backupPath = backupDatabase(dbPath, "agent-attribution", now);

    const sessionIds = candidateSessions.map((s) => s.session_id);
    const withTypeBefore = new Set(candidateSessions.filter((s) => s.agent_type != null).map((s) => s.session_id));
    const skillsBefore = countSkillRows(store, sessionIds);

    // Arm every candidate at byte 0 in one transaction (all or none). A
    // previous interrupted pass already armed them; the files it did parse
    // have moved on, so re-arming would only redo finished work.
    if (store.getMeta(AGENT_ATTRIBUTION_ARMED_KEY) !== "1") {
      store.transaction(() => {
        for (const filePath of candidateFiles) {
          const cp = store.getCheckpoint(filePath);
          store.upsertCheckpoint({
            filePath,
            fileSize: cp?.fileSize ?? 0,
            lastByteOffset: 0,
            lastMtime: 0,
            firstKbHash: cp?.firstKbHash ?? "",
            sourceDeleted: false,
          });
        }
        store.setMeta(AGENT_ATTRIBUTION_ARMED_KEY, "1");
      });
    }

    const result = await withQuarantineDedupe(store, dbPath, () =>
      withBusyRetry(() => collect(store, { ticketAllowlist: opts.ticketAllowlist }, now), {
        onRetry: opts.onBusyRetry,
      }),
    );

    // Complete pass: gate on, armed marker off.
    store.transaction(() => {
      store.setMeta(AGENT_ATTRIBUTION_BACKFILL_KEY, AGENT_ATTRIBUTION_BACKFILL_VALUE);
      store.setMeta(AGENT_ATTRIBUTION_ARMED_KEY, "");
    });

    const idSet = new Set(sessionIds);
    const afterSessions = store
      .getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true })
      .filter((s) => idSet.has(s.session_id));
    const sessionsGained = afterSessions.filter((s) => s.agent_type != null && !withTypeBefore.has(s.session_id)).length;

    return {
      dryRun: false,
      alreadyDone: false,
      files: candidateFiles.length,
      sessionsGainingAgentType: sessionsGained,
      messagesGainingSkill: countSkillRows(store, sessionIds) - skillsBefore,
      backupPath,
      parseErrors: result.parseErrors,
    };
  } finally {
    releaseLock(store, pid);
  }
}
