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
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DailyDigest } from './types.js';
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
  /** Persist digest for hash and prune oldest entries if over maxEntries. */
  write(hash: string, digest: DailyDigest): void;
}

const DEFAULT_ROOT_DIR = path.join(os.homedir(), '.claude-stats', 'recap-cache');
const DEFAULT_MAX_ENTRIES = 30;

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
      try {
        return JSON.parse(raw) as DailyDigest;
      } catch {
        // Corrupt cache file — treat as miss. Do not delete; leave for forensics.
        return null;
      }
    },

    write(hash: string, digest: DailyDigest): void {
      // Lazily create the cache directory on first write.
      ensurePrivateDir(rootDir);

      writePrivateFile(cacheFilePath(hash), JSON.stringify(digest));

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
