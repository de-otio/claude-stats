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
 *   S3 — The mirror is a copy of the source prefix MINUS the `api-request*`
 *   lines (system prompts, tool definitions and, on 2.1.290-2.1.304, auto-mode
 *   classifier context; nothing in claude-stats reads them). Once lines are
 *   dropped, the mirror's size no longer equals the source offset it covers, so
 *   S2's size-derived watermark cannot be used alone. A small `<mirror>.mark`
 *   sidecar records `<sourceOffset> <mirrorBytes>`: the source offset archived
 *   so far and the mirror size at that moment. A mirror longer than recorded
 *   (a crash between append and mark write) is truncated back before the next
 *   append, so the append stays idempotent; a mirror with no mark (written
 *   before S3) keeps the old rule, size == offset.
 *
 * Ordering contract: the caller MUST invoke `mirrorSessionRange` BEFORE it
 * writes the DB checkpoint. Archive-before-checkpoint means a crash between the
 * two re-does the archive append (idempotent — see S2) rather than skipping it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isApiRequestLine } from "@claude-stats/core/parser/session";
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

/** Longest line prefix `isApiRequestLine` needs: `{"type":"api-request-shape"` is 27. */
const HEAD_LEN = 32;
const NL = 0x0a;

/** Path of the watermark sidecar for a mirror file (not `.jsonl`: retention ignores it). */
export function markFilePath(mirrorPath: string): string {
  return `${mirrorPath}.mark`;
}

interface Mark {
  readonly sourceOffset: number;
  readonly mirrorBytes: number;
}

function readMark(markPath: string): Mark | null {
  try {
    const m = /^(\d+) (\d+)\s*$/.exec(fs.readFileSync(markPath, "utf8"));
    if (!m) return null;
    const sourceOffset = Number(m[1]);
    const mirrorBytes = Number(m[2]);
    return Number.isSafeInteger(sourceOffset) && Number.isSafeInteger(mirrorBytes)
      ? { sourceOffset, mirrorBytes }
      : null;
  } catch {
    return null;
  }
}

/** True when `offset` is 0 or the source byte just before it is a newline. */
function atLineStart(sourcePath: string, offset: number): boolean {
  if (offset === 0) return true;
  let fd: number | null = null;
  try {
    fd = fs.openSync(sourcePath, "r");
    const b = Buffer.alloc(1);
    return fs.readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === NL;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Atomic replace, so a crash never leaves a torn mark. */
function writeMark(markPath: string, mark: Mark): void {
  const tmp = `${markPath}.tmp`;
  fs.writeFileSync(tmp, `${mark.sourceOffset} ${mark.mirrorBytes}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, markPath);
}

/**
 * Copy source bytes [from, to) and append them to `destFd`, dropping every
 * `api-request*` line (S3). Streams in bounded chunks, so a large range, or a
 * line larger than a chunk, never buffers whole: the decision is made from the
 * first HEAD_LEN bytes of each line, held back across chunk boundaries, and
 * then applies to the rest of that line. Returns bytes WRITTEN to the mirror.
 */
function copyRange(sourcePath: string, from: number, to: number, destFd: number): number {
  if (to <= from) return 0;
  const srcFd = fs.openSync(sourcePath, "r");
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    const head = Buffer.allocUnsafe(HEAD_LEN);
    let headLen = 0;
    // "head": the current line's first bytes are still being collected.
    let mode: "head" | "keep" | "skip" = "head";
    let offset = from;
    let total = 0;
    const emit = (b: Buffer, start: number, end: number): void => {
      if (end <= start) return;
      fs.writeSync(destFd, b, start, end - start);
      total += end - start;
    };
    const skipsHead = (): boolean => isApiRequestLine(head.toString("latin1", 0, headLen));

    while (offset < to) {
      const want = Math.min(COPY_CHUNK, to - offset);
      const read = fs.readSync(srcFd, buf, 0, want, offset);
      if (read <= 0) break; // source shorter than expected — stop cleanly
      offset += read;
      let i = 0;
      while (i < read) {
        if (mode === "head") {
          const nl = buf.indexOf(NL, i);
          const hasNl = nl >= 0 && nl < read;
          const segEnd = hasNl ? nl : read;
          const take = Math.min(segEnd - i, HEAD_LEN - headLen);
          buf.copy(head, headLen, i, i + take);
          headLen += take;
          i += take;
          if (hasNl && i === segEnd) {
            // The line ended inside the head window; buf[i] is its newline.
            if (!skipsHead()) {
              emit(head, 0, headLen);
              emit(buf, i, i + 1);
            }
            headLen = 0;
            i += 1;
          } else if (headLen === HEAD_LEN) {
            mode = skipsHead() ? "skip" : "keep";
            if (mode === "keep") emit(head, 0, headLen);
            headLen = 0;
          }
          // else: the chunk ended mid-head; keep collecting from the next chunk.
        } else {
          const nl = buf.indexOf(NL, i);
          const hasNl = nl >= 0 && nl < read;
          const end = hasNl ? nl + 1 : read;
          if (mode === "keep") emit(buf, i, end);
          i = end;
          if (hasNl) mode = "head";
        }
      }
    }
    // The range ended inside a line's head window (no trailing newline).
    if (mode === "head" && headLen > 0 && !skipsHead()) emit(head, 0, headLen);
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

  // A vanished source must never cost us the mirror (the rewrite path truncates it).
  if (!fs.existsSync(input.sourceFilePath)) {
    return { mirrorPath, bytesWritten: 0, priorWatermark: fileSize(mirrorPath), recopied: false, skipped: true };
  }

  const markPath = markFilePath(mirrorPath);
  const mirrorSize = fileSize(mirrorPath);
  const mark = readMark(markPath);
  // Source offset archived so far. With a mark it is the recorded one; without
  // (a mirror from before S3, or none yet) the mirror is a byte-for-byte prefix
  // and its size IS the offset.
  const watermark = mark ? mark.sourceOffset : mirrorSize;
  const target = input.lastGoodOffset;

  // A rewrite (collector said so, OR the parsed end regressed below what we have
  // already mirrored — which can only happen if the source was rewritten, OR the
  // mirror is shorter than the mark recorded: it was lost or tampered with)
  // means the mirror's prefix is stale. Truncate and re-copy [0, target).
  // A watermark that is not at a line start (source byte before it is not a
  // newline) cannot be resumed from: copying would begin mid-line, and the
  // line-prefix filter would let the remainder of an api-request line through.
  // That happens when the mark was deleted from a filtered mirror (the size
  // fallback then points into the middle of the source) or the source changed.
  const isRewrite =
    input.mode === "rewrite" ||
    target < watermark ||
    (mark !== null && mirrorSize < mark.mirrorBytes) ||
    !atLineStart(input.sourceFilePath, watermark);

  try {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true, mode: DIR_MODE });

    if (isRewrite) {
      // Mark first: a mirror that holds filtered content must never be without
      // a mark, or a crash would let the size fallback misread it as a byte copy.
      writeMark(markPath, { sourceOffset: 0, mirrorBytes: 0 });
      const fd = fs.openSync(mirrorPath, "w", FILE_MODE);
      try {
        const written = copyRange(input.sourceFilePath, 0, target, fd);
        writeMark(markPath, { sourceOffset: target, mirrorBytes: written });
        return { mirrorPath, bytesWritten: written, priorWatermark: watermark, recopied: true, skipped: false };
      } finally {
        fs.closeSync(fd);
      }
    }

    // Append path (covers both "new" and "append"). The range is [watermark,
    // target) — driven by the archive's own watermark, NOT the collector's
    // startOffset — so a previously failed append is filled in here (S2).
    if (target <= watermark) {
      return { mirrorPath, bytesWritten: 0, priorWatermark: watermark, recopied: false, skipped: true };
    }
    // Drop any bytes a crashed or failed append left beyond the recorded size.
    if (mark && mirrorSize > mark.mirrorBytes) fs.truncateSync(mirrorPath, mark.mirrorBytes);
    const base = mark ? mark.mirrorBytes : mirrorSize;
    // Adopting a markless mirror (or starting a new one): record where it
    // stands BEFORE the first filtered byte lands, so no-mark never coexists
    // with filtered content. A crash mid-copy is then undone by the truncate
    // above on the next call.
    if (!mark) writeMark(markPath, { sourceOffset: watermark, mirrorBytes: mirrorSize });
    const fd = fs.openSync(mirrorPath, "a", FILE_MODE);
    try {
      const written = copyRange(input.sourceFilePath, watermark, target, fd);
      writeMark(markPath, { sourceOffset: target, mirrorBytes: base + written });
      return { mirrorPath, bytesWritten: written, priorWatermark: watermark, recopied: false, skipped: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best-effort: swallow and report a no-op so collect never breaks.
    return { mirrorPath, bytesWritten: 0, priorWatermark: watermark, recopied: false, skipped: true };
  }
}
