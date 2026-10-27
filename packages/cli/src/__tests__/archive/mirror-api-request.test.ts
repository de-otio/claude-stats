/**
 * Archive mirror (S3): `api-request*` lines are not archived.
 *
 * They hold system prompts, tool definitions and (Claude Code 2.1.290-2.1.304)
 * auto-mode classifier context, and nothing in claude-stats reads them. Because
 * the mirror is then SMALLER than the source offset it covers, these tests also
 * pin the watermark behaviour that replaces "mirror size == source offset".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorSessionRange } from "../../archive/mirror.js";
import { mirrorFilePath } from "../../archive/paths.js";
import { pruneArchive } from "../../archive/retention.js";

const PROJECT_DIR = "-Users-alice-repos-example";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

let tmp: string;
let archiveRoot: string;
let sourcePath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-apireq-"));
  archiveRoot = path.join(tmp, "archive");
  sourcePath = path.join(tmp, "source.jsonl");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mirrorPath = () => mirrorFilePath(archiveRoot, PROJECT_DIR, SESSION_ID);
const markPath = () => `${mirrorPath()}.mark`;
const readMirror = () => fs.readFileSync(mirrorPath()).toString("utf8");

function input(mode: "new" | "append" | "rewrite" | "deleted", lastGoodOffset: number) {
  return { sourceFilePath: sourcePath, projectDirName: PROJECT_DIR, sessionId: SESSION_ID, mode, lastGoodOffset };
}

function convLine(seq: number): string {
  return JSON.stringify({
    sessionId: SESSION_ID,
    type: seq === 0 ? "user" : "assistant",
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    message: { role: seq === 0 ? "user" : "assistant", content: `msg ${seq}` },
  });
}
function apiLine(kind: string, pad: number): string {
  return JSON.stringify({ type: kind, sessionId: SESSION_ID, pad: "p".repeat(pad) });
}
const isApi = (l: string) => /^\{"type":"api-request(-shape|-blob)?"/.test(l);
const join = (lines: string[]) => lines.map((l) => l + "\n").join("");
/** What the mirror must hold: the source minus every api-request line. */
const withoutApi = (lines: string[]) => join(lines.filter((l) => !isApi(l)));

describe("mirrorSessionRange — excludes api-request lines (S3)", () => {
  it("drops the three variants, keeps every other line byte-for-byte", () => {
    const lines = [
      apiLine("api-request-shape", 10),
      convLine(0),
      apiLine("api-request", 300),
      convLine(1),
      apiLine("api-request-blob", 0),
      '{"type":"api-requests","k":1}', // lookalikes are kept
      '{"type":"api-request-x","k":2}',
      convLine(2),
    ];
    fs.writeFileSync(sourcePath, join(lines));
    const res = mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    const mirrored = readMirror();
    expect(mirrored).toBe(withoutApi(lines));
    expect(mirrored).not.toContain('"type":"api-request"');
    expect(mirrored).not.toContain('"type":"api-request-shape"');
    expect(mirrored).not.toContain('"type":"api-request-blob"');
    expect(mirrored).toContain('"type":"api-requests"');
    expect(mirrored).toContain('"type":"api-request-x"');
    expect(res.bytesWritten).toBe(Buffer.byteLength(withoutApi(lines)));
  });

  it("is correct across the copy-chunk boundary and for lines larger than a chunk", () => {
    // 64 KiB chunks: start an api-request line 10 bytes before a boundary so
    // its 32-byte head window straddles it, then use multi-chunk lines.
    const lines: string[] = [convLine(0)];
    const size = () => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const room = 64 * 1024 - 10 - size();
    lines.push(JSON.stringify({ type: "user", pad: "z".repeat(room - 1 - '{"type":"user","pad":""}'.length) }));
    expect(size()).toBe(64 * 1024 - 10);
    lines.push(apiLine("api-request-shape", 200_000));
    lines.push(JSON.stringify({ type: "user", pad: "k".repeat(150_000) }));
    lines.push(apiLine("api-request", 70_000));
    lines.push(convLine(6));
    fs.writeFileSync(sourcePath, join(lines));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    expect(readMirror()).toBe(withoutApi(lines));
  });

  it("keeps the mirror equal to the filtered source across incremental appends", () => {
    const lines = [
      apiLine("api-request-shape", 50), convLine(0), apiLine("api-request", 5_000),
      convLine(1), apiLine("api-request", 10), convLine(2),
      apiLine("api-request-blob", 80_000), convLine(3),
    ];
    for (let n = 1; n <= lines.length; n++) {
      const body = join(lines.slice(0, n));
      fs.writeFileSync(sourcePath, body);
      const r = mirrorSessionRange(archiveRoot, input(n === 1 ? "new" : "append", Buffer.byteLength(body)));
      expect(r.skipped).toBe(false);
      expect(readMirror()).toBe(withoutApi(lines.slice(0, n)));
    }
    // Nothing new: a no-op even though the mirror is smaller than the source offset.
    const again = mirrorSessionRange(archiveRoot, input("append", fs.statSync(sourcePath).size));
    expect(again.skipped).toBe(true);
    expect(again.bytesWritten).toBe(0);
  });

  it("recovers from a crash between the append and the mark write without duplicating", () => {
    const lines = [convLine(0), apiLine("api-request", 100), convLine(1)];
    const first = join(lines.slice(0, 2));
    fs.writeFileSync(sourcePath, first);
    mirrorSessionRange(archiveRoot, input("new", Buffer.byteLength(first)));
    const markBefore = fs.readFileSync(markPath(), "utf8");

    const all = join(lines);
    fs.writeFileSync(sourcePath, all);
    mirrorSessionRange(archiveRoot, input("append", Buffer.byteLength(all)));
    fs.writeFileSync(markPath(), markBefore); // crash: the mark never advanced

    mirrorSessionRange(archiveRoot, input("append", Buffer.byteLength(all)));
    expect(readMirror()).toBe(withoutApi(lines));
  });

  it("leaves a pre-existing mirror (no mark) alone and filters only what it appends", () => {
    const lines = [convLine(0), apiLine("api-request", 100), convLine(1)];
    const old = join(lines.slice(0, 2)); // an older release mirrored this verbatim
    fs.writeFileSync(sourcePath, join(lines));
    fs.mkdirSync(path.dirname(mirrorPath()), { recursive: true });
    fs.writeFileSync(mirrorPath(), old);
    mirrorSessionRange(archiveRoot, input("append", fs.statSync(sourcePath).size));
    expect(readMirror()).toBe(old + convLine(1) + "\n");
  });

  it("re-copies when the mirror was lost but the mark remains", () => {
    const lines = [convLine(0), apiLine("api-request", 100), convLine(1)];
    fs.writeFileSync(sourcePath, join(lines));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    fs.rmSync(mirrorPath());
    const r = mirrorSessionRange(archiveRoot, input("append", fs.statSync(sourcePath).size));
    expect(r.recopied).toBe(true);
    expect(readMirror()).toBe(withoutApi(lines));
  });

  it("a crash between the first copy and the mark write leaves no unfiltered fragment", () => {
    // New mirror: the mark ({0,0}) is on disk BEFORE any filtered byte lands.
    const lines = [convLine(0), apiLine("api-request", 300), convLine(1)];
    fs.writeFileSync(sourcePath, join(lines));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    // Simulate the crash: copy done, final mark write lost -> the pre-copy mark.
    fs.writeFileSync(markPath(), "0 0\n");
    // A fragment of the unfiltered source is all the crash could have left.
    const full = readMirror();
    fs.writeFileSync(mirrorPath(), full + '{"type":"api-request","pa');

    mirrorSessionRange(archiveRoot, input("append", fs.statSync(sourcePath).size));
    expect(readMirror()).toBe(withoutApi(lines));
    expect(readMirror()).not.toContain("api-request");
  });

  it("a deleted mark on a filtered mirror triggers a rewrite, not a mid-line resume", () => {
    const lines = [convLine(0), apiLine("api-request", 400), convLine(1), apiLine("api-request-blob", 900), convLine(2)];
    const firstTwo = join(lines.slice(0, 3));
    fs.writeFileSync(sourcePath, firstTwo);
    mirrorSessionRange(archiveRoot, input("new", Buffer.byteLength(firstTwo)));
    fs.rmSync(markPath());
    // Without the mark the size fallback points into the middle of the source.
    expect(Buffer.byteLength(readMirror())).toBeLessThan(Buffer.byteLength(firstTwo));
    const all = join(lines);
    fs.writeFileSync(sourcePath, all);
    const r = mirrorSessionRange(archiveRoot, input("append", Buffer.byteLength(all)));
    expect(r.recopied).toBe(true);
    expect(readMirror()).toBe(withoutApi(lines));
  });

  it("a watermark that is mid-line in the source takes the rewrite path", () => {
    const lines = [convLine(0), apiLine("api-request", 400), convLine(1)];
    fs.writeFileSync(sourcePath, join(lines));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    // Poison the mark with an offset inside the second line.
    const mid = Buffer.byteLength(convLine(0)) + 1 + 10;
    fs.writeFileSync(markPath(), `${mid} ${Buffer.byteLength(readMirror())}\n`);
    const r = mirrorSessionRange(archiveRoot, input("append", fs.statSync(sourcePath).size));
    expect(r.recopied).toBe(true);
    expect(readMirror()).toBe(withoutApi(lines));
  });

  it("never truncates the mirror when the source has vanished", () => {
    fs.writeFileSync(sourcePath, join([convLine(0)]));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    const before = readMirror();
    fs.rmSync(sourcePath);
    const r = mirrorSessionRange(archiveRoot, input("append", 9999));
    expect(r.skipped).toBe(true);
    expect(readMirror()).toBe(before);
  });

  it("retention removes the mark together with an expired mirror", () => {
    fs.writeFileSync(sourcePath, join([convLine(0), apiLine("api-request", 10)]));
    mirrorSessionRange(archiveRoot, input("new", fs.statSync(sourcePath).size));
    expect(fs.existsSync(markPath())).toBe(true);
    // Mirrored timestamps are in 2023; a clock far past them expires the mirror.
    const res = pruneArchive(archiveRoot, 30, () => 1_900_000_000_000);
    expect(res.removed).toBe(1);
    expect(fs.existsSync(mirrorPath())).toBe(false);
    expect(fs.existsSync(markPath())).toBe(false);
  });
});
