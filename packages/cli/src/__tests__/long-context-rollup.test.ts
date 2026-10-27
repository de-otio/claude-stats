/**
 * C2 — long-context tier across the store: the rollup (`period:"all"`) and the
 * raw (bounded) read must price Haiku 5.5 requests either side of the 100,000
 * threshold identically, and both must equal the hand-computed figure. Also the
 * V27 migration and the rollup watermark's hash of the classification.
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
import { applyPricingCache, lookupPricing, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
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
 */
const FIXTURE: Spec[] = [
  { model: HAIKU, input: 1_000, output: 5_000_000, cacheRead: 90_000, cacheCreation: 9_000, project: "A", hour: 0 },
  { model: HAIKU, input: 1_001, output: 5_000_000, cacheRead: 90_000, cacheCreation: 9_000, project: "A", hour: 0 },
  { model: HAIKU, input: 2_000, output: 8_000_000, cacheRead: 180_000, cacheCreation: 20_000, project: "B", hour: 1 },
  { model: SONNET, input: 300_000, output: 1_000_000, cacheRead: 400_000, cacheCreation: 0, project: "A", hour: 1 },
];

/** Dollars, from the published rates written out by hand (per MTok). */
const R1 = (1_000 * 0.10 + 5_000_000 * 0.50 + 90_000 * 0.01 + 9_000 * 0.125) / 1e6; // 2.502125
const R2 = (1_001 * 0.50 + 5_000_000 * 2.50 + 90_000 * 0.05 + 9_000 * 0.625) / 1e6; // 12.5106255
const R3 = (2_000 * 0.50 + 8_000_000 * 2.50 + 180_000 * 0.05 + 20_000 * 0.625) / 1e6; // 20.0225
const R4 = (300_000 * 2 + 1_000_000 * 10 + 400_000 * 0.10) / 1e6; // 10.64
const HAND_TOTAL = R1 + R2 + R3 + R4; // 45.6752505
// What the pre-C2 code reported: every Haiku request at base rates.
const UNTIERED_TOTAL =
  R1 + R4 + (1_001 * 0.10 + 5_000_000 * 0.50 + 90_000 * 0.01 + 9_000 * 0.125) / 1e6 + (2_000 * 0.10 + 8_000_000 * 0.50 + 180_000 * 0.01 + 20_000 * 0.125) / 1e6;

const WINDOW = { period: "all", since: "2023-01-01", until: "2099-01-01" } as const;

let store: Store;
let dbPath: string;
beforeEach(async () => {
  dbPath = tmp(".db");
  store = new Store(dbPath);
  await seed(store, FIXTURE);
});
afterEach(() => {
  store.close();
});

describe("test 4: rollup vs raw, to the cent, and against the hand-computed figure", () => {
  it("premise: the figures are distinguishable, so the test can fail", () => {
    expect(HAND_TOTAL).toBeCloseTo(45.6752505, 7);
    expect(HAND_TOTAL - UNTIERED_TOTAL).toBeGreaterThan(25); // the tier is worth about $26 here
  });

  it("the bounded (raw) read prices both sides of the threshold", () => {
    const data = buildDashboard(store, WINDOW);
    expect(Math.abs(data.summary.estimatedCost - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);
  });

  it("the period:'all' (rollup) read gives the same cost, and it was the rollup that answered", () => {
    const raw = buildDashboard(store, WINDOW);
    store.recomputeMessageHourly();
    expect((store as unknown as { isMessageHourlyFresh(): boolean }).isMessageHourlyFresh()).toBe(true);
    const rolled = buildDashboard(store, { period: "all" });
    expect(rolled.summary.estimatedCost).toBe(raw.summary.estimatedCost);
    expect(Math.abs(rolled.summary.estimatedCost - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);

    // The rollup holds two rows for Haiku in hour 0 / project A (one per tier).
    const db = new DatabaseSync(dbPath);
    const h0 = db
      .prepare("SELECT long_context, SUM(msg_count) AS n FROM message_hourly WHERE model = ? AND hour_utc = ? GROUP BY long_context ORDER BY long_context")
      .all(HAIKU, Math.floor((T0 + 1000) / HOUR)) as Array<{ long_context: number; n: number }>;
    db.close();
    expect(h0).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 1 }]);
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
    expect(Math.abs(haikuRaw.estimatedCost - (R1 + R2 + R3))).toBeLessThanOrEqual(0.005 + 1e-9);
    const sum = (d: typeof raw) => d.byDay.reduce((a, x) => a + x.estimatedCost, 0);
    expect(Math.abs(sum(raw) - HAND_TOTAL)).toBeLessThanOrEqual(0.01);
  });

  it("per-session cost (getCostBySession) prices the tier per request", () => {
    const costs = store.getCostBySession();
    expect(costs.get("sess-A")!).toBeCloseTo(R1 + R2 + R4, 9);
    expect(costs.get("sess-B")!).toBeCloseTo(R3, 9);
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
      const split = check
        .prepare("SELECT long_context, SUM(msg_count) AS n FROM message_hourly WHERE model = ? GROUP BY long_context ORDER BY 1")
        .all(HAIKU) as Array<{ long_context: number; n: number }>;
      check.close();
      expect(split).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 2 }]);
      const after = buildDashboard(reopened, { period: "all" }).summary.estimatedCost;
      expect(after).toBe(before);
      expect(Math.abs(after - HAND_TOTAL)).toBeLessThanOrEqual(0.005 + 1e-9);
    } finally {
      reopened.close();
      store = new Store(dbPath); // the afterEach hook closes `store`
    }
  });
});

describe("test 5: the watermark hashes the classification", () => {
  const fresh = (): boolean => (store as unknown as { isMessageHourlyFresh(): boolean }).isMessageHourlyFresh();
  const splitCounts = (): Array<{ long_context: number; n: number }> => {
    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare("SELECT long_context, SUM(msg_count) AS n FROM message_hourly WHERE model = ? GROUP BY long_context ORDER BY 1")
      .all(HAIKU) as Array<{ long_context: number; n: number }>;
    db.close();
    return rows;
  };

  it("changing the threshold in the rate table makes the rollup stale, and the next recompute rebuilds it in full", () => {
    store.recomputeMessageHourly();
    expect(fresh()).toBe(true);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 2 }]);

    // A pricing refresh moves the threshold to 150,000: r2 (100,001) is now base.
    const base = lookupPricing(HAIKU)!;
    applyPricingCache({ [HAIKU]: { ...base, longContext: { ...base.longContext!, thresholdTokens: 150_000 } } }, "2026-10-28");
    expect(fresh()).toBe(false);
    // Stale rollup is not served: the reader falls back to raw and prices with the NEW threshold.
    const r2AtBase = (1_001 * 0.10 + 5_000_000 * 0.50 + 90_000 * 0.01 + 9_000 * 0.125) / 1e6;
    const viaRaw = buildDashboard(store, { period: "all" }).summary.estimatedCost;
    expect(Math.abs(viaRaw - (R1 + r2AtBase + R3 + R4))).toBeLessThanOrEqual(0.005 + 1e-9);

    // A PARTIAL recompute (one hour) must not stamp a half-stale rollup as fresh:
    // it escalates to a full rebuild.
    store.recomputeMessageHourly([Math.floor((T0 + 1000) / HOUR)]);
    expect(fresh()).toBe(true);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 2 }, { long_context: 1, n: 1 }]);
    const viaRollup = buildDashboard(store, { period: "all" }).summary.estimatedCost;
    expect(viaRollup).toBe(viaRaw);
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
    store.recomputeMessageHourly([Math.floor((T0 + 1000) / HOUR)]);
    expect(fresh()).toBe(true);
    expect(splitCounts()).toEqual([{ long_context: 0, n: 1 }, { long_context: 1, n: 2 }]);
  });
});
