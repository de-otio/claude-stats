/**
 * Fast mode and US geo across the store (plan P1, section 3.2): the raw
 * (bounded) aggregates and the per-message readers price `speed` and
 * `inference_geo`; the hourly rollup (`period: "all"`) prices geo exactly but has
 * no `speed` key, so it prices fast messages at the standard rate and DISCLOSES
 * how many (`fastModeUnpriced`).
 *
 * Rows come through the real parser (`usage.speed`, `usage.inference_geo`) into a
 * real store. Fixtures are synthetic: the local store holds no `fast` and no
 * `us` rows, so nothing here is checked against real data. No TTL split, as in
 * the long-context test: the rollup has never carried one.
 *
 * Hand-computed from the published rates (per MTok):
 *   Fable 5.2   8 / 40,  fast 16 / 80,  us x1.1
 *   Opus 4.7    5 / 25   (no fast rate: a fast row is refused)
 *   Haiku 5.5   0.10 / 0.50 / 0.01 read, tier (>100K prompt) 0.50 / 2.50 / 0.05
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import { applyPricingCache, estimateCost, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
import { Store, groupCostOpts, rowCostOpts } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { buildAgentCostReport } from "../agentCost/index.js";
import { printSummary } from "../reporter/index.js";

const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(os.tmpdir(), `cs-fg-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
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
const M = 1_000_000;
let seq = 0;

interface Spec {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  speed?: string;
  geo?: string;
  session: "A" | "B";
}

function line(spec: Spec): Record<string, unknown> {
  seq++;
  return {
    type: "assistant",
    sessionId: `sess-${spec.session}`,
    version: "2.1.311",
    timestamp: T0 + seq * 1000,
    uuid: `fg-${seq}`,
    message: {
      id: `msg_fg_${seq}`,
      model: spec.model,
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: spec.input,
        output_tokens: spec.output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: spec.cacheRead ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        ...(spec.speed !== undefined ? { speed: spec.speed } : {}),
        ...(spec.geo !== undefined ? { inference_geo: spec.geo } : {}),
      },
    },
  };
}

async function seed(store: Store, specs: Spec[]): Promise<void> {
  for (const session of ["A", "B"] as const) {
    const lines = specs.filter((s) => s.session === session).map(line);
    if (lines.length === 0) continue;
    const file = tmp(".jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parsed = await parseSessionFile(file, `/proj-${session}`);
    store.upsertSession(parsed.session!);
    store.upsertMessages(parsed.messages);
  }
}

const FABLE = "claude-fable-5-2";
const OPUS47 = "claude-opus-4-7";
const HAIKU = "claude-haiku-5-5";

/** 1M input + 1M output per Fable/Opus row, so the figures are not noise. */
const FIXTURE: Spec[] = [
  { model: FABLE, input: M, output: M, speed: "standard", geo: "global", session: "A" }, // 8 + 40            = 48
  { model: FABLE, input: M, output: M, speed: "fast", geo: "global", session: "A" }, //   16 + 80            = 96
  { model: OPUS47, input: M, output: M, speed: "fast", geo: "global", session: "A" }, //  refused            = 0
  { model: FABLE, input: M, output: M, speed: "fast", geo: "us", session: "B" }, //       (16 + 80) x 1.1    = 105.6
  { model: FABLE, input: M, output: M, speed: "standard", geo: "us", session: "B" }, //   (8 + 40) x 1.1     = 52.8
  { model: OPUS47, input: M, output: M, speed: "standard", geo: "global", session: "B" }, // 5 + 25         = 30
  // Haiku 5.5, a 120K prompt (tier) pinned to the US: tier rates x 1.1.
  { model: HAIKU, input: 1_000, output: M, cacheRead: 119_000, speed: "standard", geo: "us", session: "B" },
];
const HAIKU_US = (1_000 * 0.5 + M * 2.5 + 119_000 * 0.05) / 1e6 * 1.1;
/** What a correct per-message price of the whole fixture is. */
const A_EXACT = 48 + 96 + 0;
const B_EXACT = 105.6 + 52.8 + 30 + HAIKU_US;
const EXACT = A_EXACT + B_EXACT;
/** What the rollup can price: geo exactly, speed not at all (all rows at standard). */
const A_ROLLUP = 48 + 48 + 30; // the refused fast Opus 4.7 row reads as a standard row there
const B_ROLLUP = 52.8 + 52.8 + 30 + HAIKU_US;
const ROLLUP = A_ROLLUP + B_ROLLUP;

let store: Store;
beforeEach(async () => {
  seq = 0;
  store = new Store(tmp(".db"));
  await seed(store, FIXTURE);
});
afterEach(() => store.close());

type GroupRow = Parameters<typeof groupCostOpts>[0] & {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};
function priceRows(rows: readonly GroupRow[]): { cost: number; unknown: number } {
  let cost = 0;
  let unknown = 0;
  for (const r of rows) {
    const e = estimateCost(r.model ?? "", r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, undefined, undefined, groupCostOpts(r));
    cost += e.cost;
    if (!e.known) unknown += 1;
  }
  return { cost, unknown };
}

describe("premise", () => {
  it("the exact and rollup figures are distinguishable, so the tests below can fail", () => {
    expect(EXACT).toBeCloseTo(48 + 96 + 105.6 + 52.8 + 30 + HAIKU_US, 9);
    expect(ROLLUP).not.toBeCloseTo(EXACT, 1);
    expect(EXACT - ROLLUP).toBeGreaterThan(40);
  });
});

describe("the raw (bounded) aggregates price speed and geo per request", () => {
  it("getMessageTotals prices to the hand figure, and the refused row is the one unknown", () => {
    const { cost, unknown } = priceRows(store.getMessageTotals({ since: 1 }));
    expect(cost).toBeCloseTo(EXACT, 6);
    expect(unknown).toBe(1);
  });

  it("splits groups only on the dimensions that matter (us, speed class); standard/global/absent collapse", () => {
    const rows = store.getMessageTotals({ since: 1 });
    const keys = rows.map((r) => `${r.model}|${r.long_context}|${r.us_geo}|${r.speed_class}`).sort();
    expect(keys).toEqual(
      [
        `${FABLE}|0|0|null`, // standard/global
        `${FABLE}|0|0|fast`,
        `${FABLE}|0|1|fast`,
        `${FABLE}|0|1|null`,
        `${OPUS47}|0|0|fast`,
        `${OPUS47}|0|0|null`,
        `${HAIKU}|1|1|null`,
      ].sort(),
    );
  });

  it("the headline in the dashboard matches, and carries no fast-mode disclosure (priced exactly)", () => {
    const d = buildDashboard(store, { period: "all", since: "2023-01-01", until: "2099-01-01" });
    expect(Math.abs(d.summary.estimatedCost - EXACT)).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(d.summary.fastModeUnpriced).toBeNull();
    // The refused fast Opus 4.7 row is a visibly missing number, named.
    expect(d.summary.unpricedModels?.map((u) => u.model)).toContain(OPUS47);
  });

  it("per-session cost (getCostBySession) and the sum over sessions", () => {
    const costs = store.getCostBySession();
    expect(costs.get("sess-A")!).toBeCloseTo(A_EXACT, 9);
    expect(costs.get("sess-B")!).toBeCloseTo(B_EXACT, 9);
  });

  it("the per-account, per-project and per-bucket readers agree with the headline", () => {
    const f = { since: 1 };
    for (const rows of [store.getMessageTotalsByAccount(f), store.getMessageTotalsByProject(f), store.getMessageTotalsByBucket(f)]) {
      expect(priceRows(rows).cost).toBeCloseTo(EXACT, 6);
    }
  });

  it("the placeholder-output totals read carries the same dimensions", () => {
    expect(priceRows(store.getPlaceholderOutputTotals({ since: 1 })).cost).toBeCloseTo(EXACT, 6);
  });

  it("the per-message readers agree with the aggregates: the agent-cost report's total", () => {
    const report = buildAgentCostReport(store, {});
    expect(report.coverage.totalCost).toBeCloseTo(EXACT, 6);
  });

  it("a message's own options (rowCostOpts) price it like its group", () => {
    const msgs = store.getMessageCostInputsByUuids(Array.from({ length: FIXTURE.length }, (_, i) => `fg-${i + 1}`));
    expect(msgs).toHaveLength(FIXTURE.length);
    let total = 0;
    for (const m of msgs) {
      total += estimateCost(m.model ?? "", m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens, undefined, undefined, rowCostOpts(m)).cost;
    }
    expect(total).toBeCloseTo(EXACT, 6);
  });
});

describe("the hourly rollup prices geo exactly and discloses the fast messages it cannot price", () => {
  beforeEach(() => {
    store.recomputeMessageHourly();
  });

  it("an unbounded read is served from the rollup and prices every row at its geo, none at its speed", () => {
    expect((store as unknown as { servedFromRollup(f: object): boolean }).servedFromRollup({})).toBe(true);
    const rows = store.getMessageTotals();
    expect(rows.every((r) => r.speed_class === null)).toBe(true);
    expect(priceRows(rows).cost).toBeCloseTo(ROLLUP, 6);
    // US-pinned Fable is x1.1 in the rollup too: that dimension is exact.
    const usFable = rows.filter((r) => r.model === FABLE && r.us_geo === 1);
    expect(priceRows(usFable).cost).toBeCloseTo(52.8 + 52.8, 6); // both at standard speed, both x1.1
  });

  it("fastModeUnpriced counts the non-standard-speed messages: 3 here", () => {
    expect(store.getFastModeUnpriced()).toBe(3);
  });

  it("the dashboard for an unbounded period carries the count; a bounded one carries null", () => {
    const rolled = buildDashboard(store, { period: "all" });
    expect(rolled.summary.fastModeUnpriced).toBe(3);
    expect(Math.abs(rolled.summary.estimatedCost - ROLLUP)).toBeLessThanOrEqual(0.005 + 1e-9);
    const bounded = buildDashboard(store, { period: "all", since: "2023-01-01", until: "2099-01-01" });
    expect(bounded.summary.fastModeUnpriced).toBeNull();
  });

  it("is null for a bounded or session-scoped read (priced per message, nothing to disclose)", () => {
    expect(store.getFastModeUnpriced({ since: 1 })).toBeNull();
    expect(store.getFastModeUnpriced({ projectPath: "/proj-A" })).toBeNull();
  });

  it("is null when no message has a non-standard speed", async () => {
    const clean = new Store(tmp(".db"));
    seq = 0;
    await seed(clean, FIXTURE.filter((s) => s.speed === "standard").map((s) => ({ ...s })));
    clean.recomputeMessageHourly();
    expect(clean.getFastModeUnpriced()).toBeNull();
    clean.close();
  });

  it("the disclosed shortfall is exactly the fast premium: rollup + 48 + 52.8 - 30 = exact", () => {
    // Fast Fable rows cost 48 (global) and 52.8 (us) more than the rollup priced them; the
    // refused fast Opus 4.7 row the rollup priced at 30 is $0 in the exact figure.
    expect(ROLLUP + 48 + 52.8 - 30).toBeCloseTo(EXACT, 9);
    expect(priceRows(store.getMessageTotals()).cost + 48 + 52.8 - 30).toBeCloseTo(priceRows(store.getMessageTotals({ since: 1 })).cost, 6);
  });

  it("the CLI summary prints the disclosure for an unbounded period and not for a bounded one", () => {
    const out = (opts: Parameters<typeof printSummary>[1]): string => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        printSummary(store, { timezone: "UTC", includeCI: true, ...opts });
        return spy.mock.calls.map((c) => String(c[0])).join("\n");
      } finally {
        spy.mockRestore();
      }
    };
    expect(out({})).toMatch(/fastModeUnpriced|fast-mode/);
    const bounded = out({ since: "2023-01-01", until: "2099-01-01" });
    expect(bounded).toMatch(/Cost|costLine/); // the bounded summary did print a cost line
    expect(bounded).not.toMatch(/fastModeUnpriced|fast-mode/);
  });
});
