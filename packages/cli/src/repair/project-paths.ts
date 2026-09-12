/**
 * Project-path repair backfill.
 *
 * `decodeProjectPath` (core/paths.ts) can't distinguish a literal hyphen in a
 * directory name from an encoded '/' — Claude Code's own directory-naming
 * scheme is lossy in that direction. The parser now prefers the session's
 * own `cwd` (ground truth) going forward (see parser/session.ts), but
 * `project_path` is written once at first insert and never revisited by
 * normal collection (see Store#upsertSession), so sessions collected before
 * that fix stay wrong until repaired here.
 *
 * For every non-deleted session whose source file still exists, re-derive
 * project_path (and the repo_url that depends on it) from the file's own
 * `cwd`. Sessions whose source file is gone have no ground truth left and
 * are left untouched (counted as `unfixable`).
 *
 * Safety, mirrors attribution/reattribute.ts: `--dry-run` computes counts
 * without writing; a real run backs up the DB first (`repair/backup.ts` — a
 * `VACUUM INTO` snapshot, since a plain file copy misses the WAL), then
 * applies all changes in one transaction.
 */
import fs from "node:fs";
import { extractCwdFromSessionFile } from "@claude-stats/core/parser/session";
import type { Store } from "../store/index.js";
import { getGitRemoteUrl } from "../git.js";
import { backupDatabase } from "./backup.js";

export interface RepairProjectPathsOptions {
  dryRun?: boolean;
  /** Path to back up before writing. Defaults to the store's OWN file
   *  (`Store#dbPath`) — never `paths.statsDb`, which would snapshot the live
   *  database whenever the store was opened on some other path (a test store,
   *  a disposable exercise DB) and leave the one being modified unprotected. */
  dbPath?: string;
}

export interface RepairProjectPathsSummary {
  dryRun: boolean;
  /** Non-deleted sessions considered. */
  totalSessions: number;
  /** Sessions whose project_path (and repo_url) changed, or would change. */
  changed: number;
  /** Sessions with no ground truth left to repair from (source file gone,
   *  unreadable, or no cwd found within the scan window). */
  unfixable: number;
  /** Path the DB was backed up to (null in dry-run, or when nothing changed). */
  backupPath: string | null;
}

export async function repairProjectPaths(
  store: Store,
  opts: RepairProjectPathsOptions,
  now: () => number,
): Promise<RepairProjectPathsSummary> {
  const dryRun = opts.dryRun ?? false;

  // includeDeleted defaults false — a session already marked source_deleted
  // has no ground truth left to repair from anyway.
  const sessions = store.getSessions({ includeCI: true, includeSubagents: true });

  const changes = new Map<string, { projectPath: string; repoUrl: string | null }>();
  let unfixable = 0;

  for (const session of sessions) {
    let cwd: string | null = null;
    try {
      if (fs.existsSync(session.source_file)) {
        cwd = await extractCwdFromSessionFile(session.source_file);
      }
    } catch {
      cwd = null;
    }
    if (cwd === null) {
      unfixable++;
      continue;
    }
    if (cwd === session.project_path) continue; // already correct
    changes.set(session.session_id, { projectPath: cwd, repoUrl: getGitRemoteUrl(cwd) });
  }

  if (dryRun) {
    return {
      dryRun: true,
      totalSessions: sessions.length,
      changed: changes.size,
      unfixable,
      backupPath: null,
    };
  }

  let backupPath: string | null = null;
  let changed = 0;
  if (changes.size > 0) {
    backupPath = backupDatabase(opts.dbPath ?? store.dbPath, "project-paths", now);

    store.transaction(() => {
      changed = store.updateProjectPaths(changes);
    });
    // message_hourly is keyed by (hour_utc, project_path, model,
    // inference_geo) — a full rebuild is already the idempotent one-shot
    // backfill path (see Store#recomputeMessageHourly).
    store.recomputeMessageHourly();
  }

  return {
    dryRun: false,
    totalSessions: sessions.length,
    changed,
    unfixable,
    backupPath,
  };
}
