/**
 * Cache-TTL fit (cache-ttl-fit B1) — store wiring, over a real SQLite store.
 *
 * Covers the B1 deliverables from `plans/cache-ttl-fit/IMPLEMENTATION.md` §3:
 *  - `getMessageTotalsBySession`'s two new SUM columns land in the right
 *    fields (a transposed 5m/1h pair typechecks but is wrong).
 *  - `buildHygieneReport`'s totalCost prices a purely-1h-write row at the
 *    1-hour rate, and an all-zero-ephemeral row identically to the pre-split
 *    (flat 5-minute-rate) behaviour.
 *  - `computeTtlFitForWindow` (`../ttlFit/index.js`) reaches `computeTtlFit`
 *    with correctly-mapped rows. `computeTtlFit`'s own arithmetic is Phase
 *    B2's to test; the assertion here only checks that this module's rows
 *    reach it correctly mapped (observedTtl, token totals).
 *
 * Design: doc/analysis/efficiency-hygiene/README.md,
 * plans/cache-ttl-fit/IMPLEMENTATION.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import { buildHygieneReport } from "../hygiene/index.js";
import { computeTtlFitForWindow } from "../ttlFit/index.js";
import { resolvePricing } from "@claude-stats/core/pricing";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { FIXED_NOW } from "./fixtures/synthetic.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-ttlfit-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
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

describe("Store.getMessageTotalsBySession — TTL split", () => {
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

  it("sums the 5m and 1h ephemeral columns into their OWN fields, not swapped", () => {
    // Deliberately different values — a transposed pair would still typecheck
    // (both are `number`) but this fails immediately if 5m and 1h land in each
    // other's field.
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { cacheCreationTokens: 1000, ephemeral5mCacheTokens: 300, ephemeral1hCacheTokens: 700 }),
    ]);

    const rows = store.getMessageTotalsBySession(["s1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ephemeral_5m_cache_tokens).toBe(300);
    expect(rows[0]!.ephemeral_1h_cache_tokens).toBe(700);
  });

  it("sums across multiple messages in the same session/model group", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { ephemeral5mCacheTokens: 100, ephemeral1hCacheTokens: 200 }),
      message("s1-m1", "s1", { ephemeral5mCacheTokens: 50, ephemeral1hCacheTokens: 25 }),
    ]);

    const rows = store.getMessageTotalsBySession(["s1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ephemeral_5m_cache_tokens).toBe(150);
    expect(rows[0]!.ephemeral_1h_cache_tokens).toBe(225);
  });
});

describe("Store.getMessagesForHygiene — TTL split columns", () => {
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

  it("returns the two ephemeral columns alongside the existing token columns", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { ephemeral5mCacheTokens: 111, ephemeral1hCacheTokens: 222 }),
    ]);

    const rows = store.getMessagesForHygiene({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ephemeral_5m_cache_tokens).toBe(111);
    expect(rows[0]!.ephemeral_1h_cache_tokens).toBe(222);
  });
});

describe("buildHygieneReport — cache writes priced at the TTL they were actually written at", () => {
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

  it("an all-1h-write row prices its cache-creation tokens at the 1-hour rate (2x the input rate), not the 1.25x 5-minute rate", () => {
    const pricing = resolvePricing("claude-sonnet-5").pricing!;
    const creationTokens = 1_000_000;

    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", {
        cacheCreationTokens: creationTokens,
        ephemeral1hCacheTokens: creationTokens,
        ephemeral5mCacheTokens: 0,
      }),
    ]);

    const report = buildHygieneReport(store, {});
    const expectedAt1h = (creationTokens / 1_000_000) * pricing.cacheWrite1hPerMillion;
    const expectedAtFlat5m = (creationTokens / 1_000_000) * pricing.cacheWritePerMillion;

    expect(report.totalCost).toBeCloseTo(expectedAt1h, 10);
    // The property under test: wiring the split in must actually move the
    // number away from the old flat 5-minute pricing, not just agree with it
    // by coincidence.
    expect(report.totalCost).toBeGreaterThan(expectedAtFlat5m);
  });

  it("an all-zero-ephemeral window (pre-column data) costs IDENTICALLY to flat 5-minute pricing — no regression for old rows", () => {
    const pricing = resolvePricing("claude-sonnet-5").pricing!;
    const creationTokens = 40_000;

    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", {
        cacheCreationTokens: creationTokens,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
      }),
    ]);

    const report = buildHygieneReport(store, {});
    const expected = (creationTokens / 1_000_000) * pricing.cacheWritePerMillion;
    expect(report.totalCost).toBeCloseTo(expected, 10);
  });

  it("a mixed 5m/1h window sums both terms at their own rates", () => {
    const pricing = resolvePricing("claude-sonnet-5").pricing!;
    const write5m = 200_000;
    const write1h = 300_000;

    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", {
        cacheCreationTokens: write5m + write1h,
        ephemeral5mCacheTokens: write5m,
        ephemeral1hCacheTokens: write1h,
      }),
    ]);

    const report = buildHygieneReport(store, {});
    const expected =
      (write5m / 1_000_000) * pricing.cacheWritePerMillion +
      (write1h / 1_000_000) * pricing.cacheWrite1hPerMillion;
    expect(report.totalCost).toBeCloseTo(expected, 10);
  });
});

describe("computeTtlFitForWindow — glue reaches computeTtlFit with mapped rows", () => {
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

  // Phase B2 landed `computeTtlFit`'s implementation during this phase (it
  // was a throwing stub when this module was written against the frozen
  // A2 contract). A handful of rows is below both of `computeTtlFit`'s
  // "insufficient-data" floors (50 timestamped rows, 5 MTok of cache-creation
  // volume), so the real, honest answer here is `insufficient-data` — this
  // asserts the glue reaches the real function with correctly-mapped rows
  // (observedTtl reflects THIS fixture's ephemeral columns), not that the
  // arithmetic itself is right (B2's own tests own that).
  it("reaches computeTtlFit with correctly-mapped rows (small window -> insufficient-data, but observedTtl reflects the fixture)", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { cacheCreationTokens: 1000, ephemeral1hCacheTokens: 1000, ephemeral5mCacheTokens: 0 }),
    ]);

    const result = computeTtlFitForWindow(store, {});
    expect(result.observedTtl).toBe("1h");
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.totals.writeTokens).toBe(1000);
    expect(result.totals.writeTokens1h).toBe(1000);
  });
});
