/**
 * Archive mirror — append / rewrite / new / deleted, [start, lastGoodOffset)
 * byte-alignment (S1), and self-heal after a failed append (S2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { mirrorSessionRange } from "../../archive/mirror.js";
import { mirrorFilePath } from "../../archive/paths.js";

const FC_SEED = 0x5eed_a11;

// A synthetic session dir + id (IETF-reserved / fake values only).
const PROJECT_DIR = "-Users-alice-repos-example";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

let tmp: string;
let archiveRoot: string;
let sourcePath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-mirror-"));
  archiveRoot = path.join(tmp, "archive");
  sourcePath = path.join(tmp, "source.jsonl");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** One synthetic JSONL line with a real ISO timestamp. */
function line(seq: number, tsMs: number): string {
  return JSON.stringify({
    sessionId: SESSION_ID,
    type: seq === 0 ? "user" : "assistant",
    timestamp: new Date(tsMs).toISOString(),
    message: { role: seq === 0 ? "user" : "assistant", content: `msg ${seq}` },
  });
}

/** Build a file body of `n` complete lines (each terminated by \n). */
function completeBody(n: number, startTs = 1_700_000_000_000): string {
  let body = "";
  for (let i = 0; i < n; i++) body += line(i, startTs + i * 1000) + "\n";
  return body;
}

function mirrorPathFor(): string {
  return mirrorFilePath(archiveRoot, PROJECT_DIR, SESSION_ID);
}

function baseInput(mode: "new" | "append" | "rewrite" | "deleted", lastGoodOffset: number) {
  return { sourceFilePath: sourcePath, projectDirName: PROJECT_DIR, sessionId: SESSION_ID, mode, lastGoodOffset };
}

describe("mirrorSessionRange — new + byte alignment (S1)", () => {
  it("archives [0, lastGoodOffset), excluding a partial trailing line", () => {
    const body = completeBody(3);
    const lastGoodOffset = Buffer.byteLength(body, "utf8");
    // A partial (unterminated, invalid-JSON) trailing line the parser withholds.
    const partial = '{"sessionId":"' + SESSION_ID + '","timestamp":"2024';
    fs.writeFileSync(sourcePath, body + partial);
    const fileSize = fs.statSync(sourcePath).size;
    expect(fileSize).toBeGreaterThan(lastGoodOffset); // partial line exists

    const res = mirrorSessionRange(archiveRoot, baseInput("new", lastGoodOffset));

    expect(res.bytesWritten).toBe(lastGoodOffset);
    expect(res.skipped).toBe(false);
    const mirrored = fs.readFileSync(mirrorPathFor());
    // Byte-for-byte equal to the source PREFIX, not the whole file.
    expect(mirrored.equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(mirrored.length).toBe(lastGoodOffset);
    expect(mirrored.length).toBeLessThan(fileSize);
    // The partial line must NOT be present.
    expect(mirrored.toString("utf8").includes(partial)).toBe(false);
  });

  it("creates the mirror file with 0600 perms and dir 0700", () => {
    const body = completeBody(1);
    fs.writeFileSync(sourcePath, body);
    mirrorSessionRange(archiveRoot, baseInput("new", Buffer.byteLength(body)));
    const fileMode = fs.statSync(mirrorPathFor()).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(mirrorPathFor())).mode & 0o777;
    // umask may clear group/other bits further, but owner-only must hold and
    // no broader-than-requested bits may appear.
    expect(fileMode & ~0o600).toBe(0);
    expect(dirMode & ~0o700).toBe(0);
  });
});

describe("mirrorSessionRange — append", () => {
  it("appends only the new range [priorWatermark, lastGoodOffset)", () => {
    const body1 = completeBody(2);
    const lg1 = Buffer.byteLength(body1);
    fs.writeFileSync(sourcePath, body1);
    const r1 = mirrorSessionRange(archiveRoot, baseInput("new", lg1));
    expect(r1.bytesWritten).toBe(lg1);

    // Source grows by two more complete lines.
    const body2 = body1 + completeBody(2, 1_700_000_100_000);
    const lg2 = Buffer.byteLength(body2);
    fs.writeFileSync(sourcePath, body2);
    const r2 = mirrorSessionRange(archiveRoot, baseInput("append", lg2));

    expect(r2.priorWatermark).toBe(lg1);
    expect(r2.bytesWritten).toBe(lg2 - lg1);
    expect(r2.recopied).toBe(false);
    const mirrored = fs.readFileSync(mirrorPathFor());
    expect(mirrored.equals(Buffer.from(body2, "utf8"))).toBe(true);
  });

  it("is a no-op when nothing new was parsed (lastGoodOffset == watermark)", () => {
    const body = completeBody(2);
    const lg = Buffer.byteLength(body);
    fs.writeFileSync(sourcePath, body);
    mirrorSessionRange(archiveRoot, baseInput("new", lg));
    const r = mirrorSessionRange(archiveRoot, baseInput("append", lg));
    expect(r.skipped).toBe(true);
    expect(r.bytesWritten).toBe(0);
  });
});

describe("mirrorSessionRange — rewrite", () => {
  it("truncates the mirror and re-copies [0, lastGoodOffset)", () => {
    const body1 = completeBody(4);
    fs.writeFileSync(sourcePath, body1);
    mirrorSessionRange(archiveRoot, baseInput("new", Buffer.byteLength(body1)));

    // Source rewritten to a SHORTER, different body.
    const body2 = completeBody(2, 1_800_000_000_000);
    const lg2 = Buffer.byteLength(body2);
    fs.writeFileSync(sourcePath, body2);
    const r = mirrorSessionRange(archiveRoot, baseInput("rewrite", lg2));

    expect(r.recopied).toBe(true);
    expect(r.bytesWritten).toBe(lg2);
    const mirrored = fs.readFileSync(mirrorPathFor());
    expect(mirrored.equals(Buffer.from(body2, "utf8"))).toBe(true);
    expect(mirrored.length).toBe(lg2); // no stale tail from the longer body1
  });

  it("treats a regressed lastGoodOffset in append mode as a rewrite", () => {
    const body1 = completeBody(4);
    fs.writeFileSync(sourcePath, body1);
    mirrorSessionRange(archiveRoot, baseInput("new", Buffer.byteLength(body1)));

    const body2 = completeBody(1, 1_900_000_000_000);
    const lg2 = Buffer.byteLength(body2);
    fs.writeFileSync(sourcePath, body2);
    // Collector mis-labels it "append", but lastGoodOffset < mirror size.
    const r = mirrorSessionRange(archiveRoot, baseInput("append", lg2));
    expect(r.recopied).toBe(true);
    const mirrored = fs.readFileSync(mirrorPathFor());
    expect(mirrored.equals(Buffer.from(body2, "utf8"))).toBe(true);
  });
});

describe("mirrorSessionRange — deleted", () => {
  it("retains the mirror unchanged (the archive outlives the source)", () => {
    const body = completeBody(3);
    fs.writeFileSync(sourcePath, body);
    mirrorSessionRange(archiveRoot, baseInput("new", Buffer.byteLength(body)));
    const before = fs.readFileSync(mirrorPathFor());

    // Source is gone; collector reports "deleted".
    fs.rmSync(sourcePath);
    const r = mirrorSessionRange(archiveRoot, baseInput("deleted", 0));
    expect(r.skipped).toBe(true);
    expect(r.bytesWritten).toBe(0);
    const after = fs.readFileSync(mirrorPathFor());
    expect(after.equals(before)).toBe(true);
  });
});

describe("mirrorSessionRange — self-heal after a failed append (S2)", () => {
  it("fills the gap when the mirror is short of the DB checkpoint", () => {
    const body = completeBody(4);
    const lgFull = Buffer.byteLength(body);
    fs.writeFileSync(sourcePath, body);

    // Simulate a prior FAILED append: the mirror only captured the first line,
    // even though a later collect's DB checkpoint has since advanced. The
    // archive knows nothing of the checkpoint — its watermark is the mirror's
    // own size.
    const shortPrefixLen = Buffer.byteLength(completeBody(1));
    const mp = mirrorPathFor();
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, body.slice(0, shortPrefixLen));

    // Next collect, append mode, full lastGoodOffset.
    const r = mirrorSessionRange(archiveRoot, baseInput("append", lgFull));

    // Copied from the MIRROR's watermark (shortPrefixLen), not from any
    // checkpoint — no gap, no double-write.
    expect(r.priorWatermark).toBe(shortPrefixLen);
    expect(r.bytesWritten).toBe(lgFull - shortPrefixLen);
    const mirrored = fs.readFileSync(mp);
    expect(mirrored.equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  it("self-heals from scratch when the mirror is missing entirely", () => {
    const body = completeBody(3);
    const lg = Buffer.byteLength(body);
    fs.writeFileSync(sourcePath, body);
    // append mode but no mirror file yet → copy [0, lg).
    const r = mirrorSessionRange(archiveRoot, baseInput("append", lg));
    expect(r.priorWatermark).toBe(0);
    expect(r.bytesWritten).toBe(lg);
    expect(fs.readFileSync(mirrorPathFor()).equals(Buffer.from(body, "utf8"))).toBe(true);
  });
});

describe("mirrorSessionRange — property: mirror always equals source prefix", () => {
  it("byte-identical to source[0, lastGoodOffset) across append sequences", () => {
    fc.assert(
      fc.property(
        // A sequence of positive per-step line counts (each step = one collect).
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 8 }),
        (steps) => {
          const localTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-prop-"));
          try {
            const root = path.join(localTmp, "archive");
            const src = path.join(localTmp, "s.jsonl");
            let body = "";
            let seq = 0;
            let ts = 1_600_000_000_000;
            for (const n of steps) {
              for (let i = 0; i < n; i++) {
                body += line(seq++, ts) + "\n";
                ts += 1000;
              }
              fs.writeFileSync(src, body);
              const lg = Buffer.byteLength(body);
              const res = mirrorSessionRange(root, {
                sourceFilePath: src,
                projectDirName: PROJECT_DIR,
                sessionId: SESSION_ID,
                mode: seq === n ? "new" : "append",
                lastGoodOffset: lg,
              });
              const mp = mirrorFilePath(root, PROJECT_DIR, SESSION_ID);
              const mirrored = fs.readFileSync(mp);
              // Invariant: mirror == full source (no partial trailing line here).
              expect(mirrored.equals(Buffer.from(body, "utf8"))).toBe(true);
              expect(res.skipped || res.bytesWritten > 0).toBe(true);
            }
          } finally {
            fs.rmSync(localTmp, { recursive: true, force: true });
          }
        },
      ),
      { seed: FC_SEED, numRuns: 60 },
    );
  });
});
