/**
 * Schema V28 (E1) — per-request records: the `api_requests` table, the
 * `messages.request_ref` column, `upsertApiRequests` (first-writer-wins on the
 * request id) and the COALESCE never-clear rule on `request_ref`.
 *
 * The migration test rewinds a populated V28 store to a true V27 shape (drop
 * the column and the table, stamp schema 27) and reopens: the migration must
 * add both back, leave every pre-existing row and sum untouched, leave
 * `message_hourly` alone, and be a no-op when run twice. Spec §8 tests 5, 10.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../store/index.js";
import type { SessionRecord, MessageRecord, ApiRequestFields } from "@claude-stats/core/types";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-store-v28-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(sessionId = "sess-v28"): SessionRecord {
  return {
    sessionId,
    projectPath: "/Users/alice/repos/myproject",
    sourceFile: `/Users/alice/.claude/projects/-Users-alice-repos-myproject/${sessionId}.jsonl`,
    firstTimestamp: 1_000_000,
    lastTimestamp: 1_005_000,
    claudeVersion: "2.1.301",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 2,
    assistantMessageCount: 2,
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheCreationTokens: 500,
    cacheReadTokens: 8_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [{ name: "Read", count: 2 }],
    models: ["claude-opus-4-6"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
  };
}

const baseMsg = {
  uuid: "m1", sessionId: "sess-v28", timestamp: 1_000_500, claudeVersion: "2.1.301",
  model: "claude-opus-4-6", stopReason: "end_turn",
  inputTokens: 100, outputTokens: 50, cacheCreationTokens: 20, cacheReadTokens: 80,
  tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
  ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null,
} as MessageRecord;

const REQ: ApiRequestFields = {
  requestId: "req_1",
  agentId: "agent-1",
  timestamp: 1_767_225_600_000,
  shapeHash: "a".repeat(64),
};

type Row = Record<string, unknown>;
function raw(dbPath: string, sql: string, ...params: unknown[]): Row[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as Row[];
  } finally {
    db.close();
  }
}
function rawOne(dbPath: string, sql: string): Row {
  return raw(dbPath, sql)[0]!;
}

describe("Store — V28 api_requests", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession());
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ }
    }
  });

  it("stores exactly the five §3 columns, nothing else (decision 7)", () => {
    expect(SCHEMA_VERSION).toBe(28);
    const cols = raw(dbPath, "PRAGMA table_info(api_requests)").map((c) => c["name"]);
    expect(cols).toEqual(["request_id", "session_id", "agent_id", "timestamp", "shape_hash"]);
    // No cc_version / query_source_* / requested_ttl — the shrunk stored list.
    const schemaSql = String(rawOne(dbPath, "SELECT sql FROM sqlite_master WHERE name = 'api_requests'")["sql"]);
    expect(schemaSql).not.toMatch(/cc_version|query_source|requested_ttl/i);
    // The partial index on messages.request_ref exists, NULL rows excluded.
    const idx = raw(dbPath, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql LIKE '%request_ref%'");
    expect(idx).toHaveLength(1);
    expect(String(idx[0]!["sql"])).toContain("WHERE request_ref IS NOT NULL");
  });

  it("upsertApiRequests stores every field", () => {
    store.upsertApiRequests("sess-v28", [REQ]);
    const row = rawOne(dbPath, "SELECT * FROM api_requests");
    expect(row).toEqual({
      request_id: "req_1",
      session_id: "sess-v28",
      agent_id: "agent-1",
      timestamp: 1_767_225_600_000,
      shape_hash: "a".repeat(64),
    });
    expect(store.countApiRequests()).toBe(1);
  });

  it("§8.5 replay: the same request id in a second session is one row, first writer wins", () => {
    store.upsertApiRequests("sess-v28", [REQ]);
    // A forked/resumed transcript replays the same line into a second file.
    // The rows are identical except session_id; the first writer's wins.
    store.upsertApiRequests("sess-other", [{ ...REQ }]);
    expect(store.countApiRequests()).toBe(1);
    const row = rawOne(dbPath, "SELECT * FROM api_requests");
    expect(row["session_id"]).toBe("sess-v28");
    // …and it is not an error, and does not update the timestamp either.
    store.upsertApiRequests("sess-other", [{ ...REQ, timestamp: 1 }]);
    expect(rawOne(dbPath, "SELECT * FROM api_requests")["timestamp"]).toBe(1_767_225_600_000);
  });

  it("upsertApiRequests with no rows is a no-op", () => {
    store.upsertApiRequests("sess-v28", []);
    expect(store.countApiRequests()).toBe(0);
  });

  it("distinct request ids accumulate under their own session ids", () => {
    store.upsertApiRequests("sess-v28", [REQ, { ...REQ, requestId: "req_2", agentId: null, timestamp: null, shapeHash: null }]);
    store.upsertApiRequests("sess-other", [{ ...REQ, requestId: "req_3" }]);
    expect(store.countApiRequests()).toBe(3);
    const rows = raw(dbPath, "SELECT request_id, session_id, agent_id, timestamp, shape_hash FROM api_requests ORDER BY request_id");
    expect(rows).toEqual([
      { request_id: "req_1", session_id: "sess-v28", agent_id: "agent-1", timestamp: 1_767_225_600_000, shape_hash: "a".repeat(64) },
      { request_id: "req_2", session_id: "sess-v28", agent_id: null, timestamp: null, shape_hash: null },
      { request_id: "req_3", session_id: "sess-other", agent_id: "agent-1", timestamp: 1_767_225_600_000, shape_hash: "a".repeat(64) },
    ]);
  });
});

describe("Store — messages.request_ref (V28)", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession());
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ }
    }
  });

  it("stores request_ref from the record and reads it back", () => {
    store.upsertMessages([{ ...baseMsg, requestRef: "req_1" }]);
    const rows = store.getSessionMessages("sess-v28");
    expect(rows[0]!.request_ref).toBe("req_1");
  });

  it("COALESCE never-clear: a writer that does not know the column keeps the value", () => {
    store.upsertMessages([{ ...baseMsg, requestRef: "req_1" }]);
    // A re-parse/older build supplies NULL — the stored value survives.
    store.upsertMessages([{ ...baseMsg, requestRef: null }]);
    expect(store.getSessionMessages("sess-v28")[0]!.request_ref).toBe("req_1");
    // Absent (undefined) behaves the same.
    const { requestRef: _omitted, ...withoutRef } = { ...baseMsg, requestRef: "req_x" } as MessageRecord;
    store.upsertMessages([{ ...withoutRef }]);
    expect(store.getSessionMessages("sess-v28")[0]!.request_ref).toBe("req_1");
  });

  it("a newer valid value replaces an older one", () => {
    store.upsertMessages([{ ...baseMsg, requestRef: "req_1" }]);
    store.upsertMessages([{ ...baseMsg, requestRef: "req_2" }]);
    expect(store.getSessionMessages("sess-v28")[0]!.request_ref).toBe("req_2");
  });

  it("absent on insert reads back as NULL", () => {
    store.upsertMessages([{ ...baseMsg }]);
    expect(store.getSessionMessages("sess-v28")[0]!.request_ref).toBeNull();
  });
});

describe("Store — migration V27 → V28 (E1 §8.10)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ }
    }
  });

  /** A populated store at the CURRENT schema, with a rollup and request data. */
  function seed(): { messagesBefore: Row[]; rollupBefore: Row; requestsBefore: number } {
    const store = new Store(dbPath);
    store.upsertSession(makeSession());
    store.upsertMessages([{ ...baseMsg, uuid: "m1", requestRef: "req_1" }, { ...baseMsg, uuid: "m2", inputTokens: 7 }]);
    store.upsertApiRequests("sess-v28", [REQ]);
    store.recomputeMessageHourly();
    const messagesBefore = raw(dbPath, "SELECT * FROM messages ORDER BY uuid");
    const rollupBefore = rawOne(dbPath, "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM message_hourly");
    const requestsBefore = store.countApiRequests();
    store.close();
    return { messagesBefore, rollupBefore, requestsBefore };
  }

  /** Rewind the populated store to a true V27 shape: no request_ref, no api_requests. */
  function rewindToV27(): void {
    const db = new DatabaseSync(dbPath);
    // The partial index references the column — drop it first, as a true V27
    // store would never have had it.
    db.exec(`
      DROP INDEX IF EXISTS idx_messages_request_ref;
      ALTER TABLE messages DROP COLUMN request_ref;
      DROP TABLE api_requests;
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '27');
    `);
    db.close();
  }

  it("adds the column, the table and the index; leaves every row, sum and the rollup untouched", () => {
    const { messagesBefore, rollupBefore, requestsBefore } = seed();
    expect(requestsBefore).toBe(1);
    rewindToV27();

    // Premise: the rewound store really is V27-shaped.
    expect(rawOne(dbPath, "SELECT value FROM metadata WHERE key = 'schema_version'")["value"]).toBe("27");
    expect(raw(dbPath, "PRAGMA table_info(messages)").map((c) => c["name"])).not.toContain("request_ref");
    expect(raw(dbPath, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'api_requests'")[0]!["n"]).toBe(0);
    expect(raw(dbPath, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_messages_request_ref'")[0]!["n"]).toBe(0);

    const store = new Store(dbPath);
    try {
      // Version stamped forward.
      expect(rawOne(dbPath, "SELECT value FROM metadata WHERE key = 'schema_version'")["value"]).toBe("28");
      // The messages table: same rows, same sums, request_ref NULL on every old row.
      const messagesAfter = raw(dbPath, "SELECT * FROM messages ORDER BY uuid");
      expect(messagesAfter).toHaveLength(messagesBefore.length);
      expect(messagesAfter.map((r) => ({ ...r, request_ref: undefined }))).toEqual(
        messagesBefore.map((r) => ({ ...r, request_ref: undefined })),
      );
      expect(messagesAfter.every((r) => r["request_ref"] === null)).toBe(true);
      const sums = (rows: Row[]) => ({
        i: rows.reduce((n, r) => n + (r["input_tokens"] as number), 0),
        o: rows.reduce((n, r) => n + (r["output_tokens"] as number), 0),
        cr: rows.reduce((n, r) => n + (r["cache_read_tokens"] as number), 0),
        cc: rows.reduce((n, r) => n + (r["cache_creation_tokens"] as number), 0),
      });
      expect(sums(messagesAfter)).toEqual(sums(messagesBefore));
      // message_hourly untouched.
      expect(rawOne(dbPath, "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM message_hourly"))
        .toEqual(rollupBefore);
      // The table and the partial index exist with the §3 shape.
      expect(raw(dbPath, "PRAGMA table_info(api_requests)").map((c) => c["name"]))
        .toEqual(["request_id", "session_id", "agent_id", "timestamp", "shape_hash"]);
      expect(raw(dbPath, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_request_ref'")[0]!["n"]).toBe(1);
      // The dropped request data does NOT come back (no backfill in the migration).
      expect(store.countApiRequests()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("is idempotent: a second V27→V28 pass changes nothing", () => {
    seed();
    rewindToV27();
    const first = new Store(dbPath);
    first.close();
    const afterFirst = raw(dbPath, "SELECT * FROM messages ORDER BY uuid");
    const rollupAfterFirst = raw(dbPath, "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i FROM message_hourly");

    // Rewind again and migrate again — the second pass must be a no-op.
    rewindToV27();
    const second = new Store(dbPath);
    try {
      expect(raw(dbPath, "SELECT * FROM messages ORDER BY uuid")).toEqual(afterFirst);
      expect(raw(dbPath, "SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i FROM message_hourly")).toEqual(rollupAfterFirst);
      // …and re-opening an already-V28 store is a no-op too.
      const third = new Store(dbPath);
      third.close();
      expect(raw(dbPath, "SELECT * FROM messages ORDER BY uuid")).toEqual(afterFirst);
    } finally {
      second.close();
    }
  });

  it("a fresh store is created directly at V28 with the full shape", () => {
    const store = new Store(dbPath);
    try {
      expect(rawOne(dbPath, "SELECT value FROM metadata WHERE key = 'schema_version'")["value"]).toBe("28");
      expect(raw(dbPath, "PRAGMA table_info(api_requests)").map((c) => c["name"]))
        .toEqual(["request_id", "session_id", "agent_id", "timestamp", "shape_hash"]);
      expect(raw(dbPath, "PRAGMA table_info(messages)").map((c) => c["name"])).toContain("request_ref");
    } finally {
      store.close();
    }
  });
});
