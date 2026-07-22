import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store, validateTag } from "../store/index.js";
import type { SessionRecord, MessageRecord, FileCheckpoint, ParseError } from "@claude-stats/core/types";
import os from "os";
import path from "path";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-abc",
    projectPath: "/Users/alice/repos/myproject",
    sourceFile: "/Users/alice/.claude/projects/-Users-alice-repos-myproject/sess-abc.jsonl",
    firstTimestamp: 1_000_000,
    lastTimestamp: 1_005_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-vscode",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 5,
    assistantMessageCount: 5,
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheCreationTokens: 500,
    cacheReadTokens: 8_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [{ name: "Read", count: 10 }, { name: "Edit", count: 3 }],
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
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<FileCheckpoint> = {}): FileCheckpoint {
  return {
    filePath: "/some/file.jsonl",
    fileSize: 1024,
    lastByteOffset: 900,
    lastMtime: 1_700_000_000_000,
    firstKbHash: "abc123",
    sourceDeleted: false,
    ...overrides,
  };
}

describe("Store — migrations", () => {
  it("creates all required tables on first open", () => {
    const dbPath = tmpDb();
    const store = new Store(dbPath);
    // If tables are missing, the session upsert below would throw
    expect(() => store.upsertSession(makeSession())).not.toThrow();
    store.close();
    fs.unlinkSync(dbPath);
  });

  it("sets busy_timeout for concurrent access safety", () => {
    const dbPath = tmpDb();
    const store = new Store(dbPath);
    // Open a second connection to the same DB — should not throw SQLITE_BUSY
    const store2 = new Store(dbPath);
    // Both should be able to upsert without error (busy_timeout lets them wait)
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store2.upsertSession(makeSession({ sessionId: "s2" }));
    store2.close();
    store.close();
    fs.unlinkSync(dbPath);
  });

  it("is idempotent — opening same DB twice does not error", () => {
    const dbPath = tmpDb();
    const s1 = new Store(dbPath);
    s1.close();
    const s2 = new Store(dbPath);
    s2.close();
    fs.unlinkSync(dbPath);
  });
});

describe("Store — session upsert", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("inserts a new session", () => {
    store.upsertSession(makeSession());
    const rows = store.getSessions({ includeDeleted: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("sess-abc");
  });

  it("updates an existing session on conflict", () => {
    store.upsertSession(makeSession({ promptCount: 5 }));
    store.upsertSession(makeSession({ promptCount: 10 }));
    const rows = store.getSessions({ includeDeleted: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt_count).toBe(10);
  });

  it("stores tool_use_counts as JSON", () => {
    store.upsertSession(makeSession());
    const rows = store.getSessions({ includeDeleted: true });
    const counts = JSON.parse(rows[0]!.tool_use_counts) as unknown[];
    expect(counts).toHaveLength(2);
  });

  it("stores models as JSON array", () => {
    store.upsertSession(makeSession({ models: ["claude-opus-4-6", "claude-sonnet-4-6"] }));
    const rows = store.getSessions({ includeDeleted: true });
    const models = JSON.parse(rows[0]!.models) as string[];
    expect(models).toContain("claude-opus-4-6");
    expect(models).toContain("claude-sonnet-4-6");
  });
});

describe("Store — getSessions filters", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({ sessionId: "s1", projectPath: "/proj/a", firstTimestamp: 1_000, isInteractive: true }));
    store.upsertSession(makeSession({ sessionId: "s2", projectPath: "/proj/b", firstTimestamp: 2_000, isInteractive: true }));
    store.upsertSession(makeSession({ sessionId: "s3", projectPath: "/proj/a", firstTimestamp: 3_000, isInteractive: false }));
    store.upsertSession(makeSession({ sessionId: "s4", projectPath: "/proj/a", firstTimestamp: 4_000, isInteractive: true, sourceDeleted: true }));
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns all interactive non-deleted sessions by default", () => {
    const rows = store.getSessions();
    expect(rows.map(r => r.session_id)).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(rows.map(r => r.session_id)).not.toContain("s3"); // non-interactive
    expect(rows.map(r => r.session_id)).not.toContain("s4"); // deleted
  });

  it("filters by projectPath", () => {
    const rows = store.getSessions({ projectPath: "/proj/a" });
    expect(rows.every(r => r.project_path === "/proj/a")).toBe(true);
  });

  it("filters by since timestamp", () => {
    const rows = store.getSessions({ since: 2_000, includeCI: true });
    expect(rows.map(r => r.session_id)).not.toContain("s1");
    expect(rows.map(r => r.session_id)).toContain("s2");
  });

  it("includes CI sessions when includeCI is true", () => {
    const rows = store.getSessions({ includeCI: true });
    expect(rows.map(r => r.session_id)).toContain("s3");
  });

  it("includes deleted sessions when includeDeleted is true", () => {
    const rows = store.getSessions({ includeDeleted: true, includeCI: true });
    expect(rows.map(r => r.session_id)).toContain("s4");
  });

  it("filters by entrypoint", () => {
    // s1-s4 all have entrypoint "claude-vscode" from makeSession default
    // Add a session with entrypoint "claude"
    store.upsertSession(makeSession({ sessionId: "s5", entrypoint: "claude", firstTimestamp: 5_000, isInteractive: true }));
    const rows = store.getSessions({ entrypoint: "claude" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("s5");
    expect(rows[0]!.entrypoint).toBe("claude");
  });

  it("includes subagent sessions by default but excludes them when includeSubagents is false", () => {
    store.upsertSession(makeSession({
      sessionId: "sub1", projectPath: "/proj/a", firstTimestamp: 6_000,
      isInteractive: true, isSubagent: true, parentSessionId: "s1",
    }));
    // Default: subagents included
    expect(store.getSessions().map(r => r.session_id)).toContain("sub1");
    // includeSubagents:false excludes them, keeps normal sessions
    const filtered = store.getSessions({ includeSubagents: false }).map(r => r.session_id);
    expect(filtered).not.toContain("sub1");
    expect(filtered).toEqual(expect.arrayContaining(["s1", "s2"]));
  });
});

describe("Store — getMessageCostInputsByUuids", () => {
  let store: Store;
  let dbPath: string;

  const msg = (uuid: string, model: string | null, input: number, output: number) => ({
    uuid, sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70",
    model, stopReason: "end_turn", inputTokens: input, outputTokens: output,
    cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [],
    thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null,
  });

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertMessages([msg("a", "claude-sonnet-4-6", 100, 50), msg("b", "claude-opus-4-6", 200, 80), msg("c", null, 10, 10)]);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns an empty array for empty input (no SQL run)", () => {
    expect(store.getMessageCostInputsByUuids([])).toEqual([]);
  });

  it("returns only the requested uuids with token columns", () => {
    const rows = store.getMessageCostInputsByUuids(["a", "c"]);
    expect(rows.map(r => r.uuid).sort()).toEqual(["a", "c"]);
    const a = rows.find(r => r.uuid === "a")!;
    expect(a.model).toBe("claude-sonnet-4-6");
    expect(a.input_tokens).toBe(100);
    expect(a.output_tokens).toBe(50);
    expect(rows.find(r => r.uuid === "c")!.model).toBeNull();
  });

  it("ignores unknown uuids and batches large inputs (>500)", () => {
    // 600 ids, only 'a' and 'b' exist → batching over two IN(...) chunks
    const ids = Array.from({ length: 600 }, (_, i) => `x${i}`);
    ids.push("a", "b");
    const rows = store.getMessageCostInputsByUuids(ids);
    expect(rows.map(r => r.uuid).sort()).toEqual(["a", "b"]);
  });
});

describe("Store — checkpoint", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns null for unknown file", () => {
    expect(store.getCheckpoint("/does/not/exist.jsonl")).toBeNull();
  });

  it("stores and retrieves a checkpoint", () => {
    const cp = makeCheckpoint();
    store.upsertCheckpoint(cp);
    const retrieved = store.getCheckpoint(cp.filePath);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.fileSize).toBe(1024);
    expect(retrieved!.firstKbHash).toBe("abc123");
    expect(retrieved!.lastByteOffset).toBe(900);
  });

  it("updates an existing checkpoint", () => {
    store.upsertCheckpoint(makeCheckpoint({ lastByteOffset: 100 }));
    store.upsertCheckpoint(makeCheckpoint({ lastByteOffset: 500 }));
    const retrieved = store.getCheckpoint("/some/file.jsonl");
    expect(retrieved!.lastByteOffset).toBe(500);
  });

  it("markSourceDeleted sets source_deleted on checkpoint and session", () => {
    const session = makeSession({
      sourceFile: "/some/file.jsonl",
    });
    store.upsertSession(session);
    store.upsertCheckpoint(makeCheckpoint({ filePath: "/some/file.jsonl" }));
    store.markSourceDeleted("/some/file.jsonl");

    const cp = store.getCheckpoint("/some/file.jsonl");
    expect(cp!.sourceDeleted).toBe(true);

    const rows = store.getSessions({ includeDeleted: true, includeCI: true });
    expect(rows[0]!.source_deleted).toBe(1);
  });
});

describe("Store — messages", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  const baseMsg = { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null };

  it("inserts message records", () => {
    store.upsertMessages([baseMsg]);
    const status = store.getStatus();
    expect(status.messageCount).toBe(1);
  });

  it("upserts on uuid conflict", () => {
    store.upsertMessages([baseMsg]);
    store.upsertMessages([{ ...baseMsg, inputTokens: 200 }]);
    const status = store.getStatus();
    expect(status.messageCount).toBe(1); // not doubled
  });

  it("roundtrips filePaths: insert with paths → readback returns same array", () => {
    store.upsertSession(makeSession({ sessionId: "s-fp" }));
    store.upsertMessages([{ ...baseMsg, uuid: "m-fp", sessionId: "s-fp", filePaths: ["a", "b"] }]);
    const rows = store.getSessionMessages("s-fp");
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!.file_paths) as string[];
    expect(parsed).toEqual(["a", "b"]);
  });

  it("defaults file_paths to '[]' when filePaths is empty array", () => {
    store.upsertSession(makeSession({ sessionId: "s-empty-fp" }));
    store.upsertMessages([{ ...baseMsg, uuid: "m-empty-fp", sessionId: "s-empty-fp", filePaths: [] }]);
    const rows = store.getSessionMessages("s-empty-fp");
    expect(rows[0]!.file_paths).toBe("[]");
  });

  it("migration v10: addColumn file_paths is idempotent on existing DB", () => {
    // Opening a fresh store runs all migrations including v10; opening again must not error
    const dbPath2 = tmpDb();
    const s1 = new Store(dbPath2);
    s1.close();
    // Re-open — v10 migration guard (addColumn with IF NOT EXISTS) must be a no-op
    expect(() => { const s2 = new Store(dbPath2); s2.close(); }).not.toThrow();
    try { fs.unlinkSync(dbPath2); } catch { /* ok */ }
  });
});

describe("Store — quarantine", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("stores parse errors", () => {
    const errors: ParseError[] = [
      { filePath: "/f.jsonl", lineNumber: 5, rawLine: "{bad", error: "SyntaxError", timestamp: Date.now() },
    ];
    store.addToQuarantine(errors);
    expect(store.getStatus().quarantineCount).toBe(1);
  });

  it("handles claudeVersion being undefined", () => {
    const errors: ParseError[] = [
      { filePath: "/f.jsonl", lineNumber: 1, rawLine: "{", error: "err", timestamp: Date.now(), claudeVersion: undefined },
    ];
    expect(() => store.addToQuarantine(errors)).not.toThrow();
  });
});

describe("Store — transaction", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("commits successful transactions", () => {
    store.transaction(() => {
      store.upsertSession(makeSession());
    });
    expect(store.getSessions({ includeDeleted: true })).toHaveLength(1);
  });

  it("rolls back on error", () => {
    try {
      store.transaction(() => {
        store.upsertSession(makeSession());
        throw new Error("deliberate failure");
      });
    } catch { /* expected */ }
    expect(store.getSessions({ includeDeleted: true })).toHaveLength(0);
  });
});

describe("Store — getStatus", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns zero counts on empty db", () => {
    const status = store.getStatus();
    expect(status.sessionCount).toBe(0);
    expect(status.messageCount).toBe(0);
    expect(status.quarantineCount).toBe(0);
    expect(status.lastCollected).toBeNull();
  });

  it("reflects inserted data", () => {
    store.upsertSession(makeSession());
    store.upsertCheckpoint(makeCheckpoint());
    const status = store.getStatus();
    expect(status.sessionCount).toBe(1);
    expect(status.lastCollected).toBeGreaterThan(0);
  });

  it("excludes source_deleted sessions from sessionCount, like sibling queries", () => {
    store.upsertSession(makeSession({ sessionId: "sess-live" }));
    store.upsertSession(makeSession({ sessionId: "sess-gone", sourceDeleted: true }));
    const status = store.getStatus();
    expect(status.sessionCount).toBe(1);
  });
});

describe("Store — getStopReasonCounts", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns correct counts for different stop_reason values", () => {
    store.upsertMessages([
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m3", sessionId: "s1", timestamp: 1002, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m4", sessionId: "s1", timestamp: 1003, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "max_tokens", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const counts = store.getStopReasonCounts(["s1"]);
    expect(counts.get("end_turn")).toBe(2);
    expect(counts.get("tool_use")).toBe(1);
    expect(counts.get("max_tokens")).toBe(1);
  });

  it("excludes null stop_reason messages", () => {
    store.upsertMessages([
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: null, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const counts = store.getStopReasonCounts(["s1"]);
    expect(counts.size).toBe(1);
    expect(counts.get("end_turn")).toBe(1);
    expect(counts.has("null")).toBe(false);
  });

  it("returns empty Map for empty session list", () => {
    const counts = store.getStopReasonCounts([]);
    expect(counts.size).toBe(0);
  });
});

describe("Store — findSession", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({ sessionId: "abcdef-1234-5678", isInteractive: true }));
    store.upsertSession(makeSession({ sessionId: "xyz789-aaaa-bbbb", isInteractive: true }));
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns row for exact match", () => {
    const row = store.findSession("abcdef-1234-5678");
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("abcdef-1234-5678");
  });

  it("returns row for prefix match (first 6 chars)", () => {
    const row = store.findSession("abcdef");
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("abcdef-1234-5678");
  });

  it("throws on ambiguous prefix", () => {
    // Both sessions start with different prefixes, so add a conflicting one
    store.upsertSession(makeSession({ sessionId: "abcdef-9999-0000", isInteractive: true }));
    expect(() => store.findSession("abcdef")).toThrow("Ambiguous session ID prefix");
  });

  it("returns null for no match", () => {
    const row = store.findSession("zzz-no-match");
    expect(row).toBeNull();
  });
});

describe("Store — getSessionMessages", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns messages ordered by timestamp ASC", () => {
    store.upsertMessages([
      { uuid: "m3", sessionId: "s1", timestamp: 3000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: ["Read"], filePaths: [], thinkingBlocks: 1, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 2000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, tools: ["Edit", "Read"], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const messages = store.getSessionMessages("s1");
    expect(messages).toHaveLength(3);
    expect(messages[0]!.uuid).toBe("m1");
    expect(messages[1]!.uuid).toBe("m2");
    expect(messages[2]!.uuid).toBe("m3");
    expect(messages[2]!.thinking_blocks).toBe(1);
    const tools = JSON.parse(messages[2]!.tools) as string[];
    expect(tools).toEqual(["Read"]);
  });

  it("returns empty array for unknown session", () => {
    const messages = store.getSessionMessages("nonexistent");
    expect(messages).toHaveLength(0);
  });
});

describe("Store — tags", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({ sessionId: "s1", isInteractive: true }));
    store.upsertSession(makeSession({ sessionId: "s2", isInteractive: true }));
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("addTag + getTagsForSession round-trip", () => {
    store.addTag("s1", "auth-refactor");
    store.addTag("s1", "sprint-12");
    const tags = store.getTagsForSession("s1");
    expect(tags).toEqual(["auth-refactor", "sprint-12"]);
  });

  it("removeTag removes only the specified tag", () => {
    store.addTag("s1", "alpha");
    store.addTag("s1", "beta");
    store.removeTag("s1", "alpha");
    const tags = store.getTagsForSession("s1");
    expect(tags).toEqual(["beta"]);
  });

  it("getTagCounts returns correct counts", () => {
    store.addTag("s1", "feature");
    store.addTag("s2", "feature");
    store.addTag("s1", "bugfix");
    const counts = store.getTagCounts();
    expect(counts).toEqual([
      { tag: "feature", count: 2 },
      { tag: "bugfix", count: 1 },
    ]);
  });

  it("getSessions({ tag }) filters correctly", () => {
    store.addTag("s1", "tagged");
    const rows = store.getSessions({ tag: "tagged" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("s1");
  });

  it("adding duplicate tag is idempotent (no error)", () => {
    store.addTag("s1", "dup");
    expect(() => store.addTag("s1", "dup")).not.toThrow();
    const tags = store.getTagsForSession("s1");
    expect(tags).toEqual(["dup"]);
  });

  it("normalizes tags to lowercase", () => {
    store.addTag("s1", "MyTag");
    const tags = store.getTagsForSession("s1");
    expect(tags).toEqual(["mytag"]);
  });

  it("getSessionIdsByTag returns correct session IDs", () => {
    store.addTag("s1", "shared");
    store.addTag("s2", "shared");
    const ids = store.getSessionIdsByTag("shared");
    expect(ids.sort()).toEqual(["s1", "s2"]);
  });
});

describe("Store — usage windows", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("upsertUsageWindow stores and getUsageWindows retrieves", () => {
    store.upsertUsageWindow({
      windowStart: 1_000_000,
      windowEnd: 1_018_000,
      accountUuid: null,
      totalCostEquivalent: 2.5,
      promptCount: 10,
      tokensByModel: { "claude-opus-4": 5000 },
      throttled: false,
    });
    const windows = store.getUsageWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.promptCount).toBe(10);
    expect(windows[0]!.totalCostEquivalent).toBe(2.5);
    expect(windows[0]!.tokensByModel).toEqual({ "claude-opus-4": 5000 });
  });

  it("upsertUsageWindow is idempotent on windowStart conflict", () => {
    const w = { windowStart: 1_000_000, windowEnd: 1_018_000, accountUuid: null, totalCostEquivalent: 1.0, promptCount: 5, tokensByModel: {}, throttled: false };
    store.upsertUsageWindow(w);
    store.upsertUsageWindow({ ...w, totalCostEquivalent: 3.0, promptCount: 15 });
    const windows = store.getUsageWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.promptCount).toBe(15); // updated
  });

  it("getUsageWindows filters by since", () => {
    store.upsertUsageWindow({ windowStart: 1_000, windowEnd: 19_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 1, tokensByModel: {}, throttled: false });
    store.upsertUsageWindow({ windowStart: 5_000, windowEnd: 23_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 2, tokensByModel: {}, throttled: false });
    const filtered = store.getUsageWindows({ since: 3_000 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.windowStart).toBe(5_000);
  });

  it("getCurrentWindow returns most recent window", () => {
    store.upsertUsageWindow({ windowStart: 1_000, windowEnd: 19_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 1, tokensByModel: {}, throttled: false });
    store.upsertUsageWindow({ windowStart: 9_000, windowEnd: 27_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 2, tokensByModel: {}, throttled: false });
    const current = store.getCurrentWindow();
    expect(current).not.toBeNull();
    expect(current!.windowStart).toBe(9_000);
  });

  it("getCurrentWindow returns null when no windows", () => {
    expect(store.getCurrentWindow()).toBeNull();
  });

  it("throttled flag is preserved as MAX (never goes false after true)", () => {
    store.upsertUsageWindow({ windowStart: 1_000, windowEnd: 19_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 1, tokensByModel: {}, throttled: true });
    store.upsertUsageWindow({ windowStart: 1_000, windowEnd: 19_000, accountUuid: null, totalCostEquivalent: 0, promptCount: 1, tokensByModel: {}, throttled: false });
    const windows = store.getUsageWindows();
    expect(windows[0]!.throttled).toBe(true);
  });
});

describe("Store — getMessageTotalsBySession", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns per-session per-model totals", () => {
    store.upsertMessages([
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "v1", model: "claude-opus-4", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 2000, claudeVersion: "v1", model: "claude-opus-4", stopReason: "end_turn", inputTokens: 200, outputTokens: 80, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m3", sessionId: "s2", timestamp: 3000, claudeVersion: "v1", model: "claude-sonnet-4", stopReason: "end_turn", inputTokens: 50, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const totals = store.getMessageTotalsBySession(["s1", "s2"]);
    const s1Opus = totals.find(t => t.session_id === "s1" && t.model === "claude-opus-4");
    expect(s1Opus).toBeDefined();
    expect(s1Opus!.input_tokens).toBe(300);
    expect(s1Opus!.output_tokens).toBe(130);
    const s2Sonnet = totals.find(t => t.session_id === "s2" && t.model === "claude-sonnet-4");
    expect(s2Sonnet).toBeDefined();
    expect(s2Sonnet!.input_tokens).toBe(50);
  });

  it("returns empty array for empty session list", () => {
    const totals = store.getMessageTotalsBySession([]);
    expect(totals).toHaveLength(0);
  });
});

describe("validateTag", () => {
  it("accepts valid tags", () => {
    expect(validateTag("auth-refactor")).toBe("auth-refactor");
    expect(validateTag("sprint_12")).toBe("sprint_12");
    expect(validateTag("a")).toBe("a");
    expect(validateTag("ABC")).toBe("abc");
  });

  it("rejects empty string", () => {
    expect(() => validateTag("")).toThrow("Invalid tag");
  });

  it("rejects tags starting with dash", () => {
    expect(() => validateTag("-bad")).toThrow("Invalid tag");
  });

  it("rejects tags starting with underscore", () => {
    expect(() => validateTag("_bad")).toThrow("Invalid tag");
  });

  it("rejects tags with spaces", () => {
    expect(() => validateTag("has space")).toThrow("Invalid tag");
  });

  it("rejects tags over 50 characters", () => {
    const longTag = "a" + "b".repeat(50);
    expect(() => validateTag(longTag)).toThrow("Invalid tag");
  });

  it("accepts tag of exactly 50 characters", () => {
    const tag50 = "a" + "b".repeat(49);
    expect(validateTag(tag50)).toBe(tag50);
  });
});

describe("Store — subagent linking", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("stores and retrieves parentSessionId and isSubagent", () => {
    store.upsertSession(makeSession({ sessionId: "parent-1" }));
    store.upsertSession(makeSession({
      sessionId: "child-1",
      parentSessionId: "parent-1",
      isSubagent: true,
    }));

    const rows = store.getSessions({ includeCI: true, includeDeleted: true });
    const parent = rows.find(r => r.session_id === "parent-1")!;
    const child = rows.find(r => r.session_id === "child-1")!;

    expect(parent.parent_session_id).toBeNull();
    expect(parent.is_subagent).toBe(0);
    expect(child.parent_session_id).toBe("parent-1");
    expect(child.is_subagent).toBe(1);
  });

  it("upsertSession preserves parentSessionId via COALESCE", () => {
    store.upsertSession(makeSession({
      sessionId: "child-1",
      parentSessionId: "parent-1",
      isSubagent: true,
    }));
    // Re-upsert without parentSessionId (simulates reparse without the field)
    store.upsertSession(makeSession({
      sessionId: "child-1",
      parentSessionId: null,
      isSubagent: false,
    }));

    const rows = store.getSessions({ includeCI: true, includeDeleted: true });
    const child = rows.find(r => r.session_id === "child-1")!;
    expect(child.parent_session_id).toBe("parent-1"); // preserved
    expect(child.is_subagent).toBe(1); // MAX keeps it true
  });

  it("upsertSessionIncremental preserves parentSessionId via COALESCE", () => {
    store.upsertSession(makeSession({
      sessionId: "child-inc",
      parentSessionId: "parent-inc",
      isSubagent: true,
    }));
    store.upsertSessionIncremental(makeSession({
      sessionId: "child-inc",
      parentSessionId: null,
      isSubagent: false,
      promptCount: 2,
    }));

    const rows = store.getSessions({ includeCI: true, includeDeleted: true });
    const child = rows.find(r => r.session_id === "child-inc")!;
    expect(child.parent_session_id).toBe("parent-inc");
    expect(child.is_subagent).toBe(1);
  });

  it("resolveParentSessionId finds session by message uuid", () => {
    store.upsertSession(makeSession({ sessionId: "parent-resolve" }));
    store.upsertMessages([{
      uuid: "msg-parent-uuid",
      sessionId: "parent-resolve",
      timestamp: 1000,
      claudeVersion: "2.1.70",
      model: "claude-opus-4-6",
      stopReason: "end_turn",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tools: [],
      thinkingBlocks: 0,
      serviceTier: null,
      inferenceGeo: null,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
      promptText: null,
    }]);

    const result = store.resolveParentSessionId("msg-parent-uuid");
    expect(result).toBe("parent-resolve");
  });

  it("resolveParentSessionId returns null for unknown uuid", () => {
    expect(store.resolveParentSessionId("nonexistent-uuid")).toBeNull();
  });

  it("getChildSessions returns children ordered by timestamp", () => {
    store.upsertSession(makeSession({ sessionId: "parent-children", firstTimestamp: 1000 }));
    store.upsertSession(makeSession({
      sessionId: "child-b",
      parentSessionId: "parent-children",
      isSubagent: true,
      firstTimestamp: 3000,
    }));
    store.upsertSession(makeSession({
      sessionId: "child-a",
      parentSessionId: "parent-children",
      isSubagent: true,
      firstTimestamp: 2000,
    }));

    const children = store.getChildSessions("parent-children");
    expect(children).toHaveLength(2);
    expect(children[0]!.session_id).toBe("child-a"); // earlier timestamp first
    expect(children[1]!.session_id).toBe("child-b");
  });

  it("getChildSessions returns empty array when no children", () => {
    store.upsertSession(makeSession({ sessionId: "lonely-parent" }));
    const children = store.getChildSessions("lonely-parent");
    expect(children).toHaveLength(0);
  });

  it("V9 migration is idempotent", () => {
    // Opening the same DB twice should not error (migration runs twice)
    const s1 = new Store(dbPath);
    s1.close();
    const s2 = new Store(dbPath);
    s2.upsertSession(makeSession({ sessionId: "after-v9", isSubagent: true }));
    const rows = s2.getSessions({ includeCI: true, includeDeleted: true });
    expect(rows.find(r => r.session_id === "after-v9")!.is_subagent).toBe(1);
    s2.close();
  });
});

describe("Store — getSpendingReport", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns empty report on empty DB", () => {
    const report = store.getSpendingReport();
    expect(report.topSessions).toEqual([]);
    expect(report.topMessages).toEqual([]);
    expect(report.byModel).toEqual([]);
    expect(report.byProject).toEqual([]);
    expect(report.cacheEfficiency).toEqual([]);
    expect(report.subagentCosts).toEqual([]);
  });

  it("returns sessions ordered by token cost descending", () => {
    store.upsertSession(makeSession({ sessionId: "cheap", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0 }));
    store.upsertSession(makeSession({ sessionId: "expensive", inputTokens: 100_000, outputTokens: 50_000, cacheCreationTokens: 5_000 }));
    store.upsertMessages([
      { uuid: "m-cheap", sessionId: "cheap", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-sonnet-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m-expensive", sessionId: "expensive", timestamp: 2000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100_000, outputTokens: 50_000, cacheCreationTokens: 5_000, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);

    const report = store.getSpendingReport();
    expect(report.topSessions.length).toBe(2);
    expect(report.topSessions[0]!.session_id).toBe("expensive");
    expect(report.topMessages[0]!.uuid).toBe("m-expensive");
  });

  it("respects since filter", () => {
    store.upsertSession(makeSession({ sessionId: "old", firstTimestamp: 1000 }));
    store.upsertSession(makeSession({ sessionId: "new", firstTimestamp: 5000 }));

    const report = store.getSpendingReport({ since: 3000 });
    expect(report.topSessions.length).toBe(1);
    expect(report.topSessions[0]!.session_id).toBe("new");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.upsertSession(makeSession({ sessionId: `s-${i}`, inputTokens: i * 1000 }));
    }
    const report = store.getSpendingReport({ limit: 3 });
    expect(report.topSessions.length).toBe(3);
  });

  it("computes by-project aggregation", () => {
    store.upsertSession(makeSession({ sessionId: "s1", projectPath: "/project-a", inputTokens: 10_000, outputTokens: 5_000 }));
    store.upsertSession(makeSession({ sessionId: "s2", projectPath: "/project-a", inputTokens: 20_000, outputTokens: 10_000 }));
    store.upsertSession(makeSession({ sessionId: "s3", projectPath: "/project-b", inputTokens: 5_000, outputTokens: 2_000 }));

    const report = store.getSpendingReport();
    expect(report.byProject.length).toBe(2);
    expect(report.byProject[0]!.project_path).toBe("/project-a"); // higher total
    expect(report.byProject[0]!.session_count).toBe(2);
    expect(report.byProject[0]!.input_tokens).toBe(30_000);
  });

  it("includes subagent cost attribution", () => {
    store.upsertSession(makeSession({ sessionId: "parent-1", inputTokens: 50_000, outputTokens: 20_000, cacheCreationTokens: 1000, firstTimestamp: 1000 }));
    store.upsertSession(makeSession({ sessionId: "child-1", parentSessionId: "parent-1", isSubagent: true, inputTokens: 10_000, outputTokens: 5_000, cacheCreationTokens: 500, firstTimestamp: 2000 }));
    store.upsertSession(makeSession({ sessionId: "child-2", parentSessionId: "parent-1", isSubagent: true, inputTokens: 8_000, outputTokens: 3_000, cacheCreationTokens: 200, firstTimestamp: 3000 }));

    const report = store.getSpendingReport({ since: 0 });
    expect(report.subagentCosts.length).toBe(1);
    expect(report.subagentCosts[0]!.parent_session_id).toBe("parent-1");
    expect(report.subagentCosts[0]!.subagent_count).toBe(2);
    expect(report.subagentCosts[0]!.subagent_tokens).toBe(10_000 + 5_000 + 500 + 8_000 + 3_000 + 200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Period-filter conversion: session-id subquery seek (output-preserving).
//
// The four message-querying methods (getMessageTotals, getMessagesForEfficiency,
// getMessagesForContext, getMessagesForEnergy) were converted from
//   FROM messages m JOIN sessions s ON m.session_id = s.session_id
//   WHERE … s.first_timestamp >= ? …
// to a session-id subquery seek. These tests assert ROW/AGGREGATE PARITY against
// an explicitly-computed expectation from a small, known synthetic fixture —
// covering a period boundary, the live edge case (session first_timestamp LATER
// than one of its message timestamps), multiple models/projects/accounts, a
// since/until window, a project_path filter, and an empty period. Synthetic data
// only (no live DB). Fixed epoch-ms; no Date.now()/Math.random() in assertions.
// ─────────────────────────────────────────────────────────────────────────────
describe("Store — message period filter (subquery seek parity)", () => {
  let store: Store;
  let dbPath: string;

  // Fixed epoch-ms period boundaries (UTC; no tz-dependent buckets used here).
  const T0 = 1_000_000_000_000; // day 0
  const DAY = 86_400_000;

  // mkMsg: a full MessageRecord with sensible defaults; only the fields the
  // converted queries read/return are varied per test.
  const mkMsg = (o: {
    uuid: string;
    sessionId: string;
    timestamp: number;
    model: string | null;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    eph5m?: number;
    eph1h?: number;
    thinking?: number;
    inferenceGeo?: string | null;
    tools?: string[];
    promptText?: string | null;
  }) => ({
    uuid: o.uuid,
    sessionId: o.sessionId,
    timestamp: o.timestamp,
    claudeVersion: "2.1.70",
    model: o.model,
    stopReason: "end_turn",
    inputTokens: o.input ?? 0,
    outputTokens: o.output ?? 0,
    cacheCreationTokens: o.cacheCreation ?? 0,
    cacheReadTokens: o.cacheRead ?? 0,
    tools: o.tools ?? [],
    filePaths: [],
    thinkingBlocks: o.thinking ?? 0,
    serviceTier: null,
    inferenceGeo: o.inferenceGeo ?? null,
    ephemeral5mCacheTokens: o.eph5m ?? 0,
    ephemeral1hCacheTokens: o.eph1h ?? 0,
    promptText: o.promptText ?? null,
  });

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);

    // Sessions ----------------------------------------------------------------
    // sA: project /Users/alice/a, account acct-1, spans day 0 → day 2 (multi-day,
    //     straddles the day-1 boundary). first_timestamp = T0.
    store.upsertSession(makeSession({
      sessionId: "sA", projectPath: "/Users/alice/a", accountUuid: "acct-1",
      firstTimestamp: T0, lastTimestamp: T0 + 2 * DAY,
    }));
    // sB: EDGE CASE — first_timestamp is T0 + 10min, but it owns a message at T0
    //     (10 min EARLIER than the session's first_timestamp). Reproduces the
    //     live case where first_timestamp (min over all parsed entries) is later
    //     than an earliest persisted assistant message. project /Users/alice/b,
    //     account acct-2.
    store.upsertSession(makeSession({
      sessionId: "sB", projectPath: "/Users/alice/b", accountUuid: "acct-2",
      firstTimestamp: T0 + 600_000, lastTimestamp: T0 + 700_000,
    }));
    // sC: day 3, project /Users/alice/a, account acct-1.
    store.upsertSession(makeSession({
      sessionId: "sC", projectPath: "/Users/alice/a", accountUuid: "acct-1",
      firstTimestamp: T0 + 3 * DAY, lastTimestamp: T0 + 3 * DAY + 1000,
    }));

    // Messages ----------------------------------------------------------------
    store.upsertMessages([
      // sA messages
      mkMsg({ uuid: "mA1", sessionId: "sA", timestamp: T0 + 100, model: "claude-opus-4-6", input: 100, output: 10, cacheRead: 5, cacheCreation: 1, eph5m: 2, eph1h: 3, thinking: 1, inferenceGeo: "us", tools: ["Read"], promptText: "pa1" }),
      mkMsg({ uuid: "mA2", sessionId: "sA", timestamp: T0 + DAY + 200, model: "claude-sonnet-4-6", input: 200, output: 20, cacheRead: 6, cacheCreation: 2, eph5m: 0, eph1h: 0, thinking: 0, inferenceGeo: null, tools: [], promptText: null }),
      // sB messages — note mB_early at T0, BEFORE sB.first_timestamp (T0+600_000)
      mkMsg({ uuid: "mB_early", sessionId: "sB", timestamp: T0, model: "claude-opus-4-6", input: 300, output: 30, cacheRead: 7, cacheCreation: 3, eph5m: 0, eph1h: 0, thinking: 2, inferenceGeo: "eu", tools: ["Edit"], promptText: "pb0" }),
      mkMsg({ uuid: "mB_late", sessionId: "sB", timestamp: T0 + 650_000, model: "claude-sonnet-4-6", input: 400, output: 40, cacheRead: 8, cacheCreation: 4, eph5m: 1, eph1h: 1, thinking: 0, inferenceGeo: null, tools: [], promptText: null }),
      // sC message (day 3)
      mkMsg({ uuid: "mC1", sessionId: "sC", timestamp: T0 + 3 * DAY, model: "claude-opus-4-6", input: 500, output: 50, cacheRead: 9, cacheCreation: 5, eph5m: 0, eph1h: 0, thinking: 0, inferenceGeo: "us", tools: [], promptText: null }),
      // A NULL-model message in sA: included by Context/Totals, excluded by
      // Efficiency/Energy (m.model IS NOT NULL).
      mkMsg({ uuid: "mA_null", sessionId: "sA", timestamp: T0 + 300, model: null, input: 11, output: 1, cacheRead: 1, cacheCreation: 0 }),
      // ORPHAN message: session_id "sX" has NO row in sessions. The prior inner
      // join dropped it; the subquery must drop it too (parity).
      mkMsg({ uuid: "mOrphan", sessionId: "sX", timestamp: T0 + 50, model: "claude-opus-4-6", input: 999, output: 99 }),
    ]);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  // ── getMessageTotals ──────────────────────────────────────────────────────
  describe("getMessageTotals", () => {
    it("no filters: aggregates per model over all NON-ORPHAN messages (orphan dropped)", () => {
      const rows = store.getMessageTotals();
      const byModel = new Map(rows.map(r => [r.model ?? "∅", r]));
      // opus: mA1(100) + mB_early(300) + mC1(500) = 900 in (mOrphan excluded)
      expect(byModel.get("claude-opus-4-6")).toEqual({
        model: "claude-opus-4-6",
        input_tokens: 100 + 300 + 500,
        output_tokens: 10 + 30 + 50,
        cache_read_tokens: 5 + 7 + 9,
        cache_creation_tokens: 1 + 3 + 5,
      });
      // sonnet: mA2(200) + mB_late(400)
      expect(byModel.get("claude-sonnet-4-6")).toEqual({
        model: "claude-sonnet-4-6",
        input_tokens: 200 + 400,
        output_tokens: 20 + 40,
        cache_read_tokens: 6 + 8,
        cache_creation_tokens: 2 + 4,
      });
      // null-model row aggregates under model = null
      expect(byModel.get("∅")).toEqual({
        model: null,
        input_tokens: 11,
        output_tokens: 1,
        cache_read_tokens: 1,
        cache_creation_tokens: 0,
      });
      // orphan never appears
      expect(rows.reduce((s, r) => s + r.input_tokens, 0)).toBe(100 + 300 + 500 + 200 + 400 + 11);
    });

    it("since boundary filters on MESSAGE timestamp: mB_early (T0) drops, sA's later messages stay", () => {
      // Message-timestamp semantics: since = T0 + 1 selects messages SENT at/after
      // T0+1 (regardless of their session's first_timestamp). mB_early (T0) drops;
      // mA1/mA_null/mA2 (all > T0) now qualify even though sA.first_ts = T0.
      const rows = store.getMessageTotals({ since: T0 + 1 });
      const byModel = new Map(rows.map(r => [r.model, r]));
      // opus: mA1(100) + mC1(500); mB_early(300) dropped by its own timestamp
      expect(byModel.get("claude-opus-4-6")!.input_tokens).toBe(100 + 500);
      // sonnet: mA2(200) + mB_late(400)
      expect(byModel.get("claude-sonnet-4-6")!.input_tokens).toBe(200 + 400);
      // null-model row present now (mA_null at T0+300 ≥ since)
      expect(rows.some(r => r.model === null)).toBe(true);
    });

    it("until upper bound (message timestamp) and project filter", () => {
      // project /Users/alice/a → sessions sA, sC. until = T0 + DAY filters on
      // MESSAGE timestamp: keeps messages sent before T0+DAY. From sA/sC that is
      // mA1(T0+100) and mA_null(T0+300); mA2(T0+DAY+200) and mC1(T0+3DAY) drop.
      const rows = store.getMessageTotals({ projectPath: "/Users/alice/a", until: T0 + DAY });
      const byModel = new Map(rows.map(r => [r.model ?? "∅", r]));
      expect(byModel.get("claude-opus-4-6")!.input_tokens).toBe(100); // mA1
      // sonnet row absent: mA2 is past `until` by its own timestamp
      expect(byModel.has("claude-sonnet-4-6")).toBe(false);
      expect(byModel.get("∅")!.input_tokens).toBe(11); // mA_null
    });

    it("empty period → no rows", () => {
      expect(store.getMessageTotals({ since: T0 + 100 * DAY })).toEqual([]);
    });
  });

  // ── getMessagesForEfficiency ──────────────────────────────────────────────
  describe("getMessagesForEfficiency", () => {
    it("no filters: every non-null-model, non-orphan message, ordered by timestamp ASC", () => {
      const rows = store.getMessagesForEfficiency();
      // Order by m.timestamp ASC: mB_early(T0), mA1(T0+100), mA2(T0+DAY+200),
      // mB_late(T0+650_000)→ wait, recompute: T0, T0+100, T0+650_000, T0+DAY+200, T0+3DAY
      // Actual ascending: mB_early(T0) < mA1(T0+100) < mB_late(T0+650_000)
      //   < mA2(T0+DAY+200) < mC1(T0+3DAY). mA_null excluded (model null),
      //   mOrphan excluded (no session).
      expect(rows.map(r => r.uuid)).toEqual(["mB_early", "mA1", "mB_late", "mA2", "mC1"]);
      const a1 = rows.find(r => r.uuid === "mA1")!;
      expect(a1).toEqual({
        uuid: "mA1", session_id: "sA", timestamp: T0 + 100, model: "claude-opus-4-6",
        input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_creation_tokens: 1,
        tools: JSON.stringify(["Read"]), thinking_blocks: 1, prompt_text: "pa1",
      });
    });

    it("project filter excludes other projects' sessions", () => {
      // /Users/alice/b → only sB
      const rows = store.getMessagesForEfficiency({ projectPath: "/Users/alice/b" });
      expect(rows.map(r => r.uuid)).toEqual(["mB_early", "mB_late"]);
    });

    it("since window filters on message timestamp: mB_early (T0) drops, sA's later messages stay", () => {
      const rows = store.getMessagesForEfficiency({ since: T0 + 1 });
      // Message-timestamp semantics: mB_early (T0) drops; mA1/mA2 (sA, > T0) stay
      // even though sA.first_ts = T0. Ordered by timestamp ASC.
      expect(rows.map(r => r.uuid)).toEqual(["mA1", "mB_late", "mA2", "mC1"]);
    });

    it("empty period → empty array", () => {
      expect(store.getMessagesForEfficiency({ since: T0 + 100 * DAY })).toEqual([]);
    });
  });

  // ── getMessagesForContext ─────────────────────────────────────────────────
  describe("getMessagesForContext", () => {
    it("no filters: all non-orphan messages (incl. null-model), ORDER BY session_id, timestamp ASC", () => {
      const rows = store.getMessagesForContext();
      // ORDER BY m.session_id, m.timestamp ASC →
      //   sA: mA1(T0+100), mA_null(T0+300), mA2(T0+DAY+200)
      //   sB: mB_early(T0), mB_late(T0+650_000)
      //   sC: mC1
      expect(rows.map(r => `${r.session_id}@${r.timestamp}`)).toEqual([
        `sA@${T0 + 100}`, `sA@${T0 + 300}`, `sA@${T0 + DAY + 200}`,
        `sB@${T0}`, `sB@${T0 + 650_000}`,
        `sC@${T0 + 3 * DAY}`,
      ]);
      const a1 = rows.find(r => r.session_id === "sA" && r.timestamp === T0 + 100)!;
      expect(a1).toEqual({
        session_id: "sA", timestamp: T0 + 100, input_tokens: 100,
        cache_read_tokens: 5, cache_creation_tokens: 1,
      });
    });

    it("project filter + since window (message timestamp)", () => {
      // /Users/alice/a → sA, sC. since = T0 + 1 filters MESSAGE timestamp: all of
      // sA's messages (mA1 T0+100, mA_null T0+300, mA2 T0+DAY+200) are > T0, so sA
      // stays; sC's mC1 too. ORDER BY session_id, timestamp ASC.
      const rows = store.getMessagesForContext({ projectPath: "/Users/alice/a", since: T0 + 1 });
      expect(rows.map(r => r.session_id)).toEqual(["sA", "sA", "sA", "sC"]);
    });

    it("empty period → empty array", () => {
      expect(store.getMessagesForContext({ since: T0 + 100 * DAY })).toEqual([]);
    });
  });

  // ── getMessagesForEnergy ──────────────────────────────────────────────────
  describe("getMessagesForEnergy", () => {
    it("no filters: non-null-model, non-orphan messages with project_path, ORDER BY timestamp ASC", () => {
      const rows = store.getMessagesForEnergy();
      // Order by timestamp ASC: mB_early(T0), mA1(T0+100), mB_late(T0+650_000),
      // mA2(T0+DAY+200), mC1(T0+3DAY). mA_null + mOrphan excluded.
      expect(rows.map(r => `${r.session_id}@${r.timestamp}`)).toEqual([
        `sB@${T0}`, `sA@${T0 + 100}`, `sB@${T0 + 650_000}`,
        `sA@${T0 + DAY + 200}`, `sC@${T0 + 3 * DAY}`,
      ]);
      // project_path comes from the correlated subquery — must match the session.
      const mb0 = rows.find(r => r.session_id === "sB" && r.timestamp === T0)!;
      expect(mb0).toEqual({
        session_id: "sB", timestamp: T0, model: "claude-opus-4-6",
        input_tokens: 300, output_tokens: 30, cache_read_tokens: 7, cache_creation_tokens: 3,
        ephemeral_5m_cache_tokens: 0, ephemeral_1h_cache_tokens: 0,
        thinking_blocks: 2, inference_geo: "eu", project_path: "/Users/alice/b",
      });
      const ma1 = rows.find(r => r.session_id === "sA" && r.timestamp === T0 + 100)!;
      expect(ma1.project_path).toBe("/Users/alice/a");
      expect(ma1.ephemeral_5m_cache_tokens).toBe(2);
      expect(ma1.ephemeral_1h_cache_tokens).toBe(3);
    });

    it("account filter restricts to that account's sessions", () => {
      // acct-2 → only sB
      const rows = store.getMessagesForEnergy({ accountUuid: "acct-2" });
      expect(rows.map(r => r.session_id)).toEqual(["sB", "sB"]);
      expect(rows.every(r => r.project_path === "/Users/alice/b")).toBe(true);
    });

    it("project filter + since window (message timestamp) drops the edge message", () => {
      // /Users/alice/b → sB; since = T0 + 1 filters MESSAGE timestamp: mB_early
      // (T0) drops even though sB.first_ts = T0+600_000; only mB_late (T0+650k) stays.
      const rows = store.getMessagesForEnergy({ projectPath: "/Users/alice/b", since: T0 + 1 });
      expect(rows.map(r => `${r.session_id}@${r.timestamp}`)).toEqual([
        `sB@${T0 + 650_000}`,
      ]);
    });

    it("empty period → empty array", () => {
      expect(store.getMessagesForEnergy({ since: T0 + 100 * DAY })).toEqual([]);
    });
  });

  // ── Message-timestamp semantics: explicit boundary-straddle guard ─────────
  describe("boundary straddle (message-timestamp axis)", () => {
    it("counts messages by their OWN timestamp, not their session's first_timestamp", () => {
      // sB starts at T0+600_000 but owns mB_early at T0. With a window
      // [T0+1, T0+700_000): mB_early (T0) is EXCLUDED though its session starts
      // in-window; mB_late (T0+650k) is INCLUDED. Conversely sA starts at T0 but
      // its mA2 (T0+DAY+200) lands outside this window. This is the signed-off
      // behaviour change from session-start to message-timestamp semantics.
      const rows = store.getMessageTotals({ since: T0 + 1, until: T0 + 700_000 });
      const byModel = new Map(rows.map(r => [r.model ?? "∅", r]));
      // opus: only mA1 (T0+100); mB_early (T0) excluded, mC1 (T0+3DAY) excluded
      expect(byModel.get("claude-opus-4-6")!.input_tokens).toBe(100);
      // sonnet: only mB_late (T0+650k); mA2 (T0+DAY+200) excluded
      expect(byModel.get("claude-sonnet-4-6")!.input_tokens).toBe(400);
      // null-model mA_null (T0+300) is in-window
      expect(byModel.get("∅")!.input_tokens).toBe(11);
      // orphan never appears regardless of axis
      expect(rows.every(r => r.input_tokens !== 999)).toBe(true);
    });
  });
});

// ─── Phase 1: persisted hourly rollup (message_hourly) parity ────────────────
//
// Synthetic data only (/Users/alice paths). Asserts that summing message_hourly
// reproduces the raw per-message sums under the EXISTS-only inclusion predicate
// (orphan-drop; null-model INCLUDED; null-ts INCLUDED under hour_utc=-1), and
// that recomputeMessageHourly is partition-correct and idempotent.
describe("Store — message_hourly rollup parity (Phase 1)", () => {
  let store: Store;
  let dbPath: string;

  const HOUR = 3_600_000;

  function mkMsg(o: Partial<MessageRecord> & { uuid: string; sessionId: string }): MessageRecord {
    return {
      timestamp: HOUR, // default: hour bucket 1
      claudeVersion: "2.1.70",
      model: "claude-opus-4-6",
      stopReason: "end_turn",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tools: [],
      filePaths: [],
      thinkingBlocks: 0,
      serviceTier: null,
      inferenceGeo: null,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
      promptText: null,
      ...o,
    };
  }

  // Fixture covering every correction: multiple models (incl. null), multiple
  // projects, varied + null inference_geo, thinking + non-thinking, a null-ts
  // message, and an orphan (session_id absent from `sessions`).
  const messages: MessageRecord[] = [
    // session sA (/Users/alice/a), bucket 1, opus, geo "eu", thinking
    mkMsg({ uuid: "m1", sessionId: "sA", inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 1, inferenceGeo: "eu", thinkingBlocks: 2, timestamp: HOUR + 1 }),
    // session sA, bucket 1, opus, geo "eu", NON-thinking
    mkMsg({ uuid: "m2", sessionId: "sA", inputTokens: 200, outputTokens: 20, cacheReadTokens: 7, cacheCreationTokens: 2, inferenceGeo: "eu", thinkingBlocks: 0, timestamp: HOUR + 2 }),
    // session sA, bucket 2, sonnet, geo NULL, thinking
    mkMsg({ uuid: "m3", sessionId: "sA", model: "claude-sonnet-4-6", inputTokens: 300, outputTokens: 30, cacheReadTokens: 9, cacheCreationTokens: 3, inferenceGeo: null, thinkingBlocks: 1, timestamp: 2 * HOUR + 1 }),
    // session sB (/Users/alice/b), bucket 1, NULL model, geo "us", non-thinking
    mkMsg({ uuid: "m4", sessionId: "sB", model: null, inputTokens: 400, outputTokens: 40, cacheReadTokens: 11, cacheCreationTokens: 4, inferenceGeo: "us", thinkingBlocks: 0, timestamp: HOUR + 3 }),
    // session sB, NULL timestamp → hour_utc -1 bucket, opus, geo null
    mkMsg({ uuid: "m5", sessionId: "sB", inputTokens: 500, outputTokens: 50, cacheReadTokens: 13, cacheCreationTokens: 5, inferenceGeo: null, thinkingBlocks: 0, timestamp: null }),
    // orphan: session "sZ" never inserted into `sessions` → must be excluded
    mkMsg({ uuid: "m6", sessionId: "sZ", inputTokens: 999, outputTokens: 999, cacheReadTokens: 999, cacheCreationTokens: 999, inferenceGeo: "eu", thinkingBlocks: 3, timestamp: HOUR + 4 }),
  ];

  type HourlyRow = {
    hour_utc: number; project_path: string; model: string; inference_geo: string;
    input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
    th_input_tokens: number; th_output_tokens: number; th_cache_read_tokens: number; th_cache_creation_tokens: number;
    msg_count: number; th_msg_count: number; min_ts: number | null;
  };

  // Read message_hourly via an independent connection to the same file.
  function readHourly(): HourlyRow[] {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare("SELECT * FROM message_hourly ORDER BY hour_utc, project_path, model, inference_geo").all() as HourlyRow[];
    } finally {
      db.close();
    }
  }

  // Raw per-message sum over EXISTS-included messages (orphan excluded), with
  // optional predicate (e.g. model present, thinking only).
  function rawSum(field: keyof MessageRecord, pred: (m: MessageRecord) => boolean = () => true): number {
    return messages
      .filter(m => m.sessionId !== "sZ") // EXISTS: sZ has no session row
      .filter(pred)
      .reduce((acc, m) => acc + (m[field] as number), 0);
  }

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({ sessionId: "sA", projectPath: "/Users/alice/a", firstTimestamp: HOUR }));
    store.upsertSession(makeSession({ sessionId: "sB", projectPath: "/Users/alice/b", firstTimestamp: HOUR }));
    // NOTE: "sZ" deliberately NOT inserted → m6 is an orphan.
    store.upsertMessages(messages);
    // Rollup was backfilled at construction (empty); recompute now that messages exist.
    store.recomputeMessageHourly();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("(a) Σ all rollup tokens == raw SUM over EXISTS-included messages (orphan excluded, null-model & null-ts INCLUDED)", () => {
    const rows = readHourly();
    const sum = (k: keyof HourlyRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
    expect(sum("input_tokens")).toBe(rawSum("inputTokens"));          // 100+200+300+400+500 = 1500
    expect(sum("output_tokens")).toBe(rawSum("outputTokens"));        // 10+20+30+40+50 = 150
    expect(sum("cache_read_tokens")).toBe(rawSum("cacheReadTokens")); // 5+7+9+11+13 = 45
    expect(sum("cache_creation_tokens")).toBe(rawSum("cacheCreationTokens")); // 1+2+3+4+5 = 15
    // orphan never contributes
    expect(rows.every(r => r.input_tokens !== 999)).toBe(true);
    // null-ts message landed in the -1 sentinel bucket
    expect(rows.some(r => r.hour_utc === -1 && r.input_tokens === 500)).toBe(true);
  });

  it("(b) Σ where model != '' == raw SUM over model IS NOT NULL (energy-read semantics)", () => {
    const rows = readHourly().filter(r => r.model !== null);
    const sumIn = rows.reduce((a, r) => a + r.input_tokens, 0);
    expect(sumIn).toBe(rawSum("inputTokens", m => m.model !== null)); // excludes m4(null model)=400 → 1100
    // null-model row is stored as actual NULL (no '' sentinel)
    const nullModelRow = readHourly().find(r => r.model === null);
    expect(nullModelRow).toBeDefined();
    expect(nullModelRow!.input_tokens).toBe(400);
  });

  it("(c) th_* sums == raw SUM where thinking_blocks > 0", () => {
    const rows = readHourly();
    const sum = (k: keyof HourlyRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const thinking = (m: MessageRecord) => m.thinkingBlocks > 0;
    expect(sum("th_input_tokens")).toBe(rawSum("inputTokens", thinking));   // m1+m3 = 100+300 = 400
    expect(sum("th_output_tokens")).toBe(rawSum("outputTokens", thinking)); // 10+30 = 40
    expect(sum("th_cache_read_tokens")).toBe(rawSum("cacheReadTokens", thinking)); // 5+9 = 14
    expect(sum("th_cache_creation_tokens")).toBe(rawSum("cacheCreationTokens", thinking)); // 1+3 = 4
    expect(sum("th_msg_count")).toBe(messages.filter(m => m.sessionId !== "sZ" && m.thinkingBlocks > 0).length); // 2
  });

  it("(d) Σ msg_count == COUNT of EXISTS-included messages", () => {
    const rows = readHourly();
    const total = rows.reduce((a, r) => a + r.msg_count, 0);
    expect(total).toBe(messages.filter(m => m.sessionId !== "sZ").length); // 5 (orphan m6 excluded)
  });

  it("groups distinct (hour, project, model, geo) and resolves project_path / sentinels", () => {
    const rows = readHourly();
    // m1+m2 share (hour 1, /Users/alice/a, opus, eu) → one merged row
    const merged = rows.find(r => r.hour_utc === 1 && r.project_path === "/Users/alice/a" && r.model === "claude-opus-4-6" && r.inference_geo === "eu");
    expect(merged).toBeDefined();
    expect(merged!.msg_count).toBe(2);
    expect(merged!.input_tokens).toBe(300); // 100 + 200
    expect(merged!.min_ts).toBe(HOUR + 1);  // MIN(timestamp) in the group
    // null geo stored as actual NULL (no '' sentinel) (m3)
    expect(rows.some(r => r.inference_geo === null && r.model === "claude-sonnet-4-6")).toBe(true);
  });

  it("recomputeMessageHourly([h]) recomputes only that bucket, leaving others untouched", () => {
    const before = readHourly();
    // Mutate the messages backing bucket 2 (m3), then recompute ONLY bucket 1.
    store.upsertMessages([mkMsg({ uuid: "m3", sessionId: "sA", model: "claude-sonnet-4-6", inputTokens: 9999, outputTokens: 30, cacheReadTokens: 9, cacheCreationTokens: 3, inferenceGeo: null, thinkingBlocks: 1, timestamp: 2 * HOUR + 1 })],);
    store.recomputeMessageHourly([1]); // touch bucket 1 only
    const after = readHourly();
    // bucket 2 row still reflects the OLD value (untouched)
    const b2 = after.find(r => r.hour_utc === 2)!;
    const b2Before = before.find(r => r.hour_utc === 2)!;
    expect(b2.input_tokens).toBe(b2Before.input_tokens); // 300, not 9999
    // bucket 1 rows unchanged in value (the mutation was in bucket 2)
    const b1After = after.filter(r => r.hour_utc === 1).reduce((a, r) => a + r.input_tokens, 0);
    const b1Before = before.filter(r => r.hour_utc === 1).reduce((a, r) => a + r.input_tokens, 0);
    expect(b1After).toBe(b1Before);
    // empty hours array is a no-op (no throw)
    expect(() => store.recomputeMessageHourly([])).not.toThrow();
  });

  it("a second full backfill is idempotent (byte-identical table)", () => {
    const first = readHourly();
    store.recomputeMessageHourly(); // full rebuild again
    const second = readHourly();
    expect(second).toEqual(first);
  });
});

// ─── Build 2 Phase 1 (Stream B): rollup READ-PATH parity + dispatcher ─────────
//
// Synthetic data only (/Users/alice paths). Asserts that the unbounded
// fast-path readers (getEnergyAggregatesFromRollup / getMessageTotalsFromRollup)
// reproduce the raw readers EXACTLY, and that getEnergyAggregates/getMessageTotals
// dispatch to the rollup ONLY when fully unbounded (no period, no session-scope).
describe("Store — rollup read-path parity (Build 2 Phase 1, Stream B)", () => {
  let store: Store;
  let dbPath: string;
  const HOUR = 3_600_000;

  function mkMsg(o: Partial<MessageRecord> & { uuid: string; sessionId: string }): MessageRecord {
    return {
      timestamp: HOUR,
      claudeVersion: "2.1.70",
      model: "claude-opus-4-6",
      stopReason: "end_turn",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tools: [],
      filePaths: [],
      thinkingBlocks: 0,
      serviceTier: null,
      inferenceGeo: null,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
      promptText: null,
      ...o,
    };
  }

  // Same fixture shape as the Phase-1 rollup test: multi-model (incl. null),
  // multi-project, varied + null geo, thinking + non-thinking, a null-ts
  // message (hour_utc=-1 sentinel), and an orphan (no session row).
  const messages: MessageRecord[] = [
    mkMsg({ uuid: "m1", sessionId: "sA", inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 1, inferenceGeo: "eu", thinkingBlocks: 2, timestamp: HOUR + 1 }),
    mkMsg({ uuid: "m2", sessionId: "sA", inputTokens: 200, outputTokens: 20, cacheReadTokens: 7, cacheCreationTokens: 2, inferenceGeo: "eu", thinkingBlocks: 0, timestamp: HOUR + 2 }),
    mkMsg({ uuid: "m3", sessionId: "sA", model: "claude-sonnet-4-6", inputTokens: 300, outputTokens: 30, cacheReadTokens: 9, cacheCreationTokens: 3, inferenceGeo: null, thinkingBlocks: 1, timestamp: 2 * HOUR + 1 }),
    mkMsg({ uuid: "m4", sessionId: "sB", model: null, inputTokens: 400, outputTokens: 40, cacheReadTokens: 11, cacheCreationTokens: 4, inferenceGeo: "us", thinkingBlocks: 0, timestamp: HOUR + 3 }),
    mkMsg({ uuid: "m5", sessionId: "sB", inputTokens: 500, outputTokens: 50, cacheReadTokens: 13, cacheCreationTokens: 5, inferenceGeo: null, thinkingBlocks: 0, timestamp: null }),
    // a second project (sC, /Users/alice/c) sonnet in geo "us" with thinking, to
    // exercise multi-project + multi-geo grouping in byProjectModel / byGeo.
    mkMsg({ uuid: "m7", sessionId: "sC", model: "claude-sonnet-4-6", inputTokens: 600, outputTokens: 60, cacheReadTokens: 15, cacheCreationTokens: 6, inferenceGeo: "us", thinkingBlocks: 4, timestamp: 2 * HOUR + 5 }),
    // orphan: never inserted into `sessions` → excluded everywhere.
    mkMsg({ uuid: "m6", sessionId: "sZ", inputTokens: 999, outputTokens: 999, cacheReadTokens: 999, cacheCreationTokens: 999, inferenceGeo: "eu", thinkingBlocks: 3, timestamp: HOUR + 4 }),
  ];

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({ sessionId: "sA", projectPath: "/Users/alice/a", firstTimestamp: HOUR }));
    store.upsertSession(makeSession({ sessionId: "sB", projectPath: "/Users/alice/b", firstTimestamp: HOUR }));
    store.upsertSession(makeSession({ sessionId: "sC", projectPath: "/Users/alice/c", firstTimestamp: HOUR }));
    store.upsertMessages(messages);
    store.recomputeMessageHourly();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  // Access the private *Raw / *FromRollup methods (TS private, runtime public).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = () => store as any;

  // Order-independent comparison: key each row by a composite of its grouping
  // columns (the GROUP BY emission order is not guaranteed), then deep-compare
  // the keyed maps. NULL/undefined min_ts normalised so the optional column
  // doesn't spuriously differ.
  function keyBy<T>(rows: T[], key: (r: T) => string): Record<string, T> {
    const out: Record<string, T> = {};
    for (const r of rows) out[key(r)] = r;
    return out;
  }
  const normMinTs = <T extends { min_ts?: number | null }>(r: T): T => ({ ...r, min_ts: r.min_ts ?? null });

  it("getMessageTotalsFromRollup deep-equals getMessageTotalsRaw({}) (order-independent, '' ↔ null model)", () => {
    const raw = s().getMessageTotalsRaw({}) as Array<{ model: string | null }>;
    const roll = s().getMessageTotalsFromRollup() as Array<{ model: string | null }>;
    // null-model row is present in both (totals INCLUDE null model).
    expect(roll.some(r => r.model === null)).toBe(true);
    expect(raw.some(r => r.model === null)).toBe(true);
    const k = (r: { model: string | null }) => String(r.model); // null → "null"
    expect(keyBy(roll, k)).toEqual(keyBy(raw, k));
  });

  it("getEnergyAggregatesFromRollup deep-equals getEnergyAggregatesRaw({}) — byModel (excludes null model; min_ts tiebreak)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    // energy excludes null-model: neither side has a null/'' model entry.
    expect(roll.byModel.every((r: { model: string }) => r.model !== "" && r.model !== null)).toBe(true);
    const k = (r: { model: string }) => r.model;
    expect(keyBy(roll.byModel.map(normMinTs), k)).toEqual(keyBy(raw.byModel.map(normMinTs), k));
  });

  it("byProjectModel parity (multi-project, GROUP BY project_path, model)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    const k = (r: { project_path: string; model: string }) => `${r.project_path} ${r.model}`;
    expect(keyBy(roll.byProjectModel.map(normMinTs), k)).toEqual(keyBy(raw.byProjectModel.map(normMinTs), k));
  });

  it("byHourModel parity (-1 sentinel ↔ NULL hour_bucket)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    // null-ts message (m5) surfaces as a NULL hour_bucket in BOTH.
    expect(roll.byHourModel.some((r: { hour_bucket: number | null }) => r.hour_bucket === null)).toBe(true);
    expect(raw.byHourModel.some((r: { hour_bucket: number | null }) => r.hour_bucket === null)).toBe(true);
    const k = (r: { hour_bucket: number | null; model: string }) => `${r.hour_bucket} ${r.model}`;
    expect(keyBy(roll.byHourModel, k)).toEqual(keyBy(raw.byHourModel, k));
  });

  it("byGeo parity ('' ↔ null geo; SUM over model-not-null)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    // m3's null geo surfaces as inference_geo:null in BOTH.
    expect(roll.byGeo.some((r: { inference_geo: string | null }) => r.inference_geo === null)).toBe(true);
    expect(raw.byGeo.some((r: { inference_geo: string | null }) => r.inference_geo === null)).toBe(true);
    const k = (r: { inference_geo: string | null }) => String(r.inference_geo);
    expect(keyBy(roll.byGeo, k)).toEqual(keyBy(raw.byGeo, k));
  });

  it("geoByEarliest parity (non-null geos, MIN(min_ts) ASC) — order matters here", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    // This one is ORDER-BY min_ts ASC, so compare arrays directly.
    expect(roll.geoByEarliest).toEqual(raw.geoByEarliest);
  });

  it("thinkingByModel parity (th_* sums, th_msg_count as msgs, only thinking buckets)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    const k = (r: { model: string }) => r.model;
    expect(keyBy(roll.thinkingByModel.map(normMinTs), k)).toEqual(keyBy(raw.thinkingByModel.map(normMinTs), k));
  });

  it("scalar fields parity (sessionsWithThinking, totalMessages, minTimestamp)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    expect(roll.sessionsWithThinking).toBe(raw.sessionsWithThinking);
    expect(roll.totalMessages).toBe(raw.totalMessages);
    expect(roll.minTimestamp).toBe(raw.minTimestamp);
  });

  it("full EnergyAggregates parity, every collection keyed (single deep-equal)", () => {
    const raw = s().getEnergyAggregatesRaw({});
    const roll = s().getEnergyAggregatesFromRollup();
    expect({
      byModel: keyBy(roll.byModel.map(normMinTs), (r: { model: string }) => r.model),
      byProjectModel: keyBy(roll.byProjectModel.map(normMinTs), (r: { project_path: string; model: string }) => `${r.project_path} ${r.model}`),
      byHourModel: keyBy(roll.byHourModel, (r: { hour_bucket: number | null; model: string }) => `${r.hour_bucket} ${r.model}`),
      byGeo: keyBy(roll.byGeo, (r: { inference_geo: string | null }) => String(r.inference_geo)),
      geoByEarliest: roll.geoByEarliest,
      sessionsWithThinking: roll.sessionsWithThinking,
      thinkingByModel: keyBy(roll.thinkingByModel.map(normMinTs), (r: { model: string }) => r.model),
      totalMessages: roll.totalMessages,
      minTimestamp: roll.minTimestamp,
    }).toEqual({
      byModel: keyBy(raw.byModel.map(normMinTs), (r: { model: string }) => r.model),
      byProjectModel: keyBy(raw.byProjectModel.map(normMinTs), (r: { project_path: string; model: string }) => `${r.project_path} ${r.model}`),
      byHourModel: keyBy(raw.byHourModel, (r: { hour_bucket: number | null; model: string }) => `${r.hour_bucket} ${r.model}`),
      byGeo: keyBy(raw.byGeo, (r: { inference_geo: string | null }) => String(r.inference_geo)),
      geoByEarliest: raw.geoByEarliest,
      sessionsWithThinking: raw.sessionsWithThinking,
      thinkingByModel: keyBy(raw.thinkingByModel.map(normMinTs), (r: { model: string }) => r.model),
      totalMessages: raw.totalMessages,
      minTimestamp: raw.minTimestamp,
    });
  });

  // ─── Dispatcher: bound → raw path; unbounded → rollup path ─────────────────

  it("getEnergyAggregates({}) (fully unbounded) returns the rollup result", () => {
    const dispatched = store.getEnergyAggregates({});
    const fromRollup = s().getEnergyAggregatesFromRollup();
    expect(dispatched).toEqual(fromRollup);
  });

  it("getEnergyAggregates({since}) uses the RAW seek path, not the rollup", () => {
    // A `since` above every timestamp yields an empty raw result; the rollup
    // (which ignores since) would NOT be empty. So if the dispatcher routed to
    // the rollup, totalMessages would be > 0. It must equal the raw path.
    const since = 100 * HOUR;
    const dispatched = store.getEnergyAggregates({ since });
    const raw = s().getEnergyAggregatesRaw({ since });
    expect(dispatched).toEqual(raw);
    expect(dispatched.totalMessages).toBe(0); // proves it did NOT read the rollup
  });

  it("getEnergyAggregates({until}) uses the RAW seek path, not the rollup, and excludes messages at/after until", () => {
    // Regression test for the custom-date-range feature: getEnergyAggregates
    // previously had no `until` param at all, so a past custom range could
    // silently include messages after the requested end. m1 (HOUR+1) and m2
    // (HOUR+2) are strictly before HOUR+3; m3 (2*HOUR+1) and m4 (HOUR+3
    // exactly, excluded by the strict `<`) must be dropped.
    const until = HOUR + 3;
    const dispatched = store.getEnergyAggregates({ until });
    const raw = s().getEnergyAggregatesRaw({ until });
    expect(dispatched).toEqual(raw);
    const rollupTotal = s().getEnergyAggregatesFromRollup().totalMessages;
    expect(dispatched.totalMessages).toBeGreaterThan(0);
    expect(dispatched.totalMessages).toBeLessThan(rollupTotal);
  });

  it("getEnergyAggregates({since, until}) combines both bounds (RAW path)", () => {
    const since = HOUR + 1;
    const until = 2 * HOUR + 1; // excludes m3 (at exactly 2*HOUR+1, strict <)
    const dispatched = store.getEnergyAggregates({ since, until });
    const raw = s().getEnergyAggregatesRaw({ since, until });
    expect(dispatched).toEqual(raw);
    // Only m1 (HOUR+1) and m2 (HOUR+2) fall in [since, until).
    expect(dispatched.totalMessages).toBe(2);
  });

  it("getEnergyAggregates({projectPath}) uses the RAW path (session-scoped)", () => {
    const dispatched = store.getEnergyAggregates({ projectPath: "/Users/alice/a" });
    const raw = s().getEnergyAggregatesRaw({ projectPath: "/Users/alice/a" });
    expect(dispatched).toEqual(raw);
    // scoped to project a → byModel has opus only (sonnet lives in /a bucket2 too,
    // but at minimum it must differ from the unbounded rollup's total).
    const rollupTotal = s().getEnergyAggregatesFromRollup().totalMessages;
    expect(dispatched.totalMessages).toBeLessThan(rollupTotal);
  });

  it("getMessageTotals({}) (fully unbounded) returns the rollup result", () => {
    const dispatched = store.getMessageTotals({});
    const fromRollup = s().getMessageTotalsFromRollup();
    const k = (r: { model: string | null }) => String(r.model);
    expect(keyBy(dispatched, k)).toEqual(keyBy(fromRollup, k));
  });

  it("getMessageTotals({until}) uses the RAW seek path, not the rollup", () => {
    const until = 0; // before every timestamp → raw is empty
    const dispatched = store.getMessageTotals({ until });
    const raw = s().getMessageTotalsRaw({ until });
    expect(dispatched).toEqual(raw);
    expect(dispatched).toHaveLength(0); // proves it did NOT read the rollup
  });
});

// ─── Phase 1 (T-store-test): getMessageTotalsBySession bound + getMessageTotals
// account/entrypoint filter + listAccounts includeDeleted ───────────────────
//
// Synthetic data only. Fixed epoch-ms timestamps; no Date.now() in assertions.

describe("Store — getMessageTotalsBySession opts.since/until bound (Phase 1 D3 effect-3)", () => {
  let store: Store;
  let dbPath: string;

  const T0 = 2_000_000_000_000;

  const mkMsg = (o: { uuid: string; sessionId: string; timestamp: number; model: string; input: number; output: number }) => ({
    uuid: o.uuid, sessionId: o.sessionId, timestamp: o.timestamp, claudeVersion: "2.1.70",
    model: o.model, stopReason: "end_turn", inputTokens: o.input, outputTokens: o.output,
    cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0,
    serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    promptText: null,
  });

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    // Boundary-straddling session: spans well beyond the query window on both sides.
    store.upsertSession(makeSession({ sessionId: "straddle", firstTimestamp: T0 - 10_000, lastTimestamp: T0 + 10_000 }));
    store.upsertMessages([
      // BEFORE the window
      mkMsg({ uuid: "before1", sessionId: "straddle", timestamp: T0 - 5_000, model: "claude-opus-4-6", input: 1_000, output: 100 }),
      // INSIDE the window [T0, T0+2000)
      mkMsg({ uuid: "in1", sessionId: "straddle", timestamp: T0, model: "claude-opus-4-6", input: 300, output: 30 }),
      mkMsg({ uuid: "in2", sessionId: "straddle", timestamp: T0 + 1_000, model: "claude-opus-4-6", input: 200, output: 20 }),
      // AFTER the window (>= until)
      mkMsg({ uuid: "after1", sessionId: "straddle", timestamp: T0 + 2_000, model: "claude-opus-4-6", input: 5_000, output: 500 }),
      mkMsg({ uuid: "after2", sessionId: "straddle", timestamp: T0 + 50_000, model: "claude-opus-4-6", input: 9_000, output: 900 }),
    ]);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("sums ONLY in-window messages when { since, until } is passed", () => {
    const totals = store.getMessageTotalsBySession(["straddle"], { since: T0, until: T0 + 2_000 });
    expect(totals).toHaveLength(1);
    const row = totals[0]!;
    expect(row.session_id).toBe("straddle");
    expect(row.model).toBe("claude-opus-4-6");
    // Only in1 (300/30) + in2 (200/20); before1 and after1/after2 excluded.
    expect(row.input_tokens).toBe(300 + 200);
    expect(row.output_tokens).toBe(30 + 20);
  });

  it("the unbounded call (no opts) still returns LIFETIME totals across the same session", () => {
    const totals = store.getMessageTotalsBySession(["straddle"]);
    expect(totals).toHaveLength(1);
    const row = totals[0]!;
    // Every message on the session, in and out of the window above.
    expect(row.input_tokens).toBe(1_000 + 300 + 200 + 5_000 + 9_000);
    expect(row.output_tokens).toBe(100 + 30 + 20 + 500 + 900);
  });

  it("since-only bound excludes messages before `since` but keeps everything at/after it", () => {
    const totals = store.getMessageTotalsBySession(["straddle"], { since: T0 + 1_000 });
    expect(totals).toHaveLength(1);
    // in2(200) + after1(5000) + after2(9000); before1 and in1 excluded.
    expect(totals[0]!.input_tokens).toBe(200 + 5_000 + 9_000);
  });

  it("until-only bound excludes messages at/after `until` but keeps everything before it", () => {
    const totals = store.getMessageTotalsBySession(["straddle"], { until: T0 + 1_000 });
    expect(totals).toHaveLength(1);
    // before1(1000) + in1(300); in2 is at exactly the (excluded) boundary is NOT — in2 is T0+1000 which is excluded (< until, strict), so only before1+in1.
    expect(totals[0]!.input_tokens).toBe(1_000 + 300);
  });
});

describe("Store — getMessageTotals accountUuid / entrypoint filter (Phase 1 D0 + S3)", () => {
  let store: Store;
  let dbPath: string;

  const T0 = 3_000_000_000_000;

  const mkMsg = (o: { uuid: string; sessionId: string; timestamp: number; model: string; input: number; output: number }) => ({
    uuid: o.uuid, sessionId: o.sessionId, timestamp: o.timestamp, claudeVersion: "2.1.70",
    model: o.model, stopReason: "end_turn", inputTokens: o.input, outputTokens: o.output,
    cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0,
    serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    promptText: null,
  });

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    // Two accounts, two entrypoints, one session each.
    store.upsertSession(makeSession({
      sessionId: "sess-work", accountUuid: "11111111-1111-1111-1111-111111111111",
      entrypoint: "claude-vscode", firstTimestamp: T0 - 1_000, lastTimestamp: T0 + 5_000,
    }));
    store.upsertSession(makeSession({
      sessionId: "sess-personal", accountUuid: "22222222-2222-2222-2222-222222222222",
      entrypoint: "claude", firstTimestamp: T0 - 1_000, lastTimestamp: T0 + 5_000,
    }));
    store.upsertMessages([
      mkMsg({ uuid: "w1", sessionId: "sess-work", timestamp: T0, model: "claude-opus-4-6", input: 1_000, output: 100 }),
      mkMsg({ uuid: "w2", sessionId: "sess-work", timestamp: T0 + 1_000, model: "claude-opus-4-6", input: 500, output: 50 }),
      mkMsg({ uuid: "p1", sessionId: "sess-personal", timestamp: T0, model: "claude-sonnet-4-6", input: 300, output: 30 }),
    ]);
    // Ensure the rollup exists (and is stale-free) so an unbounded-except-account
    // call has a real fast path available to (correctly) bypass.
    store.recomputeMessageHourly();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("getMessageTotals({ accountUuid }) returns only that account's messages", () => {
    const rows = store.getMessageTotals({ accountUuid: "11111111-1111-1111-1111-111111111111" });
    const total = rows.reduce((a, r) => a + r.input_tokens, 0);
    expect(total).toBe(1_000 + 500); // sess-work only; sess-personal's 300 excluded
    expect(rows.every(r => r.model !== "claude-sonnet-4-6")).toBe(true);
  });

  it("getMessageTotals({ accountUuid }) is in-window: excludes messages outside since/until too", () => {
    const rows = store.getMessageTotals({
      accountUuid: "11111111-1111-1111-1111-111111111111",
      since: T0 + 1_000,
    });
    const total = rows.reduce((a, r) => a + r.input_tokens, 0);
    expect(total).toBe(500); // w1 (at T0) dropped by since; only w2 remains
  });

  it("an account-filtered call bypasses the rollup fast path (matches the raw seek path exactly, not the account-blind rollup)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = store as any;
    const rollupTotal = (s.getMessageTotalsFromRollup() as Array<{ input_tokens: number }>)
      .reduce((a, r) => a + r.input_tokens, 0);
    // The rollup has no account dimension, so it sums BOTH accounts.
    expect(rollupTotal).toBe(1_000 + 500 + 300);

    const filtered = store.getMessageTotals({ accountUuid: "11111111-1111-1111-1111-111111111111" });
    const filteredTotal = filtered.reduce((a, r) => a + r.input_tokens, 0);
    // If the account filter had (wrongly) taken the fully-unbounded rollup path,
    // this would equal rollupTotal (1800). It must instead equal only the
    // filtered account's contribution — proving the raw seek path was used.
    expect(filteredTotal).toBe(1_500);
    expect(filteredTotal).not.toBe(rollupTotal);

    // And it must match the raw seek path's result exactly (private method,
    // called directly for a precise same-path comparison).
    const raw = s.getMessageTotalsRaw({ accountUuid: "11111111-1111-1111-1111-111111111111" });
    expect(filtered).toEqual(raw);
  });

  it("getMessageTotals({ entrypoint }) is symmetric with the accountUuid filter — scopes to that entrypoint's messages only", () => {
    const rows = store.getMessageTotals({ entrypoint: "claude" });
    const total = rows.reduce((a, r) => a + r.input_tokens, 0);
    expect(total).toBe(300); // sess-personal (entrypoint "claude") only
    expect(rows.every(r => r.model !== "claude-opus-4-6")).toBe(true);
  });

  it("getMessageTotals({ entrypoint }) also bypasses the rollup fast path", () => {
    const filtered = store.getMessageTotals({ entrypoint: "claude-vscode" });
    const total = filtered.reduce((a, r) => a + r.input_tokens, 0);
    expect(total).toBe(1_000 + 500); // sess-work only, not the account-blind rollup total (1800)
  });
});

describe("Store — listAccounts includeDeleted (Phase 1 Blocker 2)", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(makeSession({
      sessionId: "live-sess", accountUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      firstTimestamp: 1_000, sourceDeleted: false, isInteractive: true,
    }));
    store.upsertSession(makeSession({
      sessionId: "gone-sess", accountUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      firstTimestamp: 2_000, sourceDeleted: true, isInteractive: true,
    }));
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("excludes source_deleted accounts by default", () => {
    const accounts = store.listAccounts();
    const uuids = accounts.map(a => a.accountUuid);
    expect(uuids).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(uuids).not.toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("includes source_deleted accounts when includeDeleted: true", () => {
    const accounts = store.listAccounts({ includeDeleted: true });
    const uuids = accounts.map(a => a.accountUuid);
    expect(uuids).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(uuids).toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const gone = accounts.find(a => a.accountUuid === "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(gone!.sessionCount).toBe(1);
  });
});

describe("Store — getMessageTotalsByAccount reconciles with the headline (exact-reconciliation fix)", () => {
  let store: Store;
  let dbPath: string;

  const T0 = 3_000_000_000_000;
  const HOUR = 3_600_000;
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  const mkMsg = (o: { uuid: string; sessionId: string; timestamp: number; model: string; input: number; output: number }) => ({
    uuid: o.uuid, sessionId: o.sessionId, timestamp: o.timestamp, claudeVersion: "2.1.70",
    model: o.model, stopReason: "end_turn", inputTokens: o.input, outputTokens: o.output,
    cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], filePaths: [], thinkingBlocks: 0,
    serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    promptText: null,
  });

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    // Account A: a normal in-window session.
    store.upsertSession(makeSession({
      sessionId: "a-normal", accountUuid: A,
      firstTimestamp: T0, lastTimestamp: T0 + HOUR,
    }));
    // Account B: the pathological case that under-counted on real data — a
    // session whose stored last_timestamp is NULL and whose first_timestamp is
    // BEFORE the window, yet which has messages INSIDE the window. The
    // session-`rows` path drops it (COALESCE(last,first)=first < since); the
    // message-scoped getMessageTotalsByAccount must still count its in-window
    // messages so Σ byAccount == headline.
    store.upsertSession(makeSession({
      sessionId: "b-nulllast", accountUuid: B,
      firstTimestamp: T0 - 10 * HOUR, lastTimestamp: null,
    }));
    store.upsertMessages([
      mkMsg({ uuid: "a1", sessionId: "a-normal", timestamp: T0 + 1_000, model: "claude-opus-4-6", input: 1_000, output: 100 }),
      // B's in-window message (must be counted) + an out-of-window one (must not).
      mkMsg({ uuid: "b1", sessionId: "b-nulllast", timestamp: T0 + 2_000, model: "claude-sonnet-4-6", input: 400, output: 40 }),
      mkMsg({ uuid: "b0", sessionId: "b-nulllast", timestamp: T0 - 5 * HOUR, model: "claude-sonnet-4-6", input: 9_999, output: 9_999 }),
    ]);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("summed over accounts+models equals getMessageTotals (headline) for the same window", () => {
    const since = T0;
    const until = T0 + HOUR;
    const headline = store.getMessageTotals({ since, until });
    const byAcct = store.getMessageTotalsByAccount({ since, until });

    const sum = (rows: Array<{ input_tokens: number; output_tokens: number }>) =>
      rows.reduce((a, r) => ({ i: a.i + r.input_tokens, o: a.o + r.output_tokens }), { i: 0, o: 0 });

    expect(sum(byAcct)).toEqual(sum(headline)); // identity by construction
    expect(sum(headline).i).toBe(1_000 + 400);  // a1 + b1 only (b0 is out of window)
  });

  it("attributes the NULL-last-timestamp session's in-window message to its account", () => {
    const byAcct = store.getMessageTotalsByAccount({ since: T0, until: T0 + HOUR });
    const bRows = byAcct.filter(r => r.account_uuid === B);
    const bInput = bRows.reduce((a, r) => a + r.input_tokens, 0);
    expect(bInput).toBe(400); // the in-window message, NOT the 9_999 out-of-window one
    // And account A is present too.
    expect(byAcct.some(r => r.account_uuid === A)).toBe(true);
  });
});
