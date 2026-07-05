/**
 * Bounded retention for the transcript archive.
 *
 * Retention is pruned by the mirror's REAL last activity — the maximum message
 * timestamp found *inside* the archived JSONL — never by the file's mtime. A
 * file's mtime reflects when we last wrote to it (which can be "now" for a
 * transcript whose conversation ended weeks ago), so mtime-based pruning would
 * either keep dead transcripts forever or delete live ones. The only sound
 * signal is the activity recorded in the content itself.
 *
 * Failure-tolerant: a mirror whose content yields no parseable timestamp is
 * KEPT (we never delete on missing evidence), and a single unreadable file does
 * not abort the sweep.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { toEpochMs } from "@claude-stats/core/parser/session";
import type { RawSessionEntry } from "@claude-stats/core/types";
import { assertSafeSegment } from "./paths.js";

/** Default retention window when config omits one: 90 days. */
export const DEFAULT_RETENTION_DAYS = 90;
/** Hard ceiling so a hostile/typo config can't request an absurd window. */
export const MAX_RETENTION_DAYS = 3650; // 10 years

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Real last-activity of a mirror file: the max top-level `timestamp` across its
 * JSONL lines, in epoch-ms. Returns null when the file has no parseable
 * timestamp (a caller treats null as "keep — no evidence to prune on").
 */
export function computeLastActivity(mirrorPath: string): number | null {
  let content: string;
  try {
    content = fs.readFileSync(mirrorPath, "utf-8");
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: RawSessionEntry;
    try {
      entry = JSON.parse(line) as RawSessionEntry;
    } catch {
      continue; // skip malformed line — retention must not choke on one bad line
    }
    const ts = toEpochMs(entry.timestamp);
    if (ts !== null && (max === null || ts > max)) max = ts;
  }
  return max;
}

export interface PruneResult {
  readonly scanned: number;
  readonly removed: number;
  /** Absolute paths of mirror files deleted this sweep. */
  readonly removedPaths: readonly string[];
}

/** Clamp a requested retention (days) into [1, MAX_RETENTION_DAYS]. */
export function clampRetentionDays(days: number | undefined): number {
  const d = typeof days === "number" && Number.isFinite(days) ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
  if (d < 1) return 1;
  if (d > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return d;
}

/**
 * List every mirror file (`<archiveRoot>/<projectDir>/<session>.jsonl`),
 * validating each directory/file segment so a tampered name can never widen the
 * scan beyond the archive tree.
 */
function listMirrorFiles(archiveRoot: string): string[] {
  const out: string[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return out; // archive dir absent → nothing to prune
  }
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    let safeProject: string;
    try {
      safeProject = assertSafeSegment(pd.name, "projectDir");
    } catch {
      continue; // ignore anything that isn't a well-formed project dir
    }
    const projectPath = path.join(archiveRoot, safeProject);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      out.push(path.join(projectPath, f.name));
    }
  }
  return out;
}

/**
 * Delete mirror files whose real last-activity is older than the retention
 * window. Idempotent and best-effort: a delete that fails (or a file already
 * gone) is counted as not-removed and does not abort the sweep. Files with no
 * parseable activity are always KEPT.
 *
 * @param now injected clock (ms) for deterministic tests.
 */
export function pruneArchive(
  archiveRoot: string,
  retentionDays: number | undefined,
  now: () => number = Date.now,
): PruneResult {
  const cutoff = now() - clampRetentionDays(retentionDays) * MS_PER_DAY;
  const files = listMirrorFiles(archiveRoot);
  const removedPaths: string[] = [];
  for (const file of files) {
    const lastActivity = computeLastActivity(file);
    if (lastActivity === null) continue; // no evidence → keep
    if (lastActivity >= cutoff) continue; // still within window → keep
    try {
      fs.rmSync(file, { force: true });
      removedPaths.push(file);
    } catch {
      // best-effort: leave it for the next sweep
    }
  }
  return { scanned: files.length, removed: removedPaths.length, removedPaths };
}
