/**
 * `Store#addToQuarantine` — re-parsing the same bytes must not duplicate
 * quarantined lines.
 *
 * Identity is (file_path, error, raw_line) as a multiset; the line number is
 * not part of it (an incremental parse and a byte-0 re-parse number the same
 * line differently). See the method's doc comment.
 *
 * Nothing here reads the real home directory: every path `collect()` could
 * touch is redirected into a temp root. Fixture names are synthetic only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as pathsMod from "@claude-stats/core/paths";
import type { ParseError } from "@claude-stats/core/types";
import { Store } from "../store/index.js";
import { collect } from "../aggregator/index.js";

const now = () => 1_700_100_000_000;

function tmpDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function err(rawLine: string, lineNumber: number, over: Partial<ParseError> = {}): ParseError {
  return {
    filePath: "/home/example/proj/s.jsonl",
    lineNumber,
    rawLine,
    error: "Unexpected token",
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

function quarantineRows(dbPath: string): Array<{ file_path: string; line_number: number; raw_line: string; error: string }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT file_path, line_number, raw_line, error FROM quarantine ORDER BY id")
      .all() as Array<{ file_path: string; line_number: number; raw_line: string; error: string }>;
  } finally {
    db.close();
  }
}

describe("Store#addToQuarantine — direct", () => {
  let root: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    root = tmpDir("cs-quar");
    dbPath = path.join(root, "stats.db");
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the same batch twice adds no duplicates", () => {
    const batch = [err("{bad one", 3), err("{bad two", 7)];
    store.addToQuarantine(batch);
    const first = quarantineRows(dbPath);
    expect(first).toHaveLength(2);
    store.addToQuarantine(batch);
    expect(quarantineRows(dbPath)).toEqual(first);
  });

  it("two identical bad lines in one batch are two rows, and stay two on a re-parse", () => {
    store.addToQuarantine([err("{dup", 2), err("{dup", 5)]);
    expect(quarantineRows(dbPath)).toHaveLength(2);
    store.addToQuarantine([err("{dup", 2), err("{dup", 5)]);
    expect(quarantineRows(dbPath)).toHaveLength(2);
    // A third occurrence (the batch now holds three) is genuinely new: exactly one row added.
    store.addToQuarantine([err("{dup", 2), err("{dup", 5), err("{dup", 9)]);
    const rows = quarantineRows(dbPath);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.line_number).toBe(9);
  });

  it("the line number is not part of the identity (incremental vs byte-0 numbering)", () => {
    store.addToQuarantine([err("{bad", 1)]); // numbered from the start of an appended slice
    store.addToQuarantine([err("{bad", 41)]); // the same line numbered from the top of the file
    expect(quarantineRows(dbPath)).toHaveLength(1);
  });

  it("file, error and bytes each distinguish entries", () => {
    store.addToQuarantine([err("{bad", 1)]);
    store.addToQuarantine([
      err("{bad", 1, { filePath: "/home/example/proj/other.jsonl" }),
      err("{bad", 1, { error: "Unexpected end of JSON input" }),
      err("{bad ", 1),
    ]);
    expect(quarantineRows(dbPath)).toHaveLength(4);
  });

  it("joins a caller's transaction: a rollback leaves nothing behind", () => {
    expect(() =>
      store.transaction(() => {
        store.addToQuarantine([err("{bad", 1)]);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(quarantineRows(dbPath)).toHaveLength(0);
    // ...and a later parse of the same line is therefore new, not a duplicate.
    store.addToQuarantine([err("{bad", 1)]);
    expect(quarantineRows(dbPath)).toHaveLength(1);
  });

  it("an empty batch is a no-op", () => {
    store.addToQuarantine([]);
    expect(quarantineRows(dbPath)).toHaveLength(0);
  });
});

// ── collect() over byte-0 checkpoints ────────────────────────────────────────

const PROJECT = "/home/example/quar-proj";
const SESSION = "sess-quar-main";

function assistant(uuid: string, msgId: string, i: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SESSION,
    version: "2.1.72",
    cwd: PROJECT,
    uuid,
    timestamp: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      id: msgId,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

describe("Store#addToQuarantine — collect() over armed byte-0 checkpoints", () => {
  let root: string;
  let projectsDir: string;
  let dbPath: string;
  let mainFile: string;
  const stores: Store[] = [];

  const open = (): Store => {
    const s = new Store(dbPath);
    stores.push(s);
    return s;
  };

  /** What the backfill repairs do: every checkpoint back to byte 0. */
  const armAll = (s: Store): void => {
    s.transaction(() => {
      const cp = s.getCheckpoint(mainFile);
      s.upsertCheckpoint({
        filePath: mainFile,
        fileSize: cp?.fileSize ?? 0,
        lastByteOffset: 0,
        lastMtime: 0,
        firstKbHash: cp?.firstKbHash ?? "",
        sourceDeleted: false,
      });
    });
  };

  beforeEach(() => {
    root = tmpDir("cs-quar-collect");
    projectsDir = path.join(root, "projects");
    const projDir = path.join(projectsDir, "-home-example-quar-proj");
    fs.mkdirSync(projDir, { recursive: true });
    dbPath = path.join(root, "db", "stats.db");

    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      claudeDir: root,
      projectsDir,
      historyFile: path.join(root, "history.jsonl"),
      changelogFile: path.join(root, "cache", "changelog.md"),
      sessionsDir: path.join(root, "sessions"),
      claudeConfigFile: path.join(root, "claude.json"),
    });

    mainFile = path.join(projDir, `${SESSION}.jsonl`);
    // Bad lines are followed by a good one: a bad line at EOF may be a partial
    // write and is not quarantined yet. Two identical bad lines + one other.
    fs.writeFileSync(
      mainFile,
      [
        assistant("q-1", "msg_Q1", 1),
        "{not json",
        "{not json",
        assistant("q-2", "msg_Q2", 2),
        "{different bad",
        assistant("q-3", "msg_Q3", 3),
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const s of stores.splice(0)) s.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a sequential byte-0 re-collect adds no quarantine rows", async () => {
    const store = open();
    await collect(store, {}, now);
    const before = quarantineRows(dbPath);
    expect(before).toHaveLength(3);

    armAll(store);
    const result = await collect(store, {}, now);
    expect(result.parseErrors).toBeGreaterThan(0); // the lines WERE re-reported
    expect(quarantineRows(dbPath)).toEqual(before);
  });

  it("two concurrent collectors over armed byte-0 checkpoints add no quarantine rows", async () => {
    const a = open();
    await collect(a, {}, now);
    const before = quarantineRows(dbPath);
    expect(before).toHaveLength(3);

    armAll(a);
    // A second process's connection: neither collector's compare-and-swap
    // guard stops a byte-0 parse, so both re-parse and both report the lines.
    const b = open();
    const [ra, rb] = await Promise.all([collect(a, {}, now), collect(b, {}, now)]);
    // Both really did re-parse (otherwise this would not test the race).
    expect(ra.parseErrors).toBeGreaterThan(0);
    expect(rb.parseErrors).toBeGreaterThan(0);
    expect(quarantineRows(dbPath)).toEqual(before);
  });
});
