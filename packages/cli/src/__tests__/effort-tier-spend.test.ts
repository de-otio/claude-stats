/**
 * #125 PR 1 — tokens and cost by reasoning-effort tier.
 *
 * Covers, in order: the pure tier helpers (`effort.ts`, with fast-check), the
 * parser's `perTurnEffort ?? effort` rule (D2), the schema V26 migration, the
 * store/dashboard reconciliation on BOTH read paths (raw seek and the
 * `period:"all"` rollup, D4), and the `get_session_detail` effort surface.
 *
 * Reconciliation tests assert hand-computed token sums per tier as well as
 * "parts equal the whole", so a grouping bug (wrong key, dropped null bucket,
 * tiers folded together) fails them rather than passing against itself.
 * Synthetic names and ids only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import { compareEffort, normaliseEffort, KNOWN_EFFORT_ORDER } from "@claude-stats/core/effort";
import { estimateCost } from "@claude-stats/core/pricing";
import { Store, SCHEMA_VERSION, foldTotalsByModel } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { buildEffortMix } from "../dashboard/effort-breakdown.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(os.tmpdir(), `cs-effort-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  tmpPaths.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
  }
});

const T0 = 1_700_000_000_000; // Nov 2023
let seq = 0;

interface Spec {
  model: string;
  input: number;
  output: number;
  effort?: unknown;
  perTurnEffort?: unknown;
}

function assistantLine(spec: Spec): Record<string, unknown> {
  seq++;
  return {
    type: "assistant",
    sessionId: "sess-effort",
    version: "2.1.300",
    timestamp: T0 + seq * 1000,
    uuid: `a-${seq}`,
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.perTurnEffort !== undefined ? { perTurnEffort: spec.perTurnEffort } : {}),
    message: {
      id: `msg_${seq}`,
      model: spec.model,
      stop_reason: "end_turn",
      content: [],
      usage: { input_tokens: spec.input, output_tokens: spec.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

async function parseLines(lines: object[]) {
  const file = tmp(".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return parseSessionFile(file, "/proj");
}

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";

/** One fixture, every case the plan lists: four tiers, missing, perTurnEffort-only, an unknown tier. */
const FIXTURE: Spec[] = [
  { model: SONNET, input: 1000, output: 100, effort: "low" },
  { model: SONNET, input: 2000, output: 200, effort: "medium" },
  { model: SONNET, input: 3000, output: 300, effort: "high" },
  { model: OPUS, input: 4000, output: 400, effort: "xhigh" },
  { model: OPUS, input: 5000, output: 500, effort: "high" },
  { model: SONNET, input: 600, output: 60 }, // no effort at all
  { model: SONNET, input: 700, output: 70, perTurnEffort: "high" }, // perTurnEffort only
  { model: OPUS, input: 800, output: 80, effort: "turbo" }, // unknown future tier
];

async function seed(store: Store, specs: Spec[] = FIXTURE): Promise<void> {
  const parsed = await parseLines(specs.map(assistantLine));
  store.upsertSession(parsed.session!);
  store.upsertMessages(parsed.messages);
}

// ── effort.ts ────────────────────────────────────────────────────────────────

describe("effort helpers (D1)", () => {
  it("orders low < medium < high < xhigh < max, then others A-Z, then null", () => {
    const shuffled = [null, "turbo", "max", "low", "xhigh", "zeta", "high", "alpha", "medium"];
    expect([...shuffled].sort(compareEffort)).toEqual([
      "low", "medium", "high", "xhigh", "max", "alpha", "turbo", "zeta", null,
    ]);
  });

  const tier = fc.oneof(fc.constantFrom(...KNOWN_EFFORT_ORDER), fc.stringMatching(/^[a-z]{1,10}$/), fc.constant(null));

  it("is a total order: antisymmetric, transitive, null last", () => {
    fc.assert(
      fc.property(tier, tier, tier, (a, b, c) => {
        expect(Math.sign(compareEffort(a, b)) + Math.sign(compareEffort(b, a))).toBe(0);
        expect(compareEffort(a, a)).toBe(0);
        if (compareEffort(a, b) <= 0 && compareEffort(b, c) <= 0) expect(compareEffort(a, c)).toBeLessThanOrEqual(0);
        if (a !== null && b === null) expect(compareEffort(a, b)).toBeLessThan(0);
        if (compareEffort(a, b) === 0) expect(a).toBe(b);
      }),
    );
  });

  it("sorting is independent of input order (unknown tiers are stable)", () => {
    fc.assert(
      fc.property(fc.array(tier, { maxLength: 12 }), (xs) => {
        const forward = [...xs].sort(compareEffort);
        const reversed = [...xs].reverse().sort(compareEffort);
        expect(reversed).toEqual(forward);
      }),
    );
  });

  it("normaliseEffort keeps any non-empty string verbatim and maps the rest to null", () => {
    expect(normaliseEffort("turbo")).toBe("turbo");
    expect(normaliseEffort("")).toBeNull();
    expect(normaliseEffort(undefined)).toBeNull();
    expect(normaliseEffort(3)).toBeNull();
  });
});

// ── parser (D2) ──────────────────────────────────────────────────────────────

describe("parser: perTurnEffort ?? effort (D2, provisional per V5)", () => {
  it("per-turn value wins when both are present and differ", async () => {
    const r = await parseLines([assistantLine({ model: SONNET, input: 1, output: 1, effort: "high", perTurnEffort: "xhigh" })]);
    expect(r.messages[0]!.effort).toBe("xhigh");
  });
  it("falls back to effort when perTurnEffort is absent", async () => {
    const r = await parseLines([assistantLine({ model: SONNET, input: 1, output: 1, effort: "medium" })]);
    expect(r.messages[0]!.effort).toBe("medium");
  });
  it("falls back to effort when perTurnEffort is malformed", async () => {
    const r = await parseLines([assistantLine({ model: SONNET, input: 1, output: 1, effort: "high", perTurnEffort: "Has Space" })]);
    expect(r.messages[0]!.effort).toBe("high");
  });
  it("uses perTurnEffort when effort is malformed or missing", async () => {
    const r = await parseLines([
      assistantLine({ model: SONNET, input: 1, output: 1, effort: "NOT OK", perTurnEffort: "low" }),
      assistantLine({ model: SONNET, input: 1, output: 1, perTurnEffort: "xhigh" }),
    ]);
    expect(r.messages.map((m) => m.effort)).toEqual(["low", "xhigh"]);
  });
  it("is null when both are malformed or absent", async () => {
    const r = await parseLines([
      assistantLine({ model: SONNET, input: 1, output: 1, effort: 7, perTurnEffort: "UPPER" }),
      assistantLine({ model: SONNET, input: 1, output: 1 }),
    ]);
    expect(r.messages.map((m) => m.effort)).toEqual([null, null]);
  });
});

// ── reconciliation on both read paths (D4) ───────────────────────────────────

describe("byEffort reconciles with the headline and byModel", () => {
  let store: Store;
  beforeEach(async () => {
    store = new Store(tmp(".db"));
    await seed(store);
  });
  afterEach(() => store.close());

  // Hand-computed from FIXTURE, independent of the code under test.
  const EXPECTED_INPUT_BY_TIER = new Map<string | null, number>([
    ["low", 1000],
    ["medium", 2000],
    ["high", 3000 + 5000 + 700],
    ["xhigh", 4000],
    ["turbo", 800],
    [null, 600],
  ]);

  function check(data: ReturnType<typeof buildDashboard>): void {
    const byEffort = data.byEffort!;
    // Display order and open vocabulary: unknown tier kept, null last.
    expect(byEffort.map((e) => e.effort)).toEqual(["low", "medium", "high", "xhigh", "turbo", null]);
    for (const row of byEffort) {
      expect(row.inputTokens).toBe(EXPECTED_INPUT_BY_TIER.get(row.effort));
    }
    // Tiers sum to the headline.
    const sum = (f: (e: (typeof byEffort)[number]) => number): number => byEffort.reduce((n, e) => n + f(e), 0);
    expect(sum((e) => e.inputTokens)).toBe(data.summary.inputTokens);
    expect(sum((e) => e.outputTokens)).toBe(data.summary.outputTokens);
    expect(sum((e) => e.estimatedCost)).toBeCloseTo(data.summary.estimatedCost, 1);
    expect(Math.abs(sum((e) => e.estimatedCost) - data.summary.estimatedCost)).toBeLessThan(0.005 * byEffort.length + 1e-9);
    expect(sum((e) => e.messages)).toBe(FIXTURE.length);
    expect(sum((e) => e.costShare)).toBeCloseTo(1, 3);

    // Each model's tiers sum to that model's row; models sum to the headline.
    let modelInput = 0;
    for (const m of data.byModel) {
      const tiers = m.byEffort!;
      expect(tiers.reduce((n, e) => n + e.inputTokens, 0)).toBe(m.inputTokens);
      expect(tiers.reduce((n, e) => n + e.outputTokens, 0)).toBe(m.outputTokens);
      modelInput += m.inputTokens;
    }
    expect(modelInput).toBe(data.summary.inputTokens);
    const opus = data.byModel.find((m) => m.model === OPUS)!;
    expect(opus.byEffort!.map((e) => [e.effort, e.inputTokens])).toEqual([
      ["high", 5000],
      ["xhigh", 4000],
      ["turbo", 800],
    ]);
    const sonnet = data.byModel.find((m) => m.model === SONNET)!;
    expect(sonnet.byEffort!.map((e) => [e.effort, e.inputTokens])).toEqual([
      ["low", 1000],
      ["medium", 2000],
      ["high", 3700],
      [null, 600],
    ]);

    // Coverage: everything but the one untagged message is tagged.
    // (priced independently here, from the fixture's own tokens, unrounded)
    const price = (s: Spec): number => estimateCost(s.model, s.input, s.output, 0, 0).cost;
    const totalCost = FIXTURE.reduce((n, s) => n + price(s), 0);
    const untaggedCost = FIXTURE.filter((s) => s.effort === undefined && s.perTurnEffort === undefined).reduce((n, s) => n + price(s), 0);
    expect(data.effortCoverage!.taggedMessageShare).toBeCloseTo(7 / 8, 4);
    expect(data.effortCoverage!.taggedCostShare).toBeCloseTo(1 - untaggedCost / totalCost, 4);
  }

  it("raw path (bounded window)", () => {
    const data = buildDashboard(store, { period: "all", since: "2023-01-01", until: "2099-01-01" });
    check(data);
  });

  it("rollup path (period:'all', no filter)", () => {
    store.recomputeMessageHourly();
    const data = buildDashboard(store, { period: "all" });
    check(data);
  });

  it("the rollup path really is the rollup, and equals the raw path row for row", async () => {
    // A 1h-TTL cache write is invisible to the rollup (it carries no TTL split),
    // so a differing split between the two reads proves which path ran.
    const eph = tmp(".db");
    const s = new Store(eph);
    try {
      const parsed = await parseLines(FIXTURE.map(assistantLine));
      parsed.messages[0]!.ephemeral1hCacheTokens = 50;
      parsed.messages[0]!.cacheCreationTokens = 50;
      s.upsertSession(parsed.session!);
      s.upsertMessages(parsed.messages);
      const raw = s.getMessageTotals();
      expect(raw.find((r) => r.effort === "low")!.ephemeral_1h_cache_tokens).toBe(50);
      s.recomputeMessageHourly();
      const rolled = s.getMessageTotals();
      expect(rolled.find((r) => r.effort === "low")!.ephemeral_1h_cache_tokens).toBe(0);

      const key = (r: { model: string; effort: string | null }): string => `${r.model}|${r.effort}`;
      const strip = (rows: typeof raw) =>
        rows
          .map((r) => ({ ...r, ephemeral_5m_cache_tokens: 0, ephemeral_1h_cache_tokens: 0 }))
          .sort((a, b) => key(a).localeCompare(key(b)));
      expect(strip(rolled)).toEqual(strip(raw));
    } finally {
      s.close();
    }
  });

  it("raw and rollup dashboards agree on every effort figure", () => {
    const raw = buildDashboard(store, { period: "all", since: "2023-01-01", until: "2099-01-01" });
    store.recomputeMessageHourly();
    const rolled = buildDashboard(store, { period: "all" });
    expect(rolled.byEffort).toEqual(raw.byEffort);
    expect(rolled.byModel).toEqual(raw.byModel);
    expect(rolled.effortCoverage).toEqual(raw.effortCoverage);
  });

  it("foldTotalsByModel collapses tiers back to one row per model with unchanged sums", () => {
    const folded = foldTotalsByModel(store.getMessageTotals());
    expect(folded.map((r) => r.model).sort()).toEqual([OPUS, SONNET]);
    expect(folded.find((r) => r.model === OPUS)!.input_tokens).toBe(5000 + 4000 + 800);
    expect(folded.find((r) => r.model === SONNET)!.input_tokens).toBe(1000 + 2000 + 3000 + 600 + 700);
  });

  it("a window with no effort tags reports one null bucket and zero coverage", async () => {
    const s = new Store(tmp(".db"));
    try {
      await seed(s, [{ model: SONNET, input: 100, output: 10 }]);
      const d = buildDashboard(s, { period: "all" });
      expect(d.byEffort!.map((e) => e.effort)).toEqual([null]);
      expect(d.effortCoverage).toEqual({ taggedCostShare: 0, taggedMessageShare: 0 });
    } finally {
      s.close();
    }
  });
});

// ── migration ────────────────────────────────────────────────────────────────

describe("schema V26", () => {
  it("opens a V25 store with data at V26, rebuilds the rollup, and keeps the all-time headline", async () => {
    const dbPath = tmp(".db");
    const first = new Store(dbPath);
    await seed(first);
    first.recomputeMessageHourly();
    const before = buildDashboard(first, { period: "all" });
    first.close();

    // Rewind to the V25 shape: the 4-key rollup without `effort`, version 25.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TABLE message_hourly;
      CREATE TABLE message_hourly (
        hour_utc INTEGER NOT NULL, project_path TEXT, model TEXT, inference_geo TEXT,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
        th_input_tokens INTEGER NOT NULL, th_output_tokens INTEGER NOT NULL,
        th_cache_read_tokens INTEGER NOT NULL, th_cache_creation_tokens INTEGER NOT NULL,
        msg_count INTEGER NOT NULL, th_msg_count INTEGER NOT NULL, min_ts INTEGER,
        PRIMARY KEY (hour_utc, project_path, model, inference_geo)
      );
      INSERT INTO message_hourly
        SELECT CAST(timestamp / 3600000 AS INTEGER), NULL, model, inference_geo,
               SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens),
               0, 0, 0, 0, COUNT(*), 0, MIN(timestamp)
        FROM messages GROUP BY 1, model, inference_geo;
      DELETE FROM metadata WHERE key = 'message_hourly_watermark';
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '25');
    `);
    raw.close();

    const reopened = new Store(dbPath);
    try {
      expect(SCHEMA_VERSION).toBe(26);
      const check = new DatabaseSync(dbPath);
      const cols = (check.prepare("PRAGMA table_info(message_hourly)").all() as Array<{ name: string; pk: number }>);
      expect(cols.find((c) => c.name === "effort")).toBeDefined();
      expect(cols.find((c) => c.name === "effort")!.pk).toBeGreaterThan(0);
      const version = check.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe("26");
      const rolled = check
        .prepare("SELECT COUNT(DISTINCT effort) AS n, SUM(msg_count) AS m, SUM(effort IS NULL) AS nulls FROM message_hourly")
        .get() as { n: number; m: number; nulls: number };
      expect(rolled.m).toBe(FIXTURE.length);
      expect(rolled.n).toBe(5); // low, medium, high, xhigh, turbo (COUNT DISTINCT skips NULL)
      expect(rolled.nulls).toBeGreaterThan(0); // the not-reported bucket is kept
      check.close();

      const after = buildDashboard(reopened, { period: "all" });
      expect(after.summary.estimatedCost).toBe(before.summary.estimatedCost);
      expect(after.summary.inputTokens).toBe(before.summary.inputTokens);
      expect(after.byEffort).toEqual(before.byEffort);
    } finally {
      reopened.close();
    }
  });
});

// ── get_session_detail ───────────────────────────────────────────────────────

describe("effortMix", () => {
  it("groups a session's messages and cost by tier, null last", () => {
    const priced = (input: number, output: number): number => estimateCost(SONNET, input, output, 0, 0).cost;
    const mix = buildEffortMix([
      { model: SONNET, effort: "high", input_tokens: 1000, output_tokens: 100 },
      { model: SONNET, effort: "low", input_tokens: 200, output_tokens: 20 },
      { model: SONNET, effort: "high", input_tokens: 3000, output_tokens: 300 },
      { model: SONNET, effort: null, input_tokens: 10, output_tokens: 1 },
    ]);
    expect(mix.map((r) => [r.effort, r.messages])).toEqual([["low", 1], ["high", 2], [null, 1]]);
    expect(mix.find((r) => r.effort === "high")!.estimatedCost).toBeCloseTo(priced(1000, 100) + priced(3000, 300), 2);
  });
});
