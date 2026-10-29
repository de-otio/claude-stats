/**
 * E1 aggregator wiring — the parser→store path for the V28 request records.
 *
 * The parser tests cover `parseSessionFile` and the store tests cover the SQL;
 * these cover the seam between them: that `collect()` actually hands
 * `api_requests` rows and `messages.request_ref` to the store, that a request
 * line and the assistant message referencing it can land in DIFFERENT collects
 * (the line precedes the message in the transcript), and that a head miss
 * neither aborts the collect nor quarantines the line.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `cs-agg-e1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SID = "sess-e1-agg";
const REAL_HASH = "a".repeat(64);
const TS_ISO = "2026-01-01T00:00:00.000Z";
const TS_MS = Date.parse(TS_ISO);

function userLine(ts: number): string {
  return JSON.stringify({
    type: "user", sessionId: SID, version: "2.1.301", timestamp: ts, uuid: `u-${ts}`,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

function assistantLine(ts: number, msgId: string, requestRef?: string): string {
  return JSON.stringify({
    type: "assistant", sessionId: SID, version: "2.1.301", timestamp: ts, uuid: `a-${ts}`,
    ...(requestRef !== undefined ? { requestRef } : {}),
    message: {
      id: msgId, model: "claude-opus-4-6", stop_reason: "end_turn", content: [],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 },
    },
  });
}

function apiRequestLine(id: string, ts: number = TS_MS): string {
  return JSON.stringify({
    type: "api-request", sessionId: SID, agentId: "agent-1", id,
    timestamp: new Date(ts).toISOString(), version: "2.1.301",
    querySource: "repl_main_thread", shapeHash: REAL_HASH,
    params: { model: "claude-opus-4-6" },
    cacheControl: { ephemeral: { type: "ttl", ttl: "5m" } },
  });
}

/** A plain api-request line whose head THROWS on parse: the first `,"params":`
 *  cut leaves the outer object unclosed because `params` follows a sibling key. */
function headThrowLine(id: string): string {
  return JSON.stringify({
    type: "api-request", sessionId: SID, agentId: "agent-1", id,
    timestamp: TS_ISO, version: "2.1.301", shapeHash: REAL_HASH,
    wrapper: { x: 1, params: 2 },
    params: { model: "claude-opus-4-6" },
  });
}

type Row = Record<string, unknown>;
function raw(dbPath: string, sql: string, ...params: unknown[]): Row[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as Row[];
  } finally {
    db.close();
  }
}
function rawOne(dbPath: string, sql: string, ...params: unknown[]): Row {
  return raw(dbPath, sql, ...params)[0]!;
}

describe("collect — E1 request records", () => {
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    projectsDir = tmpDir();
    dbPath = path.join(os.tmpdir(), `cs-agg-e1-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...original, projectsDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ }
    }
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("persists api_requests rows and messages.request_ref through collect(), not just through the store API", async () => {
    // Same rationale as the api_error_events wiring test: deleting the
    // `store.upsertApiRequests(...)` call in the aggregator must turn this red.
    const projDir = path.join(projectsDir, "-proj-e1");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, `${SID}.jsonl`);
    fs.writeFileSync(sessFile, [
      userLine(TS_MS - 1000),
      apiRequestLine("req_1"),
      assistantLine(TS_MS, "msg_1", "req_1"),
    ].join("\n") + "\n");

    const result = await collect(store);
    expect(result.filesProcessed).toBe(1);
    expect(result.apiRequestHeadMisses).toBe(0);
    expect(result.apiRequestsRead).toBe(1);

    const req = rawOne(dbPath, "SELECT * FROM api_requests");
    expect(req).toEqual({
      request_id: "req_1",
      session_id: SID, // the store's own session id, never a line-supplied one
      agent_id: "agent-1",
      timestamp: TS_MS,
      shape_hash: REAL_HASH,
    });
    const msg = rawOne(dbPath, "SELECT uuid, request_ref FROM messages");
    expect(msg).toEqual({ uuid: `a-${TS_MS}`, request_ref: "req_1" });
  });

  it("§8.4 — a request line and the assistant referencing it can land in different collects", async () => {
    // Real transcripts interleave: the `api-request` line is written when the
    // request is SENT, the assistant message (carrying requestRef) when it
    // returns. A crash or a truncated tail between the two must not lose the
    // join: phase 1 stores the request row with no message; phase 2 appends
    // the message and the join holds.
    const projDir = path.join(projectsDir, "-proj-e1-split");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, `${SID}.jsonl`);
    fs.writeFileSync(sessFile, [userLine(TS_MS - 1000), apiRequestLine("req_1")].join("\n") + "\n");

    const first = await collect(store);
    expect(first.filesProcessed).toBe(1);
    expect(first.messagesUpserted).toBe(0); // no assistant message yet
    expect(store.countApiRequests()).toBe(1);
    expect(raw(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL")[0]!["n"]).toBe(0);

    // Phase 2: the transcript grows — the assistant message arrives.
    fs.appendFileSync(sessFile, assistantLine(TS_MS, "msg_1", "req_1") + "\n");
    const second = await collect(store);
    expect(second.filesProcessed).toBe(1);
    expect(second.filesSkipped).toBe(0);
    expect(second.messagesUpserted).toBe(1);

    // The join holds: the message's request_ref resolves to the stored row.
    const joined = rawOne(
      dbPath,
      `SELECT m.uuid, m.request_ref, r.request_id, r.shape_hash
         FROM messages m JOIN api_requests r ON r.request_id = m.request_ref
        WHERE m.session_id = ?`,
      SID,
    );
    expect(joined).toEqual({ uuid: `a-${TS_MS}`, request_ref: "req_1", request_id: "req_1", shape_hash: REAL_HASH });
    // Still exactly one request row — the append re-parse did not duplicate it.
    expect(store.countApiRequests()).toBe(1);
  });

  it("§8.6b — a head-throw line neither aborts the collect nor quarantines the line", async () => {
    const projDir = path.join(projectsDir, "-proj-e1-miss");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, `${SID}.jsonl`);
    const good = apiRequestLine("req_good");
    fs.writeFileSync(sessFile, [
      userLine(TS_MS - 1000),
      headThrowLine("req_bad"), // head parse throws → miss, counted, never thrown
      good,
      assistantLine(TS_MS, "msg_1", "req_good"),
    ].join("\n") + "\n");

    // collect() must COMPLETE (a throw would abort the run and strand the
    // checkpoint before this line).
    const result = await collect(store);
    expect(result.filesProcessed).toBe(1);
    expect(result.parseErrors).toBe(0); // the miss is not a parse error
    expect(result.apiRequestHeadMisses).toBe(1);
    expect(result.apiRequestsRead).toBe(2); // rows read + misses

    // The checkpoint advanced PAST the bad line: the whole file was consumed.
    const checkpoint = store.getCheckpoint(sessFile);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.lastByteOffset).toBe(fs.statSync(sessFile).size);

    // The miss produced NO row and NO quarantine entry for that line.
    expect(store.countApiRequests()).toBe(1);
    expect(rawOne(dbPath, "SELECT request_id FROM api_requests")["request_id"]).toBe("req_good");
    expect(raw(dbPath, "SELECT COUNT(*) AS n FROM quarantine")[0]!["n"]).toBe(0);

    // The lines after the miss were still processed normally.
    expect(rawOne(dbPath, "SELECT request_ref FROM messages")["request_ref"]).toBe("req_good");
  });
});
