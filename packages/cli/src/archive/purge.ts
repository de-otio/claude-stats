/**
 * Purge — irreversibly delete the user's locally stored data.
 *
 * This is the security-sensitive counterpart to the archive: it removes the
 * transcript mirror, the export bundles, and (optionally) the stats database,
 * and unregisters the MCP server so Claude Code stops spawning it. It is the
 * single clean function the Wire/UX phases call from the MCP
 * `unregisterMcpServer()` path and the VS Code "Delete All Stored Data" command
 * — those phases inject the surface-specific unregister hook; this module owns
 * the deletion.
 *
 * Defensive posture:
 *   - Every deletion target passes `assertSafeToDelete` first, so a bad path can
 *     never escalate into deleting `~` or `/`.
 *   - Idempotent: a target that is already gone is a success, not an error.
 *   - Best-effort per target: one failed deletion is recorded but does not stop
 *     the others (so a locked DB file can't strand the archive).
 */
import * as fs from "node:fs";
import { paths } from "@claude-stats/core/paths";
import { assertSafeToDelete, ArchivePathError } from "./paths.js";
import { unregisterMcpServerFromClaudeJson } from "./unregister.js";

export interface PurgeOptions {
  /** Archive mirror root. Defaults to `paths.archiveDir`. */
  readonly archiveRoot?: string;
  /** Export bundle root. Defaults to `paths.bundleDir`. */
  readonly bundleRoot?: string;
  /** Stats DB path. Defaults to `paths.statsDb`. */
  readonly dbPath?: string;
  /** When true, also delete the stats DB (+ its -wal/-shm sidecars). */
  readonly deleteDb?: boolean;
  /**
   * Injected MCP-unregister hook. The Wire/UX phases pass the surface's real
   * implementation. When omitted, `unregisterMcpServerFromClaudeJson` is used;
   * pass `false` to skip unregistering entirely.
   */
  readonly unregister?: (() => void) | false;
}

export interface PurgeTargetOutcome {
  readonly target: string;
  readonly deleted: boolean;
  readonly existed: boolean;
  readonly error?: string;
}

export interface PurgeResult {
  readonly outcomes: readonly PurgeTargetOutcome[];
  readonly unregistered: boolean;
  /** Whole purge succeeded (no target errored). */
  readonly ok: boolean;
}

/** Recursively delete one path, guarded and idempotent. */
function deleteGuarded(target: string): PurgeTargetOutcome {
  let safe: string;
  try {
    safe = assertSafeToDelete(target);
  } catch (err) {
    const msg = err instanceof ArchivePathError ? err.message : String(err);
    return { target, deleted: false, existed: false, error: msg };
  }
  const existed = fs.existsSync(safe);
  try {
    fs.rmSync(safe, { recursive: true, force: true });
    return { target: safe, deleted: true, existed };
  } catch (err) {
    return { target: safe, deleted: false, existed, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete all locally stored claude-stats data. See `PurgeOptions`.
 *
 * The stats DB is deleted only when `deleteDb` is true (the archive/bundle are
 * always removed) — some callers want to wipe transcripts while keeping the
 * aggregated stats DB, others want a full reset.
 */
export function purgeAllData(opts: PurgeOptions = {}): PurgeResult {
  const archiveRoot = opts.archiveRoot ?? paths.archiveDir;
  const bundleRoot = opts.bundleRoot ?? paths.bundleDir;
  const dbPath = opts.dbPath ?? paths.statsDb;

  const outcomes: PurgeTargetOutcome[] = [];
  outcomes.push(deleteGuarded(archiveRoot));
  outcomes.push(deleteGuarded(bundleRoot));

  if (opts.deleteDb) {
    // Delete the DB and its WAL/SHM sidecars (node:sqlite WAL mode).
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      // Sidecars may not exist; treat missing as a clean no-op.
      if (suffix === "" || fs.existsSync(p)) outcomes.push(deleteGuarded(p));
    }
  }

  let unregistered = false;
  if (opts.unregister !== false) {
    const hook = opts.unregister ?? unregisterMcpServerFromClaudeJson;
    try {
      hook();
      unregistered = true;
    } catch {
      unregistered = false; // non-fatal — data is still purged
    }
  }

  const ok = outcomes.every((o) => o.error === undefined);
  return { outcomes, unregistered, ok };
}
