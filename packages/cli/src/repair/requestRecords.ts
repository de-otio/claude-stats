/**
 * Request-record backfill (schema V28, E1): re-parse every session whose
 * transcript survives so existing history gains `api_requests` rows and
 * `messages.request_ref` — the per-request records a collect only writes for
 * lines appended after V28.
 *
 * Shape and safety follow `repair/agentAttribution.ts`, whose machinery is
 * reused where it is exported (`RepairLockHeldError`, the lock key,
 * `withBusyRetry`, `REPAIR_BUSY_TIMEOUT_MS`) and mirrored where it is private
 * (the lock claim/release). Why it is safe:
 *
 *  - **Scanner-driven only.** The files re-parsed are the ones
 *    `discoverSessionFiles` finds; `sessions.source_file` is never opened.
 *  - **The same collector path.** Candidates' checkpoints are reset to byte 0
 *    and `collect()` does the parse, so the bounded head read, the carrier
 *    election and every other rule apply exactly as in normal collection.
 *    `api_requests` is keyed on the request id with `ON CONFLICT DO NOTHING`
 *    (first writer wins) and `messages` on `uuid`, so the re-parse upserts in
 *    place: no row is added or removed, `request_ref` only ever fills from
 *    NULL (the store COALESCEs it), and nothing about cost is touched.
 *  - **Quarantine is not duplicated** (same multiset rule as the other
 *    byte-0 re-parse repairs).
 *  - **Advisory lock** shared with the other re-parse repairs (same metadata
 *    key): they all do byte-0 re-parses that bypass the collector's
 *    concurrent-parse guard, so they must exclude each other as well as
 *    themselves.
 *  - **Resumable.** The gate key `request_records_backfill = v28` is set only
 *    after a complete pass. Arming the checkpoints is recorded in a second
 *    key so an interrupted pass, re-run, continues with the files not yet
 *    parsed instead of starting over; a pass that completed clears it.
 *
 * `--dry-run` writes nothing and takes no lock: it parses the candidate files
 * read-only and reports COUNTS only (files and `api-request` lines it would
 * read — never request ids, shape hashes or any other field value).
 *
 * A second run is a no-op once the gate is set; `--force` re-runs anyway (the
 * pass is idempotent by construction, so forcing only repeats work).
 */
import { parseSessionFile } from "@claude-stats/core/parser/session";
import { discoverSessionFiles } from "../scanner/index.js";
import type { SessionFile } from "../scanner/index.js";
import { collect } from "../aggregator/index.js";
import { backupDatabase } from "./backup.js";
import {
  REPAIR_BUSY_TIMEOUT_MS,
  REPAIR_DEDUPE_LOCK_KEY,
  RepairLockHeldError,
  withBusyRetry,
} from "./dedupe.js";
import type { RepairLock } from "./dedupe.js";
import type { SessionRow, Store } from "../store/index.js";

/** Gate: set to {@link REQUEST_RECORDS_BACKFILL_VALUE} once a pass completed. */
export const REQUEST_RECORDS_BACKFILL_KEY = "request_records_backfill";
export const REQUEST_RECORDS_BACKFILL_VALUE = "v28";
/** Set when the checkpoints were armed; cleared when the pass completes. */
export const REQUEST_RECORDS_ARMED_KEY = "request_records_backfill_armed";

export interface RepairRequestRecordsOptions {
  dryRun?: boolean;
  /** Re-run even when the gate key is already set. */
  force?: boolean;
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

export interface RepairRequestRecordsSummary {
  dryRun: boolean;
  /** The gate key was already set (and `--force` was not given): nothing was done. */
  alreadyDone: boolean;
  /** Transcript files that are (or would be) re-parsed. */
  files: number;
  /**
   * Plain `api-request` lines that are (dry run: would be) read by the bounded
   * head reader — rows plus head misses. Counts only, never a field value.
   */
  requestLines: number;
  /** `api_requests` rows the pass added (dry run: 0 — nothing is written). */
  requestsStored: number;
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

export async function repairRequestRecords(
  store: Store,
  opts: RepairRequestRecordsOptions,
  now: () => number,
): Promise<RepairRequestRecordsSummary> {
  const dryRun = opts.dryRun ?? false;
  const pid = opts.pid ?? process.pid;

  if (
    !opts.force &&
    store.getMeta(REQUEST_RECORDS_BACKFILL_KEY) === REQUEST_RECORDS_BACKFILL_VALUE
  ) {
    return {
      dryRun,
      alreadyDone: true,
      files: 0,
      requestLines: 0,
      requestsStored: 0,
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

  if (dryRun) {
    // Read-only: parse every candidate from byte 0 and count the plain
    // `api-request` lines the bounded reader would be called on (rows plus
    // head misses). No lock, no backup, no write.
    let requestLines = 0;
    for (const filePath of candidateFiles) {
      const sf: SessionFile = filesByPath.get(filePath)!;
      const parsed = await parseSessionFile(sf.filePath, sf.projectPath);
      requestLines += parsed.apiRequests.length + parsed.apiRequestHeadMisses;
    }
    return {
      dryRun: true,
      alreadyDone: false,
      files: candidateFiles.length,
      requestLines,
      requestsStored: 0,
      backupPath: null,
      parseErrors: 0,
    };
  }

  if (candidateFiles.length === 0) {
    // Nothing to re-parse: sessions collected from now on get the V28 capture.
    store.setMeta(REQUEST_RECORDS_BACKFILL_KEY, REQUEST_RECORDS_BACKFILL_VALUE);
    return {
      dryRun: false,
      alreadyDone: false,
      files: 0,
      requestLines: 0,
      requestsStored: 0,
      backupPath: null,
      parseErrors: 0,
    };
  }

  // ── the write path ───────────────────────────────────────────────────────
  claimLock(store, pid, now, opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS);
  store.setBusyTimeout(REPAIR_BUSY_TIMEOUT_MS);
  try {
    const dbPath = opts.dbPath ?? store.dbPath;
    const backupPath = backupDatabase(dbPath, "request-records", now);

    const rowsBefore = store.countApiRequests();

    // Arm every candidate at byte 0 in one transaction (all or none). A
    // previous interrupted pass already armed them; the files it did parse
    // have moved on, so re-arming would only redo finished work.
    if (store.getMeta(REQUEST_RECORDS_ARMED_KEY) !== "1") {
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
        store.setMeta(REQUEST_RECORDS_ARMED_KEY, "1");
      });
    }

    const result = await withBusyRetry(() => collect(store, { ticketAllowlist: opts.ticketAllowlist }, now), {
      onRetry: opts.onBusyRetry,
    });

    // Complete pass: gate on, armed marker off.
    store.transaction(() => {
      store.setMeta(REQUEST_RECORDS_BACKFILL_KEY, REQUEST_RECORDS_BACKFILL_VALUE);
      store.setMeta(REQUEST_RECORDS_ARMED_KEY, "");
    });

    return {
      dryRun: false,
      alreadyDone: false,
      files: candidateFiles.length,
      requestLines: result.apiRequestsRead,
      requestsStored: store.countApiRequests() - rowsBefore,
      backupPath,
      parseErrors: result.parseErrors,
    };
  } finally {
    releaseLock(store, pid);
  }
}
