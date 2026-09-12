/**
 * Pre-repair database backup.
 *
 * The store opens its database in WAL mode, so at any moment part of the
 * committed content lives in `<db>-wal` rather than in `<db>` itself. Copying
 * the main file alone therefore yields a backup that is consistent but STALE
 * — missing every page since the last checkpoint, which on a freshly created
 * database can be the schema itself. `VACUUM INTO` reads through the
 * connection's own view of the database (main file + WAL) and writes a
 * complete, self-contained copy; it is SQLite's supported way to snapshot a
 * live database without stopping writers.
 *
 * It runs on a SEPARATE connection: `VACUUM` is not allowed inside a
 * transaction, and the store's own connection may have one open.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Snapshot `dbPath` to `${dbPath}.pre-repair-${label}-${now()}` and return
 * the backup's path, or `null` when there is no database file to back up.
 */
export function backupDatabase(dbPath: string, label: string, now: () => number): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const backupPath = `${dbPath}.pre-repair-${label}-${now()}`;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // The path is our own construction (the store's file plus a suffix we
    // wrote), not caller input, so it can be quoted into the statement —
    // `VACUUM INTO` does not accept a bound parameter. Single quotes in a
    // filesystem path are still escaped, because a home directory can carry
    // one.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return backupPath;
}
