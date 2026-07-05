/**
 * Raw-transcript mirror — the Phase A seed of the transcript archive.
 *
 * During collect, for each changed session file the collector already computes
 * an append/rewrite/new/deleted classification, a `startOffset`, and a
 * `lastGoodOffset` (the byte offset after the last *fully parsed* line). This
 * module copies the byte range the collector actually parsed into a mirror
 * file so transcripts survive Claude Code's own mtime-based file cleanup.
 *
 * Two review findings shape the design:
 *
 *   S1 — Archive the range [start, lastGoodOffset), NOT [start, fileStats.size).
 *   Copying to the file's *current* size would archive a partial trailing line
 *   (a line the parser deliberately withheld because it may be a partial
 *   write). That partial line re-appears on the next collect and gets appended
 *   a second time, corrupting the mirror. We only ever copy up to
 *   `lastGoodOffset`.
 *
 *   S2 — The archive keeps its OWN progress watermark, re-derived from the size
 *   of the mirror file itself, decoupled from the DB checkpoint. The mirror is
 *   a byte-for-byte copy of the source prefix, so its size IS the source offset
 *   we have archived so far. If a best-effort append failed on a previous
 *   collect (mirror short, but the DB checkpoint advanced), the next collect
 *   copies the gap [mirrorSize, lastGoodOffset) and self-heals — instead of a
 *   silent permanent hole.
 *
 * Ordering contract: the caller MUST invoke `mirrorSessionRange` BEFORE it
 * writes the DB checkpoint. Archive-before-checkpoint means a crash between the
 * two re-does the archive append (idempotent — see S2) rather than skipping it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { mirrorFilePath } from "./paths.js";

/** How the collector classified this file's change since the last collect. */
export type ChangeMode = "new" | "append" | "rewrite" | "deleted";

export interface MirrorInput {
  /** Absolute path to the live Claude Code session JSONL. */
  readonly sourceFilePath: string;
  /** Claude Code's encoded project directory name (a bare basename). */
  readonly projectDirName: string;
  /** Session id — becomes `<sessionId>.jsonl` under the project dir. */
  readonly sessionId: string;
  /** The collector's change classification for this file. */
  readonly mode: ChangeMode;
  /** Byte offset after the last fully parsed line (NEVER fileStats.size). */
  readonly lastGoodOffset: number;
}

export interface MirrorResult {
  /** Absolute path to the mirror file (even when no bytes were written). */
  readonly mirrorPath: string;
  /** Bytes appended to the mirror this call. */
  readonly bytesWritten: number;
  /** The archive's own watermark BEFORE this call (mirror size on entry). */
  readonly priorWatermark: number;
  /** True when the mirror was truncated and re-copied from offset 0. */
  readonly recopied: boolean;
  /** True when the call was a no-op (disabled/deleted/nothing new). */
  readonly skipped: boolean;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const COPY_CHUNK = 64 * 1024;

/** Byte size of an existing file, or 0 when it does not exist. */
function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Copy source bytes [from, to) and append them to `destFd`. Streams in bounded
 * chunks so a large range never buffers the whole file. Returns bytes copied.
 */
function copyRange(sourcePath: string, from: number, to: number, destFd: number): number {
  if (to <= from) return 0;
  const srcFd = fs.openSync(sourcePath, "r");
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    let offset = from;
    let total = 0;
    while (offset < to) {
      const want = Math.min(COPY_CHUNK, to - offset);
      const read = fs.readSync(srcFd, buf, 0, want, offset);
      if (read <= 0) break; // source shorter than expected — stop cleanly
      fs.writeSync(destFd, buf, 0, read);
      offset += read;
      total += read;
    }
    return total;
  } finally {
    fs.closeSync(srcFd);
  }
}

/**
 * Mirror the parsed byte range of one session into the archive.
 *
 * Pure-ish imperative shell: all filesystem effects live here; the decision of
 * WHAT range to copy is derived from the mirror's own on-disk size (S2) and the
 * collector's `mode`, never from the DB checkpoint.
 *
 * Best-effort: never throws on an I/O failure — the archive is a non-critical
 * side channel and must not break collection. A failed append simply leaves the
 * mirror short; the next collect self-heals.
 */
export function mirrorSessionRange(archiveRoot: string, input: MirrorInput): MirrorResult {
  const mirrorPath = mirrorFilePath(archiveRoot, input.projectDirName, input.sessionId);

  // Deleted sources are the whole point of the archive — retain the mirror.
  if (input.mode === "deleted") {
    return { mirrorPath, bytesWritten: 0, priorWatermark: fileSize(mirrorPath), recopied: false, skipped: true };
  }

  const watermark = fileSize(mirrorPath);
  const target = input.lastGoodOffset;

  // A rewrite (collector said so, OR the parsed end regressed below what we have
  // already mirrored — which can only happen if the source was rewritten) means
  // the mirror's prefix is stale. Truncate and re-copy [0, target).
  const isRewrite = input.mode === "rewrite" || target < watermark;

  try {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true, mode: DIR_MODE });

    if (isRewrite) {
      const fd = fs.openSync(mirrorPath, "w", FILE_MODE);
      try {
        const written = copyRange(input.sourceFilePath, 0, target, fd);
        return { mirrorPath, bytesWritten: written, priorWatermark: watermark, recopied: true, skipped: false };
      } finally {
        fs.closeSync(fd);
      }
    }

    // Append path (covers both "new" and "append"). The range is [watermark,
    // target) — driven by the mirror's own size, NOT the collector's
    // startOffset — so a previously failed append is filled in here (S2).
    if (target <= watermark) {
      return { mirrorPath, bytesWritten: 0, priorWatermark: watermark, recopied: false, skipped: true };
    }
    const fd = fs.openSync(mirrorPath, "a", FILE_MODE);
    try {
      const written = copyRange(input.sourceFilePath, watermark, target, fd);
      return { mirrorPath, bytesWritten: written, priorWatermark: watermark, recopied: false, skipped: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best-effort: swallow and report a no-op so collect never breaks.
    return { mirrorPath, bytesWritten: 0, priorWatermark: watermark, recopied: false, skipped: true };
  }
}
