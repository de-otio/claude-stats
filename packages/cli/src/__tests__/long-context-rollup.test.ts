/**
 * C2 — long-context tier across the store: the rollup (`period:"all"`) and the
 * raw (bounded) read must price Haiku 5.5 requests either side of the 100,000
 * threshold identically, and both must equal the hand-computed figure. Also the
 * V27 migration, the other aggregated readers (bucket, project, account,
 * usage windows) and the rollup watermark's hash of the classification.
 *
 * Rows carry NO TTL split on purpose: the rollup has never carried one, so a
 * split would make raw and rollup differ for a reason unrelated to this change
 * (that gap is documented in `effort-tier-spend.test.ts`). Synthetic ids only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import {
  applyPricingCache,
  estimateCost,
  longContextSqlExprHash,
  lookupPricing,
  PRICING_VERIFIED_DATE,
} from "@claude-stats/core/pricing";
import { Store, SCHEMA_VERSION } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";

const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(os.tmpdir(), `cs-lc-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  tmpPaths.push(p);
  return p;
}
afterEach(() => {
  applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
  }
});

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const BUCKET = 900_000;
let seq = 0;

interface Spec {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  project: "A" | "B";
  hour: number;
}

function line(spec: Spec): Record<string, unknown> {
  seq++;
  return {
    type: "assistant",
    sessionId: `sess-${spec.project}`,
    version: "2.1.300",
    timestamp: T0 + spec.hour * HOUR + seq * 1000,
    uuid: `lc-${seq}`,
    message: {
      id: `msg_lc_${seq}`,
      model: spec.model,
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: spec.input,
        output_tokens: spec.output,
        cache_creation_input_tokens: spec.cacheCreation ?? 0,
        cache_read_input_tokens: spec.cacheRead ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        inference_geo: "us",
      },
    },
  };
}

async function seed(store: Store, specs: Spec[]): Promise<void> {
  for (const project of ["A", "B"] as const) {
    const lines = specs.filter((s) => s.project === project).map(line);
    if (lines.length === 0) continue;
    const file = tmp(".jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parsed = await parseSessionFile(file, `/proj-${project}`);
    store.upsertSession(parsed.session!);
    store.upsertMessages(parsed.messages);
  }
}

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

/**
 * Hour 0 / project A holds BOTH sides of the threshold for the same model, so a
 * rollup that merged them (or a reader that grouped without the flag) would
 * misprice one of them. Output is large so the dollar figures are not noise.
 *
 *  r1  prompt 1,000 + 90,000 + 9,000   = 100,000  -> base (the boundary)
 *  r2  prompt 1,001 + 90,000 + 9,000   = 100,001  -> tier
 *  r3  prompt 2,000 + 180,000 + 20,000 = 202,000  -> tier (other hour/project)
 *  r4  Sonnet 5.5, prompt 700,000, no tier        -> base
 *  r5  prompt 1,000 + 110,000 + 9,000  = 120,000  -> tier, in hour 2, which the
 *      partial recomputes below never touch. It flips to base when the
 *      threshold moves to 150,000, so only a full rebuild reclassifies it
 *      (r2 flips too, but it sits in the hour that IS recomputed).
 */
const FIXTURE: Spec[] = [
  { model: HAIKU, input: 1_000, output: 5_000_000, cacheRead: 90_000, cacheCreation: 9_000, project: "A", hour: 0 },
  { model: HAIKU, input: 1_001, output: 5_000_000, cacheRead: 90_000, cacheCreation: 9_000, project: "A", hour: 0 },
  { model: HAIKU, input: 2_000, output: 8_000_000, cacheRead: 180_000, cacheCreation: 20_000, project: "B", hour: 1 },
  { model: SONNET, input: 300_000, output: 1_000_000, cacheRead: 400_000, cacheCreation: 0, project: "A", hour: 1 },
  { model: HAIKU, input: 1_000, output: 1_000_000, cacheRead: 110_000, cacheCreation: 9_000, project: "A", hour: 2 },
];

/** Dollars, from the published rates written out by hand (per MTok). */
const R1 = (1_000 * 0.10 + 5_000_000 * 0.50 + 90_000 * 0.01 + 9_000 * 0.125) / 1e6; // 2.502125
const R2 = (1_001 * 0.50 + 5_000_000 * 2.50 + 90_000 * 0.05 + 9_000 * 0.625) / 1e6; // 12.5106255
const R2_BASE = (1_001 * 0.10 + 5_000_000 * 0.50 + 90_000 * 0.01 + 9_000 * 0.125) / 1e6;
const R3 = (2_000 * 0.50 + 8_000_000 * 2.50 + 180_000 * 0.05 + 20_000 * 0.625) / 1e6; // 20.0225
const R3_BASE = (2_000 * 0.10 + 8_000_000 * 0.50 + 180_000 * 0.01 + 20_000 * 0.125) / 1e6;
const R4 = (300_000 * 2 + 1_000_000 * 10 + 400_000 * 0.10) / 1e6; // 10.64
const R5 = (1_000 * 0.50 + 1_000_000 * 2.50 + 110_000 * 0.05 + 9_000 * 0.625) / 1e6; // 2.511625
const R5_BASE = (1_000 * 0.10 + 1_000_000 * 0.50 + 110_000 * 0.01 + 9_000 * 0.125) / 1e6;
const HAND_TOTAL = R1 + R2 + R3 + R4 + R5; // 48.1868755
// What the pre-C2 code reported: every Haiku request at base rates.
const UNTIERED_TOTAL = R1 + R2_BASE + R3_BASE + R4 + R5_BASE;
// Threshold moved to 150,000: only r3 (202,000) stays in the tier.
const TOTAL_AT_150K = R1 + R2_BASE + R3 + R4 + R5_BASE;

const WINDOW = { period: "all", since: "2023-01-01", until: "2099-01-01" } as const;

type TotalRow = {
  model: string;
  long_context: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};
/** Unrounded dollars for aggregated rows, each priced with its own tier flag. */
function priceRows(rows: readonly TotalRow[], only?: (m: string) => boolean): number {
  let total = 0;
  for (const r of rows) {
    if (only && !only(r.model)) continue;
    total += estimateCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, undefined, undefined, { longContext: r.long_context === 1 }).cost;
  }
  return total;
}
const isHaiku = (m: string): boolean => m === HAIKU;

let store: Store;
let dbPath: string;
beforeEach(async () => {
  seq = 0; // timestamps depend only on the spec, so bucket membership is deterministic
  dbPath = tmp(".db");
  store = new Store(dbPath);
  await seed(store, FIXTURE);
});
afterEach(() => {
  store.close();
});

const fresh = (): boolean => (store as unknown as { isMessageHourlyFresh(): boolean }).isMessageHourlyFresh();
const hourOf = (hour: number): number => Math.floor((T0 + hour * HOUR + 1000) / HOUR);
/** Rollup rows of one model by tier: [{long_context, n}], optionally for one hour. */
function splitCounts(model = HAIKU, hour?: number): Array<{ long_context: number; n: number }> {
  const db = new DatabaseSync(dbPath);
  const rows = (hour === undefined
    ? db.prepare("SELECT long_context, SUM(msg_count) AS n FROM message_hourly WHERE model = ? GROUP BY long_context ORDER BY 1").all(model)
    : db.prepare("SELECT long_context, SUM(msg_count) AS n FROM message_hourly WHERE model = ? AND hour_utc = ? GROUP BY long_context ORDER BY 1").all(model, hourOf(hour))) as Array<{ long_context: number; n: number }>;
  db.close();
  return rows;
}

describe("test 4: rollup vs raw, to the cent, and against the hand-computed figure", () => {
  it("premise: the figures are distinguishable, so the test can fail", () => {
    expect(HAND_TOTAL).toBeCloseTo(48.1868755, 7);
    expect(HAND_TOTAL - UNTIERED_TOTAL).toBeGreaterThan(25); // the tier is worth about $28 here
  });

  it("the bounded (raw) read prices both sides of the threshold", () => {
    const data = buildDashboard(store, WINDOW);
    expect(Math.abs(data.summary.estimatedCost - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);
    // Unrounded, at 6 digits: one wrong column on one request (R2's cache write
    // is a $0.0045 difference) cannot hide inside the cent.
    expect(priceRows(store.getMessageTotals({ since: 1 }))).toBeCloseTo(HAND_TOTAL, 6);
  });

  it("the period:'all' (rollup) read gives the same cost, and it was the rollup that answered", () => {
    const raw = buildDashboard(store, WINDOW);
    store.recomputeMessageHourly();
    expect(fresh()).toBe(true);
    const rolled = buildDashboard(store, { period: "all" });
    expect(rolled.summary.estimatedCost).toBe(raw.summary.estimatedCost);
    expect(Math.abs(rolled.summary.estimatedCost - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(priceRows(store.getMessageTotals())).toBeCloseTo(HAND_TOTAL, 6);
    expect(priceRows(store.getMessageTotals())).toBeCloseTo(priceRows(store.getMessageTotals({ since: 1 })), 9);

    // The rollup holds two rows for Haiku in hour 0 / project A (one per tier).
    expect(splitCounts(HAIKU, 0)).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 1 }]);
  });

  it("per-model and per-day figures also agree between the two paths", () => {
    const raw = buildDashboard(store, WINDOW);
    store.recomputeMessageHourly();
    const rolled = buildDashboard(store, { period: "all" });
    const haikuRaw = raw.byModel.find((m) => m.model === HAIKU)!;
    const haikuRolled = rolled.byModel.find((m) => m.model === HAIKU)!;
    // One entry per model, priced across both tiers.
    expect(raw.byModel.filter((m) => m.model === HAIKU)).toHaveLength(1);
    expect(haikuRolled.estimatedCost).toBe(haikuRaw.estimatedCost);
    expect(Math.abs(haikuRaw.estimatedCost - (R1 + R2 + R3 + R5))).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(priceRows(store.getMessageTotals({ since: 1 }), isHaiku)).toBeCloseTo(R1 + R2 + R3 + R5, 6);
    expect(priceRows(store.getMessageTotals(), isHaiku)).toBeCloseTo(R1 + R2 + R3 + R5, 6);
    const sum = (d: typeof raw) => d.byDay.reduce((a, x) => a + x.estimatedCost, 0);
    expect(Math.abs(sum(raw) - HAND_TOTAL)).toBeLessThanOrEqual(0.01);
  });

  it("per-session cost (getCostBySession) prices the tier per request", () => {
    const costs = store.getCostBySession();
    expect(costs.get("sess-A")!).toBeCloseTo(R1 + R2 + R4 + R5, 9);
    expect(costs.get("sess-B")!).toBeCloseTo(R3, 9);
  });
});

describe("the other aggregated readers split by tier and price to the hand figure", () => {
  it("getMessageTotalsByBucket: both tiers in one bucket are separate rows; the sum is the hand total", () => {
    const rows = store.getMessageTotalsByBucket({ since: 1 });
    expect(priceRows(rows)).toBeCloseTo(HAND_TOTAL, 6);
    // r1 and r2 share a 15-minute bucket and a model: one row per tier.
    const bucket0 = Math.floor((T0 + 1000) / BUCKET) * BUCKET;
    const h = rows.filter((r) => r.model === HAIKU && r.bucket_start === bucket0);
    expect(h.map((r) => r.long_context).sort()).toEqual([0, 1]);
    expect(priceRows(h)).toBeCloseTo(R1 + R2, 6);
  });

  it("getMessageTotalsByProject: per-project cost matches the hand figures", () => {
    const rows = store.getMessageTotalsByProject({ since: 1 });
    expect(priceRows(rows)).toBeCloseTo(HAND_TOTAL, 6);
    expect(priceRows(rows.filter((r) => r.project_path.endsWith("-A")))).toBeCloseTo(R1 + R2 + R4 + R5, 6);
    expect(priceRows(rows.filter((r) => r.project_path.endsWith("-B")))).toBeCloseTo(R3, 6);
    expect(rows.filter((r) => r.project_path.endsWith("-A") && r.model === HAIKU).map((r) => r.long_context).sort()).toEqual([0, 1]);
  });

  it("getMessageTotalsByAccount: priced per tier, sums to the hand total", () => {
    const rows = store.getMessageTotalsByAccount({ since: 1 });
    expect(priceRows(rows)).toBeCloseTo(HAND_TOTAL, 6);
    expect(rows.filter((r) => r.model === HAIKU).map((r) => r.long_context).sort()).toEqual([0, 1]);
  });

  it("usage windows (computeWindowsSince via recomputeWindowsInRange, getCurrentWindow) price the tier", () => {
    store.recomputeWindowsInRange(0, 4_000_000_000_000);
    const windows = store.getUsageWindows();
    // Both sessions start within five hours of each other: one window, all cost in it.
    expect(windows).toHaveLength(1);
    // Windows round to 4 decimals.
    expect(windows[0]!.totalCostEquivalent).toBeCloseTo(HAND_TOTAL, 4);
    expect(store.getCurrentWindow()!.totalCostEquivalent).toBeCloseTo(HAND_TOTAL, 4);
    // Untiered it would be ~$28 lower.
    expect(Math.abs(windows[0]!.totalCostEquivalent - UNTIERED_TOTAL)).toBeGreaterThan(25);
  });
});

describe("V27 migration", () => {
  it("is schema 27 with long_context in the rollup primary key, next to effort", () => {
    expect(SCHEMA_VERSION).toBe(27);
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare("PRAGMA table_info(message_hourly)").all() as Array<{ name: string; pk: number }>;
    db.close();
    expect(cols.find((c) => c.name === "long_context")!.pk).toBeGreaterThan(0);
    expect(cols.find((c) => c.name === "effort")!.pk).toBeGreaterThan(0);
  });

  it("opens a V26 store with data, rebuilds the rollup with the tier split, keeps the all-time cost", () => {
    store.recomputeMessageHourly();
    const before = buildDashboard(store, { period: "all" }).summary.estimatedCost;
    store.close();

    // Rewind to the V26 shape: no long_context column, schema 26, no watermark.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TABLE message_hourly;
      CREATE TABLE message_hourly (
        hour_utc INTEGER NOT NULL, project_path TEXT, model TEXT, inference_geo TEXT, effort TEXT,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
        th_input_tokens INTEGER NOT NULL, th_output_tokens INTEGER NOT NULL,
        th_cache_read_tokens INTEGER NOT NULL, th_cache_creation_tokens INTEGER NOT NULL,
        msg_count INTEGER NOT NULL, th_msg_count INTEGER NOT NULL, min_ts INTEGER,
        PRIMARY KEY (hour_utc, project_path, model, inference_geo, effort)
      );
      INSERT INTO message_hourly
        SELECT CAST(timestamp / 3600000 AS INTEGER), NULL, model, inference_geo, effort,
               SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens),
               0, 0, 0, 0, COUNT(*), 0, MIN(timestamp)
        FROM messages GROUP BY 1, model, inference_geo, effort;
      DELETE FROM metadata WHERE key = 'message_hourly_watermark';
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '26');
    `);
    raw.close();

    const reopened = new Store(dbPath);
    try {
      const check = new DatabaseSync(dbPath);
      const version = check.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe("27");
      check.close();
      expect(splitCounts()).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 3 }]);
      const after = buildDashboard(reopened, { period: "all" }).summary.estimatedCost;
      expect(after).toBe(before);
      expect(Math.abs(after - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(priceRows(reopened.getMessageTotals())).toBeCloseTo(HAND_TOTAL, 6);
    } finally {
      reopened.close();
      store = new Store(dbPath); // the afterEach hook closes `store`
    }
  });
});

describe("test 5: the watermark hashes the classification", () => {
  const withThreshold = (t: number): void => {
    const base = lookupPricing(HAIKU)!;
    applyPricingCache({ [HAIKU]: { ...base, longContext: { ...base.longContext!, thresholdTokens: t } } }, "2026-10-28");
  };

  it("changing the threshold makes the rollup stale; a PARTIAL recompute escalates and reclassifies hours it did not touch", () => {
    store.recomputeMessageHourly();
    expect(fresh()).toBe(true);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 3 }]);
    expect(splitCounts(HAIKU, 2)).toEqual([{ long_context: 1, n: 1 }]); // r5, tier at 100,000

    // A pricing refresh moves the threshold to 150,000: r2 and r5 become base.
    withThreshold(150_000);
    expect(fresh()).toBe(false);
    // The stale rollup is not served: the reader falls back to raw and uses the NEW threshold.
    expect(priceRows(store.getMessageTotals({ since: 1 }))).toBeCloseTo(TOTAL_AT_150K, 6);
    const viaRaw = buildDashboard(store, { period: "all" }).summary.estimatedCost;
    expect(Math.abs(viaRaw - TOTAL_AT_150K)).toBeLessThanOrEqual(0.005 + 1e-9);

    // Recompute ONLY hour 0 (r1, r2). Hour 2 (r5) is not in the request, yet it
    // must be reclassified: a partial recompute must not stamp a half-stale
    // rollup as fresh, so it escalates to a full rebuild.
    store.recomputeMessageHourly([hourOf(0)]);
    expect(fresh()).toBe(true);
    expect(splitCounts(HAIKU, 2)).toEqual([{ long_context: 0, n: 1 }]);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 3 }, { long_context: 1, n: 1 }]);
    expect(priceRows(store.getMessageTotals())).toBeCloseTo(TOTAL_AT_150K, 6);
    expect(buildDashboard(store, { period: "all" }).summary.estimatedCost).toBe(viaRaw);
  });

  it("a rate-table refresh that leaves the classification alone keeps the rollup fresh", () => {
    store.recomputeMessageHourly();
    const base = lookupPricing(HAIKU)!;
    // Different VALUES, same threshold and same tiered model set.
    applyPricingCache({ [HAIKU]: { ...base, longContext: { ...base.longContext!, rates: { ...base.longContext!.rates, outputPerMillion: 3 } } } }, "2026-10-28");
    expect(fresh()).toBe(true);
  });

  it("a partial recompute with an unchanged classification stays partial and fresh", () => {
    store.recomputeMessageHourly();
    store.recomputeMessageHourly([hourOf(0)]);
    expect(fresh()).toBe(true);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 3 }]);
  });

  it("adding a tier to ANOTHER model changes the hash, makes the rollup stale, and the rebuild splits that model", () => {
    store.recomputeMessageHourly();
    const h0 = longContextSqlExprHash();
    expect(splitCounts(SONNET)).toEqual([{ long_context: 0, n: 1 }]);

    const sonnet = lookupPricing(SONNET)!;
    applyPricingCache(
      {
        [SONNET]: {
          ...sonnet,
          longContext: {
            thresholdTokens: 100_000,
            rates: {
              inputPerMillion: sonnet.inputPerMillion * 2,
              outputPerMillion: sonnet.outputPerMillion * 2,
              cacheReadPerMillion: sonnet.cacheReadPerMillion * 2,
              cacheWritePerMillion: sonnet.cacheWritePerMillion * 2,
              cacheWrite1hPerMillion: sonnet.cacheWrite1hPerMillion * 2,
            },
          },
        },
      },
      "2026-10-28",
    );
    expect(longContextSqlExprHash()).not.toBe(h0);
    expect(fresh()).toBe(false);

    store.recomputeMessageHourly([hourOf(0)]); // escalates: the Sonnet row sits in hour 1
    expect(fresh()).toBe(true);
    expect(splitCounts(SONNET)).toEqual([{ long_context: 1, n: 1 }]); // r4 prompt 700,000
    // And the cost follows: r4 at 2x rates (hand: 2*R4), everything else as before.
    expect(priceRows(store.getMessageTotals())).toBeCloseTo(HAND_TOTAL + R4, 6);
    expect(priceRows(store.getMessageTotals({ since: 1 }))).toBeCloseTo(HAND_TOTAL + R4, 6);
  });

  it("a legacy watermark with no |lc= suffix reads as stale, and the next recompute rebuilds and stamps it", () => {
    store.recomputeMessageHourly();
    expect(fresh()).toBe(true);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'message_hourly_watermark'").get() as { value: string };
    expect(row.value).toContain("|lc=");
    const legacy = row.value.split("|lc=")[0]!; // exactly what a pre-V27 build wrote
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'message_hourly_watermark'").run(legacy);
    db.close();

    expect(fresh()).toBe(false);
    // Even a partial recompute does not trust the legacy stamp: it rebuilds in full.
    db_corruptHour2();
    store.recomputeMessageHourly([hourOf(0)]);
    expect(fresh()).toBe(true);
    expect(splitCounts(HAIKU, 2)).toEqual([{ long_context: 1, n: 1 }]);
  });
});

/** Make hour 2's rollup row wrong, so only a full rebuild (not a partial one of hour 0) can repair it. */
function db_corruptHour2(): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE message_hourly SET long_context = 0 WHERE model = ? AND hour_utc = ?").run(HAIKU, hourOf(2));
  db.close();
}
