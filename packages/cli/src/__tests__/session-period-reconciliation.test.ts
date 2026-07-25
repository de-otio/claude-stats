/**
 * Regression tests for the "0 sessions beside a non-zero cost" dashboard bug.
 *
 * The dashboard computes its headline cost / active-hours from MESSAGE
 * timestamps but its sessions / prompts / token counts from the SESSION set.
 * Those two reads must select the same work. They desynced because
 * `sessions.last_timestamp` — a cache of the session's max message timestamp —
 * was being overwritten with NULL by both upsert paths whenever a parse chunk
 * contained no timestamped entry (SQLite's scalar `max()` also returns NULL if
 * ANY argument is NULL). A NULL `last_timestamp` beside an early
 * `first_timestamp` then failed the `activeSince` predicate, so the session
 * vanished from the period while its messages still priced into the headline.
 *
 * Fixing that exposed a second, independent way the two halves disagreed: the
 * `sessions` token columns are LIFETIME totals, so summing them into a window
 * dragged a straddling session's entire history in (a week-long session put 7.1
 * BILLION cache reads into one day), and `byDay`/`byHour` keyed that lifetime
 * total to the session's FIRST timestamp. Period aggregates are now sourced from
 * `messages` — the same read cost is priced from.
 *
 * The tests are grouped by the layer they pin:
 *   1. the writes must never destroy a known-good last_timestamp,
 *   2. the read must find in-window sessions even if the cache IS wrong,
 *   3. the migration must repair rows already corrupted on disk,
 *   4. an end-to-end invariant that fails for ANY future cause of the same
 *      class of desync, not just this one,
 *   5. tokens are attributed to when they were SENT, not to a session's start,
 *   6. a narrowing filter applies to BOTH halves or neither.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import fs from "fs";

// The fixtures below carry no account_uuid, so pin "no current account" —
// readClaudeAccount() returns ClaudeAccount | null, never a uuid-less object.
// Without the mock the dashboard would read the developer's real ~/.claude.json
// and attribute the fixture sessions to whoever ran the suite.
vi.mock("../account.js", () => ({
  readClaudeAccount: () => null,
}));

import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { estimateCost } from "@claude-stats/core/pricing";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dbPath: string;
let store: Store;

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "s1",
    projectPath: "/Users/alice/repos/p",
    sourceFile: "/Users/alice/.claude/projects/p/s1.jsonl",
    firstTimestamp: 1_000_000,
    lastTimestamp: 1_005_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 3,
    assistantMessageCount: 3,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4"],
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
    ...over,
  };
}

function makeMessage(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid: "m1",
    sessionId: "s1",
    timestamp: 1_000_000,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 50,
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
    // Default to "this message answered a real user prompt" so fixtures report a
    // non-zero period prompt count, the way collected data does.
    isTurnStart: true,
    ...over,
  };
}

function rawLastTimestamp(sessionId: string): number | null {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw
    .prepare("SELECT last_timestamp FROM sessions WHERE session_id = ?")
    .get(sessionId) as { last_timestamp: number | null } | undefined;
  raw.close();
  return row?.last_timestamp ?? null;
}

beforeEach(() => {
  dbPath = path.join(
    os.tmpdir(),
    `cs-period-recon-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
  fs.rmSync(dbPath, { force: true });
  store = new Store(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed by a test that reopens the store */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

// ── 1. The writes must never destroy a known-good last_timestamp ─────────────
describe("session upserts — last_timestamp must never be NULL-poisoned", () => {
  it("incremental upsert with a timestamp-less delta keeps the existing last_timestamp", () => {
    // A delta chunk containing only untimestamped entries (summary/meta lines)
    // makes parseSession return lastTimestamp: null. The old
    // MAX(sessions.last_timestamp, excluded.last_timestamp) evaluated to NULL.
    store.upsertSession(makeSession({ firstTimestamp: 1_000, lastTimestamp: 9_000 }));
    store.upsertSessionIncremental(makeSession({ firstTimestamp: 1_000, lastTimestamp: null }));

    expect(rawLastTimestamp("s1")).toBe(9_000);
  });

  it("incremental upsert still advances last_timestamp when the delta has a later one", () => {
    store.upsertSession(makeSession({ lastTimestamp: 9_000 }));
    store.upsertSessionIncremental(makeSession({ lastTimestamp: 12_000 }));

    expect(rawLastTimestamp("s1")).toBe(12_000);
  });

  it("incremental upsert never moves last_timestamp backwards", () => {
    store.upsertSession(makeSession({ lastTimestamp: 9_000 }));
    store.upsertSessionIncremental(makeSession({ lastTimestamp: 4_000 }));

    expect(rawLastTimestamp("s1")).toBe(9_000);
  });

  it("full re-parse upsert with a null lastTimestamp keeps the existing value", () => {
    store.upsertSession(makeSession({ lastTimestamp: 9_000 }));
    store.upsertSession(makeSession({ lastTimestamp: null }));

    expect(rawLastTimestamp("s1")).toBe(9_000);
  });

  it("leaves last_timestamp NULL when it has never been known", () => {
    store.upsertSession(makeSession({ lastTimestamp: null }));
    store.upsertSessionIncremental(makeSession({ lastTimestamp: null }));

    expect(rawLastTimestamp("s1")).toBeNull();
  });
});

// ── 2. The read must not depend on the cache being correct ───────────────────
describe("getSessions({ activeSince }) — membership follows messages, not just the cache", () => {
  it("includes a session whose last_timestamp is NULL but which has in-window messages", () => {
    const windowStart = 10 * DAY;
    // Started before the window, cache destroyed, but it was active inside it.
    store.upsertSession(
      makeSession({ firstTimestamp: windowStart - 2 * DAY, lastTimestamp: null }),
    );
    store.upsertMessages([makeMessage({ timestamp: windowStart + HOUR })]);

    const rows = store.getSessions({ activeSince: windowStart, includeCI: true, includeDeleted: true });
    expect(rows.map(r => r.session_id)).toEqual(["s1"]);
  });

  it("includes a session whose cached last_timestamp is merely STALE (too early)", () => {
    // Same failure mode without any NULL: any drift that under-reports the end
    // of a session must not be able to hide it from the period.
    const windowStart = 10 * DAY;
    store.upsertSession(
      makeSession({ firstTimestamp: windowStart - 2 * DAY, lastTimestamp: windowStart - DAY }),
    );
    store.upsertMessages([makeMessage({ timestamp: windowStart + HOUR })]);

    const rows = store.getSessions({ activeSince: windowStart, includeCI: true, includeDeleted: true });
    expect(rows.map(r => r.session_id)).toEqual(["s1"]);
  });

  it("still excludes a session with no messages in the window", () => {
    // The fix must not become "include everything" — a genuinely older session
    // stays out.
    const windowStart = 10 * DAY;
    store.upsertSession(
      makeSession({ firstTimestamp: windowStart - 5 * DAY, lastTimestamp: windowStart - 4 * DAY }),
    );
    store.upsertMessages([makeMessage({ timestamp: windowStart - 4 * DAY })]);

    const rows = store.getSessions({ activeSince: windowStart, includeCI: true, includeDeleted: true });
    expect(rows).toEqual([]);
  });

  it("honours `until` when the message arm pulls a session in", () => {
    // A historical custom range must not be widened by the new arm: a message
    // AFTER the range end is not membership.
    const windowStart = 10 * DAY;
    const windowEnd = 11 * DAY;
    store.upsertSession(
      makeSession({ firstTimestamp: windowStart - DAY, lastTimestamp: null }),
    );
    store.upsertMessages([makeMessage({ timestamp: windowEnd + DAY })]);

    const rows = store.getSessions({
      activeSince: windowStart,
      until: windowEnd,
      includeCI: true,
      includeDeleted: true,
    });
    expect(rows).toEqual([]);
  });
});

// ── 3. Rows already corrupted on disk must be repaired ───────────────────────
describe("migration V17 — repairs last_timestamp from messages", () => {
  /** Write a pre-fix row shape directly, bypassing the (now-fixed) upserts. */
  function seedCorruptedDb(lastTs: number | null, msgTs: number): void {
    store.upsertSession(makeSession({ firstTimestamp: 1_000, lastTimestamp: 5_000 }));
    store.upsertMessages([makeMessage({ timestamp: msgTs })]);
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE sessions SET last_timestamp = ? WHERE session_id = ?").run(lastTs, "s1");
    // Force the migration chain to re-run V17 on the next open.
    raw.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run("16");
    raw.close();
  }

  it("backfills a NULL last_timestamp from the session's max message timestamp", () => {
    seedCorruptedDb(null, 7_500);
    store = new Store(dbPath); // runs migrateToV17
    expect(rawLastTimestamp("s1")).toBe(7_500);
  });

  it("advances a stale last_timestamp to the real max message timestamp", () => {
    seedCorruptedDb(2_000, 7_500);
    store = new Store(dbPath);
    expect(rawLastTimestamp("s1")).toBe(7_500);
  });

  it("never moves last_timestamp backwards (pruned messages keep the recorded end)", () => {
    seedCorruptedDb(9_999, 7_500);
    store = new Store(dbPath);
    expect(rawLastTimestamp("s1")).toBe(9_999);
  });

  it("is idempotent — a second run changes nothing", () => {
    seedCorruptedDb(null, 7_500);
    store = new Store(dbPath);
    const afterFirst = rawLastTimestamp("s1");
    store.close();
    store = new Store(dbPath);
    expect(rawLastTimestamp("s1")).toBe(afterFirst);
  });

  it("leaves a session with no messages alone", () => {
    store.upsertSession(makeSession({ sessionId: "empty", lastTimestamp: null }));
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run("16");
    raw.close();
    store = new Store(dbPath);
    expect(rawLastTimestamp("empty")).toBeNull();
  });
});

// ── 4. The end-to-end invariant that catches this CLASS of bug ───────────────
describe("buildDashboard — session-scoped summary reconciles with message-scoped cost", () => {
  /**
   * The general guard: every half of the dashboard must describe the SAME work.
   * Whatever the cause — a drifted aggregate column, a filter applied to one
   * read but not the other, a timezone boundary computed two ways, a lifetime
   * counter summed into a window — one of these assertions fails.
   */
  function expectSummaryReconciles(period: "day" | "week"): void {
    const data = buildDashboard(store, { period, timezone: "UTC" });
    const s = data.summary;

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const since = Date.parse(`${data.sinceIso}T00:00:00.000Z`);
    const truth = raw
      .prepare(
        `SELECT COALESCE(SUM(m.input_tokens), 0) i,
                COALESCE(SUM(m.output_tokens), 0) o,
                COALESCE(SUM(m.cache_read_tokens), 0) cr,
                COUNT(DISTINCT m.session_id) owners
         FROM messages m JOIN sessions s ON s.session_id = m.session_id
         WHERE m.timestamp >= ?`,
      )
      .get(since) as { i: number; o: number; cr: number; owners: number };
    raw.close();

    // (a) Priced work with zero sessions is the original user-visible symptom.
    if (s.estimatedCost > 0) {
      expect(s.sessions, `cost $${s.estimatedCost} attributed to 0 sessions`).toBeGreaterThan(0);
      expect(s.prompts, `cost $${s.estimatedCost} attributed to 0 prompts`).toBeGreaterThan(0);
    }

    // (b) Every session owning an in-window message must be IN the session set.
    expect(
      s.sessions,
      `${truth.owners} session(s) own in-window messages but the summary reports ${s.sessions}`,
    ).toBeGreaterThanOrEqual(truth.owners);

    // (c) Headline tokens are the in-window message totals — NOT the session
    // rows' lifetime sums, which would drag a straddling session's whole
    // history into the window.
    expect(
      { input: s.inputTokens, output: s.outputTokens, cacheRead: s.cacheReadTokens },
      "headline tokens must equal the in-window message totals",
    ).toEqual({ input: truth.i, output: truth.o, cacheRead: truth.cr });

    // (d) Every split must sum back to the headline it is a split OF.
    const dayΣ = data.byDay.reduce(
      (a, d) => ({
        i: a.i + d.inputTokens, o: a.o + d.outputTokens,
        cr: a.cr + d.cacheReadTokens, cost: a.cost + d.estimatedCost,
      }),
      { i: 0, o: 0, cr: 0, cost: 0 },
    );
    expect({ i: dayΣ.i, o: dayΣ.o, cr: dayΣ.cr }, "Σ byDay tokens != headline")
      .toEqual({ i: truth.i, o: truth.o, cr: truth.cr });
    // Cost is rounded per day, so allow a cent of accumulated rounding.
    expect(Math.abs(dayΣ.cost - s.estimatedCost), "Σ byDay cost != headline cost")
      .toBeLessThan(0.02);

    const projΣ = data.byProject.reduce(
      (a, p) => ({ i: a.i + p.inputTokens, o: a.o + p.outputTokens }),
      { i: 0, o: 0 },
    );
    expect(projΣ, "Σ byProject tokens != headline").toEqual({ i: truth.i, o: truth.o });

    if (data.byHour.length > 0) {
      const hourΣ = data.byHour.reduce(
        (a, h) => ({ i: a.i + h.inputTokens, o: a.o + h.outputTokens }),
        { i: 0, o: 0 },
      );
      expect(hourΣ, "Σ byHour tokens != headline").toEqual({ i: truth.i, o: truth.o });
    }
  }

  it("reconciles for a session that straddles the period boundary with a NULL last_timestamp", () => {
    // The exact production shape: session started yesterday, cache wiped, real
    // work done inside today's window.
    const now = Date.now();
    const todayStart = Math.floor(now / DAY) * DAY;
    const inWindow = todayStart + HOUR;

    store.upsertSession(
      makeSession({
        firstTimestamp: todayStart - 3 * HOUR,
        lastTimestamp: null,
        promptCount: 4,
        inputTokens: 1_234,
        outputTokens: 5_678,
        cacheReadTokens: 90_000,
      }),
    );
    store.upsertMessages([
      makeMessage({
        uuid: "m-in",
        timestamp: inWindow,
        inputTokens: 1_234,
        outputTokens: 5_678,
        cacheReadTokens: 90_000,
      }),
    ]);

    expectSummaryReconciles("day");
  });

  it("reconciles across several sessions with mixed-quality timestamp caches", () => {
    const now = Date.now();
    const todayStart = Math.floor(now / DAY) * DAY;

    const fixtures: Array<{ id: string; first: number; last: number | null }> = [
      { id: "healthy", first: todayStart + HOUR, last: todayStart + 2 * HOUR },
      { id: "null-cache", first: todayStart - 5 * HOUR, last: null },
      { id: "stale-cache", first: todayStart - 6 * HOUR, last: todayStart - 5 * HOUR },
    ];

    for (const f of fixtures) {
      store.upsertSession(
        makeSession({
          sessionId: f.id,
          sourceFile: `/Users/alice/.claude/projects/p/${f.id}.jsonl`,
          firstTimestamp: f.first,
          lastTimestamp: f.last,
          promptCount: 2,
          inputTokens: 500,
          outputTokens: 700,
          cacheReadTokens: 11_000,
        }),
      );
      store.upsertMessages([
        makeMessage({
          uuid: `msg-${f.id}`,
          sessionId: f.id,
          timestamp: todayStart + 3 * HOUR,
          inputTokens: 500,
          outputTokens: 700,
          cacheReadTokens: 11_000,
        }),
      ]);
    }

    expectSummaryReconciles("day");
    expectSummaryReconciles("week");
  });
});

// ── 5. Period scoping: lifetime counters must not leak into a window ──────────
describe("buildDashboard — tokens are attributed to when they were SENT", () => {
  it("a session spanning 3 days puts its tokens on the days it ran, not all on day 1", () => {
    // The pre-fix byDay keyed a session's ENTIRE lifetime token total to its
    // first_timestamp, so a long session dumped everything into one bucket.
    const t0 = Date.UTC(2026, 0, 10, 12, 0, 0);
    const DAYS = [t0, t0 + DAY, t0 + 2 * DAY];

    store.upsertSession(
      makeSession({
        firstTimestamp: t0,
        lastTimestamp: t0 + 2 * DAY,
        inputTokens: 300,
        outputTokens: 30,
      }),
    );
    store.upsertMessages(
      DAYS.map((ts, i) =>
        makeMessage({ uuid: `m-${i}`, timestamp: ts, inputTokens: 100, outputTokens: 10 }),
      ),
    );

    const data = buildDashboard(store, {
      since: "2026-01-10",
      until: "2026-01-12",
      timezone: "UTC",
    });

    const byDate = new Map(data.byDay.map(d => [d.date, d]));
    for (const date of ["2026-01-10", "2026-01-11", "2026-01-12"]) {
      expect(byDate.get(date)?.inputTokens, `${date} should carry its own 100 input tokens`).toBe(100);
      expect(byDate.get(date)?.outputTokens).toBe(10);
    }
    // The session itself is still counted once, on the day it started.
    expect(byDate.get("2026-01-10")?.sessions).toBe(1);
    expect(byDate.get("2026-01-11")?.sessions).toBe(0);
  });

  it("only the in-window portion of a straddling session's tokens is counted", () => {
    const windowStart = Date.UTC(2026, 0, 10, 0, 0, 0);
    store.upsertSession(
      makeSession({
        firstTimestamp: windowStart - 2 * DAY,
        lastTimestamp: windowStart + HOUR,
        inputTokens: 1_000_000, // lifetime — mostly spent before the window
        outputTokens: 500_000,
      }),
    );
    store.upsertMessages([
      makeMessage({ uuid: "m-before", timestamp: windowStart - DAY, inputTokens: 999_000, outputTokens: 499_000 }),
      makeMessage({ uuid: "m-inside", timestamp: windowStart + HOUR, inputTokens: 1_000, outputTokens: 1_000 }),
    ]);

    const data = buildDashboard(store, { since: "2026-01-10", until: "2026-01-10", timezone: "UTC" });
    expect(data.summary.sessions).toBe(1);
    expect(data.summary.inputTokens).toBe(1_000);
    expect(data.summary.outputTokens).toBe(1_000);
  });
});

// ── 6. Filter symmetry between the session set and the message reads ─────────
describe("buildDashboard — narrowing filters apply to BOTH halves", () => {
  beforeEach(() => {
    // One interactive session and one CI-only session, in separate projects so
    // the byProject split shows which halves saw the narrowing.
    for (const [id, project, interactive] of [
      ["human", "/proj/human", true],
      ["ci", "/proj/ci", false],
    ] as Array<[string, string, boolean]>) {
      store.upsertSession(
        makeSession({
          sessionId: id,
          sourceFile: `/Users/alice/.claude/projects/p/${id}.jsonl`,
          projectPath: project,
          isInteractive: interactive,
          firstTimestamp: 5 * DAY,
          lastTimestamp: 5 * DAY + HOUR,
          inputTokens: 2_000_000,
          outputTokens: 400_000,
        }),
      );
      store.upsertMessages([
        makeMessage({ uuid: `m-${id}`, sessionId: id, timestamp: 5 * DAY, inputTokens: 2_000_000, outputTokens: 400_000 }),
      ]);
    }
  });

  /** Cost of exactly `n` of the identical fixture messages. */
  function fixtureCost(n: number): number {
    const { cost } = estimateCost("claude-sonnet-4", 2_000_000 * n, 400_000 * n, 0, 0);
    return Math.round(cost * 100) / 100;
  }

  it("includeCI=false drops the CI session from tokens, cost AND byProject", () => {
    // COST is the assertion that pins the pre-existing asymmetry: `rows` dropped
    // the CI session, but the message-scoped reads ignored includeCI entirely, so
    // the headline kept pricing CI work the session set had already excluded.
    const data = buildDashboard(store, { timezone: "UTC", includeCI: false });
    expect(data.summary.sessions).toBe(1);
    expect(data.summary.inputTokens).toBe(2_000_000);
    expect(data.summary.estimatedCost, "cost must exclude the CI session too").toBe(fixtureCost(1));
    expect(data.byProject.map(p => p.projectPath)).toEqual(["/proj/human"]);
  });

  it("includeCI=true counts both", () => {
    const data = buildDashboard(store, { timezone: "UTC", includeCI: true });
    expect(data.summary.sessions).toBe(2);
    expect(data.summary.inputTokens).toBe(4_000_000);
    expect(data.summary.estimatedCost).toBe(fixtureCost(2));
    expect(data.byProject.map(p => p.projectPath).sort()).toEqual(["/proj/ci", "/proj/human"]);
  });
});

// ── 7. A zeroed replay must not wipe real usage from a message row ────────────
describe("upsertMessages — an empty usage block carries no information", () => {
  function tokensOf(uuid: string): { i: number; o: number; cr: number } {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const r = raw
      .prepare("SELECT input_tokens i, output_tokens o, cache_read_tokens cr FROM messages WHERE uuid = ?")
      .get(uuid) as { i: number; o: number; cr: number };
    raw.close();
    return r;
  }

  it("a later all-zero copy of the same uuid keeps the stored usage", () => {
    // The real shape: a resume/compaction replay re-emits the turn with
    // {input:0,output:0,cache:0}. Last-write-wins destroyed real billed usage.
    store.upsertMessages([makeMessage({ uuid: "m-x", inputTokens: 500, outputTokens: 490, cacheReadTokens: 420_067 })]);
    store.upsertMessages([makeMessage({ uuid: "m-x", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })]);

    expect(tokensOf("m-x")).toEqual({ i: 500, o: 490, cr: 420_067 });
  });

  it("a genuine correction with non-zero usage still wins, even downwards", () => {
    // Must not become a blunt MAX(): a real re-parse that reports LOWER usage is
    // a correction, and the rollup recompute depends on it landing.
    store.upsertMessages([makeMessage({ uuid: "m-y", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 })]);
    store.upsertMessages([makeMessage({ uuid: "m-y", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })]);

    expect(tokensOf("m-y")).toEqual({ i: 1, o: 1, cr: 0 });
  });

  it("a first write of genuinely zero usage is still stored", () => {
    store.upsertMessages([makeMessage({ uuid: "m-z", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })]);
    expect(tokensOf("m-z")).toEqual({ i: 0, o: 0, cr: 0 });
  });
});

// ── 8. Session counters are a PROJECTION of messages, not an accumulator ──────
describe("recomputeSessionAggregates — idempotent projection of messages", () => {
  function counters(sessionId = "s1") {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const r = raw
      .prepare(`SELECT input_tokens i, output_tokens o, cache_read_tokens cr,
                       assistant_message_count aac, prompt_count pc, thinking_blocks tb,
                       throttle_events te, web_search_requests ws
                FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, number>;
    raw.close();
    return r;
  }

  it("replaces inflated counters with the true message totals", () => {
    // The exact production shape: a session row carrying counters ~14x the truth
    // because the same delta was added repeatedly by concurrent collectors.
    store.upsertSession(
      makeSession({ inputTokens: 9_999_999, outputTokens: 9_999_999, assistantMessageCount: 60_428, promptCount: 28_403 }),
    );
    store.upsertMessages([
      makeMessage({ uuid: "m1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, isTurnStart: true }),
      makeMessage({ uuid: "m2", inputTokens: 20, outputTokens: 6, cacheReadTokens: 8, isTurnStart: false }),
    ]);

    store.recomputeSessionAggregates(["s1"]);

    expect(counters()).toMatchObject({ i: 30, o: 11, cr: 15, aac: 2, pc: 1 });
  });

  it("is idempotent — running it repeatedly does not change the result", () => {
    // This is the property the additive upsert lacked, and the direct regression
    // test for the 14x inflation.
    store.upsertSession(makeSession());
    store.upsertMessages([makeMessage({ uuid: "m1", inputTokens: 10, outputTokens: 5, isTurnStart: true })]);

    store.recomputeSessionAggregates(["s1"]);
    const once = counters();
    for (let i = 0; i < 5; i++) store.recomputeSessionAggregates(["s1"]);

    expect(counters()).toEqual(once);
  });

  it("re-upserting the SAME messages twice leaves counters unchanged", () => {
    // Simulates two collectors processing the same delta — the scenario that
    // inflated the store, since `messages` dedupes but the counters did not.
    const msgs = [
      makeMessage({ uuid: "m1", inputTokens: 10, outputTokens: 5, isTurnStart: true }),
      makeMessage({ uuid: "m2", inputTokens: 20, outputTokens: 6, isTurnStart: true }),
    ];
    store.upsertSession(makeSession());
    store.upsertMessages(msgs);
    store.recomputeSessionAggregates(["s1"]);
    const first = counters();

    store.upsertMessages(msgs);
    store.recomputeSessionAggregates(["s1"]);

    expect(counters()).toEqual(first);
    expect(first).toMatchObject({ i: 30, o: 11, aac: 2, pc: 2 });
  });

  it("derives throttle events and web requests from the message rows", () => {
    store.upsertSession(makeSession({ throttleEvents: 500, webSearchRequests: 500 }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", isThrottled: true, webSearchRequests: 2 }),
      makeMessage({ uuid: "m2", isThrottled: false, webSearchRequests: 1 }),
    ]);

    store.recomputeSessionAggregates(["s1"]);

    expect(counters()).toMatchObject({ te: 1, ws: 3 });
  });

  it("leaves prompt_count alone for a legacy session with no turn-start signal", () => {
    // Pre-V18 rows have is_turn_start=0 on every message. Recomputing blindly
    // would report "0 prompts" for all history; a stale non-zero value is less
    // wrong than a confident zero.
    store.upsertSession(makeSession({ promptCount: 42 }));
    store.upsertMessages([makeMessage({ uuid: "m1", isTurnStart: false })]);

    store.recomputeSessionAggregates(["s1"]);

    expect(counters().pc).toBe(42);
  });

  it("only touches the sessions it is given", () => {
    store.upsertSession(makeSession({ sessionId: "a", inputTokens: 777 }));
    store.upsertSession(makeSession({ sessionId: "b", inputTokens: 777 }));
    store.upsertMessages([
      makeMessage({ uuid: "ma", sessionId: "a", inputTokens: 1 }),
      makeMessage({ uuid: "mb", sessionId: "b", inputTokens: 1 }),
    ]);

    store.recomputeSessionAggregates(["a"]);

    expect(counters("a").i).toBe(1);
    expect(counters("b").i).toBe(777);
  });
});

// ── 9. "Prompts" means user turns, not tool results ──────────────────────────
describe("buildDashboard — prompts count user turns", () => {
  it("counts turn-start messages in the window, not every message", () => {
    const t0 = Date.UTC(2026, 2, 5, 9, 0, 0);
    store.upsertSession(makeSession({ firstTimestamp: t0, lastTimestamp: t0 + HOUR, promptCount: 227 }));
    // One real prompt answered by an assistant message, then 4 tool round-trips.
    store.upsertMessages([
      makeMessage({ uuid: "turn", timestamp: t0, isTurnStart: true }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeMessage({ uuid: `tool-${i}`, timestamp: t0 + i * 60_000, isTurnStart: false }),
      ),
    ]);

    const data = buildDashboard(store, { since: "2026-03-05", until: "2026-03-05", timezone: "UTC" });
    // NOT 227 (the session's lifetime count, which counted every tool result)
    // and not 5 (every message).
    expect(data.summary.prompts).toBe(1);
    expect(data.byDay.find(d => d.date === "2026-03-05")?.prompts).toBe(1);
  });
});
