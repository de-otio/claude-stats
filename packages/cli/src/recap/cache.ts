/**
 * Snapshot-hash file cache for daily digests (SR-4).
 *
 * The cache key is a SHA-256 hash of all inputs that determine whether a
 * previously-computed DailyDigest is still valid. If any input changes
 * (new messages, new commits, different date/tz, project list change) the
 * hash changes and we get a cache miss — the digest is recomputed.
 *
 * Storage: one JSON file per hash under ~/.claude-stats/recap-cache/.
 * Permissions are enforced via fs-secure helpers (SR-3).
 *
 * File format (v3.06+):
 *   { digest: DailyDigest, inputs?: SnapshotHashInputs }
 *
 * Legacy format (v1/v2): the file contained a bare DailyDigest object.
 * Detection: presence of the `digest` key at the top level.
 * Back-compat: read() strips the wrapper and returns just the DailyDigest;
 * readWithInputs() returns null for legacy entries (no inputs stored).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DailyDigest, CachedEntry } from './types.js';
import { ensurePrivateDir, readIfReadable, writePrivateFile } from './fs-secure.js';

// ── Hash inputs ───────────────────────────────────────────────────────────────

export interface SnapshotHashInputs {
  /** YYYY-MM-DD string for the day being summarised. */
  date: string;
  /**
   * IANA timezone name from Intl.DateTimeFormat().resolvedOptions().timeZone.
   * Must NOT come from the $TZ environment variable (SR-4).
   */
  tz: string;
  /** Project paths considered for this digest. Sorted defensively inside computeSnapshotHash. */
  sortedProjectPaths: readonly string[];
  /** max(message.uuid) over all messages on this date, or null if none. */
  maxMessageUuid: string | null;
  /** Map of project_path → last commit SHA (null when no commits). */
  perProjectLastCommit: Readonly<Record<string, string | null>>;
  /**
   * Map of session_id → last message UUID for that session (v3.06+).
   * Enables per-session diffing in the incremental-digest patcher.
   * Optional for back-compat: absent in v1/v2 cache entries.
   */
  perSessionLastMessageUuid?: Readonly<Record<string, string | null>>;
}

/**
 * Compute a deterministic SHA-256 hash over all inputs that affect digest
 * correctness (SR-4).
 *
 * The unit-separator character \x1f is used between concatenated parts so
 * that no input value can produce a collision by injecting the separator
 * characters used elsewhere in the string.
 */
export function computeSnapshotHash(inputs: SnapshotHashInputs): string {
  // Sort defensively — callers should already sort, but we guarantee it.
  const sortedPaths = [...inputs.sortedProjectPaths].sort();

  // Sort commit map keys for determinism regardless of insertion order.
  const commitPart = Object.keys(inputs.perProjectLastCommit)
    .sort()
    .map(p => `${p}=${inputs.perProjectLastCommit[p] ?? 'null'}`)
    .join(',');

  // NOTE: perSessionLastMessageUuid is NOT included in the hash because
  // maxMessageUuid already captures "did any session change?" at the global
  // level.  perSessionLastMessageUuid is metadata stored alongside the digest
  // for the incremental patcher (v3.06) to diff which specific session changed,
  // but it does not affect cache key correctness and must not change hashes
  // for existing entries (back-compat with precompute.ts and v1/v2 entries).
  const parts = [
    `date:${inputs.date}`,
    `tz:${inputs.tz}`,
    `projects:${sortedPaths.join(',')}`,
    `maxUuid:${inputs.maxMessageUuid ?? 'null'}`,
    `commits:${commitPart}`,
  ];

  return crypto
    .createHash('sha256')
    .update(parts.join('\x1f'))
    .digest('hex');
}

// ── Cache client ──────────────────────────────────────────────────────────────

export interface CacheClient {
  /** Returns the cached DailyDigest for hash, or null on miss / parse error. */
  read(hash: string): DailyDigest | null;
  /**
   * Returns the cached DailyDigest plus its SnapshotHashInputs for hash, or
   * null on miss / parse error / legacy entry (v1/v2 entries have no inputs).
   * (v3.06+)
   */
  readWithInputs(hash: string): CachedEntry | null;
  /**
   * Scan the cache for the most recently-written entry whose digest.date and
   * digest.tz match the given values.  Uses file mtime as a proxy for
   * recency (simpler than embedding a builtAt timestamp).
   *
   * Returns null when no matching entry is found or on any I/O error.
   * (v3.06+)
   */
  readMostRecentForDate(date: string, tz: string): CachedEntry | null;
  /**
   * Persist digest for hash and prune oldest entries if over maxEntries.
   *
   * @param inputs  When supplied (v3.06+), the SnapshotHashInputs are stored
   *   alongside the digest so subsequent readWithInputs() calls succeed.
   *   When omitted (existing v1/v2 callers), only the digest is stored and
   *   readWithInputs() will return null for this entry — back-compat preserved.
   */
  write(hash: string, digest: DailyDigest, inputs?: SnapshotHashInputs): void;
}

const DEFAULT_ROOT_DIR = path.join(os.homedir(), '.claude-stats', 'recap-cache');
const DEFAULT_MAX_ENTRIES = 30;

/**
 * Parse a cache file's raw JSON into a { digest, inputs? } shape.
 *
 * Handles two formats:
 *   v1/v2: bare DailyDigest object (no `digest` key at top level)
 *   v3.06+: { digest: DailyDigest, inputs?: SnapshotHashInputs }
 *
 * Returns null on parse error.
 */
function parseCacheFile(raw: string): { digest: DailyDigest; inputs?: SnapshotHashInputs } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // v3.06+ format: top-level object has a `digest` key whose value is an object
    if (typeof parsed === 'object' && parsed !== null && 'digest' in parsed && typeof parsed['digest'] === 'object') {
      return parsed as { digest: DailyDigest; inputs?: SnapshotHashInputs };
    }
    // Legacy v1/v2: the object IS the digest
    return { digest: parsed as unknown as DailyDigest };
  } catch {
    return null;
  }
}

/**
 * Create a file-backed CacheClient.
 *
 * @param opts.rootDir    Directory to store cache files (default ~/.claude-stats/recap-cache/).
 * @param opts.maxEntries Maximum number of cache entries to keep (default 30).
 *                        Oldest entries by mtime are deleted when the limit is exceeded.
 */
export function createFileCache(opts?: {
  rootDir?: string;
  maxEntries?: number;
}): CacheClient {
  const rootDir = opts?.rootDir ?? DEFAULT_ROOT_DIR;
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  function cacheFilePath(hash: string): string {
    return path.join(rootDir, `${hash}.json`);
  }

  return {
    read(hash: string): DailyDigest | null {
      const raw = readIfReadable(cacheFilePath(hash));
      if (raw === null) return null;
      const entry = parseCacheFile(raw);
      if (entry === null) return null; // Corrupt cache file — treat as miss
      return entry.digest;
    },

    readWithInputs(hash: string): CachedEntry | null {
      const raw = readIfReadable(cacheFilePath(hash));
      if (raw === null) return null;
      const entry = parseCacheFile(raw);
      if (entry === null) return null; // Corrupt cache file
      // Legacy entries have no inputs; return null (caller must fall back to full rebuild)
      if (!entry.inputs) return null;
      return { digest: entry.digest, inputs: entry.inputs };
    },

    readMostRecentForDate(date: string, tz: string): CachedEntry | null {
      // Scan the cache directory for all .json files and find the most recent
      // one (by file mtime) whose stored digest matches the given date and tz.
      let files: string[];
      try {
        files = fs.readdirSync(rootDir).filter(f => f.endsWith('.json'));
      } catch {
        // Directory doesn't exist yet, or unreadable
        return null;
      }

      // Build list of candidate files with their mtimes, sorted newest first
      const candidates: Array<{ filePath: string; mtime: number }> = [];
      for (const fname of files) {
        const filePath = path.join(rootDir, fname);
        try {
          const stat = fs.statSync(filePath);
          candidates.push({ filePath, mtime: stat.mtime.getTime() });
        } catch {
          // File disappeared between readdir and stat — skip
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime); // newest first

      for (const { filePath } of candidates) {
        const raw = readIfReadable(filePath);
        if (raw === null) continue;
        const entry = parseCacheFile(raw);
        if (entry === null) continue;
        if (entry.digest.date === date && entry.digest.tz === tz) {
          // Must have inputs to be useful for patching; skip legacy entries
          // and continue scanning for a newer v3.06+ entry.
          if (!entry.inputs) continue;
          return { digest: entry.digest, inputs: entry.inputs };
        }
      }
      return null;
    },

    write(hash: string, digest: DailyDigest, inputs?: SnapshotHashInputs): void {
      // Lazily create the cache directory on first write.
      ensurePrivateDir(rootDir);

      // Store in v3.06+ format when inputs are provided; otherwise store bare
      // digest for back-compat with v1/v2 readers.
      const payload = inputs !== undefined
        ? JSON.stringify({ digest, inputs })
        : JSON.stringify(digest);

      writePrivateFile(cacheFilePath(hash), payload);

      // Prune oldest entries to stay within maxEntries. Failures must not
      // propagate — a failed prune is non-fatal.
      try {
        pruneCache(rootDir, maxEntries);
      } catch {
        // Intentionally swallowed — prune failure must not fail the write.
      }
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Delete the oldest cache files (by mtime) until only maxEntries remain.
 */
function pruneCache(rootDir: string, maxEntries: number): void {
  const entries = fs.readdirSync(rootDir).filter(f => f.endsWith('.json'));

  if (entries.length <= maxEntries) return;

  // Build list of [filePath, mtime] pairs, sorted oldest first.
  const withMtime = entries.map(name => {
    const filePath = path.join(rootDir, name);
    const mtime = fs.statSync(filePath).mtime.getTime();
    return { filePath, mtime };
  });

  withMtime.sort((a, b) => a.mtime - b.mtime);

  const deleteCount = withMtime.length - maxEntries;
  for (let i = 0; i < deleteCount; i++) {
    fs.unlinkSync(withMtime[i]!.filePath);
  }
}
