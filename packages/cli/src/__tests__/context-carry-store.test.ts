/**
 * Context carry cost (context-carry-cost B1) — store wiring, over a real
 * SQLite store.
 *
 * Covers the B1 deliverables from
 * `plans/context-carry-cost/IMPLEMENTATION.md` §4/B1:
 *  - `getMessagesForHygiene`'s SELECT carries `m.tools`, and
 *    `HygieneMessageStoreRow`/`toHygieneMessageRow` land it as parsed
 *    `readonly string[]` — LOAD-BEARING: the store query result is cast
 *    `as HygieneMessageStoreRow[]` over a raw SQL string, so adding the field
 *    to the interface without adding the column to the SELECT produces zero
 *    type errors and ships `undefined` at runtime.
 *  - The four token columns (input/output/cacheRead/cacheCreation) are
 *    coerced through `nonNegativeFiniteInt` in every mapper, so a hostile
 *    stored value degrades to `0` rather than poisoning a sum or a subtraction
 *    downstream.
 *  - `computeContextCarryForWindow` (`../contextCarry/index.js`) reaches
 *    `computeContextCarry` with correctly-mapped rows, including a real
 *    reset through the glue.
 *  - `DashboardData.contextCarry` (attached by `attachInsights`) is a
 *    `concentration`/`preludeByProject`-stripped projection — no session id
 *    reaches it.
 *
 * Design: plans/context-carry-cost/IMPLEMENTATION.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store/index.js";
import { buildHygieneReport } from "../hygiene/index.js";
import { computeContextCarryForWindow } from "../contextCarry/index.js";
import { buildDashboard, attachInsights } from "../dashboard/index.js";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { FIXED_NOW } from "./fixtures/synthetic.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-contextcarry-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, projectPath = "/w/alpha", overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath, sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 60_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: FIXED_NOW, claudeVersion: "2.1.70",
    model: "claude-sonnet-5", stopReason: "end_turn",
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

describe("Store.getMessagesForHygiene — tools column (context-carry-cost B1)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  // LOAD-BEARING (IMPLEMENTATION.md §4/B1 item 5): the store query result is
  // cast `as HygieneMessageStoreRow[]` over a raw SQL string, so adding
  // `tools` to the interface without adding `m.tools` to the SELECT produces
  // zero type errors and ships `undefined` at runtime — this is the one test
  // that would catch that regression.
  it("the SELECT carries m.tools through to the row", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { tools: ["Bash", "Read"] }),
    ]);

    const rows = store.getMessagesForHygiene({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tools).toBe(JSON.stringify(["Bash", "Read"]));
  });

  // Paired positive: a message with no tool calls still round-trips as the
  // empty-array sentinel, not `undefined` or a missing field.
  it("a message with no tool calls carries the '[]' sentinel, not undefined", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([message("s1-m0", "s1", { tools: [] })]);

    const rows = store.getMessagesForHygiene({});
    expect(rows[0]!.tools).toBe("[]");
  });

  // `parseTools`' three degrade paths. The store always WRITES well-formed
  // JSON, so these values can only arrive from outside `upsertMessages` — a
  // hand-edited row or a synced shard from another writer — which is exactly
  // why the guard is there and why reaching it needs a raw UPDATE. Each case
  // pairs the hostile row with a well-formed one in the SAME window, so the
  // assertion proves the window still computes rather than merely "didn't
  // throw": a `tools` of `undefined` would make `contextBloat`'s
  // `tools[tools.length - 1]` throw and take the whole fit down.
  const writeRawTools = (uuid: string, raw: string): void => {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE messages SET tools = ? WHERE uuid = ?").run(raw, uuid);
    db.close();
  };

  /** A session that trips `context-bloat`: 4 growth turns of +25K each, over
   *  the default 20K increment / 3 occurrence thresholds. The tool call that
   *  produced the LARGEST increment sits on the row BEFORE it, which is what
   *  `toolClause` reads — so `s1-m3`'s tools are what the detail names. */
  const bloatingSession = (): void => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 10_000 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1_000, inputTokens: 35_000 }),
      message("s1-m2", "s1", { timestamp: FIXED_NOW + 2_000, inputTokens: 60_000 }),
      message("s1-m3", "s1", { timestamp: FIXED_NOW + 3_000, inputTokens: 85_000, tools: ["Read"] }),
      message("s1-m4", "s1", { timestamp: FIXED_NOW + 4_000, inputTokens: 115_000 }),
    ]);
  };

  const bloatDetail = (): string => {
    const report = buildHygieneReport(store, {});
    const detector = report.digest.active.find((d) => d.detectorId === "context-bloat");
    expect(detector).toBeDefined();
    expect(detector!.findings).toHaveLength(1);
    return detector!.findings[0]!.detail;
  };

  // The paired POSITIVE, first: a well-formed tools array survives the parse
  // and reaches the one place that renders it. Without this, the three degrade
  // cases below would all still pass if `parseTools` unconditionally returned
  // the empty list — the failure mode a "didn't throw" test cannot see.
  it("keeps a well-formed tools array intact, all the way to context-bloat's tool clause", () => {
    bloatingSession();
    expect(bloatDetail()).toContain("following a `Read` call");
  });

  // The three degrade paths. The store always WRITES well-formed JSON, so
  // these values can only arrive from outside `upsertMessages` — a hand-edited
  // row or a shard synced by another writer — which is why the guard exists
  // and why reaching it needs a raw UPDATE. Each asserts the window still
  // computes AND that the clause degrades to silence rather than naming a tool
  // that isn't there: an unguarded `42` renders as "following a tool call",
  // and an unguarded `undefined` makes `toolClause`'s `prev.tools[0]` throw
  // and takes the whole report down.
  //
  // WHICH `parseTools` these reach: `hygiene/index.ts`'s. `context-bloat` is
  // the only consumer of `HygieneMessageRow.tools` anywhere, and it is fed by
  // `buildHygieneReport`. `contextCarry/index.ts` keeps its own fourth copy
  // because `HygieneMessageRow` requires the field, but `computeContextCarry`
  // never reads it — so that copy's guard branches are not reachable through
  // any assertion this suite could make, and are left uncovered rather than
  // pinned by a test that cannot fail. Verified by mutation: stripping the
  // `Array.isArray`/`typeof` guards from `contextCarry/index.ts` leaves this
  // file green; stripping the same two from `hygiene/index.ts` turns the
  // scalar and non-string cases red. The malformed-JSON case survives that
  // mutation because the `catch` — a THIRD, separate guard — still holds it;
  // it is kept as the case that pins the `catch` itself.
  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON scalar rather than an array", '"Read"'],
    ["an array holding only non-string elements", "[42, null]"],
  ])("degrades %s to an empty tools list rather than throwing", (_label, raw) => {
    bloatingSession();
    store.close();
    writeRawTools("s1-m3", raw);
    store = new Store(dbPath);

    const detail = bloatDetail();
    expect(detail).not.toContain("following");
    expect(detail).toContain("4 turns added");
    expect(computeContextCarryForWindow(store, {}).carriedTokens).toBe(305_000);
  });
});

describe("toHygieneMessageRow token coercion — hostile stored values (review F1)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  // `computeContextCarryForWindow`'s `carriedTokens` is `SUM(totalContext(row))`
  // over the window — a value that reaches the pure engine as `NaN` or
  // negative would poison that sum (and everything downstream: increments,
  // resets, carry cost). Each case below pairs the hostile row with a normal
  // row in the SAME window, on the SAME code path, so the assertion proves
  // coercion (a clean, finite, correctly-summed total) rather than merely
  // "didn't throw".

  it("a negative input_tokens value coerces to 0, not a poisoned negative sum", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      // A negative value SQLite stores verbatim as an INTEGER (verified: no
      // affinity conversion rejects it) — this is real hostile data a
      // hand-edited JSONL or a synced shard's row could carry, not a
      // hypothetical.
      message("s1-m0", "s1", { inputTokens: -50_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    const result = computeContextCarryForWindow(store, {});
    // The hostile row contributes 0, not -50_000 — carriedTokens is the clean
    // row's 10_000, never negative and never NaN.
    expect(result.carriedTokens).toBe(10_000);
    expect(Number.isFinite(result.carriedTokens)).toBe(true);
  });

  it("a non-finite (Infinity) cache_read_tokens value coerces to 0, not Infinity propagated through the sum", () => {
    // `NaN` itself cannot be exercised through a real store round-trip: the
    // token columns are `INTEGER NOT NULL DEFAULT 0`, and node:sqlite stores a
    // bound `NaN` parameter as SQL NULL (verified separately), which the
    // NOT-NULL constraint then REJECTS at insert time — so a stored NaN is
    // schema-impossible, not merely rare. `Infinity`, however, DOES survive a
    // real round-trip (stored as SQLite REAL `Infinity`, verified), and
    // `nonNegativeFiniteInt`'s `!Number.isFinite(value)` guard covers both —
    // this is the reachable member of that guard's condition.
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 0, cacheReadTokens: Infinity, cacheCreationTokens: 0 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    const result = computeContextCarryForWindow(store, {});
    expect(result.carriedTokens).toBe(5_000);
    expect(Number.isFinite(result.carriedTokens)).toBe(true);
    expect(Number.isNaN(result.carriedTokens)).toBe(false);
  });

  it("a string cache_creation_tokens value coerces to 0, not a NaN from string arithmetic", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      // SQLite's INTEGER-affinity column stores a non-numeric string as TEXT
      // verbatim (verified) — the coercion must not let `"garbage"` reach a
      // `+` where it would either NaN or string-concatenate.
      message("s1-m0", "s1", {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: "garbage" as unknown as number,
      }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 7_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    const result = computeContextCarryForWindow(store, {});
    expect(result.carriedTokens).toBe(7_000);
    expect(Number.isFinite(result.carriedTokens)).toBe(true);
  });
});

describe("computeContextCarryForWindow — glue reaches computeContextCarry with mapped rows", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("a session with a genuine drop-after-large-context produces exactly the one expected reset, and a stable session produces none", () => {
    store.upsertSession(session("s1"));
    store.upsertSession(session("s2", "/w/beta"));
    store.upsertMessages([
      // s1: 200_000 -> 50_000 is a >40% drop from a >150_000 baseline — a
      // genuine reset under `detectResets`' defaults.
      message("s1-m0", "s1", { inputTokens: 200_000 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 50_000 }),
      // s2: two ordinary turns, no qualifying drop — paired negative control
      // in the SAME window/query, proving s1's reset isn't a window-wide
      // artifact.
      message("s2-m0", "s2", { inputTokens: 30_000 }),
      message("s2-m1", "s2", { timestamp: FIXED_NOW + 1000, inputTokens: 35_000 }),
    ]);

    const result = computeContextCarryForWindow(store, {});
    expect(result.resets).toHaveLength(1);
    expect(result.resets[0]!.sessionId).toBe("s1");
    expect(result.resets[0]!.beforeTokens).toBe(200_000);
    expect(result.resets[0]!.afterTokens).toBe(50_000);
  });

  // Sanity-checks the glue reaches the real (Phase B2) engine at all, rather
  // than silently swallowing a throw — paired with the reset-count test
  // above on carriedTokens' own arithmetic.
  it("carriedTokens sums totalContext across every row in the window", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 1_000, cacheReadTokens: 200, cacheCreationTokens: 300 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    const result = computeContextCarryForWindow(store, {});
    expect(result.carriedTokens).toBe(1_000 + 200 + 300 + 2_000);
  });
});

describe("DashboardData.contextCarry — the payload projection (review F8 + its follow-up)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("drops concentration and re-keys preludeByProject, even though the full result the glue computes carries a session id and an absolute path", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    // Positive control on the SAME code path: the full result really does
    // carry `concentration[].sessionId` and a `preludeByProject` row keyed by
    // an ABSOLUTE project path — proving the projection below actually
    // transformed something, rather than the fields never having been there in
    // the first place.
    const full = computeContextCarryForWindow(store, {});
    expect(full.concentration.length).toBeGreaterThan(0);
    expect(full.concentration[0]!.sessionId).toBe("s1");
    expect(full.preludeByProject.length).toBeGreaterThan(0);
    expect(full.preludeByProject[0]!.projectPath).toBe("/w/alpha");

    const config: Config = {};
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);

    expect(data.contextCarry).not.toBeNull();
    expect(data.contextCarry).toBeDefined();
    // `concentration` is DROPPED: a per-session ranking with no renderer on
    // this page would be pure payload weight.
    expect(data.contextCarry).not.toHaveProperty("concentration");
    // `preludeByProject` is KEPT but RE-KEYED — the step-change alert is its
    // only consumer and only ever renders the short label, so the absolute
    // path never enters the payload. Shortening at ATTACH time is what makes
    // that a property of the payload rather than a promise about the renderer.
    expect(data.contextCarry!.preludeByProject.length).toBe(full.preludeByProject.length);
    expect(data.contextCarry!.preludeByProject[0]).not.toHaveProperty("projectPath");
    expect(data.contextCarry!.preludeByProject[0]!.projectLabel).toBe("w/alpha");
    expect(data.contextCarry!.preludeByProject[0]!.sessions).toEqual(full.preludeByProject[0]!.sessions);
    // Everything else survives the projection unchanged.
    expect(data.contextCarry!.carriedTokens).toBe(full.carriedTokens);
    expect(data.contextCarry!.sizeBands).toEqual(full.sizeBands);
  });

  // The whole point of re-keying rather than stripping: whatever a report file
  // ends up containing, an absolute project path is not in THIS field. Asserted
  // on the serialised form, because serialisation is what the rendered HTML
  // actually embeds.
  it("serialises the prelude series with no absolute path in it", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ]);

    const data = attachInsights(store, buildDashboard(store, {}), {}, {} as Config);
    const serialised = JSON.stringify(data.contextCarry!.preludeByProject);
    expect(serialised.length).toBeGreaterThan(2); // not the empty array
    expect(serialised).not.toContain("/w/alpha");
    expect(serialised).toContain("w/alpha");
  });
});

describe("buildContextAnalysis's compaction detector — rewired onto detectResets (review C-4)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("no longer flags an ordinary drop that the old input-tokens-alone/10K rule would have caught, since it now requires a >150K floor", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      // 20_000 -> 8_000 is a >40% drop above the OLD 10_000 floor, so the
      // former rule fired here. It is well below `detectResets`' 150_000
      // floor, so the rewired detector must NOT flag it — the whole point of
      // C-4 is one consistent compaction count, not two disagreeing ones.
      message("s1-m0", "s1", { inputTokens: 20_000 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 8_000 }),
    ]);

    const data = buildDashboard(store, {});
    expect(data.contextAnalysis?.compactionEvents ?? []).toHaveLength(0);
    expect(data.contextAnalysis?.compactionRate ?? 0).toBe(0);
  });

  it("still flags a genuine large-context drop (paired positive on the same code path)", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { inputTokens: 200_000 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, inputTokens: 50_000 }),
    ]);

    const data = buildDashboard(store, {});
    expect(data.contextAnalysis?.compactionEvents).toHaveLength(1);
    expect(data.contextAnalysis?.compactionEvents[0]).toMatchObject({
      sessionId: "s1",
      tokensBefore: 200_000,
      tokensAfter: 50_000,
    });
  });
});
