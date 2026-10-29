/**
 * V28 (E1) — the request-record link across the sync-merge seam.
 *
 * `messages.request_ref` is another device's output, so it is re-validated
 * where it enters this device's store (`rowToMessageRecord`), and the merge
 * fold is latest-non-null-wins, mirroring `skill` (V25): a newer snapshot
 * that predates the column must not erase what an older one knew. The
 * store's COALESCE never-clear is the last line of defence on re-apply.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DeviceId, StampedRecord } from "@claude-stats/core/types/shard";
import type { SessionExportPayload } from "../../backup/records.js";
import { Store, type MessageRow, type SessionRow } from "../../store/index.js";
import { applyMerged, mergeRecords, rowToMessageRecord } from "../../sync-merge/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const stores: Store[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cs-e1-merge-"));
  tmpDirs.push(d);
  return d;
}
function freshStore(): { store: Store; dbPath: string } {
  const dbPath = path.join(tmpDir(), "stats.db");
  const store = new Store(dbPath);
  stores.push(store);
  return { store, dbPath };
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

function sessionRow(sessionId: string): SessionRow {
  return {
    session_id: sessionId,
    project_path: "/home/example/proj",
    source_file: `/home/example/.claude/projects/p/${sessionId}.jsonl`,
    first_timestamp: 1_700_000_000_000,
    last_timestamp: 1_700_000_100_000,
    claude_version: "2.1.301",
    entrypoint: "cli",
    git_branch: null,
    is_interactive: 1,
    prompt_count: 1,
    assistant_message_count: 1,
    input_tokens: 1,
    output_tokens: 2,
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
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: null,
    median_response_time_ms: null,
  } as SessionRow;
}

function messageRow(uuid: string, sessionId: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    uuid,
    session_id: sessionId,
    timestamp: 1_700_000_050_000,
    claude_version: "2.1.301",
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    input_tokens: 1,
    output_tokens: 2,
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

/** A stamped shard record for `sessionId` at logical clock `counter`. */
function stamped(
  sessionId: string,
  device: DeviceId,
  counter: number,
  messages: MessageRow[],
): StampedRecord<SessionExportPayload> {
  return {
    clock: { wallMs: 500 + counter, counter, originDevice: device },
    value: { session: sessionRow(sessionId), messages },
  };
}

// ── rowToMessageRecord — validation where the value enters ────────────────────

const HOSTILE_REQUEST_REFS = [
  "../../x",
  "r".repeat(129), // IDENTIFIER_RE caps at 128
  "<script>alert(1)</script>",
  "/etc/passwd",
  "@evil",
  "=cmd",
  "has space",
  "req\u0001with-control",
  "",
  42,
  { toString: "x" },
];

describe("rowToMessageRecord validates request_ref", () => {
  it("a valid request id passes through unchanged", () => {
    expect(rowToMessageRecord(messageRow("m1", "s1", { request_ref: "req_1" })).requestRef).toBe("req_1");
  });

  it.each(HOSTILE_REQUEST_REFS.map((v, i) => [i, v] as const))("hostile value #%i lands as NULL", (_i, value) => {
    expect(rowToMessageRecord(messageRow("m1", "s1", { request_ref: value as never })).requestRef).toBeNull();
  });

  it("a column absent altogether (a peer older than V28) reads as null", () => {
    const row = messageRow("m1", "s1");
    delete (row as Partial<MessageRow>).request_ref;
    expect(rowToMessageRecord(row).requestRef).toBeNull();
  });
});

// ── unionMessages — the merge fold is latest-non-null-wins ───────────────────

describe("mergeRecords folds request_ref latest-non-null-wins (mirrors skill)", () => {
  const A = "aaaa0001" as DeviceId;
  const B = "aaaa0002" as DeviceId;

  it("the higher-clock row's non-null value wins", () => {
    const older = stamped("s1", A, 1, [messageRow("m1", "s1", { request_ref: "req_old" })]);
    const newer = stamped("s1", B, 2, [messageRow("m1", "s1", { request_ref: "req_new" })]);
    for (const order of [[older, newer], [newer, older]] as const) {
      const [merged] = mergeRecords(order);
      expect(merged!.messages[0]!.request_ref).toBe("req_new");
    }
  });

  it("a higher-clock row that predates the column (NULL) does not erase the older value", () => {
    // The pre-V28 peer's shard carries no request_ref at all: the spread
    // leaves it undefined, which must fold as "no opinion", not as a clear.
    const older = stamped("s1", A, 1, [messageRow("m1", "s1", { request_ref: "req_1" })]);
    const newerRow = messageRow("m1", "s1");
    delete (newerRow as Partial<MessageRow>).request_ref;
    const newer = stamped("s1", B, 2, [newerRow]);
    for (const order of [[older, newer], [newer, older]] as const) {
      const [merged] = mergeRecords(order);
      expect(merged!.messages[0]!.request_ref).toBe("req_1");
    }
  });

  it("both sides NULL stays unset", () => {
    const a = stamped("s1", A, 1, [messageRow("m1", "s1")]);
    const b = stamped("s1", B, 2, [messageRow("m1", "s1")]);
    const [merged] = mergeRecords([a, b]);
    expect(merged!.messages[0]!.request_ref ?? null).toBeNull();
  });

  it("the fold converges for any arrival order and is idempotent", () => {
    const a = stamped("s1", A, 1, [messageRow("m1", "s1", { request_ref: "req_1" })]);
    const b = stamped("s1", B, 2, [messageRow("m1", "s1", { request_ref: "req_2" })]);
    const c = stamped("s1", "aaaa0003" as DeviceId, 3, [messageRow("m1", "s1", { request_ref: null })]);
    const canonical = JSON.stringify(mergeRecords([a, b, c]));
    expect(JSON.stringify(mergeRecords([c, b, a]))).toBe(canonical);
    expect(JSON.stringify(mergeRecords([...mergeRecords([a, b]), ...mergeRecords([c])].map((m) => ({
      clock: m.clock,
      value: { session: m.session, messages: m.messages },
    }))))).toBe(canonical);
  });
});

// ── applyMerged — the store's COALESCE never-clear is the last defence ───────

describe("applyMerged never clears a stored request_ref", () => {
  it("re-applying an older shard whose row carries no request_ref keeps the value", () => {
    const { store } = freshStore();
    const newer = stamped("s1", "aaaa0002" as DeviceId, 2, [messageRow("m1", "s1", { request_ref: "req_1" })]);
    applyMerged(store, mergeRecords([newer]));
    expect(store.getSessionMessages("s1")[0]!.request_ref).toBe("req_1");

    // A pre-V28 peer's shard: same message uuid, no request_ref column value.
    // The merge fold keeps "req_1"; even a direct re-apply of the bare row
    // must not clear it (COALESCE never-clear in upsertMessages).
    const olderRow = messageRow("m1", "s1");
    delete (olderRow as Partial<MessageRow>).request_ref;
    const older = stamped("s1", "aaaa0001" as DeviceId, 1, [olderRow]);
    applyMerged(store, mergeRecords([older, newer]));
    expect(store.getSessionMessages("s1")[0]!.request_ref).toBe("req_1");
    applyMerged(store, mergeRecords([older]));
    expect(store.getSessionMessages("s1")[0]!.request_ref).toBe("req_1");
  });

  it("a hostile request_ref in a shard lands as NULL, not stored raw", () => {
    const { store } = freshStore();
    const shard = stamped("s1", "aaaa0002" as DeviceId, 1, [
      messageRow("m1", "s1", { request_ref: "<script>alert(1)</script>" }),
    ]);
    applyMerged(store, mergeRecords([shard]));
    expect(store.getSessionMessages("s1")[0]!.request_ref).toBeNull();
  });
});
