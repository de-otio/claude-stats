/**
 * Secure filesystem helpers for the recap module.
 *
 * Every directory and file written under ~/.claude-stats/ by recap code MUST
 * go through these helpers (SR-3). They enforce strict permissions:
 *   - Directories: 0o700 (owner rwx only)
 *   - Files:       0o600 (owner rw only)
 *
 * The explicit chmodSync after mkdir/write defends against two scenarios:
 *   1. A pre-existing directory/file with looser permissions (e.g. 0o755).
 *   2. A process umask that strips bits from the mode passed to mkdirSync.
 */
import fs from 'node:fs';

/**
 * Create a directory (and all ancestors) with mode 0o700.
 * If the directory already exists with looser permissions, it is chmod-ed
 * down to 0o700 regardless.
 */
export function ensurePrivateDir(absPath: string): void {
  fs.mkdirSync(absPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(absPath, 0o700);
}

/**
 * Write data to a file with mode 0o600.
 * If the file already exists with looser permissions, it is chmod-ed
 * down to 0o600 after the write.
 *
 * The caller is responsible for ensuring the parent directory exists
 * (typically via ensurePrivateDir).
 */
export function writePrivateFile(absPath: string, data: string | Buffer): void {
  fs.writeFileSync(absPath, data, { mode: 0o600 });
  fs.chmodSync(absPath, 0o600);
}

/**
 * Read a file as UTF-8 text.
 *
 * Returns null if the file does not exist (ENOENT).
 * Re-throws for any other error (EACCES, EISDIR, corrupt read, etc.) so
 * callers can distinguish "not cached" from "permission denied".
 */
export function readIfReadable(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
