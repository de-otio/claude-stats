/**
 * C3 (plan P1, section 3.2): the analytics that read a cache rate directly
 * (cache-TTL fit, context carry, context bloat, auto-compact fit) price each
 * request at the rate it was billed at: long-context tier, fast mode, US geo.
 *
 * Before this they resolved one rate row per model, so Haiku 5.5 requests over
 * 100K prompt tokens read 5x low (the C2 follow-up), and a fast-mode or US row
 * read at the standard rate.
 *
 * Two kinds of expectation, so no test checks the code against itself:
 *  - hand arithmetic from the published rates (Haiku 5.5 base 0.10 / 0.50 /
 *    0.01 read / 0.125 5m / 0.20 1h; tier 5x each), and
 *  - an EQUIVALENCE: a window of tiered Haiku rows must give the same dollars
 *    as the same window on a fictional non-tiered model whose configured rates
 *    ARE the tier rates.
 *
 * Fixtures are synthetic. Standard rows are covered by the existing suites,
 * which pass unchanged.
 */
import { describe, it, expect } from "vitest";
import { computeTtlFit } from "@claude-stats/core/ttlFit";
import { computeContextCarry } from "@claude-stats/core/contextCarry";
import { computeAutoCompactFit } from "@claude-stats/core/autoCompactFit";
import { runHygieneDetectors, type HygieneMessageRow } from "@claude-stats/core/hygiene";
import type { ModelPricing, RateOverrides } from "@claude-stats/core/pricing";

const T0 = 1_767_571_200_000;
const MIN = 60_000;
const K = 1_000;
const HAIKU = "claude-haiku-5-5";

function row(o: Partial<HygieneMessageRow> & { sessionId: string; uuid: string }): HygieneMessageRow {
  return {
    projectPath: "/w/alpha",
    timestamp: T0,
    model: HAIKU,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    toolErrorCount: 0,
    tools: [],
    outputPlaceholder: false,
    effort: null,
    isSubagent: false,
    claudeVersion: null,
    speed: null,
    inferenceGeo: null,
    ...o,
  };
}

/** One session, one row per spec, `stepMs` apart. */
function chain(sessionId: string, specs: ReadonlyArray<Partial<HygieneMessageRow>>, stepMs = MIN): HygieneMessageRow[] {
  return specs.map((s, i) => row({ sessionId, uuid: `${sessionId}-m${i}`, timestamp: T0 + i * stepMs, ...s }));
}

/** Haiku 5.5's tier rates, written out, as a non-tiered configured model. */
const TIER_ROW: ModelPricing = {
  inputPerMillion: 0.5,
  outputPerMillion: 2.5,
  cacheReadPerMillion: 0.05,
  cacheWritePerMillion: 0.625,
  cacheWrite1hPerMillion: 1,
  ttlRateBasis: "parsed",
};
const TIERED_MODEL = "claude-test-tier-5";
const TIER_OVERRIDES: RateOverrides = { first_party: { [TIERED_MODEL]: TIER_ROW } };
const asTiered = (rows: readonly HygieneMessageRow[]): HygieneMessageRow[] => rows.map((r) => ({ ...r, model: TIERED_MODEL }));

// ─── context carry ───────────────────────────────────────────────────────────

describe("computeContextCarry prices each turn at its own request's rate", () => {
  // Contexts 60K (base), 120K and 130K (over the 100K threshold: tier).
  const rows = chain("s1", [{ cacheReadTokens: 60 * K }, { cacheReadTokens: 120 * K }, { cacheReadTokens: 130 * K }]);

  it("a long-context turn is carried at the tier read rate (0.05), a short one at the base (0.01)", () => {
    const { turns } = computeContextCarry(rows);
    expect(turns.map((t) => t.increment)).toEqual([60 * K, 60 * K, 10 * K]);
    expect(turns.map((t) => t.remainingRequestsInCycle)).toEqual([3, 2, 1]);
    // increment x remaining x rate / 1e6
    expect(turns[0]!.carryCost).toBeCloseTo((60 * K * 3 * 0.01) / 1e6, 12);
    expect(turns[1]!.carryCost).toBeCloseTo((60 * K * 2 * 0.05) / 1e6, 12);
    expect(turns[2]!.carryCost).toBeCloseTo((10 * K * 1 * 0.05) / 1e6, 12);
  });

  it("flags the adjusted rate on exactly the turns priced off their model's base rate, and only those", () => {
    const { turns } = computeContextCarry(rows);
    expect(turns[0]).not.toHaveProperty("adjustedCacheReadRate");
    expect(turns[1]!.adjustedCacheReadRate).toBe(0.05);
    expect(turns[2]!.adjustedCacheReadRate).toBe(0.05);
  });

  it("a window with no modified request serialises exactly as before (no new key anywhere)", () => {
    const std = chain("s2", [{ model: "claude-opus-5", cacheReadTokens: 60 * K }, { model: "claude-opus-5", cacheReadTokens: 90 * K }]);
    for (const t of computeContextCarry(std).turns) expect(t).not.toHaveProperty("adjustedCacheReadRate");
  });

  it("equals the same window on a non-tiered model carrying the tier rates (the equivalence)", () => {
    const long = chain("s3", [{ cacheReadTokens: 110 * K }, { cacheReadTokens: 150 * K }, { cacheReadTokens: 190 * K }, { cacheReadTokens: 230 * K }]);
    const a = computeContextCarry(long);
    const b = computeContextCarry(asTiered(long), { rateOverrides: TIER_OVERRIDES });
    expect(a.totalCarryCost).not.toBeNull();
    expect(a.totalCarryCost).toBeCloseTo(b.totalCarryCost!, 12);
    expect(a.turns.map((t) => t.carryCost)).toEqual(b.turns.map((t) => t.carryCost));
  });

  it("fast mode: Fable 5.2 is carried at 2 x 0.20 = 0.40; a US row at 0.22; both at 0.44", () => {
    const mk = (extra: Partial<HygieneMessageRow>) =>
      computeContextCarry(chain("s4", [{ model: "claude-fable-5-2", cacheReadTokens: 100 * K, ...extra }, { model: "claude-fable-5-2", cacheReadTokens: 100 * K, ...extra }])).turns[0]!;
    // First turn: increment 100K, 2 remaining requests.
    expect(mk({}).carryCost).toBeCloseTo((100 * K * 2 * 0.2) / 1e6, 12);
    expect(mk({ speed: "fast" }).carryCost).toBeCloseTo((100 * K * 2 * 0.4) / 1e6, 12);
    expect(mk({ inferenceGeo: "us" }).carryCost).toBeCloseTo((100 * K * 2 * 0.22) / 1e6, 12);
    expect(mk({ speed: "fast", inferenceGeo: "us" }).carryCost).toBeCloseTo((100 * K * 2 * 0.44) / 1e6, 12);
    expect(mk({ speed: "fast" }).adjustedCacheReadRate).toBe(0.4);
  });

  it("fast mode on a model with no published fast rate is unpriced (null), not priced at standard", () => {
    const [t0] = computeContextCarry(chain("s5", [{ model: "claude-opus-4-7", speed: "fast", cacheReadTokens: 100 * K }, { model: "claude-opus-4-7", speed: "fast", cacheReadTokens: 100 * K }])).turns;
    expect(t0!.carryCost).toBeNull();
    expect(t0!.adjustedCacheReadRate).toBeNull();
  });
});

// ─── context bloat ───────────────────────────────────────────────────────────

describe("detectContextBloat prices the added tokens at the row's own rate", () => {
  /** The context-bloat findings for a window, through the public detector runner. */
  const bloat = (rows: readonly HygieneMessageRow[]) =>
    runHygieneDetectors(rows, {}).find((r) => r.detectorId === "context-bloat")!.findings;
  // Contexts 110K, 140K, 170K, 200K: three 30K increments, all on long-context rows.
  const specs = [110, 140, 170, 200].map((k) => ({ cacheReadTokens: k * K }));

  it("Haiku 5.5 over 100K: waste = 30K x (3+2+1 remaining) x 0.05 / 1e6, not x 0.01", () => {
    const [f] = bloat(chain("b1", specs));
    expect(f).toBeDefined();
    expect(f!.estimatedWaste).toBeCloseTo((30 * K * (3 + 2 + 1) * 0.05) / 1e6, 12);
  });

  it("the same window below the threshold stays at the base rate", () => {
    // The last context is exactly 100K: still the base tier.
    const small = [10, 40, 70, 100].map((k) => ({ cacheReadTokens: k * K }));
    const [f] = bloat(chain("b2", small));
    expect(f!.estimatedWaste).toBeCloseTo((30 * K * (3 + 2 + 1) * 0.01) / 1e6, 12);
  });

  it("a US-pinned Fable row carries the 1.1x multiplier", () => {
    const fable = (extra: Partial<HygieneMessageRow>) =>
      bloat(chain("b3", specs.map((s) => ({ ...s, model: "claude-fable-5-2", ...extra }))))[0]!.estimatedWaste;
    expect(fable({})).toBeCloseTo((30 * K * 6 * 0.2) / 1e6, 12);
    expect(fable({ inferenceGeo: "us" })).toBeCloseTo((30 * K * 6 * 0.22) / 1e6, 12);
  });
});

// ─── cache-TTL fit ───────────────────────────────────────────────────────────

describe("computeTtlFit prices each request at its own rate, one model row per model", () => {
  /** Rows 10 minutes apart (every gap is 'resume-short'), written at the 1-hour TTL. */
  const ttlRows = (n: number, per: Partial<HygieneMessageRow>, id = "t1") =>
    chain(id, Array.from({ length: n }, () => ({ cacheCreationTokens: 5 * K, ephemeral1hCacheTokens: 5 * K, ...per })), 10 * MIN);

  it("a long-context row's premiums are the tier's (x5), a short row's the base's", () => {
    const longRows = ttlRows(60, { inputTokens: 1 * K, cacheReadTokens: 120 * K }, "long");
    const shortRows = ttlRows(60, { inputTokens: 1 * K, cacheReadTokens: 10 * K }, "short");
    const fit = computeTtlFit([...longRows, ...shortRows]);
    expect(fit.byModel).toHaveLength(1); // two rate groups, ONE row for the model
    const m = fit.byModel[0]!;
    expect(m.model).toBe(HAIKU);
    expect(m.writeTokens1h).toBe(120 * 5 * K);
    // saved = W1h x (write1h - write5m): tier 1 - 0.625 = 0.375; base 0.20 - 0.125 = 0.075.
    expect(m.savedOnWritesAtShortTtl!).toBeCloseTo((60 * 5 * K * 0.375 + 60 * 5 * K * 0.075) / 1e6, 12);
    // extra = recovered reads x (write5m - read): tier 0.625 - 0.05 = 0.575; base 0.125 - 0.01 = 0.115.
    // 59 of each session's 60 rows follow a 10-minute gap and were recorded at 1h.
    expect(m.recoveredReadTokens).toBe(59 * 120 * K + 59 * 10 * K);
    expect(m.extraCostAtShortTtl!).toBeCloseTo((59 * 120 * K * 0.575 + 59 * 10 * K * 0.115) / 1e6, 12);
    // The break-even ratio is a property of the model's own rate structure (uniform x5 leaves it unchanged).
    expect(m.breakEvenRatio).toBeCloseTo(0.075 / 0.115, 12);
  });

  it("equals the same window on a non-tiered model carrying the tier rates (the equivalence)", () => {
    const longRows = ttlRows(60, { inputTokens: 1 * K, cacheReadTokens: 120 * K });
    const a = computeTtlFit(longRows);
    const b = computeTtlFit(asTiered(longRows), { rateOverrides: TIER_OVERRIDES });
    expect(a.byModel[0]!.netCostOfShortTtl!).toBeCloseTo(b.byModel[0]!.netCostOfShortTtl!, 12);
    expect(a.nearBoundary.impliedSwing).toBeCloseTo(b.nearBoundary.impliedSwing, 12);
    expect(a.totals.netCostOfShortTtl!).toBeCloseTo(b.totals.netCostOfShortTtl!, 12);
  });

  it("a fast-mode Fable 5.2 row doubles the premiums; a fast row on an unpriced-fast model is an unpriced row", () => {
    const std = computeTtlFit(ttlRows(60, { model: "claude-fable-5-2", cacheReadTokens: 50 * K }));
    const fast = computeTtlFit(ttlRows(60, { model: "claude-fable-5-2", cacheReadTokens: 50 * K, speed: "fast" }));
    expect(fast.byModel[0]!.savedOnWritesAtShortTtl!).toBeCloseTo(std.byModel[0]!.savedOnWritesAtShortTtl! * 2, 12);
    expect(fast.byModel[0]!.extraCostAtShortTtl!).toBeCloseTo(std.byModel[0]!.extraCostAtShortTtl! * 2, 12);

    const refused = computeTtlFit(ttlRows(60, { model: "claude-opus-4-7", cacheReadTokens: 50 * K, speed: "fast" }));
    expect(refused.byModel).toEqual([]);
    expect(refused.unpricedRows).toBe(60);
  });
});

// ─── auto-compact fit ────────────────────────────────────────────────────────

describe("computeAutoCompactFit reads each turn's own cache-read rate", () => {
  /** Four sawtooth cycles whose every context is over 100K (110K..390K, then a >40% drop). */
  function sawtoothRows(): HygieneMessageRow[] {
    const specs: Array<Partial<HygieneMessageRow>> = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let step = 0; step < 15; step++) specs.push({ cacheReadTokens: 110 * K + step * 20 * K, outputTokens: 100 });
    }
    return chain("a1", specs);
  }

  it("a tiered window gives the same fit as the tier rates on a non-tiered model (the equivalence)", () => {
    const rows = sawtoothRows();
    const a = computeAutoCompactFit(computeContextCarry(rows));
    const b = computeAutoCompactFit(computeContextCarry(asTiered(rows), { rateOverrides: TIER_OVERRIDES }), { rateOverrides: TIER_OVERRIDES });
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(a.candidates.map((c) => c.netSaving)).toEqual(b.candidates.map((c) => c.netSaving));
    // And it is NOT the base-rate answer: the same window priced at Haiku's BASE rates (a
    // non-tiered model carrying them) is 1/5 of the dollars.
    const BASE_ROW: ModelPricing = { ...TIER_ROW, inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125, cacheWrite1hPerMillion: 0.2 };
    const baseOverrides: RateOverrides = { first_party: { [TIERED_MODEL]: BASE_ROW } };
    const base = computeAutoCompactFit(computeContextCarry(asTiered(rows), { rateOverrides: baseOverrides }), { rateOverrides: baseOverrides });
    const at = (r: ReturnType<typeof computeAutoCompactFit>) => r.candidates.find((c) => c.windowTokens === 200 * K)!.netSaving!;
    expect(at(a)).toBeCloseTo(at(base) * 5, 9);
  });

  it("a turn carrying an adjusted rate overrides its model's base rate; null makes it unpriced", () => {
    const carry = computeContextCarry(sawtoothRows());
    const turns = carry.turns.map((t) => ({ ...t, adjustedCacheReadRate: 0.01 }));
    const asBase = computeAutoCompactFit({ ...carry, turns });
    const unpriced = computeAutoCompactFit({ ...carry, turns: carry.turns.map((t) => ({ ...t, adjustedCacheReadRate: null })) });
    const tier = computeAutoCompactFit(carry);
    const at = (r: ReturnType<typeof computeAutoCompactFit>) => r.candidates.find((c) => c.windowTokens === 200 * K)!.netSaving;
    expect(at(tier)).not.toBeNull();
    // The adjusted rate (0.01) replaces the tier rate (0.05) the model-id path would have used.
    expect(at(asBase)).not.toBeCloseTo(at(tier)!, 6);
    expect(at(unpriced)).toBeNull();
  });
});
