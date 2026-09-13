/**
 * Usage-dedupe repair: re-parse every session whose transcript survives so its
 * rows are counted once per API response instead of once per content block.
 *
 * Every row written before schema V23 carries `cost_basis = 'pre-dedupe'`:
 * one API response was stored as N entries, each repeating the whole
 * response's usage, and every one of them was summed (measured 2.03 entries
 * per response, 1.94x on cache reads, 2.60x on output — see
 * `doc/analysis/cost-correctness-2026-09/`). The corrected parser elects one
 * usage carrier per `message.id` and zeroes the rest at the store, but it can
 * only do that for bytes it reads — and on the machine this was designed on,
 * 90.2% of sessions have no surviving transcript. So this repair reaches what
 * it can reach, and the rest stays `'pre-dedupe'` and is disclosed as such on
 * every cost surface.
 *
 * Why this is safe to run:
 *
 *  - **Nothing is deleted.** Uuids are per entry and never change, so a
 *    re-parse from byte 0 upserts the SAME rows in place: the carrier keeps
 *    its usage, the others are zeroed, and their tool / thinking-block /
 *    file-path data — accumulated per entry, 92% of tool-use records live on
 *    non-first entries — is untouched. Row count before equals row count after.
 *  - **Scanner-driven only.** The files re-parsed are the ones
 *    `discoverSessionFiles` finds under the projects directory. It NEVER opens
 *    `sessions.source_file`: that column arrives from peers via sync and is
 *    not trustworthy input — a hostile value there would have the parser
 *    write arbitrary file bytes into `quarantine.raw_line`. The session is
 *    derived from the file (a file is a candidate when a session row claims it
 *    as its source), not the file from the session.
 *  - **The same collector path.** A candidate's checkpoint is reset to byte 0
 *    and `collect()` does the parse, so every rule the collector applies —
 *    the store-level carrier enforcement, session-aggregate recompute inside
 *    the same transaction, ticket extraction, quarantine — applies here too.
 *    Nothing about how a transcript becomes rows is reimplemented.
 *  - **Advisory lock.** The collector's compare-and-swap guard is disabled
 *    when it parses from offset 0 (`aggregator/index.ts`, the `startOffset >
 *    0` arm), which is exactly what a repair makes every candidate do — so two
 *    concurrent repairs would be two concurrent full re-parses. A lock in
 *    `metadata` (pid + timestamp) refuses the second. A lock from a process
 *    that no longer exists, or older than `lockTtlMs`, is stale and reclaimed.
 *
 * Afterwards the two derived tables that cache VALUES rather than rows are
 * rebuilt: `message_hourly` in full (its freshness watermark now moves with
 * `SUM(usage_counted)`, but a full rebuild is the documented one-shot path),
 * and `usage_windows` by clearing the basis marker `repriceUsageWindows`
 * checks — it stores dollars, and routine collection only revisits two days.
 *
 * Shape follows `repair/project-paths.ts`: `--dry-run` reports without
 * writing; a real run backs up the DB file first.
 */
import { discoverSessionFiles } from "../scanner/index.js";
import { backupDatabase } from "./backup.js";
import { collect, repriceUsageWindows, USAGE_WINDOW_BASIS_KEY } from "../aggregator/index.js";
import type { MessageRow, SessionRow, Store } from "../store/index.js";

export interface RepairDedupeOptions {
  dryRun?: boolean;
  /** Path to back up before writing. Defaults to the store's own file. */
  dbPath?: string;
  /** `config.tickets.projectKeys`, threaded through to `collect()`. */
  ticketAllowlist?: readonly string[];
  /** Called once per session inspected during candidate discovery. */
  onProgress?: (scanned: number, total: number) => void;
  /** Age after which a lock is stale even if its process cannot be probed. Default 6h. */
  lockTtlMs?: number;
  /** Called before each SQLITE_BUSY backoff, for progress output. */
  onBusyRetry?: (attempt: number, delayMs: number) => void;
  /** Identity of THIS process, for the lock. Defaults to `process.pid`. */
  pid?: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RepairDedupeSummary {
  dryRun: boolean;
  /** Sessions carrying `pre-dedupe` rows whose transcript was found and re-parsed (or would be). */
  sessionsRepaired: number;
  /** Sessions carrying `pre-dedupe` rows with no transcript on disk — they stay as they are. */
  sessionsSkippedNoTranscript: number;
  /** Sessions with a transcript and no `pre-dedupe` row — nothing to do. */
  sessionsAlreadyClean: number;
  /** Counted rows labelled `pre-dedupe` in the repaired sessions before the run. */
  preDedupeRowsInScope: number;
  /** Rows whose label moved `pre-dedupe` → `per-response` (0 in a dry run). */
  rowsRelabelled: number;
  /** Counted rows still labelled `pre-dedupe` anywhere in the store after the run. */
  preDedupeRowsRemaining: number;
  /** Token totals over the repaired sessions, before and after. Equal in a dry run. */
  before: TokenTotals;
  after: TokenTotals;
  /** Path the DB was backed up to (null in a dry run, or when nothing was repaired). */
  backupPath: string | null;
  /** Parse errors the collector quarantined during the re-parse. */
  parseErrors: number;
}

/** Thrown when another repair holds the lock. Carries the holder for the message. */
export class RepairLockHeldError extends Error {
  constructor(
    readonly holder: RepairLock,
  ) {
    super(`usage-dedupe repair already running (pid ${holder.pid}, started ${new Date(holder.startedAt).toISOString()})`);
    this.name = "RepairLockHeldError";
  }
}

export interface RepairLock {
  pid: number;
  startedAt: number;
}

export const REPAIR_DEDUPE_LOCK_KEY = "repair_dedupe_lock";
/** ISO timestamp of the last repair that ran to completion (not dry-run). */
export const REPAIR_DEDUPE_COMPLETED_KEY = "repair_dedupe_completed_at";

/** Busy timeout for the repair connection — see `Store#setBusyTimeout`. */
export const REPAIR_BUSY_TIMEOUT_MS = 30_000;

/** SQLite's SQLITE_BUSY result code, as `node:sqlite` reports it. */
const SQLITE_BUSY = 5;

/** True for the error `node:sqlite` throws when the busy timeout expires. */
export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (e.errcode === SQLITE_BUSY) return true;
  return e.code === "ERR_SQLITE_ERROR" && typeof e.message === "string" && /database is locked/i.test(e.message);
}

/**
 * Run `fn`, retrying on SQLITE_BUSY with exponential backoff. The first
 * production run of this repair aborted with `database is locked`: twelve
 * processes had the file open (the extension's collector, MCP servers from
 * other sessions) and one of them held a write transaction past the store's
 * 5 s default wait. `collect()` is checkpoint-driven, so re-invoking it after
 * a busy abort resumes with the files that were not yet parsed — the retry is
 * safe by construction, not by luck. Anything that is not SQLITE_BUSY is
 * rethrown on the first occurrence.
 */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, delayMs: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= attempts) throw err;
      const delay = base * 2 ** (attempt - 1);
      opts.onRetry?.(attempt, delay);
      await sleep(delay);
    }
  }
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

/** True when `pid` is a live process on this machine (or one we may not probe). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, not ours → alive. ESRCH (and anything else): gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim the lock or throw. Runs inside one transaction so the read and the
 * write cannot interleave with another claimant's.
 */
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
  // Only the holder releases — a stale lock reclaimed by someone else must
  // not be cleared by the process that lost it.
  if (held && held.pid === pid) store.setMeta(REPAIR_DEDUPE_LOCK_KEY, "");
}

function zeroTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addSessionTotals(into: TokenTotals, s: SessionRow): void {
  into.inputTokens += s.input_tokens;
  into.outputTokens += s.output_tokens;
  into.cacheReadTokens += s.cache_read_tokens;
  into.cacheCreationTokens += s.cache_creation_tokens;
}

/** Counted rows still labelled `pre-dedupe`. Non-carriers carry no usage and are not counted. */
function preDedupeCount(rows: readonly MessageRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (r.usage_counted === 0) continue;
    if (r.cost_basis !== "per-response") n++;
  }
  return n;
}

export async function repairDedupe(
  store: Store,
  opts: RepairDedupeOptions,
  now: () => number,
): Promise<RepairDedupeSummary> {
  const dryRun = opts.dryRun ?? false;
  const pid = opts.pid ?? process.pid;

  // ── candidate discovery: files first, sessions derived from them ─────────
  const filesByPath = new Map(discoverSessionFiles().map((sf) => [sf.filePath, sf]));

  // EVERY session — CI, subagent and source-deleted alike. The deleted ones
  // are the point: Claude Code prunes transcripts and the collector marks the
  // session `source_deleted`, so the rows that can never be repaired live
  // almost entirely under that flag. Leaving them out would make the
  // "skipped" and "remaining" counts — the numbers that tell a user how much
  // of their history is still inflated — silently wrong. A deleted session
  // whose file has reappeared under the projects directory is a candidate
  // like any other: the file on disk is the ground truth.
  const sessions = store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true });

  const candidates: SessionRow[] = [];
  let sessionsSkippedNoTranscript = 0;
  let sessionsAlreadyClean = 0;
  let preDedupeRowsInScope = 0;
  let preDedupeRowsElsewhere = 0;

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const preDedupe = preDedupeCount(store.getSessionMessages(session.session_id));
    if (preDedupe === 0) {
      if (filesByPath.has(session.source_file)) sessionsAlreadyClean++;
    } else if (filesByPath.has(session.source_file)) {
      candidates.push(session);
      preDedupeRowsInScope += preDedupe;
    } else {
      sessionsSkippedNoTranscript++;
      preDedupeRowsElsewhere += preDedupe;
    }
    opts.onProgress?.(i + 1, sessions.length);
  }

  const before = zeroTotals();
  for (const s of candidates) addSessionTotals(before, s);

  if (dryRun || candidates.length === 0) {
    return {
      dryRun,
      sessionsRepaired: candidates.length,
      sessionsSkippedNoTranscript,
      sessionsAlreadyClean,
      preDedupeRowsInScope,
      rowsRelabelled: 0,
      preDedupeRowsRemaining: preDedupeRowsInScope + preDedupeRowsElsewhere,
      before,
      after: { ...before },
      backupPath: null,
      parseErrors: 0,
    };
  }

  // ── the write path ───────────────────────────────────────────────────────
  claimLock(store, pid, now, opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS);
  store.setBusyTimeout(REPAIR_BUSY_TIMEOUT_MS);
  try {
    // The store's OWN file, not `paths.statsDb` — see `Store#dbPath`.
    const backupPath = backupDatabase(opts.dbPath ?? store.dbPath, "dedupe", now);

    // Reset each candidate's checkpoint to byte 0. `collect()` then treats the
    // file as changed and — whether it classifies the change as an append or
    // a rewrite — parses from offset 0 and takes the full-session upsert path.
    // The reset is one transaction so a crash here leaves either all or none
    // of the candidates armed; an armed-but-unparsed checkpoint is harmless,
    // the next collect simply re-parses it.
    store.transaction(() => {
      for (const s of candidates) {
        const cp = store.getCheckpoint(s.source_file);
        store.upsertCheckpoint({
          filePath: s.source_file,
          fileSize: cp?.fileSize ?? 0,
          lastByteOffset: 0,
          lastMtime: 0,
          firstKbHash: cp?.firstKbHash ?? "",
          sourceDeleted: false,
        });
      }
    });

    const result = await withBusyRetry(
      () => collect(store, { ticketAllowlist: opts.ticketAllowlist }, now),
      { onRetry: opts.onBusyRetry },
    );

    // `message_hourly` caches token VALUES per hour; a repair changes values on
    // existing rows. The collector recomputed the hours it touched, but the
    // full rebuild is the documented one-shot path and costs one scan.
    store.recomputeMessageHourly();
    // `usage_windows` stores dollars and is only revisited for two days by
    // routine collection. Clearing the basis marker makes the next check
    // recompute every window; doing it here rather than waiting for the next
    // collect means the repair leaves no stale dollar figure behind it.
    store.setMeta(USAGE_WINDOW_BASIS_KEY, "");
    repriceUsageWindows(store);
    // Lets the cost-basis disclosure stop telling the user to run a repair
    // they have already run — what remains pre-dedupe has no transcript.
    store.setMeta(REPAIR_DEDUPE_COMPLETED_KEY, new Date(now()).toISOString());

    // ── after ────────────────────────────────────────────────────────────
    const candidateIds = new Set(candidates.map((s) => s.session_id));
    const afterSessions = store
      .getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true })
      .filter((s) => candidateIds.has(s.session_id));
    const after = zeroTotals();
    let preDedupeAfterInScope = 0;
    for (const s of afterSessions) {
      addSessionTotals(after, s);
      preDedupeAfterInScope += preDedupeCount(store.getSessionMessages(s.session_id));
    }

    return {
      dryRun: false,
      sessionsRepaired: candidates.length,
      sessionsSkippedNoTranscript,
      sessionsAlreadyClean,
      preDedupeRowsInScope,
      rowsRelabelled: preDedupeRowsInScope - preDedupeAfterInScope,
      preDedupeRowsRemaining: preDedupeAfterInScope + preDedupeRowsElsewhere,
      before,
      after,
      backupPath,
      parseErrors: result.parseErrors,
    };
  } finally {
    releaseLock(store, pid);
  }
}
