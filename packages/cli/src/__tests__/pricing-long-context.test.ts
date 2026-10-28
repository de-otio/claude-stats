/**
 * C2 — long-context pricing tier (Haiku 5.5): `estimateCost`'s `longContext`
 * option, `isLongContextRequest`, and `longContextSqlExpr`.
 *
 * Expectations are hand-computed from the published rates (V6), not from the
 * code under test: Haiku 5.5 base 0.10 / 0.50 / 0.01 / 0.125 / 0.20 and tier
 * 0.50 / 2.50 / 0.05 / 0.625 / 1 per MTok (in / out / read / 5m write / 1h write).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import {
  applyPricingCache,
  estimateCost,
  isLongContextRequest,
  longContextSqlExpr,
  longContextSqlExprHash,
  lookupPricing,
  PRICING_VERIFIED_DATE,
} from "@claude-stats/core/pricing";

const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;
const HAIKU = "claude-haiku-5-5";

beforeAll(() => applyPricingCache({}, ORIGINAL_VERIFIED_DATE));
afterAll(() => applyPricingCache({}, ORIGINAL_VERIFIED_DATE));

/** Price one request the way a per-message call site does. */
function priced(model: string, i: number, o: number, cr: number, cc: number, split?: { m5: number; h1: number }) {
  return estimateCost(
    model, i, o, cr, cc, undefined,
    split ? { ephemeral5mCacheTokens: split.m5, ephemeral1hCacheTokens: split.h1 } : undefined,
    { longContext: isLongContextRequest(model, i, cr, cc) },
  );
}

describe("test 1: threshold boundary and whole-request scope", () => {
  it("a prompt of exactly 100,000 is the base tier; 100,001 is the tier", () => {
    // 1M output tokens so the output rate shows: base 0.50, tier 2.50.
    const at = priced(HAIKU, 0, 1_000_000, 100_000, 0);
    // 1_000_000 * 0.50/M + 100_000 * 0.01/M = 0.5 + 0.001
    expect(at.cost).toBeCloseTo(0.501, 9);

    const over = priced(HAIKU, 0, 1_000_000, 100_001, 0);
    // 1_000_000 * 2.50/M + 100_001 * 0.05/M = 2.5 + 0.00500005
    expect(over.cost).toBeCloseTo(2.50500005, 9);
  });

  it("prompt size is input + cache read + cache creation, not any one of them", () => {
    // Each part alone is under the threshold; the sum is 100,001.
    expect(isLongContextRequest(HAIKU, 40_000, 40_000, 20_001)).toBe(true);
    expect(isLongContextRequest(HAIKU, 40_000, 40_000, 20_000)).toBe(false);
    expect(isLongContextRequest(HAIKU, 100_001, 0, 0)).toBe(true);
    expect(isLongContextRequest(HAIKU, 0, 0, 100_001)).toBe(true);
    // Output never counts toward the prompt.
    expect(isLongContextRequest(HAIKU, 1, 1, 1)).toBe(false);
    expect(priced(HAIKU, 1, 5_000_000, 0, 0).cost).toBeCloseTo(0.0000001 + 2.5, 9); // base: 5M out * 0.50
  });

  it("the whole request is at the tier rate: every column, output included", () => {
    // in 60k + read 30k + write 20k = 110k (tier). Hand-computed at tier rates.
    const r = priced(HAIKU, 60_000, 10_000, 30_000, 20_000);
    const expected = (60_000 * 0.50 + 10_000 * 2.50 + 30_000 * 0.05 + 20_000 * 0.625) / 1_000_000;
    expect(r.cost).toBeCloseTo(expected, 12);
    // Not the "excess only" reading: 10k of the prompt over 100k at tier, rest base.
    const excessOnly = (50_000 * 0.10 + 10_000 * 0.50 + 30_000 * 0.01 + 20_000 * 0.125) / 1_000_000 + (10_000 * 0.4) / 1_000_000;
    expect(Math.abs(r.cost - excessOnly)).toBeGreaterThan(0.01);
  });

  it("the id forms of Haiku 5.5 all carry the tier: [1m], dated, Bedrock, Vertex", () => {
    for (const id of [`${HAIKU}[1m]`, `${HAIKU}-20261001`, `anthropic.${HAIKU}`, `${HAIKU}@20261001`]) {
      expect(lookupPricing(id)?.longContext?.thresholdTokens, id).toBe(100_000);
      expect(isLongContextRequest(id, 0, 150_000, 0), id).toBe(true);
      expect(isLongContextRequest(id, 0, 99_999, 0), id).toBe(false);
    }
  });
});

describe("test 2: TTL split under the tier", () => {
  it("prices 5m and 1h writes at the tier's write rates", () => {
    // 400k 5m + 700k 1h = 1.1M written, request is long-context.
    const r = priced(HAIKU, 0, 0, 0, 1_100_000, { m5: 400_000, h1: 700_000 });
    expect(r.cost).toBeCloseTo((400_000 * 0.625 + 700_000 * 1.0) / 1_000_000, 12); // 0.95
    // The base-rate answer would be 0.19; the tier must not be that.
    expect(r.cost).not.toBeCloseTo((400_000 * 0.125 + 700_000 * 0.20) / 1_000_000, 3);
  });

  it("rule 1: no split prices every write at the 5m tier rate, all unattributed", () => {
    const r = priced(HAIKU, 0, 0, 0, 1_100_000);
    expect(r.cost).toBeCloseTo((1_100_000 * 0.625) / 1_000_000, 12);
    expect(r.unattributedWriteTokens).toBe(1_100_000);
  });

  it("rule 2: the residual is priced at the 5m tier rate and reported", () => {
    const r = priced(HAIKU, 0, 0, 0, 1_200_000, { m5: 400_000, h1: 700_000 });
    expect(r.cost).toBeCloseTo((500_000 * 0.625 + 700_000 * 1.0) / 1_000_000, 12);
    expect(r.unattributedWriteTokens).toBe(100_000);
    expect(r.overAttributedWriteTokens).toBe(0);
  });

  it("rule 3: a split larger than the writes is priced as given and the excess reported", () => {
    // 1.0M written but the split claims 1.1M: still a long-context request.
    const r = priced(HAIKU, 0, 0, 0, 1_000_000, { m5: 400_000, h1: 700_000 });
    expect(r.cost).toBeCloseTo((400_000 * 0.625 + 700_000 * 1.0) / 1_000_000, 12);
    expect(r.overAttributedWriteTokens).toBe(100_000);
    expect(r.unattributedWriteTokens).toBe(0);
  });

  it("rule 4: an unknown model stays $0 / known:false even with the flag", () => {
    const r = estimateCost("claude-nonesuch-9", 1, 1, 1, 150_000, undefined, undefined, { longContext: true });
    expect(r.known).toBe(false);
    expect(r.cost).toBe(0);
    expect(r.unattributedWriteTokens).toBe(150_000);
  });

  it("rule 1 and rule 2 (a 0/0 split) still agree to the last bit under the tier", () => {
    const noSplit = estimateCost(HAIKU, 5, 7, 150_000, 3, undefined, undefined, { longContext: true }).cost;
    const zeroSplit = estimateCost(HAIKU, 5, 7, 150_000, 3, undefined, { ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0 }, { longContext: true }).cost;
    expect(zeroSplit).toBe(noSplit);
  });
});

describe("test 3: a model without a tier", () => {
  it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-haiku-4-5"])(
    "%s with longContext:true prices at base rates, known:true",
    (model) => {
      const flagged = estimateCost(model, 300_000, 20_000, 400_000, 50_000, undefined, undefined, { longContext: true });
      const plain = estimateCost(model, 300_000, 20_000, 400_000, 50_000);
      expect(flagged.known).toBe(true);
      expect(flagged.cost).toBe(plain.cost);
      expect(flagged.cost).toBeGreaterThan(0);
      expect(isLongContextRequest(model, 300_000, 400_000, 50_000)).toBe(false);
    },
  );

  it("omitting the option is byte-identical to the pre-C2 call", () => {
    for (const model of [HAIKU, "claude-opus-5-5"]) {
      const a = estimateCost(model, 1234, 567, 150_000, 89);
      const b = estimateCost(model, 1234, 567, 150_000, 89, undefined, undefined, undefined);
      const c = estimateCost(model, 1234, 567, 150_000, 89, undefined, undefined, { longContext: false });
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });
});

describe("test 7: property — tier is exactly 5x base over the threshold, base otherwise", () => {
  const count = fc.integer({ min: 0, max: 400_000 });

  it("cost(tier) == 5 * cost(base) when over 100,000, else equals base (Haiku 5.5)", () => {
    fc.assert(
      fc.property(count, count, count, count, fc.integer({ min: 0, max: 400_000 }), (i, o, cr, cc, h1raw) => {
        const h1 = Math.min(h1raw, cc);
        const split = { ephemeral5mCacheTokens: cc - h1, ephemeral1hCacheTokens: h1 };
        const base = estimateCost(HAIKU, i, o, cr, cc, undefined, split).cost;
        const flagged = estimateCost(HAIKU, i, o, cr, cc, undefined, split, { longContext: isLongContextRequest(HAIKU, i, cr, cc) }).cost;
        const over = i + cr + cc > 100_000;
        const want = over ? 5 * base : base;
        expect(Math.abs(flagged - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, want));
        // and the forced flag gives 5x regardless of size
        const forced = estimateCost(HAIKU, i, o, cr, cc, undefined, split, { longContext: true }).cost;
        expect(Math.abs(forced - 5 * base)).toBeLessThanOrEqual(1e-9 * Math.max(1, 5 * base));
      }),
      { numRuns: 300 },
    );
  });

  it("a model with no tier never changes with the flag", () => {
    fc.assert(
      fc.property(count, count, count, count, (i, o, cr, cc) => {
        const a = estimateCost("claude-sonnet-5-5", i, o, cr, cc).cost;
        const b = estimateCost("claude-sonnet-5-5", i, o, cr, cc, undefined, undefined, { longContext: true }).cost;
        expect(b).toBe(a);
      }),
    );
  });
});

describe("the SQL expression is the same classification as isLongContextRequest", () => {
  it("agrees with the TS function over random rows, boundary included", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (model TEXT, i INTEGER, cr INTEGER, cc INTEGER)");
    const ins = db.prepare("INSERT INTO t VALUES (?, ?, ?, ?)");
    const models = [
      HAIKU,
      `${HAIKU}[1m]`,
      `${HAIKU}-20261001`, // dated snapshot
      `anthropic.${HAIKU}`, // Bedrock (Mantle)
      `us.anthropic.${HAIKU}-v1:0`, // Bedrock legacy, region-prefixed
      `${HAIKU}@20261001`, // Vertex
      `${HAIKU}-1`, // point-release: unpriced, but both classifiers flag it (it costs $0 either way)
      `x-${HAIKU}`, // not a Haiku 5.5 id by prefix; same story
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-4-5",
      "claude-nonesuch-9",
    ];
    const cases: Array<[string, number, number, number]> = [];
    for (const m of models) {
      cases.push([m, 100_000, 0, 0], [m, 0, 100_000, 0], [m, 0, 0, 100_001], [m, 50_000, 25_000, 25_001], [m, 50_000, 25_000, 25_000]);
    }
    fc.assert(
      fc.property(fc.constantFrom(...models), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), (m, i, cr, cc) => {
        cases.push([m, i, cr, cc]);
      }),
      { numRuns: 200 },
    );
    for (const c of cases) ins.run(...c);
    const expr = longContextSqlExpr({ model: "model", input: "i", cacheRead: "cr", cacheCreation: "cc" });
    const rows = db.prepare(`SELECT model, i, cr, cc, ${expr} AS lc FROM t`).all() as Array<{ model: string; i: number; cr: number; cc: number; lc: number }>;
    expect(rows.length).toBe(cases.length);
    for (const r of rows) {
      expect(r.lc === 1, `${r.model} ${r.i}/${r.cr}/${r.cc}`).toBe(isLongContextRequest(r.model, r.i, r.cr, r.cc));
    }
    expect(rows.some((r) => r.lc === 1)).toBe(true);
    expect(rows.some((r) => r.lc === 0)).toBe(true);
    db.close();
  });

  it("treats NULL token columns as zero and a NULL model as untiered", () => {
    const db = new DatabaseSync(":memory:");
    const expr = longContextSqlExpr({ model: "model", input: "i", cacheRead: "cr", cacheCreation: "cc" });
    db.exec("CREATE TABLE t (model TEXT, i INTEGER, cr INTEGER, cc INTEGER)");
    db.exec(`INSERT INTO t VALUES ('${HAIKU}', NULL, 150000, NULL), (NULL, 150000, 0, 0), ('${HAIKU}', NULL, NULL, NULL)`);
    const rows = db.prepare(`SELECT ${expr} AS lc FROM t`).all() as Array<{ lc: number }>;
    expect(rows.map((r) => r.lc)).toEqual([1, 0, 0]);
    db.close();
  });

  it("the id forms the TS test covers all classify the same in SQL, one by one", () => {
    const db = new DatabaseSync(":memory:");
    const expr = longContextSqlExpr({ model: "m", input: "i", cacheRead: "cr", cacheCreation: "cc" });
    for (const id of [`${HAIKU}[1m]`, `${HAIKU}-20261001`, `anthropic.${HAIKU}`, `${HAIKU}@20261001`, `us.anthropic.${HAIKU}-v1:0`]) {
      for (const [i, cr, cc, want] of [[0, 150_000, 0, 1], [0, 100_000, 0, 0], [60_000, 30_000, 10_001, 1]] as const) {
        const got = (db.prepare(`SELECT ${expr} AS lc FROM (SELECT ? AS m, ? AS i, ? AS cr, ? AS cc)`).get(id, i, cr, cc) as { lc: number }).lc;
        expect(got, `${id} ${i}/${cr}/${cc}`).toBe(want);
        expect(isLongContextRequest(id, i, cr, cc), `${id} ${i}/${cr}/${cc}`).toBe(want === 1);
      }
    }
    db.close();
  });

  it("the hash covers the SET of tiered models and each threshold, not just one threshold", () => {
    const h0 = longContextSqlExprHash();
    const expr0 = longContextSqlExpr({ model: "m", input: "i", cacheRead: "cr", cacheCreation: "cc" });
    const sonnet = lookupPricing("claude-sonnet-5-5")!;
    const tier = (threshold: number) => ({
      thresholdTokens: threshold,
      rates: {
        inputPerMillion: sonnet.inputPerMillion * 2,
        outputPerMillion: sonnet.outputPerMillion * 2,
        cacheReadPerMillion: sonnet.cacheReadPerMillion * 2,
        cacheWritePerMillion: sonnet.cacheWritePerMillion * 2,
        cacheWrite1hPerMillion: sonnet.cacheWrite1hPerMillion * 2,
      },
    });
    try {
      // A second tiered model, same threshold: the set changed.
      applyPricingCache({ "claude-sonnet-5-5": { ...sonnet, longContext: tier(100_000) } }, ORIGINAL_VERIFIED_DATE);
      const h1 = longContextSqlExprHash();
      expect(h1).not.toBe(h0);
      expect(longContextSqlExpr({ model: "m", input: "i", cacheRead: "cr", cacheCreation: "cc" })).not.toBe(expr0);
      expect(isLongContextRequest("claude-sonnet-5-5", 0, 150_000, 0)).toBe(true);
      expect(isLongContextRequest("claude-sonnet-5-5", 0, 100_000, 0)).toBe(false);

      // The second model's own threshold moves: hash moves again.
      applyPricingCache({ "claude-sonnet-5-5": { ...sonnet, longContext: tier(200_000) } }, ORIGINAL_VERIFIED_DATE);
      const h2 = longContextSqlExprHash();
      expect(h2).not.toBe(h1);
      expect(h2).not.toBe(h0);
    } finally {
      applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
    }
    expect(longContextSqlExprHash()).toBe(h0);
  });

  it("its hash is stable, and moves when the threshold moves", () => {
    const h0 = longContextSqlExprHash();
    expect(longContextSqlExprHash()).toBe(h0);
    const base = lookupPricing(HAIKU)!;
    applyPricingCache({ [HAIKU]: { ...base, longContext: { ...base.longContext!, thresholdTokens: 50_000 } } }, ORIGINAL_VERIFIED_DATE);
    try {
      expect(longContextSqlExprHash()).not.toBe(h0);
      expect(isLongContextRequest(HAIKU, 0, 60_000, 0)).toBe(true);
    } finally {
      applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
    }
    expect(longContextSqlExprHash()).toBe(h0);
  });
});
