/**
 * Phase D — CONVERGENCE properties of the pure merge core (B2).
 *
 * The merge must be a commutative, associative, idempotent monoid so any two
 * devices that pulled the same shard set converge byte-identically regardless of
 * arrival order — and it must resolve equal-COUNTER records deterministically via
 * the origin-device tiebreak, NEVER via the DB `updated_at` (B2). fast-check is
 * seeded for reproducibility.
 *
 * Synthetic fixtures only: fake hex device ids, fake session/message ids.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { DeviceId, OriginClock, StampedRecord } from "@claude-stats/core/types/shard";
import type { SessionExportPayload } from "../../backup/records.js";
import type { MessageRow, SessionRow } from "../../store/index.js";
import { combineSession, compareClock, mergeRecords, type MergedSession } from "../../sync-merge/merge.js";
import { rowToMessageRecord } from "../../sync-merge/apply.js";

// ── deterministic record construction ────────────────────────────────────────
// Content is a PURE function of (sessionId, device, counter) so two records that
// tie on the full clock key are byte-identical — the invariant the merge assumes.

const DEVICES: DeviceId[] = ["aaaa0001", "aaaa0002", "aaaa0003"] as DeviceId[];
const SESSIONS = ["s1", "s2", "s3"];

function sessionRow(sessionId: string, device: DeviceId, counter: number): SessionRow {
  return {
    session_id: sessionId,
    project_path: "/home/example/proj",
    source_file: `/home/example/.claude/projects/p/${sessionId}.jsonl`,
    first_timestamp: 1_000 + counter,
    last_timestamp: 2_000 + counter,
    claude_version: device, // descriptive marker → proves which record won LWW
    entrypoint: "cli",
    git_branch: null,
    is_interactive: 1,
    prompt_count: counter,
    assistant_message_count: counter,
    input_tokens: counter * 10,
    output_tokens: counter * 20,
    cache_creation_tokens: counter,
    cache_read_tokens: counter,
    web_search_requests: counter,
    web_fetch_requests: counter,
    tool_use_counts: "[]",
    models: JSON.stringify([device]),
    repo_url: null,
    account_uuid: null,
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: counter,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: counter,
    active_duration_ms: counter,
    median_response_time_ms: null,
  } as SessionRow;
}

function messageRow(uuid: string, sessionId: string, prompt: string): MessageRow {
  return {
    uuid,
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    claude_version: "1.0.0",
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
    prompt_text: prompt,
  } as MessageRow;
}

function makeRecord(sessionId: string, device: DeviceId, counter: number): StampedRecord<SessionExportPayload> {
  const clock: OriginClock = { wallMs: 500 + counter, counter, originDevice: device };
  const messages: MessageRow[] = [
    // Shared uuid across a session → exercises LWW-per-uuid (later clock wins).
    messageRow(`${sessionId}-shared`, sessionId, `${device}:${counter}`),
    // Per-device uuid → exercises union growth.
    messageRow(`${sessionId}-${device}`, sessionId, `${device}`),
  ];
  return { clock, value: { session: sessionRow(sessionId, device, counter), messages } };
}

// ── seeded shuffle (no bare Math.random) ─────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const norm = (m: readonly MergedSession[]): string =>
  JSON.stringify(m.map((s) => ({ clock: s.clock, session: s.session, messages: s.messages })));

const recordArb = fc.tuple(
  fc.constantFrom(...SESSIONS),
  fc.constantFrom(...DEVICES),
  fc.integer({ min: 0, max: 5 }),
).map(([sid, dev, counter]) => makeRecord(sid, dev, counter));

const recordsArb = fc.array(recordArb, { minLength: 0, maxLength: 30 });

// ─────────────────────────────────────────────────────────────────────────────

describe("merge is a convergent monoid (commutative + associative)", () => {
  it("is order-independent: any shuffle merges to the same canonical view", () => {
    fc.assert(
      fc.property(recordsArb, fc.integer({ min: 1, max: 1_000_000 }), (records, seed) => {
        const canonical = norm(mergeRecords(records));
        expect(norm(mergeRecords(shuffle(records, seed)))).toBe(canonical);
        expect(norm(mergeRecords([...records].reverse()))).toBe(canonical);
      }),
      { seed: 0x5eed, numRuns: 300 },
    );
  });

  it("associativity: merging piecewise then together equals merging all at once", () => {
    fc.assert(
      fc.property(recordsArb, recordsArb, recordsArb, (a, b, c) => {
        const all = norm(mergeRecords([...a, ...b, ...c]));
        // Re-feeding merged winners back in must not change the result.
        const partial = mergeRecords([...a, ...b]);
        const asRecords: StampedRecord<SessionExportPayload>[] = partial.map((m) => ({
          clock: m.clock,
          value: { session: m.session, messages: m.messages },
        }));
        expect(norm(mergeRecords([...asRecords, ...c]))).toBe(all);
      }),
      { seed: 0x5eed, numRuns: 200 },
    );
  });
});

describe("merge is idempotent", () => {
  it("merge(X) === merge(X ∪ X) — duplicate shards change nothing", () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const once = norm(mergeRecords(records));
        expect(norm(mergeRecords([...records, ...records]))).toBe(once);
      }),
      { seed: 0x5eed, numRuns: 300 },
    );
  });
});

describe("equal-counter records resolve on the device tiebreak, not updated_at (B2)", () => {
  it("higher origin device deterministically wins an equal-counter conflict", () => {
    const lo = makeRecord("s1", "aaaa0001" as DeviceId, 3);
    const hi = makeRecord("s1", "aaaa0002" as DeviceId, 3); // SAME counter, higher device
    expect(compareClock(lo.clock, hi.clock)).toBeLessThan(0);

    const a = mergeRecords([lo, hi]);
    const b = mergeRecords([hi, lo]);
    // Input order must not matter — both pick the higher-device snapshot.
    expect(norm(a)).toBe(norm(b));
    expect(a[0]!.session.claude_version).toBe("aaaa0002");
    expect(a[0]!.clock.originDevice).toBe("aaaa0002");
  });

  it("combineSession PROJECTS counters from the merged message union", () => {
    // Was: `max()` across versions. That is safe only while a counter can only
    // grow, and V23's usage-carrier model makes these counters SHRINK — so a
    // max() fold would let one un-upgraded peer's inflated shard pin the old
    // number on every device, permanently and unrecoverably by any clock.
    // The counters are now derived from the rows they summarise, exactly as
    // the store's own recomputeSessionAggregates derives them.
    const older = makeRecord("s1", "aaaa0001" as DeviceId, 2);
    const newer = makeRecord("s1", "aaaa0001" as DeviceId, 5);
    const [merged] = mergeRecords([newer, older]);
    // Union is 2 messages (shared uuid + one per-device uuid), 1 input token each.
    expect(merged!.messages).toHaveLength(2);
    expect(merged!.session.input_tokens).toBe(2);
    expect(merged!.session.assistant_message_count).toBe(2);
    // No is_turn_start signal anywhere in the union (pre-V18 rows have none),
    // so prompt_count keeps the last known value rather than reporting zero.
    expect(merged!.session.prompt_count).toBe(5);
    expect(merged!.clock.counter).toBe(5);
    // Union of messages: shared uuid resolves to the newer prompt; both per-device
    // uuids are the same device here so union stays 2 messages.
    expect(merged!.session.session_id).toBe("s1");
    const shared = merged!.messages.find((m) => m.uuid === "s1-shared");
    expect(shared!.prompt_text).toBe("aaaa0001:5");
  });

  it("compareClock ignores wallMs (skew must never decide)", () => {
    const a: OriginClock = { wallMs: 9_999, counter: 1, originDevice: "aaaa0001" as DeviceId };
    const b: OriginClock = { wallMs: 1, counter: 2, originDevice: "aaaa0001" as DeviceId };
    // b has the lower wall clock but the higher counter → b wins.
    expect(compareClock(a, b)).toBeLessThan(0);
  });
});

describe("combineSession algebraic laws (unit)", () => {
  const A = { clock: makeRecord("s1", "aaaa0001" as DeviceId, 1).clock, session: sessionRow("s1", "aaaa0001" as DeviceId, 1), messages: [] as MessageRow[] };
  const B = { clock: makeRecord("s1", "aaaa0002" as DeviceId, 4).clock, session: sessionRow("s1", "aaaa0002" as DeviceId, 4), messages: [] as MessageRow[] };
  const C = { clock: makeRecord("s1", "aaaa0003" as DeviceId, 2).clock, session: sessionRow("s1", "aaaa0003" as DeviceId, 2), messages: [] as MessageRow[] };

  it("commutative", () => {
    expect(JSON.stringify(combineSession(A, B))).toBe(JSON.stringify(combineSession(B, A)));
  });
  it("associative", () => {
    expect(JSON.stringify(combineSession(combineSession(A, B), C))).toBe(
      JSON.stringify(combineSession(A, combineSession(B, C))),
    );
  });
  it("idempotent", () => {
    expect(JSON.stringify(combineSession(A, A))).toBe(JSON.stringify(mergeRecords([
      { clock: A.clock, value: { session: A.session, messages: A.messages } },
    ])[0]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V23 — the cross-device half of the usage-carrier model.
//
// The release makes session token counters SHRINK. Everything below pins the
// two ways that could have gone wrong: a `max()` fold pinning the inflated
// value forever, and a sync quietly erasing another device's doubt about how a
// number was counted.

function v23Message(
  uuid: string,
  sessionId: string,
  opts: Partial<MessageRow> = {},
): MessageRow {
  return {
    uuid,
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    claude_version: "1.0.0",
    model: "claude-x",
    stop_reason: "end_turn",
    input_tokens: 0,
    output_tokens: 0,
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
    ...opts,
  } as MessageRow;
}

function stamped(
  sessionId: string,
  device: DeviceId,
  counter: number,
  messages: MessageRow[],
  sessionOverrides: Partial<SessionRow> = {},
): StampedRecord<SessionExportPayload> {
  return {
    clock: { wallMs: 500 + counter, counter, originDevice: device },
    value: {
      session: { ...sessionRow(sessionId, device, counter), ...sessionOverrides },
      messages,
    },
  };
}

describe("V23 — counters follow the repair downwards across devices", () => {
  it("an un-upgraded peer's inflated shard cannot pin the old number", () => {
    // One API response written as two transcript entries. The un-upgraded peer
    // still has both rows counting the full usage (1000 + 1000) and a session
    // row that says 2000. The repaired device has demoted the second entry to a
    // zeroed non-carrier, so the true figure is 1000.
    const stale = stamped(
      "s1",
      "aaaa0001" as DeviceId,
      1,
      [
        v23Message("e1", "s1", { input_tokens: 1_000, message_id: "msg_1", usage_counted: 1 }),
        v23Message("e2", "s1", { input_tokens: 1_000, message_id: "msg_1", usage_counted: 1 }),
      ],
      { input_tokens: 2_000 },
    );
    const repaired = stamped(
      "s1",
      "aaaa0002" as DeviceId,
      2,
      [
        v23Message("e1", "s1", {
          input_tokens: 1_000,
          message_id: "msg_1",
          usage_counted: 1,
          cost_basis: "per-response",
        }),
        v23Message("e2", "s1", {
          input_tokens: 0,
          message_id: "msg_1",
          usage_counted: 0,
          cost_basis: "per-response",
        }),
      ],
      { input_tokens: 1_000 },
    );

    for (const order of [[stale, repaired], [repaired, stale]]) {
      const [merged] = mergeRecords(order);
      expect(merged!.session.input_tokens).toBe(1_000);
      // …and the rows agree with the counter, which is the whole point of
      // projecting rather than folding.
      const rowSum = merged!.messages.reduce((n, m) => n + m.input_tokens, 0);
      expect(rowSum).toBe(merged!.session.input_tokens);
    }
  });

  it("projection is exact for every counter the store projects", () => {
    const rec = stamped(
      "s1",
      "aaaa0001" as DeviceId,
      1,
      [
        v23Message("a", "s1", {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_tokens: 7,
          cache_creation_tokens: 9,
          thinking_blocks: 2,
          web_search_requests: 1,
          web_fetch_requests: 4,
          is_throttled: 1,
          is_turn_start: 1,
        }),
        v23Message("b", "s1", { output_tokens: 1, is_turn_start: 1 }),
      ],
      { input_tokens: 999, prompt_count: 999 },
    );
    const [merged] = mergeRecords([rec]);
    const s = merged!.session;
    expect(s.input_tokens).toBe(3);
    expect(s.output_tokens).toBe(6);
    expect(s.cache_read_tokens).toBe(7);
    expect(s.cache_creation_tokens).toBe(9);
    expect(s.thinking_blocks).toBe(2);
    expect(s.web_search_requests).toBe(1);
    expect(s.web_fetch_requests).toBe(4);
    expect(s.throttle_events).toBe(1);
    expect(s.assistant_message_count).toBe(2);
    expect(s.prompt_count).toBe(2); // real is_turn_start signal wins over 999
  });

  it("a session with no messages keeps its last known counters", () => {
    // Mirrors the SQL projection's `WHERE EXISTS (SELECT 1 FROM messages)` arm:
    // with nothing to project from, a fabricated zero is worse than a stale max.
    const a = stamped("s1", "aaaa0001" as DeviceId, 1, [], { input_tokens: 40 });
    const b = stamped("s1", "aaaa0002" as DeviceId, 2, [], { input_tokens: 10 });
    const [merged] = mergeRecords([a, b]);
    expect(merged!.session.input_tokens).toBe(40);
  });
});

describe("V23 — cost_basis is worst-wins on merge", () => {
  it("a newer 'per-response' row cannot erase an older device's doubt", () => {
    const doubtful = stamped("s1", "aaaa0001" as DeviceId, 1, [
      v23Message("e1", "s1", { input_tokens: 5, cost_basis: "pre-dedupe" }),
    ]);
    const confident = stamped("s1", "aaaa0002" as DeviceId, 9, [
      v23Message("e1", "s1", { input_tokens: 5, cost_basis: "per-response" }),
    ]);
    for (const order of [[doubtful, confident], [confident, doubtful]]) {
      const [merged] = mergeRecords(order);
      expect(merged!.messages[0]!.cost_basis).toBe("pre-dedupe");
    }
  });

  it("agreement on 'per-response' survives the fold", () => {
    const a = stamped("s1", "aaaa0001" as DeviceId, 1, [
      v23Message("e1", "s1", { cost_basis: "per-response" }),
    ]);
    const b = stamped("s1", "aaaa0002" as DeviceId, 2, [
      v23Message("e1", "s1", { cost_basis: "per-response" }),
    ]);
    expect(mergeRecords([a, b])[0]!.messages[0]!.cost_basis).toBe("per-response");
  });

  it("an absent cost_basis is doubt, not permission", () => {
    // A shard written before the column existed cannot vouch for its numbers.
    const legacy = stamped("s1", "aaaa0001" as DeviceId, 1, [v23Message("e1", "s1")]);
    const [merged] = mergeRecords([legacy]);
    expect(merged!.messages[0]!.cost_basis).toBe("pre-dedupe");
  });
});

describe("V23 — rowToMessageRecord carries every persisted column", () => {
  it("restores the four V18 columns it was silently dropping", () => {
    const rec = rowToMessageRecord(
      v23Message("e1", "s1", {
        is_turn_start: 1,
        web_search_requests: 3,
        web_fetch_requests: 4,
        is_throttled: 1,
      }),
    );
    expect(rec.isTurnStart).toBe(true);
    expect(rec.webSearchRequests).toBe(3);
    expect(rec.webFetchRequests).toBe(4);
    expect(rec.isThrottled).toBe(true);
  });

  it("carries the V23 columns, defaulting an old peer's row pessimistically", () => {
    const carried = rowToMessageRecord(
      v23Message("e1", "s1", {
        message_id: "msg_1",
        usage_counted: 0,
        cost_basis: "per-response",
        effort: "xhigh",
        speed: "standard",
        thinking_tokens: 42,
      }),
    );
    expect(carried.messageId).toBe("msg_1");
    expect(carried.usageCounted).toBe(false);
    expect(carried.costBasis).toBe("per-response");
    expect(carried.effort).toBe("xhigh");
    expect(carried.speed).toBe("standard");
    expect(carried.thinkingTokens).toBe(42);

    const legacy = rowToMessageRecord(v23Message("e2", "s1"));
    expect(legacy.messageId).toBeNull();
    expect(legacy.usageCounted).toBe(true); // the column's own default
    expect(legacy.costBasis).toBe("pre-dedupe"); // unknown reads as untrusted
    // NOT 0 — an unreported thinking-token count must never read as "no thinking".
    expect(legacy.thinkingTokens).toBeNull();
  });
});
