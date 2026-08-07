/**
 * Schema V22 storage seam — `api_error_events` (`Store#migrateToV22`'s doc
 * comment has the full design rationale).
 *
 * What's under test: the migration lands cleanly on both a fresh DB and an
 * upgrade path, the upsert is idempotent by `uuid` (a re-parsed byte range
 * must not duplicate a row), and the period-scoped read is what
 * `summarizeApiThrottle` actually consumes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store/index.js";
import type { ApiErrorEvent, SessionRecord } from "@claude-stats/core/types";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-api-throttle-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: 1_000_000, lastTimestamp: 1_010_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-opus-4-6"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function event(overrides: Partial<ApiErrorEvent> & { uuid: string; sessionId: string }): ApiErrorEvent {
  return {
    timestamp: 1_005_000,
    terminal: false,
    kind: "server_error",
    status: 529,
    retryInMs: 1_000,
    retryAttempt: 1,
    isNetworkDown: false,
    ...overrides,
  };
}

describe("schema V22 migration", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { try { fs.unlinkSync(dbPath); } catch { /* best effort */ } });

  it("creates api_error_events on a fresh database and reports version 22", () => {
    const store = new Store(dbPath);
    store.close();
    const raw = new DatabaseSync(dbPath);
    const version = raw
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("22");
    const cols = raw.prepare("PRAGMA table_info(api_error_events)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ["is_network_down", "kind", "retry_attempt", "retry_in_ms", "session_id", "status", "terminal", "timestamp", "uuid"].sort(),
    );
    raw.close();
  });

  it("lands cleanly on a V21 database (upgrade path) without touching existing tables", () => {
    // Simulate a pre-V22 database by creating one, then manually resetting
    // the stamped version, exactly like `task-class-store.test.ts` does for
    // its own migration boundary.
    const store1 = new Store(dbPath);
    store1.upsertSession(session("s1"));
    store1.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE metadata SET value = '21' WHERE key = 'schema_version'").run();
    raw.close();

    const store2 = new Store(dbPath); // re-opens, should run migrateToV22
    expect(store2.getApiErrorEvents()).toEqual([]);
    store2.close();

    const raw2 = new DatabaseSync(dbPath);
    const version = raw2
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("22");
    // The existing session survived the migration untouched.
    const s = raw2.prepare("SELECT session_id FROM sessions WHERE session_id = 's1'").get();
    expect(s).toBeTruthy();
    raw2.close();
  });
});

describe("Store#upsertApiErrorEvents / getApiErrorEvents", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(session("s1"));
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("round-trips every field exactly", () => {
    const e = event({
      uuid: "evt-1", sessionId: "s1", timestamp: 42_000, terminal: true,
      kind: "rate_limit", status: 429, retryInMs: null, retryAttempt: null, isNetworkDown: false,
    });
    store.upsertApiErrorEvents([e]);
    const got = store.getApiErrorEvents();
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(e);
  });

  it("does nothing on an empty array (no-op, not an error)", () => {
    expect(() => store.upsertApiErrorEvents([])).not.toThrow();
    expect(store.getApiErrorEvents()).toEqual([]);
  });

  it("is idempotent by uuid — a re-parsed byte range upserts, never duplicates", () => {
    const e1 = event({ uuid: "evt-dup", sessionId: "s1", retryAttempt: 1, retryInMs: 500 });
    store.upsertApiErrorEvents([e1]);
    // Same uuid, "corrected" retry data — simulates a re-parse of the same line.
    const e2 = event({ uuid: "evt-dup", sessionId: "s1", retryAttempt: 1, retryInMs: 750 });
    store.upsertApiErrorEvents([e2]);
    const got = store.getApiErrorEvents();
    expect(got).toHaveLength(1);
    expect(got[0]!.retryInMs).toBe(750);
  });

  it("filters by since/until (period scope), inclusive on both ends", () => {
    store.upsertApiErrorEvents([
      event({ uuid: "e-before", sessionId: "s1", timestamp: 100 }),
      event({ uuid: "e-in", sessionId: "s1", timestamp: 500 }),
      event({ uuid: "e-at-since", sessionId: "s1", timestamp: 200 }),
      event({ uuid: "e-at-until", sessionId: "s1", timestamp: 800 }),
      event({ uuid: "e-after", sessionId: "s1", timestamp: 1_000 }),
    ]);
    const got = store.getApiErrorEvents({ since: 200, until: 800 });
    const uuids = got.map((e) => e.uuid).sort();
    expect(uuids).toEqual(["e-at-since", "e-at-until", "e-in"]);
  });

  it("returns events across multiple sessions when no filter is given", () => {
    store.upsertSession(session("s2"));
    store.upsertApiErrorEvents([
      event({ uuid: "e-s1", sessionId: "s1" }),
      event({ uuid: "e-s2", sessionId: "s2" }),
    ]);
    const got = store.getApiErrorEvents();
    expect(got.map((e) => e.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("N-1: scopes by accountUuid through the session join — api_error_events has no account_uuid column of its own", () => {
    // Two accounts on one machine, each with a rejection. Without account
    // scoping (the verified defect) a per-account caveat like "your
    // account's rate-limit tier" would be rendered beside a count that
    // silently pooled BOTH accounts' events.
    store.upsertSession(session("s2", { accountUuid: "acct-B" }));
    // s1 was seeded with accountUuid: null in beforeEach — give it a real one.
    store.upsertSession(session("s1", { accountUuid: "acct-A" }));
    store.upsertApiErrorEvents([
      event({ uuid: "e-a", sessionId: "s1" }),
      event({ uuid: "e-b", sessionId: "s2" }),
    ]);
    const forA = store.getApiErrorEvents({ accountUuid: "acct-A" });
    const forB = store.getApiErrorEvents({ accountUuid: "acct-B" });
    expect(forA.map((e) => e.uuid)).toEqual(["e-a"]);
    expect(forB.map((e) => e.uuid)).toEqual(["e-b"]);
    // Unscoped still returns both — scoping is opt-in, not a behaviour change
    // for existing callers.
    expect(store.getApiErrorEvents().map((e) => e.uuid).sort()).toEqual(["e-a", "e-b"]);
  });

  it("N-1: scopes by projectPath through the same session join", () => {
    store.upsertSession(session("s2", { projectPath: "/w/beta" }));
    store.upsertApiErrorEvents([
      event({ uuid: "e-alpha", sessionId: "s1" }), // s1 is /w/alpha (default)
      event({ uuid: "e-beta", sessionId: "s2" }),
    ]);
    const got = store.getApiErrorEvents({ projectPath: "/w/beta" });
    expect(got.map((e) => e.uuid)).toEqual(["e-beta"]);
  });
});
