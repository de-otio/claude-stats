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
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

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
const HOUR = 3_600_000;
let seq = 0;

interface Spec {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  eph5m?: number;
  eph1h?: number; // eph5m + eph1h = cacheCreation
  effort?: unknown;
  perTurnEffort?: unknown;
  project?: "A" | "B";
  hour?: number;
  geo?: string;
  /** Shared `message.id`: the max-usage line is the carrier, the rest are demoted (tokens zeroed). */
  msgId?: string;
  /** False for a line that loses the carrier race. Hand-set; the test asserts the parser agrees. */
  counted?: boolean;
}

function assistantLine(spec: Spec): Record<string, unknown> {
  seq++;
  return {
    type: "assistant",
    sessionId: `sess-${spec.project ?? "A"}`,
    version: "2.1.300",
    timestamp: T0 + (spec.hour ?? 0) * HOUR + seq * 1000,
    uuid: `a-${seq}`,
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    ...(spec.perTurnEffort !== undefined ? { perTurnEffort: spec.perTurnEffort } : {}),
    message: {
      id: spec.msgId ?? `msg_${seq}`,
      model: spec.model,
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: spec.input,
        output_tokens: spec.output,
        cache_creation_input_tokens: spec.cacheCreation ?? 0,
        cache_read_input_tokens: spec.cacheRead ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: spec.eph5m ?? 0, ephemeral_1h_input_tokens: spec.eph1h ?? 0 },
        inference_geo: spec.geo ?? "us",
      },
    },
  };
}

async function parseLines(lines: object[], projectName = "/proj") {
  const file = tmp(".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return parseSessionFile(file, projectName);
}

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";
const UNKNOWN_MODEL = "claude-nonesuch-9"; // no rate row: cost 0, tokens still counted

/**
 * Every case the plan lists, spread over two hours, two projects and two
 * inference_geo values so the rollup read must MERGE buckets, with distinct
 * non-zero cache values per row so a swapped column cannot go unnoticed.
 */
const FIXTURE: Spec[] = [
  { model: SONNET, input: 1000, output: 100, cacheRead: 11_000, cacheCreation: 20_000, eph5m: 15_000, eph1h: 5_000, effort: "low", project: "A", hour: 0, geo: "us" },
  { model: SONNET, input: 2000, output: 200, cacheRead: 22_000, cacheCreation: 40_000, eph5m: 10_000, eph1h: 30_000, effort: "medium", project: "A", hour: 1, geo: "eu" },
  { model: SONNET, input: 3000, output: 300, cacheRead: 33_000, cacheCreation: 60_000, eph5m: 60_000, eph1h: 0, effort: "high", project: "B", hour: 0, geo: "us" },
  { model: OPUS, input: 4000, output: 400, cacheRead: 44_000, cacheCreation: 80_000, eph5m: 0, eph1h: 80_000, effort: "xhigh", project: "A", hour: 1, geo: "us" },
  { model: OPUS, input: 5000, output: 500, cacheRead: 55_000, cacheCreation: 100_000, eph5m: 40_000, eph1h: 60_000, effort: "high", project: "B", hour: 1, geo: "eu" },
  { model: SONNET, input: 600, output: 60, cacheRead: 66_000, cacheCreation: 120_000, eph5m: 120_000, eph1h: 0, project: "A", hour: 1, geo: "us" }, // no effort at all
  { model: SONNET, input: 700, output: 70, cacheRead: 77_000, cacheCreation: 140_000, eph5m: 100_000, eph1h: 40_000, perTurnEffort: "high", project: "B", hour: 0, geo: "eu" }, // perTurnEffort only
  { model: OPUS, input: 800, output: 80, cacheRead: 88_000, cacheCreation: 160_000, eph5m: 0, eph1h: 160_000, effort: "turbo", project: "A", hour: 0, geo: "us" }, // unknown future tier
  { model: UNKNOWN_MODEL, input: 900, output: 90, cacheRead: 99_000, cacheCreation: 180_000, eph5m: 80_000, eph1h: 100_000, effort: "high", project: "B", hour: 1, geo: "us" }, // unpriced model, tagged
  { model: SONNET, input: 0, output: 0, effort: "low", project: "A", hour: 1, geo: "us" }, // zero-token tagged row
  // One response written as two lines: the larger one is the carrier; the
  // smaller one keeps its own (different) effort but loses its tokens.
  { model: SONNET, input: 10, output: 1, cacheRead: 1, effort: "low", project: "B", hour: 0, geo: "us", msgId: "msg_shared", counted: false },
  { model: SONNET, input: 1200, output: 120, cacheRead: 111_000, cacheCreation: 200_000, eph5m: 200_000, eph1h: 0, effort: "xhigh", project: "B", hour: 0, geo: "us", msgId: "msg_shared", counted: true },
];

// ── independent expectations, computed from the specs alone ──────────────────

const tierOf = (s: Spec): string | null => ((s.perTurnEffort ?? s.effort) as string | undefined) ?? null;
const live = (s: Spec): boolean => s.counted !== false;
const n = (s: Spec, v: number | undefined): number => (live(s) ? (v ?? 0) : 0);

/** Cost of one fixture row; `split` = the raw path's TTL split, off = the rollup's (no split). */
function price(s: Spec, split: boolean): number {
  return estimateCost(
    s.model, n(s, s.input), n(s, s.output), n(s, s.cacheRead), n(s, s.cacheCreation), undefined,
    split ? { ephemeral5mCacheTokens: n(s, s.eph5m), ephemeral1hCacheTokens: n(s, s.eph1h) } : undefined,
  ).cost;
}
function expectFor(rows: Spec[], split: boolean) {
  return {
    input: rows.reduce((a, s) => a + n(s, s.input), 0),
    output: rows.reduce((a, s) => a + n(s, s.output), 0),
    cacheRead: rows.reduce((a, s) => a + n(s, s.cacheRead), 0),
    cacheCreation: rows.reduce((a, s) => a + n(s, s.cacheCreation), 0),
    messages: rows.length,
    cost: rows.reduce((a, s) => a + price(s, split), 0),
  };
}
const round2 = (x: number): number => Math.round(x * 100) / 100;

async function seed(store: Store, specs: Spec[] = FIXTURE): Promise<void> {
  for (const project of ["A", "B"] as const) {
    const lines = specs.filter((s) => (s.project ?? "A") === project).map(assistantLine);
    if (lines.length === 0) continue;
    const parsed = await parseLines(lines, `/proj-${project}`);
    store.upsertSession(parsed.session!);
    store.upsertMessages(parsed.messages);
  }
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

const TIER_ORDER = ["low", "medium", "high", "xhigh", "turbo", null]; // hand-written, not compareEffort
const WINDOW = { period: "all", since: "2023-01-01", until: "2099-01-01" } as const;

describe("byEffort reconciles with the headline and byModel", () => {
  let store: Store;
  let dbPath: string;
  beforeEach(async () => {
    dbPath = tmp(".db");
    store = new Store(dbPath);
    await seed(store);
  });
  afterEach(() => store.close());

  function checkTier(row: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; messages: number; estimatedCost: number }, rows: Spec[], split: boolean): void {
    const e = expectFor(rows, split);
    expect(row.inputTokens).toBe(e.input);
    expect(row.outputTokens).toBe(e.output);
    expect(row.cacheReadTokens).toBe(e.cacheRead);
    expect(row.cacheCreationTokens).toBe(e.cacheCreation);
    expect(row.messages).toBe(e.messages);
    expect(Math.abs(row.estimatedCost - e.cost)).toBeLessThanOrEqual(0.005 + 1e-9);
  }

  /** `split`: the raw path prices the 5m/1h cache-write split; the rollup cannot. */
  function check(data: ReturnType<typeof buildDashboard>, split: boolean): void {
    const byEffort = data.byEffort!;
    expect(byEffort.map((e) => e.effort)).toEqual(TIER_ORDER);
    for (const row of byEffort) {
      checkTier(row, FIXTURE.filter((s) => tierOf(s) === row.effort), split);
    }

    // Headline against an independent total, not against the sum of its own parts.
    const all = expectFor(FIXTURE, split);
    expect(data.summary.inputTokens).toBe(all.input);
    expect(data.summary.outputTokens).toBe(all.output);
    expect(data.summary.cacheReadTokens).toBe(all.cacheRead);
    expect(data.summary.cacheCreationTokens).toBe(all.cacheCreation);
    expect(Math.abs(data.summary.estimatedCost - all.cost)).toBeLessThanOrEqual(0.005 + 1e-9);
    const sumCost = byEffort.reduce((x, e) => x + e.estimatedCost, 0);
    expect(Math.abs(sumCost - data.summary.estimatedCost)).toBeLessThanOrEqual(0.005 * byEffort.length + 1e-9);
    expect(byEffort.reduce((x, e) => x + e.messages, 0)).toBe(FIXTURE.length);
    for (const row of byEffort) {
      const rows = FIXTURE.filter((s) => tierOf(s) === row.effort);
      expect(row.costShare).toBeCloseTo(expectFor(rows, split).cost / all.cost, 3);
    }

    // Each model, and each of its tiers.
    expect(data.byModel.map((m) => m.model).sort()).toEqual([OPUS, SONNET, UNKNOWN_MODEL].sort());
    for (const m of data.byModel) {
      const rows = FIXTURE.filter((s) => s.model === m.model);
      const e = expectFor(rows, split);
      expect(m.inputTokens).toBe(e.input);
      expect(m.outputTokens).toBe(e.output);
      expect(Math.abs(m.estimatedCost - e.cost)).toBeLessThanOrEqual(0.005 + 1e-9);
      const tiers = [...new Set(rows.map(tierOf))].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
      expect(m.byEffort!.map((t) => t.effort)).toEqual(tiers);
      for (const t of m.byEffort!) checkTier(t, rows.filter((s) => tierOf(s) === t.effort), split);
    }

    // Coverage. The untagged row is the only null; the zero-token row is tagged but costs nothing;
    // the unpriced-model row is tagged and counts toward messages but adds no cost.
    const untagged = FIXTURE.filter((s) => tierOf(s) === null);
    expect(untagged).toHaveLength(1);
    expect(data.effortCoverage!.taggedMessageShare).toBeCloseTo((FIXTURE.length - 1) / FIXTURE.length, 4);
    expect(data.effortCoverage!.taggedCostShare).toBeCloseTo(1 - expectFor(untagged, split).cost / all.cost, 4);
  }

  it("premise: the parser demotes the smaller sibling and keeps its effort", () => {
    const msgs = store.getSessionMessages("sess-B").filter((m) => m.message_id === "msg_shared");
    expect(msgs.map((m) => [m.effort, m.usage_counted, m.input_tokens])).toEqual([["low", 0, 0], ["xhigh", 1, 1200]]);
  });

  it("premise: the 5m/1h split changes the price, so raw and rollup costs differ in a known way", () => {
    expect(expectFor(FIXTURE, true).cost - expectFor(FIXTURE, false).cost).toBeGreaterThan(0.5);
  });

  it("raw path (bounded window) prices the TTL split", () => {
    check(buildDashboard(store, WINDOW), true);
  });

  it("rollup path (period:'all') ran: it prices without the TTL split, to the known amount", () => {
    store.recomputeMessageHourly();
    const data = buildDashboard(store, { period: "all" });
    // Raw and rollup differ by > 0.5 (premise above); matching the NO-split total proves the rollup served this.
    expect(Math.abs(data.summary.estimatedCost - expectFor(FIXTURE, false).cost)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(Math.abs(data.summary.estimatedCost - expectFor(FIXTURE, true).cost)).toBeGreaterThan(0.5);
    check(data, false);
  });

  it("the rollup merges buckets: many hour/project/geo rows, same totals per (model, effort) as raw", () => {
    const raw = store.getMessageTotals();
    expect(raw.some((r) => r.ephemeral_1h_cache_tokens > 0)).toBe(true);
    store.recomputeMessageHourly();
    const db = new DatabaseSync(dbPath);
    const buckets = db
      .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT hour_utc) AS h, COUNT(DISTINCT project_path) AS p, COUNT(DISTINCT inference_geo) AS g FROM message_hourly")
      .get() as { c: number; h: number; p: number; g: number };
    db.close();
    expect(buckets.h).toBeGreaterThanOrEqual(2);
    expect(buckets.p).toBe(2);
    expect(buckets.g).toBe(2);
    expect(buckets.c).toBeGreaterThan(raw.length);
    const rolled = store.getMessageTotals();
    expect(rolled.every((r) => r.ephemeral_1h_cache_tokens === 0)).toBe(true);
    const key = (r: { model: string; effort: string | null }): string => `${r.model}|${r.effort}`;
    const strip = (rows: typeof raw) =>
      rows.map((r) => ({ ...r, ephemeral_5m_cache_tokens: 0, ephemeral_1h_cache_tokens: 0 })).sort((a, b) => key(a).localeCompare(key(b)));
    expect(strip(rolled)).toEqual(strip(raw));
  });

  it("raw and rollup dashboards agree on every token and message figure", () => {
    const raw = buildDashboard(store, WINDOW);
    store.recomputeMessageHourly();
    const rolled = buildDashboard(store, { period: "all" });
    const tokens = (rows: NonNullable<typeof raw.byEffort>) => rows.map(({ estimatedCost: _c, costShare: _s, ...rest }) => rest);
    expect(tokens(rolled.byEffort!)).toEqual(tokens(raw.byEffort!));
    expect(rolled.effortCoverage!.taggedMessageShare).toBe(raw.effortCoverage!.taggedMessageShare);
  });

  it("demoted siblings: both rows count as messages, tokens sit only on the carrier's tier", () => {
    const d = buildDashboard(store, WINDOW);
    const low = d.byEffort!.find((e) => e.effort === "low")!;
    const xhigh = d.byEffort!.find((e) => e.effort === "xhigh")!;
    // low: row 1, the zero-token row and the demoted sibling -> 3 messages, only row 1's tokens
    expect(low.messages).toBe(3);
    expect(low.inputTokens).toBe(1000);
    // xhigh: the Opus xhigh row and the sibling carrier
    expect(xhigh.messages).toBe(2);
    expect(xhigh.inputTokens).toBe(4000 + 1200);
  });

  it("foldTotalsByModel collapses tiers back to one row per model with every sum unchanged", () => {
    const folded = foldTotalsByModel(store.getMessageTotals());
    expect(folded.map((r) => r.model).sort()).toEqual([OPUS, SONNET, UNKNOWN_MODEL].sort());
    for (const r of folded) {
      const rows = FIXTURE.filter((s) => s.model === r.model);
      const e = expectFor(rows, true);
      expect(r.input_tokens).toBe(e.input);
      expect(r.output_tokens).toBe(e.output);
      expect(r.cache_read_tokens).toBe(e.cacheRead);
      expect(r.cache_creation_tokens).toBe(e.cacheCreation);
      expect(r.ephemeral_5m_cache_tokens).toBe(rows.reduce((a, s) => a + n(s, s.eph5m), 0));
      expect(r.ephemeral_1h_cache_tokens).toBe(rows.reduce((a, s) => a + n(s, s.eph1h), 0));
    }
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

  it("tagged rows that cost nothing (zero tokens, unpriced model): cost share 0, message share not", async () => {
    const s = new Store(tmp(".db"));
    try {
      await seed(s, [
        { model: SONNET, input: 0, output: 0, effort: "high" },
        { model: UNKNOWN_MODEL, input: 500, output: 50, effort: "low" },
      ]);
      const d = buildDashboard(s, { period: "all" });
      expect(d.summary.estimatedCost).toBe(0);
      expect(d.effortCoverage).toEqual({ taggedCostShare: 0, taggedMessageShare: 1 });
      expect(d.byEffort!.map((e) => e.costShare)).toEqual([0, 0]);
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
      const cols = check.prepare("PRAGMA table_info(message_hourly)").all() as Array<{ name: string; pk: number }>;
      expect(cols.find((c) => c.name === "effort")!.pk).toBeGreaterThan(0);
      const version = check.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe("26");
      const rolled = check
        .prepare("SELECT COUNT(DISTINCT effort) AS n, SUM(msg_count) AS m, SUM(effort IS NULL) AS nulls, COUNT(*) AS buckets FROM message_hourly")
        .get() as { n: number; m: number; nulls: number; buckets: number };
      expect(rolled.m).toBe(FIXTURE.length); // includes the demoted sibling row
      expect(rolled.n).toBe(5); // low, medium, high, xhigh, turbo (COUNT DISTINCT skips NULL)
      expect(rolled.nulls).toBeGreaterThan(0);
      expect(rolled.buckets).toBeGreaterThan(6); // hours x projects x geos stayed separate
      const low = check.prepare("SELECT SUM(msg_count) AS m FROM message_hourly WHERE effort = 'low'").get() as { m: number };
      expect(low.m).toBe(3); // incl. the demoted sibling that lost its tokens
      check.close();

      const after = buildDashboard(reopened, { period: "all" });
      expect(after.summary.estimatedCost).toBe(before.summary.estimatedCost);
      expect(after.summary.inputTokens).toBe(before.summary.inputTokens);
      expect(after.summary.cacheCreationTokens).toBe(expectFor(FIXTURE, false).cacheCreation);
      expect(after.byEffort).toEqual(before.byEffort);
    } finally {
      reopened.close();
    }
  });
});

// ── get_stats payload ────────────────────────────────────────────────────────

describe("get_stats MCP payload", () => {
  it("carries byEffort, effortCoverage and byModel[].byEffort, equal to the dashboard's", async () => {
    const store = new Store(tmp(".db"));
    try {
      await seed(store);
      store.recomputeMessageHourly();
      const server = createMcpServer(store);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "effort-test", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = await client.callTool({ name: "get_stats", arguments: { period: "all" } });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      const dash = buildDashboard(store, { period: "all" });
      expect(body["byEffort"]).toEqual(dash.byEffort);
      expect(body["effortCoverage"]).toEqual(dash.effortCoverage);
      const byModel = body["byModel"] as Array<{ model: string; byEffort: unknown[] }>;
      expect(byModel.length).toBe(3);
      expect(byModel.every((m) => Array.isArray(m.byEffort) && m.byEffort.length > 0)).toBe(true);
      expect(byModel).toEqual(dash.byModel);
      const detail = await client.callTool({ name: "get_session_detail", arguments: { sessionId: "sess-B" } });
      const d = JSON.parse((detail.content as Array<{ text: string }>)[0]!.text) as {
        effortMix: Array<{ effort: string | null; messages: number }>;
        messages: Array<{ effort: string | null }>;
      };
      expect(d.messages.map((m) => m.effort)).toContain("xhigh");
      expect(d.effortMix.find((r) => r.effort === "low")!.messages).toBe(1); // sess-B: only the demoted sibling is low
      await client.close();
    } finally {
      store.close();
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
