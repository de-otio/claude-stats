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

  it("combineSession takes max() of monotonic counters across versions", () => {
    // Same session, different counters: winner is the higher clock, but the
    // cumulative counters are the max seen — never lost, never double-counted.
    const older = makeRecord("s1", "aaaa0001" as DeviceId, 2);
    const newer = makeRecord("s1", "aaaa0001" as DeviceId, 5);
    const [merged] = mergeRecords([newer, older]);
    expect(merged!.session.input_tokens).toBe(50); // max(20, 50)
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
