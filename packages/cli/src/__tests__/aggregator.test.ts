import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import os from "os";
import path from "path";
import fs from "fs";

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `cs-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-agg-1",
    version: "2.1.70",
    timestamp: 1_700_000_000_000,
    uuid: `msg-${Math.random()}`,
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    message: {
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
      },
    },
    ...overrides,
  });
}

function makeUserLine(sessionId = "sess-agg-1"): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    version: "2.1.70",
    timestamp: 1_699_999_000_000,
    uuid: `usr-${Math.random()}`,
    isMeta: false,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("collect", () => {
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    projectsDir = tmpDir();
    dbPath = path.join(os.tmpdir(), `cs-agg-db-${Date.now()}.db`);
    store = new Store(dbPath);

    // Redirect scanner to temp projects dir
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      projectsDir,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("returns zeros for empty projects directory", async () => {
    const result = await collect(store);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.sessionsUpserted).toBe(0);
  });

  it("processes a new session file end-to-end", async () => {
    const projDir = path.join(projectsDir, "-proj-test");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess-agg-1.jsonl");
    fs.writeFileSync(sessFile, [makeUserLine(), makeSessionLine()].join("\n") + "\n");

    const result = await collect(store);
    expect(result.filesProcessed).toBe(1);
    expect(result.sessionsUpserted).toBe(1);
    expect(result.messagesUpserted).toBe(1);

    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe("sess-agg-1");
    expect(sessions[0]!.prompt_count).toBe(1);
    expect(sessions[0]!.input_tokens).toBe(100);
  });

  it("skips unchanged files on second run", async () => {
    const projDir = path.join(projectsDir, "-proj-skip");
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, "sess.jsonl"), makeSessionLine() + "\n");

    await collect(store);
    const result2 = await collect(store);
    expect(result2.filesSkipped).toBe(1);
    expect(result2.filesProcessed).toBe(0);
  });

  it("processes only new lines when file is appended", async () => {
    const projDir = path.join(projectsDir, "-proj-append");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess.jsonl");

    // Write one line and collect
    fs.writeFileSync(sessFile, makeSessionLine() + "\n");
    await collect(store);

    // Append a second line and collect again
    fs.appendFileSync(sessFile, makeSessionLine({ uuid: "msg-second" }) + "\n");
    // Force mtime to change by touching the file stat (already changed by write)
    const result2 = await collect(store);
    expect(result2.filesProcessed).toBe(1);
    // The second message is in a different session record aggregate, messages count increments
    expect(result2.messagesUpserted).toBe(1);
  });

  it("records parse errors in quarantine", async () => {
    const projDir = path.join(projectsDir, "-proj-err");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess.jsonl");
    // A valid line, then a bad mid-line, then another valid line
    fs.writeFileSync(sessFile,
      makeSessionLine() + "\n" +
      "NOT VALID JSON {\n" +
      makeSessionLine({ uuid: "msg-3" }) + "\n"
    );

    const result = await collect(store);
    expect(result.parseErrors).toBe(1);
    expect(store.getStatus().quarantineCount).toBe(1);
  });

  it("marks file as source_deleted when file disappears", async () => {
    const projDir = path.join(projectsDir, "-proj-del");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "vanish.jsonl");
    fs.writeFileSync(sessFile, makeSessionLine() + "\n");

    await collect(store);

    // Now delete the file and collect again — the scanner will discover it
    // then getFileStats returns null
    fs.unlinkSync(sessFile);
    const result2 = await collect(store);
    expect(result2.filesDeleted).toBe(1);
  });

  // NOTE: the two tests that asserted the surface-blind ~/.claude.json account
  // fallback during collect were removed in Phase 1 — that fallback was
  // deliberately deleted from the aggregator (it mis-attributed non-CLI
  // surfaces; see plan B4). Surface-aware attribution + its tests land in
  // Phase 2 (A).

  it("sets is_subagent = 1 for files in subagents/ directory", async () => {
    const projDir = path.join(projectsDir, "-proj-sub");
    const subagentsDir = path.join(projDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });

    // Parent session file
    const parentLine = makeSessionLine({ sessionId: "parent-sess", uuid: "parent-msg-uuid" });
    fs.writeFileSync(path.join(projDir, "parent-sess.jsonl"), [makeUserLine("parent-sess"), parentLine].join("\n") + "\n");

    // Subagent session file
    const childLine = makeSessionLine({ sessionId: "child-sess" });
    fs.writeFileSync(path.join(subagentsDir, "child-sess.jsonl"), childLine + "\n");

    await collect(store);
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    const parent = sessions.find(s => s.session_id === "parent-sess");
    const child = sessions.find(s => s.session_id === "child-sess");

    expect(parent).toBeDefined();
    expect(parent!.is_subagent).toBe(0);
    expect(child).toBeDefined();
    expect(child!.is_subagent).toBe(1);
  });

  it("resolves parentUuid to parent_session_id during collection", async () => {
    const projDir = path.join(projectsDir, "-proj-resolve");
    const subagentsDir = path.join(projDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });

    // Parent session with a known message UUID
    const parentMsgUuid = "known-parent-msg-uuid";
    const parentLine = makeSessionLine({ sessionId: "parent-res", uuid: parentMsgUuid });
    fs.writeFileSync(path.join(projDir, "parent-res.jsonl"), [makeUserLine("parent-res"), parentLine].join("\n") + "\n");

    // Subagent file with parentUuid pointing to that message
    const childLine = JSON.stringify({
      type: "assistant",
      sessionId: "child-res",
      version: "2.1.70",
      timestamp: 1_700_000_100_000,
      uuid: "child-msg-uuid",
      parentUuid: parentMsgUuid,
      message: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });
    fs.writeFileSync(path.join(subagentsDir, "child-res.jsonl"), childLine + "\n");

    await collect(store);
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    const child = sessions.find(s => s.session_id === "child-res");

    expect(child).toBeDefined();
    expect(child!.is_subagent).toBe(1);
    expect(child!.parent_session_id).toBe("parent-res");
  });

  it("leaves parent_session_id null when parentUuid cannot be resolved", async () => {
    const projDir = path.join(projectsDir, "-proj-noresolve");
    const subagentsDir = path.join(projDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });

    // Subagent file with parentUuid that doesn't match any stored message
    const childLine = JSON.stringify({
      type: "assistant",
      sessionId: "orphan-child",
      version: "2.1.70",
      timestamp: 1_700_000_100_000,
      uuid: "orphan-msg-uuid",
      parentUuid: "nonexistent-parent-msg",
      message: {
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });
    fs.writeFileSync(path.join(subagentsDir, "orphan-child.jsonl"), childLine + "\n");

    await collect(store);
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    const child = sessions.find(s => s.session_id === "orphan-child");

    expect(child).toBeDefined();
    expect(child!.is_subagent).toBe(1);
    expect(child!.parent_session_id).toBeNull();
  });
});

// ── message_hourly incremental maintenance (Build 2 Phase 1, Stream A) ─────────
//
// collect() maintains the message_hourly rollup incrementally by recomputing only
// the hour partitions touched in each run. These tests assert that the incremental
// maintenance produces a table BYTE-IDENTICAL to a from-scratch full rebuild, across
// initial collect, append, rewrite, and no-change re-collect.

describe("collect — message_hourly incremental maintenance", () => {
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  const HOUR = 3_600_000;

  // A message at a chosen hour bucket with chosen token counts. Distinct hour
  // buckets are produced by setting timestamp = bucket * HOUR (+ a small offset).
  function msgLine(o: {
    sessionId?: string;
    uuid?: string;
    bucket: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): string {
    return JSON.stringify({
      type: "assistant",
      sessionId: o.sessionId ?? "sess-mh",
      version: "2.1.70",
      timestamp: o.bucket * HOUR + 1, // +1 so floor() lands squarely in `bucket`
      uuid: o.uuid ?? `msg-${Math.random()}`,
      message: {
        model: o.model ?? "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [],
        usage: {
          input_tokens: o.inputTokens ?? 100,
          output_tokens: o.outputTokens ?? 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  }

  type HourlyRow = Record<string, unknown>;

  // Read the full message_hourly table via an INDEPENDENT node:sqlite connection,
  // ordered by the full PK so two snapshots are directly comparable.
  function readHourly(): HourlyRow[] {
    const db = new DatabaseSync(dbPath);
    try {
      return db
        .prepare(
          "SELECT * FROM message_hourly ORDER BY hour_utc, project_path, model, inference_geo"
        )
        .all() as HourlyRow[];
    } finally {
      db.close();
    }
  }

  // The oracle: snapshot the rollup, force a full from-scratch rebuild, snapshot
  // again, then restore the incremental state by rebuilding once more (the full
  // rebuild is deterministic, so the restored state equals the pre-oracle state).
  // Returns { incremental, fullRebuild } for comparison.
  function snapshotVsFullRebuild(): { incremental: HourlyRow[]; fullRebuild: HourlyRow[] } {
    const incremental = readHourly();
    store.recomputeMessageHourly(); // full rebuild (no args)
    const fullRebuild = readHourly();
    return { incremental, fullRebuild };
  }

  beforeEach(() => {
    projectsDir = tmpDir();
    dbPath = path.join(os.tmpdir(), `cs-agg-mh-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);

    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      projectsDir,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("(1) initial collect populates the rollup and matches a full rebuild", async () => {
    const projDir = path.join(projectsDir, "-proj-mh-init");
    fs.mkdirSync(projDir);
    // Two distinct hour buckets, two models → multiple rollup rows.
    fs.writeFileSync(
      path.join(projDir, "sess-mh.jsonl"),
      [
        makeUserLine("sess-mh"),
        msgLine({ uuid: "i1", bucket: 100, inputTokens: 100, outputTokens: 10 }),
        msgLine({ uuid: "i2", bucket: 100, inputTokens: 200, outputTokens: 20 }),
        msgLine({ uuid: "i3", bucket: 200, inputTokens: 300, outputTokens: 30, model: "claude-sonnet-4-6" }),
      ].join("\n") + "\n",
    );

    await collect(store);

    // Rollup is non-empty after the initial collect.
    expect(readHourly().length).toBeGreaterThan(0);

    const { incremental, fullRebuild } = snapshotVsFullRebuild();
    expect(incremental).toEqual(fullRebuild);
  });

  it("(2) append updates affected hours and still equals a full rebuild", async () => {
    const projDir = path.join(projectsDir, "-proj-mh-append");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess-mh.jsonl");

    fs.writeFileSync(
      sessFile,
      [
        makeUserLine("sess-mh"),
        msgLine({ uuid: "a1", bucket: 100, inputTokens: 100, outputTokens: 10 }),
      ].join("\n") + "\n",
    );
    await collect(store);

    // Append a message in a NEW hour bucket and one in the EXISTING bucket.
    fs.appendFileSync(
      sessFile,
      [
        msgLine({ uuid: "a2", bucket: 100, inputTokens: 50, outputTokens: 5 }),
        msgLine({ uuid: "a3", bucket: 300, inputTokens: 70, outputTokens: 7 }),
      ].join("\n") + "\n",
    );
    const r = await collect(store);
    expect(r.filesProcessed).toBe(1);

    const { incremental, fullRebuild } = snapshotVsFullRebuild();
    expect(incremental).toEqual(fullRebuild);
  });

  it("(3) rewrite with changed token counts updates without double-counting", async () => {
    const projDir = path.join(projectsDir, "-proj-mh-rewrite");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess-mh.jsonl");

    fs.writeFileSync(
      sessFile,
      [
        makeUserLine("sess-mh"),
        msgLine({ uuid: "r1", bucket: 100, inputTokens: 100, outputTokens: 10 }),
        msgLine({ uuid: "r2", bucket: 100, inputTokens: 200, outputTokens: 20 }),
      ].join("\n") + "\n",
    );
    await collect(store);

    // Rewrite the whole file (offset 0) with DIFFERENT token counts for the same
    // message UUIDs (upsert overwrites in `messages`). A correct partition recompute
    // (DELETE the bucket then re-SUM from messages) yields the NEW totals, not new+old.
    fs.writeFileSync(
      sessFile,
      [
        makeUserLine("sess-mh"),
        msgLine({ uuid: "r1", bucket: 100, inputTokens: 1, outputTokens: 1 }),
        msgLine({ uuid: "r2", bucket: 100, inputTokens: 2, outputTokens: 2 }),
      ].join("\n") + "\n",
    );
    const r = await collect(store);
    expect(r.filesProcessed).toBe(1);

    // The bucket-100 input total must reflect the rewrite (1+2=3), not 300 or 303.
    const bucket100 = readHourly().filter(
      (row) => row.hour_utc === 100 && row.model === "claude-opus-4-6"
    );
    const inputSum = bucket100.reduce((a, row) => a + (row.input_tokens as number), 0);
    expect(inputSum).toBe(3);

    const { incremental, fullRebuild } = snapshotVsFullRebuild();
    expect(incremental).toEqual(fullRebuild);
  });

  it("(4) no-change re-collect leaves the rollup byte-identical", async () => {
    const projDir = path.join(projectsDir, "-proj-mh-nochange");
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, "sess-mh.jsonl"),
      [
        makeUserLine("sess-mh"),
        msgLine({ uuid: "n1", bucket: 100, inputTokens: 100, outputTokens: 10 }),
        msgLine({ uuid: "n2", bucket: 200, inputTokens: 200, outputTokens: 20 }),
      ].join("\n") + "\n",
    );
    await collect(store);

    const before = JSON.stringify(readHourly());

    // Re-collect with no filesystem change → file is skipped, no message upserts,
    // touchedHours is empty, recomputeMessageHourly is not called.
    const r = await collect(store);
    expect(r.filesSkipped).toBe(1);
    expect(r.filesProcessed).toBe(0);

    const after = JSON.stringify(readHourly());
    expect(after).toBe(before);
  });
});
