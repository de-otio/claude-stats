/**
 * Safe reader for a subagent's sibling `agent-<id>.meta.json`.
 *
 * The imperative shell around the pure `parseSubagentMeta` in core. Treated as
 * a file-read primitive an attacker would like to aim (threat list §8.3, §8.9):
 *
 *  - The path is derived ONLY from the transcript path the scanner discovered
 *    on disk — never from `sessions.source_file`, which can arrive via sync and
 *    is therefore untrusted. The transcript's basename must look like
 *    `agent-<id>.jsonl`; the meta path is the same directory + the same stem +
 *    `.meta.json`, so no component of it comes from file contents.
 *  - No symlinks (`O_NOFOLLOW`, or lstat + dev/ino match where the platform has
 *    no `O_NOFOLLOW`), no FIFOs or devices (`O_NONBLOCK` so the open itself
 *    cannot block the extension host, then fstat must say regular file), and a
 *    64 KiB size cap enforced both on fstat and while reading.
 *  - Any failure is "not recorded" (all-null). Never throws, never logs the
 *    path or the contents.
 */
import fs from "fs";
import path from "path";
import { EMPTY_SUBAGENT_META, parseSubagentMeta } from "@claude-stats/core/subagentMeta";
import type { SubagentMeta } from "@claude-stats/core/subagentMeta";

/** Basename a scanned subagent transcript must have for its meta to be read. */
export const SUBAGENT_TRANSCRIPT_RE = /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/;

/** Largest `.meta.json` read; real files are a few hundred bytes. */
export const MAX_SUBAGENT_META_BYTES = 65_536;

/** The open-flag constants the reader branches on (injectable for tests). */
export interface OpenConstants {
  readonly O_RDONLY: number;
  readonly O_NOFOLLOW?: number | undefined;
  readonly O_NONBLOCK?: number | undefined;
}

/**
 * The sibling meta path for a scanned transcript path, or null when the
 * transcript's basename is not `agent-<id>.jsonl`.
 */
export function subagentMetaPath(transcriptPath: string): string | null {
  const base = path.basename(transcriptPath);
  if (!SUBAGENT_TRANSCRIPT_RE.test(base)) return null;
  const stem = base.slice(0, -".jsonl".length);
  return path.join(path.dirname(transcriptPath), `${stem}.meta.json`);
}

/**
 * Open `p` for reading without following a symlink and without blocking.
 * Returns the fd, or null when the target must not be read.
 */
function openNoFollow(p: string, c: OpenConstants): number | null {
  if (c.O_NOFOLLOW !== undefined && c.O_NONBLOCK !== undefined) {
    // macOS / Linux. A symlink fails with ELOOP; a FIFO opens immediately
    // instead of waiting for a writer and is rejected by the fstat below.
    return fs.openSync(p, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  }
  // Windows: `O_RDONLY | undefined` would be 0 and silently follow symlinks.
  // lstat must see a regular file, and the fd we open must be that same file.
  const before = fs.lstatSync(p);
  if (!before.isFile()) return null;
  const fd = fs.openSync(p, "r");
  try {
    const after = fs.fstatSync(fd);
    if (after.dev === before.dev && after.ino === before.ino) return fd;
  } catch {
    /* fall through to close */
  }
  fs.closeSync(fd);
  return null;
}

/**
 * Read at most {@link MAX_SUBAGENT_META_BYTES} from a regular, non-symlink
 * file. Null on any failure, a non-regular file, or a file over the cap.
 *
 * @internal exported for tests; production callers use {@link readSubagentMeta}.
 */
export function readBoundedRegularFile(
  p: string,
  constants: OpenConstants = fs.constants,
): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openNoFollow(p, constants);
    if (fd === null) return null;
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SUBAGENT_META_BYTES) return null;
    // One byte over the cap, so a file that grew after fstat is detected
    // rather than silently truncated into different JSON.
    const buf = Buffer.alloc(MAX_SUBAGENT_META_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_SUBAGENT_META_BYTES) return null;
    return buf.subarray(0, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/**
 * The validated meta for a scanned subagent transcript. `transcriptPath` must
 * be the path the scanner discovered — never a stored `source_file`.
 */
export function readSubagentMeta(
  transcriptPath: string,
  constants: OpenConstants = fs.constants,
): SubagentMeta {
  try {
    const metaPath = subagentMetaPath(transcriptPath);
    if (metaPath === null) return EMPTY_SUBAGENT_META;
    const bytes = readBoundedRegularFile(metaPath, constants);
    return bytes === null ? EMPTY_SUBAGENT_META : parseSubagentMeta(bytes);
  } catch {
    return EMPTY_SUBAGENT_META;
  }
}
