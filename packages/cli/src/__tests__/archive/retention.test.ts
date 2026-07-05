/**
 * Archive retention — pruned by REAL last activity (max timestamp in content),
 * NEVER by file mtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pruneArchive,
  computeLastActivity,
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from "../../archive/retention.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed injected clock

let tmp: string;
let archiveRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-ret-"));
  archiveRoot = path.join(tmp, "archive");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a mirror file with lines whose max timestamp is `lastActivityMs`. */
function writeMirror(projectDir: string, sessionId: string, lastActivityMs: number | null): string {
  const dir = path.join(archiveRoot, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  let body = "";
  if (lastActivityMs === null) {
    // A line with NO timestamp field → no activity evidence.
    body = JSON.stringify({ sessionId, type: "summary", note: "no ts" }) + "\n";
  } else {
    // Two lines; the later one carries the max timestamp.
    body += JSON.stringify({ sessionId, type: "user", timestamp: new Date(lastActivityMs - 5000).toISOString() }) + "\n";
    body += JSON.stringify({ sessionId, type: "assistant", timestamp: new Date(lastActivityMs).toISOString() }) + "\n";
  }
  fs.writeFileSync(file, body);
  return file;
}

const P = "-Users-alice-repos-example";

describe("computeLastActivity", () => {
  it("returns the max timestamp across lines", () => {
    const f = writeMirror(P, "s-max", NOW - 3 * MS_PER_DAY);
    expect(computeLastActivity(f)).toBe(NOW - 3 * MS_PER_DAY);
  });

  it("returns null when no line carries a timestamp", () => {
    const f = writeMirror(P, "s-none", null);
    expect(computeLastActivity(f)).toBeNull();
  });

  it("ignores malformed lines without throwing", () => {
    const dir = path.join(archiveRoot, P);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "s-bad.jsonl");
    fs.writeFileSync(
      f,
      "{not json\n" + JSON.stringify({ timestamp: new Date(NOW).toISOString() }) + "\n",
    );
    expect(computeLastActivity(f)).toBe(NOW);
  });
});

describe("clampRetentionDays", () => {
  it("applies the default for undefined/non-finite", () => {
    expect(clampRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(clampRetentionDays(Number.NaN)).toBe(DEFAULT_RETENTION_DAYS);
  });
  it("clamps into [1, MAX]", () => {
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(-10)).toBe(1);
    expect(clampRetentionDays(MAX_RETENTION_DAYS + 999)).toBe(MAX_RETENTION_DAYS);
    expect(clampRetentionDays(30)).toBe(30);
  });
});

describe("pruneArchive — by activity, not mtime", () => {
  it("removes files older than the window and keeps recent ones", () => {
    const old = writeMirror(P, "s-old", NOW - 200 * MS_PER_DAY);
    const recent = writeMirror(P, "s-recent", NOW - 10 * MS_PER_DAY);

    const res = pruneArchive(archiveRoot, 90, () => NOW);

    expect(res.removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("removes an OLD-activity file even when its mtime is now (mtime ignored)", () => {
    const old = writeMirror(P, "s-old-fresh-mtime", NOW - 300 * MS_PER_DAY);
    // Force a very-recent mtime — mtime-based pruning would KEEP this.
    const nowSec = NOW / 1000;
    fs.utimesSync(old, nowSec, nowSec);

    const res = pruneArchive(archiveRoot, 90, () => NOW);
    expect(res.removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("keeps a RECENT-activity file even when its mtime is ancient (mtime ignored)", () => {
    const recent = writeMirror(P, "s-recent-old-mtime", NOW - 5 * MS_PER_DAY);
    const ancientSec = (NOW - 400 * MS_PER_DAY) / 1000;
    fs.utimesSync(recent, ancientSec, ancientSec);

    const res = pruneArchive(archiveRoot, 90, () => NOW);
    expect(res.removed).toBe(0);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("keeps files with no activity evidence (never delete on missing signal)", () => {
    const none = writeMirror(P, "s-noactivity", null);
    const res = pruneArchive(archiveRoot, 1, () => NOW);
    expect(fs.existsSync(none)).toBe(true);
    expect(res.removed).toBe(0);
  });

  it("is a clean no-op when the archive dir does not exist", () => {
    const res = pruneArchive(path.join(tmp, "absent"), 90, () => NOW);
    expect(res).toEqual({ scanned: 0, removed: 0, removedPaths: [] });
  });

  it("ignores directory entries whose name is not a safe project segment", () => {
    // A dir with an unsafe name (space) must be skipped, not scanned.
    const badDir = path.join(archiveRoot, "bad name");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "x.jsonl"),
      JSON.stringify({ timestamp: new Date(NOW - 500 * MS_PER_DAY).toISOString() }) + "\n",
    );
    const recent = writeMirror(P, "s-ok", NOW - 1 * MS_PER_DAY);
    const res = pruneArchive(archiveRoot, 90, () => NOW);
    expect(fs.existsSync(recent)).toBe(true);
    // Only the well-formed project dir's one file was scanned.
    expect(res.scanned).toBe(1);
    // The unsafe dir's stale file was left untouched (not scanned, not deleted).
    expect(fs.existsSync(path.join(badDir, "x.jsonl"))).toBe(true);
  });
});
