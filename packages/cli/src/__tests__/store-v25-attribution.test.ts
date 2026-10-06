/**
 * V25 — agent attribution capture: sessions.agent_type / spawn_depth /
 * spawn_tool_use_id and messages.skill.
 *
 * Covers the migration, the latest-non-null-wins upserts on both session write
 * paths, and the sync-merge seam (export -> merge -> applyMerged), which is a
 * known lossy seam and where a shard from another device is re-validated.
 * Synthetic names only.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";
import { assertDeviceId } from "@claude-stats/core/types/shard";
import {
  deriveMaster,
  generateDek,
  generateSignKeyPair,
  generateWrapKeyPair,
  wrapDek,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";
import { utf8Encode } from "@claude-stats/core/bundle";

import { Store, SCHEMA_VERSION, type MessageRow, type SessionRow } from "../store/index.js";
import {
  DirectoryStorageTransport,
  buildSessionRecords,
  pushShard,
  type BackupCrypto,
  type DeviceIdentity,
} from "../backup/index.js";
import {
  MemoryKnownDeviceRegistry,
  applyMerged,
  mergeRecords,
  rowToMessageRecord,
  rowToSessionRecord,
  syncOnce,
} from "../sync-merge/index.js";
import { combineSession } from "../sync-merge/merge.js";
import { SHORT_TOKEN_SHAPE } from "../sync-merge/apply.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const stores: Store[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cs-v25-"));
  tmpDirs.push(d);
  return d;
}
function openStore(dbPath: string): Store {
  const s = new Store(dbPath);
  stores.push(s);
  return s;
}
function freshStore(): { store: Store; dbPath: string } {
  const dbPath = path.join(tmpDir(), "stats.db");
  return { store: openStore(dbPath), dbPath };
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sessionRecord(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    projectPath: "/home/example/proj",
    sourceFile: `/home/example/${id}.jsonl`,
    firstTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_100_000,
    claudeVersion: "2.1.72",
    entrypoint: "cli",
    gitBranch: null,
    permissionMode: null,
    isInteractive: false,
    promptCount: 0,
    assistantMessageCount: 1,
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-x"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: true,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...over,
  };
}

function messageRecord(uuid: string, sessionId: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp: 1_700_000_050_000,
    claudeVersion: "2.1.72",
    model: "claude-x",
    stopReason: "end_turn",
    inputTokens: 5,
    outputTokens: 10,
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
    toolErrorCount: 0,
    isTurnStart: false,
    webSearchRequests: 0,
    webFetchRequests: 0,
    isThrottled: false,
    ...over,
  };
}

function rawSession(dbPath: string, id: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(id) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function columnsOf(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

function metaValue(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const r = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * A database as a V24 build left it: open the CURRENT store (so every table and
 * column is real, not a hand-trimmed approximation), then take the V25 additions
 * away again and stamp the version back to 24. SQLite supports DROP COLUMN, and
 * the partial index must go first because it references the column.
 */
function makeV24Db(): string {
  const dbPath = path.join(tmpDir(), "v24.db");
  const s = new Store(dbPath);
  s.upsertSession(sessionRecord("old-sess"));
  s.upsertMessages([messageRecord("old-msg", "old-sess")]);
  s.close();
  const db = new DatabaseSync(dbPath);
  db.exec("DROP INDEX idx_sessions_agent_type");
  db.exec("ALTER TABLE sessions DROP COLUMN agent_type");
  db.exec("ALTER TABLE sessions DROP COLUMN spawn_depth");
  db.exec("ALTER TABLE sessions DROP COLUMN spawn_tool_use_id");
  db.exec("ALTER TABLE messages DROP COLUMN skill");
  db.exec("UPDATE metadata SET value = '24' WHERE key = 'schema_version'");
  db.close();
  return dbPath;
}

const NEW_SESSION_COLS = ["agent_type", "spawn_depth", "spawn_tool_use_id"];

// ── migration ────────────────────────────────────────────────────────────────

describe("V25 migration", () => {
  it("creates the columns and the partial index on a fresh store, at SCHEMA_VERSION", () => {
    const { store, dbPath } = freshStore();
    store.close();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
    expect(columnsOf(dbPath, "sessions")).toEqual(expect.arrayContaining(NEW_SESSION_COLS));
    expect(columnsOf(dbPath, "messages")).toContain("skill");
    const db = new DatabaseSync(dbPath);
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_agent_type'")
      .get() as { sql: string } | undefined;
    db.close();
    expect(idx?.sql).toMatch(/WHERE agent_type IS NOT NULL/);
  });

  it("is idempotent: opening twice neither throws nor changes the schema", () => {
    const { store, dbPath } = freshStore();
    store.close();
    const before = columnsOf(dbPath, "sessions");
    expect(() => openStore(dbPath).close()).not.toThrow();
    expect(() => openStore(dbPath).close()).not.toThrow();
    expect(columnsOf(dbPath, "sessions")).toEqual(before);
  });

  it("is idempotent when the version stamp is rolled back over existing columns", () => {
    const { store, dbPath } = freshStore();
    store.upsertSession(sessionRecord("s1", { agentType: "my-reviewer", spawnDepth: 2 }));
    store.close();
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE metadata SET value = '24' WHERE key = 'schema_version'");
    db.close();
    expect(() => openStore(dbPath).close()).not.toThrow();
    expect(rawSession(dbPath, "s1")?.["agent_type"]).toBe("my-reviewer");
    expect(metaValue(dbPath, "schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("upgrades a V24 database: columns present, existing rows NULL, data intact", () => {
    const dbPath = makeV24Db();
    expect(columnsOf(dbPath, "sessions")).not.toContain("agent_type");
    expect(columnsOf(dbPath, "messages")).not.toContain("skill");

    openStore(dbPath).close();

    expect(columnsOf(dbPath, "sessions")).toEqual(expect.arrayContaining(NEW_SESSION_COLS));
    expect(columnsOf(dbPath, "messages")).toContain("skill");
    const row = rawSession(dbPath, "old-sess");
    expect(row).toBeDefined();
    for (const c of NEW_SESSION_COLS) expect(row?.[c]).toBeNull();
    expect(row?.["input_tokens"]).toBeTypeOf("number");
    const db = new DatabaseSync(dbPath);
    const msg = db.prepare("SELECT skill, output_tokens FROM messages WHERE uuid = 'old-msg'").get() as {
      skill: unknown;
      output_tokens: number;
    };
    db.close();
    expect(msg.skill).toBeNull();
    expect(msg.output_tokens).toBe(10);
    expect(metaValue(dbPath, "schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("survives a partial fixture that lacks the sessions table (like the V24 guard)", () => {
    const dbPath = path.join(tmpDir(), "partial.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.exec("INSERT INTO metadata (key, value) VALUES ('schema_version', '24')");
    raw.close();
    expect(() => openStore(dbPath).close()).not.toThrow();
  });
});

// ── upserts ──────────────────────────────────────────────────────────────────

describe.each([
  ["upsertSession", (s: Store, r: SessionRecord) => s.upsertSession(r)],
  ["upsertSessionIncremental", (s: Store, r: SessionRecord) => s.upsertSessionIncremental(r)],
] as const)("%s — latest-non-null-wins for the V25 session columns", (_name, upsert) => {
  const full = { agentType: "my-reviewer", spawnDepth: 2, spawnToolUseId: "toolu_abc123" } as const;

  it("stores the three columns on insert", () => {
    const { store, dbPath } = freshStore();
    upsert(store, sessionRecord("s1", full));
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("my-reviewer");
    expect(row?.["spawn_depth"]).toBe(2);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_abc123");
  });

  it("a null (or undefined) update does NOT clobber known values", () => {
    const { store, dbPath } = freshStore();
    upsert(store, sessionRecord("s1", full));
    upsert(store, sessionRecord("s1", { agentType: null, spawnDepth: null, spawnToolUseId: null }));
    upsert(store, sessionRecord("s1")); // fields absent entirely
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("my-reviewer");
    expect(row?.["spawn_depth"]).toBe(2);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_abc123");
  });

  it("a newer non-null value replaces the older one", () => {
    const { store, dbPath } = freshStore();
    upsert(store, sessionRecord("s1", full));
    upsert(store, sessionRecord("s1", { agentType: "acme-critic", spawnDepth: 3, spawnToolUseId: "toolu_def456" }));
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("acme-critic");
    expect(row?.["spawn_depth"]).toBe(3);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_def456");
  });

  it("each column is independent (partial update keeps the others)", () => {
    const { store, dbPath } = freshStore();
    upsert(store, sessionRecord("s1", full));
    upsert(store, sessionRecord("s1", { agentType: "acme-critic" }));
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("acme-critic");
    expect(row?.["spawn_depth"]).toBe(2);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_abc123");
  });

  it("an absent record field is stored as NULL, not a string", () => {
    const { store, dbPath } = freshStore();
    upsert(store, sessionRecord("s1"));
    const row = rawSession(dbPath, "s1");
    for (const c of NEW_SESSION_COLS) expect(row?.[c]).toBeNull();
  });

  it("round-trips through getSessions (the SELECT * the export path uses)", () => {
    const { store } = freshStore();
    upsert(store, sessionRecord("s1", full));
    const [row] = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(row?.agent_type).toBe("my-reviewer");
    expect(row?.spawn_depth).toBe(2);
    expect(row?.spawn_tool_use_id).toBe("toolu_abc123");
  });
});

describe("upsertMessages — skill", () => {
  it("stores skill; NULL does not clobber; a newer non-null replaces", () => {
    const { store } = freshStore();
    store.upsertSession(sessionRecord("s1"));
    store.upsertMessages([messageRecord("m1", "s1", { skill: "example-skill" })]);
    expect(store.getSessionMessages("s1")[0]?.skill).toBe("example-skill");

    store.upsertMessages([messageRecord("m1", "s1", { skill: null })]);
    store.upsertMessages([messageRecord("m1", "s1")]); // field absent
    expect(store.getSessionMessages("s1")[0]?.skill).toBe("example-skill");

    store.upsertMessages([messageRecord("m1", "s1", { skill: "acme-critic" })]);
    expect(store.getSessionMessages("s1")[0]?.skill).toBe("acme-critic");
  });

  it("a message with no skill reads NULL", () => {
    const { store } = freshStore();
    store.upsertSession(sessionRecord("s1"));
    store.upsertMessages([messageRecord("m1", "s1")]);
    expect(store.getSessionMessages("s1")[0]?.skill).toBeNull();
  });
});

describe("session aggregates projection leaves the V25 columns alone", () => {
  it("recomputeSessionAggregates does not touch agent_type / spawn_* / skill", () => {
    const { store, dbPath } = freshStore();
    store.upsertSession(sessionRecord("s1", { agentType: "my-reviewer", spawnDepth: 1, spawnToolUseId: "toolu_x1" }));
    store.upsertMessages([messageRecord("m1", "s1", { skill: "example-skill" })]);
    store.recomputeSessionAggregates(["s1"]);
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("my-reviewer");
    expect(row?.["spawn_depth"]).toBe(1);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_x1");
    expect(store.getSessionMessages("s1")[0]?.skill).toBe("example-skill");
  });
});

// ── sync-merge ───────────────────────────────────────────────────────────────

const DEVICE_A = assertDeviceId("deadbeefcafe0001");
const DEVICE_B = assertDeviceId("deadbeefcafe0002");

function exportRecords(src: Store, wallMs = 1, device = DEVICE_A, counter = 0) {
  const sessions = src.getSessions({ includeCI: true, includeDeleted: true });
  return buildSessionRecords(sessions, (id) => src.getSessionMessages(id), {
    originDevice: device,
    localSourceFiles: new Set(sessions.map((s) => s.source_file)),
    wallMs,
    startCounter: counter,
  });
}

describe("sync round trip (export -> merge -> applyMerged)", () => {
  it("preserves every V25 column into a fresh store", () => {
    const { store: src } = freshStore();
    src.upsertSession(
      sessionRecord("s1", { agentType: "my-reviewer", spawnDepth: 2, spawnToolUseId: "toolu_abc123" }),
    );
    src.upsertMessages([
      messageRecord("m1", "s1", { skill: "example-skill", effort: "high", speed: "fast" }),
      messageRecord("m2", "s1"),
    ]);

    const { store: dst, dbPath } = freshStore();
    const result = applyMerged(dst, mergeRecords(exportRecords(src)));
    expect(result.sessionsApplied).toBe(1);

    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("my-reviewer");
    expect(row?.["spawn_depth"]).toBe(2);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_abc123");
    const msgs = dst.getSessionMessages("s1");
    expect(msgs.find((m) => m.uuid === "m1")?.skill).toBe("example-skill");
    expect(msgs.find((m) => m.uuid === "m1")?.effort).toBe("high");
    expect(msgs.find((m) => m.uuid === "m1")?.speed).toBe("fast");
    expect(msgs.find((m) => m.uuid === "m2")?.skill).toBeNull();
  });

  it("goes through a real encrypted shard push and syncOnce", async () => {
    const { store: src } = freshStore();
    src.upsertSession(
      sessionRecord("s1", { agentType: "acme-critic", spawnDepth: 3, spawnToolUseId: "toolu_zz9" }),
    );
    src.upsertMessages([messageRecord("m1", "s1", { skill: "example-skill" })]);

    const argon: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };
    const dek = generateDek();
    const kdfSalt = generateKdfSalt();
    const master = deriveMaster(utf8Encode("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23"), kdfSalt, argon);
    const crypto: BackupCrypto = {
      dek,
      passphraseWrappedDek: wrapDek(dek, [{ kind: "passphrase", masterKey: master }]),
      kdfSalt,
      kdfParams: argon,
    };
    const wrap = generateWrapKeyPair();
    const sig = generateSignKeyPair();
    const identity: DeviceIdentity = {
      deviceId: DEVICE_B,
      wrapPublicKey: wrap.publicKey,
      signPublicKey: sig.publicKey,
      signingSecretKey: sig.secretKey,
    };
    const transport = new DirectoryStorageTransport(tmpDir());
    await pushShard({
      transport,
      identity,
      crypto,
      encryptSyncData: true,
      records: exportRecords(src, 1, DEVICE_B),
      seq: 0,
      enrolledAt: 1,
    });

    const { store: dst, dbPath } = freshStore();
    const status = await syncOnce({
      transport,
      dek,
      store: dst,
      self: DEVICE_A,
      registry: new MemoryKnownDeviceRegistry([DEVICE_B]),
      now: () => 1,
    });
    expect(status.ok).toBe(true);
    const row = rawSession(dbPath, "s1");
    expect(row?.["agent_type"]).toBe("acme-critic");
    expect(row?.["spawn_depth"]).toBe(3);
    expect(row?.["spawn_tool_use_id"]).toBe("toolu_zz9");
    expect(dst.getSessionMessages("s1")[0]?.skill).toBe("example-skill");
  });

  it("a newer snapshot that predates V25 (NULLs) does not erase the older one's attribution", () => {
    const { store: older } = freshStore();
    older.upsertSession(
      sessionRecord("s1", { agentType: "my-reviewer", spawnDepth: 2, spawnToolUseId: "toolu_abc123" }),
    );
    older.upsertMessages([messageRecord("m1", "s1", { skill: "example-skill" })]);
    const { store: newer } = freshStore();
    newer.upsertSession(sessionRecord("s1"));
    newer.upsertMessages([messageRecord("m1", "s1")]);

    const records = [...exportRecords(older, 1, DEVICE_A), ...exportRecords(newer, 2, DEVICE_B)];
    const merged = mergeRecords(records);
    expect(merged[0]?.session.agent_type).toBe("my-reviewer");
    expect(merged[0]?.session.spawn_depth).toBe(2);
    expect(merged[0]?.session.spawn_tool_use_id).toBe("toolu_abc123");
    expect(merged[0]?.messages[0]?.skill).toBe("example-skill");
    // order-free
    expect(mergeRecords([...records].reverse())).toEqual(merged);
  });

  it("a newer snapshot with a value replaces the older one's value", () => {
    const { store: older } = freshStore();
    older.upsertSession(sessionRecord("s1", { agentType: "my-reviewer", spawnDepth: 1 }));
    const { store: newer } = freshStore();
    newer.upsertSession(sessionRecord("s1", { agentType: "acme-critic", spawnDepth: 2 }));
    const merged = mergeRecords([...exportRecords(older, 1, DEVICE_A), ...exportRecords(newer, 2, DEVICE_B)]);
    expect(merged[0]?.session.agent_type).toBe("acme-critic");
    expect(merged[0]?.session.spawn_depth).toBe(2);
  });

  it("combineSession stays idempotent and does not add keys to rows that never had them", () => {
    const { store: s } = freshStore();
    s.upsertSession(sessionRecord("s1"));
    const merged = mergeRecords(exportRecords(s));
    const m = merged[0]!;
    expect(combineSession(m, m)).toEqual(m);
    expect(mergeRecords([...exportRecords(s), ...exportRecords(s)])).toEqual(merged);
  });
});

// ── hostile shard rows ───────────────────────────────────────────────────────

function hostileSessionRow(over: Record<string, unknown>): SessionRow {
  return {
    session_id: "h1",
    project_path: "/home/example/p",
    source_file: "/home/example/h1.jsonl",
    first_timestamp: 100,
    last_timestamp: 200,
    claude_version: "1",
    entrypoint: "cli",
    git_branch: null,
    is_interactive: 0,
    prompt_count: 0,
    assistant_message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    web_search_requests: 0,
    web_fetch_requests: 0,
    tool_use_counts: "[]",
    models: "[]",
    repo_url: null,
    account_uuid: null,
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 1,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: null,
    median_response_time_ms: null,
    ...over,
  } as SessionRow;
}

function hostileMessageRow(over: Record<string, unknown>): MessageRow {
  return {
    uuid: "hm1",
    session_id: "h1",
    timestamp: 150,
    claude_version: "1",
    model: "claude-x",
    stop_reason: "end_turn",
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tools: "[]",
    file_paths: "[]",
    thinking_blocks: 0,
    service_tier: null,
    inference_geo: null,
    ephemeral_5m_cache_tokens: 0,
    ephemeral_1h_cache_tokens: 0,
    prompt_text: null,
    ...over,
  } as MessageRow;
}

const HOSTILE_IDENTIFIERS = [
  "../../x",
  "A".repeat(10 * 1024),
  "<script>alert(1)</script>",
  "/etc/passwd",
  "@evil",
  "=cmd",
  "has space",
  "",
  42,
  { toString: "x" },
];

describe("a hostile shard row lands as NULL", () => {
  it.each(HOSTILE_IDENTIFIERS.map((v, i) => [i, v] as const))("agent_type #%i", (_i, value) => {
    expect(rowToSessionRecord(hostileSessionRow({ agent_type: value })).agentType).toBeNull();
    const { store, dbPath } = freshStore();
    applyMerged(store, [
      { clock: { wallMs: 1, counter: 0, originDevice: DEVICE_B }, session: hostileSessionRow({ agent_type: value }), messages: [] },
    ]);
    expect(rawSession(dbPath, "h1")?.["agent_type"]).toBeNull();
  });

  it.each(HOSTILE_IDENTIFIERS.map((v, i) => [i, v] as const))("skill #%i", (_i, value) => {
    expect(rowToMessageRecord(hostileMessageRow({ skill: value })).skill).toBeNull();
    const { store } = freshStore();
    applyMerged(store, [
      {
        clock: { wallMs: 1, counter: 0, originDevice: DEVICE_B },
        session: hostileSessionRow({}),
        messages: [hostileMessageRow({ skill: value })],
      },
    ]);
    expect(store.getSessionMessages("h1")[0]?.skill).toBeNull();
  });

  it.each([99, 0, -1, "2", 1.5, NaN, 17, null, undefined, {}])("spawn_depth %j", (value) => {
    expect(rowToSessionRecord(hostileSessionRow({ spawn_depth: value })).spawnDepth).toBeNull();
  });

  it.each(["x", "toolu_", "toolu_bad id", "../toolu_x", `toolu_${"a".repeat(200)}`, 7, null])(
    "spawn_tool_use_id %j",
    (value) => {
      expect(rowToSessionRecord(hostileSessionRow({ spawn_tool_use_id: value })).spawnToolUseId).toBeNull();
    },
  );

  it.each(["HIGH", "a b", "x".repeat(11), "x".repeat(10_000), "hi-gh", "", 1, { a: 1 }])(
    "effort / speed %j",
    (value) => {
      const rec = rowToMessageRecord(hostileMessageRow({ effort: value, speed: value }));
      expect(rec.effort).toBeNull();
      expect(rec.speed).toBeNull();
    },
  );

  it("valid values pass through unchanged", () => {
    const s = rowToSessionRecord(
      hostileSessionRow({ agent_type: "my-reviewer", spawn_depth: 16, spawn_tool_use_id: "toolu_bdrk_abc" }),
    );
    expect(s.agentType).toBe("my-reviewer");
    expect(s.spawnDepth).toBe(16);
    expect(s.spawnToolUseId).toBe("toolu_bdrk_abc");
    const m = rowToMessageRecord(hostileMessageRow({ skill: "example-skill", effort: "high", speed: "fast" }));
    expect(m.skill).toBe("example-skill");
    expect(m.effort).toBe("high");
    expect(m.speed).toBe("fast");
  });

  it("columns absent altogether (a peer older than V25) read as null", () => {
    const s = rowToSessionRecord(hostileSessionRow({}));
    expect([s.agentType, s.spawnDepth, s.spawnToolUseId]).toEqual([null, null, null]);
    expect(rowToMessageRecord(hostileMessageRow({})).skill).toBeNull();
  });
});

// ── applyMerged keeps session counters = projection of stored messages ───────

describe("applyMerged re-projects session counters from the stored messages", () => {
  it("a shard with two carriers for one (session, message_id) lands with projected counters", () => {
    const { store, dbPath } = freshStore();
    // The peer's shard claims BOTH entries of one response carry usage, and its
    // session counters sum them (an un-upgraded or inconsistent peer).
    const carrier = {
      session_id: "c1",
      message_id: "msg_dup1",
      usage_counted: 1,
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 7,
      cache_creation_tokens: 3,
    };
    applyMerged(store, [
      {
        clock: { wallMs: 1, counter: 0, originDevice: DEVICE_B },
        session: hostileSessionRow({
          session_id: "c1",
          input_tokens: 200,
          output_tokens: 80,
          cache_read_tokens: 14,
          cache_creation_tokens: 6,
          assistant_message_count: 2,
        }),
        messages: [
          hostileMessageRow({ ...carrier, uuid: "c1-a" }),
          hostileMessageRow({ ...carrier, uuid: "c1-b", timestamp: 151 }),
        ],
      },
    ]);

    const msgs = store.getSessionMessages("c1");
    expect(msgs).toHaveLength(2);
    // upsertMessages demoted the second carrier...
    expect(msgs.filter((m) => m.usage_counted === 1)).toHaveLength(1);
    const sum = (k: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens") =>
      msgs.reduce((acc, m) => acc + m[k], 0);
    // ...and the session row follows the stored rows, not the shard's sums.
    const row = rawSession(dbPath, "c1");
    expect(row?.["input_tokens"]).toBe(sum("input_tokens"));
    expect(row?.["output_tokens"]).toBe(sum("output_tokens"));
    expect(row?.["cache_read_tokens"]).toBe(sum("cache_read_tokens"));
    expect(row?.["cache_creation_tokens"]).toBe(sum("cache_creation_tokens"));
    // Pinned absolutely too, so a projection that double-counted the messages
    // could not pass by agreeing with an equally wrong message sum.
    expect([row?.["input_tokens"], row?.["output_tokens"], row?.["cache_read_tokens"], row?.["cache_creation_tokens"]])
      .toEqual([100, 40, 7, 3]);
    expect(row?.["assistant_message_count"]).toBe(2);
  });

  it("does not re-project sessions it skipped as this device's own", () => {
    const { store, dbPath } = freshStore();
    store.upsertSession(sessionRecord("own", { inputTokens: 999 }));
    // A local message whose sum disagrees with the stored counter: a projection
    // would rewrite it, so an untouched 999 proves the skip held.
    store.upsertMessages([messageRecord("own-m", "own", { inputTokens: 5 })]);
    const result = applyMerged(
      store,
      [{ clock: { wallMs: 1, counter: 0, originDevice: DEVICE_A }, session: hostileSessionRow({ session_id: "own" }), messages: [] }],
      { selfDeviceId: DEVICE_A },
    );
    expect(result.skippedOwnDevice).toBe(1);
    expect(rawSession(dbPath, "own")?.["input_tokens"]).toBe(999);
  });
});

// ── SHORT_TOKEN_SHAPE must agree with the parser's SHORT_TOKEN_RE ────────────

describe("effort/speed shape agrees with the parser", () => {
  it("apply.ts's regex matches packages/core/src/parser/session.ts's SHORT_TOKEN_RE", () => {
    const parserSrc = fs.readFileSync(
      path.resolve(__dirname, "../../../core/src/parser/session.ts"),
      "utf8",
    );
    const m = /const SHORT_TOKEN_RE = \/(.+)\/([a-z]*);/.exec(parserSrc);
    expect(m).not.toBeNull();
    const parserRe = new RegExp(m![1]!, m![2]!);
    expect(SHORT_TOKEN_SHAPE.source).toBe(parserRe.source);
    expect(SHORT_TOKEN_SHAPE.flags).toBe(parserRe.flags);

    const samples = [
      "low", "medium", "high", "xhigh", "max", "standard", "fast", "a", "abcdefghij", "abcdefghijk",
      "HIGH", "High", "a b", "a-b", "a_b", "a1", "", " ", "high\n", "\nhigh", "../x", "é", "x".repeat(5000),
    ];
    for (const s of samples) expect(SHORT_TOKEN_SHAPE.test(s), JSON.stringify(s)).toBe(parserRe.test(s));
  });
});
