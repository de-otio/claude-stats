import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store, validateTag } from "../store/index.js";
import type { SessionRecord, FileCheckpoint, ParseError } from "@claude-stats/core/types";
import os from "os";
import path from "path";
import fs from "fs";

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

  it("inserts message records", () => {
    store.upsertMessages([
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const status = store.getStatus();
    expect(status.messageCount).toBe(1);
  });

  it("upserts on uuid conflict", () => {
    const msg = { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null };
    store.upsertMessages([msg]);
    store.upsertMessages([{ ...msg, inputTokens: 200 }]);
    const status = store.getStatus();
    expect(status.messageCount).toBe(1); // not doubled
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
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m3", sessionId: "s1", timestamp: 1002, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m4", sessionId: "s1", timestamp: 1003, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "max_tokens", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);
    const counts = store.getStopReasonCounts(["s1"]);
    expect(counts.get("end_turn")).toBe(2);
    expect(counts.get("tool_use")).toBe(1);
    expect(counts.get("max_tokens")).toBe(1);
  });

  it("excludes null stop_reason messages", () => {
    store.upsertMessages([
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: null, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
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
      { uuid: "m3", sessionId: "s1", timestamp: 3000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: ["Read"], thinkingBlocks: 1, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 2000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, tools: ["Edit", "Read"], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
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
      { uuid: "m1", sessionId: "s1", timestamp: 1000, claudeVersion: "v1", model: "claude-opus-4", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m2", sessionId: "s1", timestamp: 2000, claudeVersion: "v1", model: "claude-opus-4", stopReason: "end_turn", inputTokens: 200, outputTokens: 80, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m3", sessionId: "s2", timestamp: 3000, claudeVersion: "v1", model: "claude-sonnet-4", stopReason: "end_turn", inputTokens: 50, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
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
      { uuid: "m-cheap", sessionId: "cheap", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-sonnet-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "m-expensive", sessionId: "expensive", timestamp: 2000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100_000, outputTokens: 50_000, cacheCreationTokens: 5_000, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
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
