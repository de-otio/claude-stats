/**
 * Fast-mode and US-geo pricing, and the 5.2 rows (plan P1, section 3.1-3.2).
 *
 * Every expectation is hand-computed from the rates on the published pricing
 * page (read 2026-11-10), not from the code under test:
 *
 *   Fable 5.2 / Mythos 5.2   $8 / $40,  read 0.20, 5m write 10,   1h write 16
 *   fast mode                $16 / $80 (2x); the cache multipliers stack on it,
 *                            so every cache rate is 2x too (read 0.40, 20, 32)
 *   inference_geo "us"       1.1x on every category, Claude 4.6 and later
 *
 * Fixtures are synthetic: the real store holds no `fast` and no `us` rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyPricingCache,
  costOptionsKey,
  estimateCost,
  isLongContextRequest,
  lookupPricing,
  PRICING_VERIFIED_DATE,
  resolveRequestPricing,
  type ModelPricing,
} from "@claude-stats/core/pricing";

const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;
beforeEach(() => applyPricingCache({}, ORIGINAL_VERIFIED_DATE));
afterEach(() => applyPricingCache({}, ORIGINAL_VERIFIED_DATE));

const M = 1_000_000;
/** 1M tokens of each category; the cost is then the sum of the five rates (writes at 5m). */
const ONE_M_EACH = [M, M, M, M] as const;
const sumOfRates = (r: { in: number; out: number; read: number; w5: number }) => r.in + r.out + r.read + r.w5;

describe("the 5.2 rows (3.1)", () => {
  it.each(["claude-fable-5-2", "claude-mythos-5-2"])("%s is priced at 8 / 40 / 0.20 / 10 / 16", (id) => {
    const p = lookupPricing(id)!;
    expect(p).toMatchObject({
      inputPerMillion: 8,
      outputPerMillion: 40,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 10,
      cacheWrite1hPerMillion: 16,
      ttlRateBasis: "parsed",
    });
    expect(estimateCost(id, ...ONE_M_EACH).cost).toBeCloseTo(sumOfRates({ in: 8, out: 40, read: 0.2, w5: 10 }), 10);
  });

  it("the Bedrock id resolves to the same row", () => {
    expect(lookupPricing("anthropic.claude-fable-5-2")).toEqual(lookupPricing("claude-fable-5-2"));
    expect(estimateCost("anthropic.claude-fable-5-2", ...ONE_M_EACH).known).toBe(true);
  });

  it("5.1 and 5.0 keep their own rows (5.2 did not capture them)", () => {
    expect(lookupPricing("claude-fable-5-1")!.cacheReadPerMillion).toBe(0.25);
    expect(lookupPricing("claude-fable-5")!.cacheReadPerMillion).toBe(1);
  });

  it("a hypothetical 5.3 stays refused, not priced from the 5.2 row", () => {
    const r = estimateCost("claude-fable-5-3", ...ONE_M_EACH);
    expect(r).toMatchObject({ cost: 0, known: false });
  });
});

describe("speed (3.2 rules table)", () => {
  const std = estimateCost("claude-fable-5-2", ...ONE_M_EACH).cost; // 58.2

  it("absent, null and 'standard' are bit-identical to no options", () => {
    for (const speed of [undefined, null, "standard"] as const) {
      const r = estimateCost("claude-fable-5-2", ...ONE_M_EACH, undefined, undefined, { speed });
      expect(r.cost).toBe(std);
      expect(r.known).toBe(true);
      expect(r.reason).toBeUndefined();
    }
    expect(estimateCost("claude-fable-5-2", ...ONE_M_EACH, undefined, undefined, {}).cost).toBe(std);
  });

  it("fast multiplies all five rates by 2: $16 / $80 and the cache rates stacked on top", () => {
    const fast = { speed: "fast" } as const;
    // Each column alone, 1M tokens.
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(16, 10);
    expect(estimateCost("claude-fable-5-2", 0, M, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(80, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, M, 0, undefined, undefined, fast).cost).toBeCloseTo(0.4, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, 0, M, undefined, undefined, fast).cost).toBeCloseTo(20, 10);
    // 1h write via the TTL split.
    expect(
      estimateCost("claude-fable-5-2", 0, 0, 0, M, undefined, { ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: M }, fast).cost,
    ).toBeCloseTo(32, 10);
    expect(estimateCost("claude-fable-5-2", ...ONE_M_EACH, undefined, undefined, fast).cost).toBe(std * 2);
  });

  it("fast is published for Fable 5.2, Mythos 5.2, Opus 5.5, Opus 5 and Opus 4.8 (2x each)", () => {
    const fast = { speed: "fast" } as const;
    // Page: Opus 5.5 $8 / $40; Opus 5 and Opus 4.8 $10 / $50.
    expect(estimateCost("claude-opus-5-5", M, M, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(8 + 40, 10);
    expect(estimateCost("claude-opus-5", M, M, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(10 + 50, 10);
    expect(estimateCost("claude-opus-4-8", M, M, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(10 + 50, 10);
    expect(estimateCost("claude-mythos-5-2", M, M, 0, 0, undefined, undefined, fast).cost).toBeCloseTo(16 + 80, 10);
  });

  it.each([
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-mythos-5-1",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
  ])("fast on %s (no published fast rate) is REFUSED, never priced at standard", (id) => {
    const r = estimateCost(id, ...ONE_M_EACH, undefined, undefined, { speed: "fast" });
    expect(r).toMatchObject({ cost: 0, known: false, reason: "fast-unpriced" });
    // And the same model at standard is priced, so the refusal is about speed alone.
    expect(estimateCost(id, ...ONE_M_EACH).known).toBe(true);
  });

  it.each(["turbo", "Fast", "FAST", "", "fast "])("any other speed value (%j) is refused as speed-unknown", (speed) => {
    const r = estimateCost("claude-fable-5-2", ...ONE_M_EACH, undefined, undefined, { speed });
    expect(r).toMatchObject({ cost: 0, known: false, reason: "speed-unknown" });
  });

  it("a refusal reports the cache-creation volume as unattributed, like an unknown model", () => {
    const r = estimateCost("claude-sonnet-5", 1, 1, 1, 777, undefined, undefined, { speed: "fast" });
    expect(r.unattributedWriteTokens).toBe(777);
    expect(r.overAttributedWriteTokens).toBe(0);
  });

  it("an unknown model keeps its plain unknown result (no reason), whatever the speed", () => {
    const r = estimateCost("claude-not-a-model", 1, 1, 1, 1, undefined, undefined, { speed: "fast" });
    expect(r.known).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("a configured override row without a fast multiplier refuses fast too", () => {
    const row: ModelPricing = {
      inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25, cacheWrite1hPerMillion: 2, ttlRateBasis: "parsed",
    };
    const overrides = { first_party: { "claude-fable-5-2": row } } as const;
    expect(estimateCost("claude-fable-5-2", ...ONE_M_EACH, overrides, undefined, { speed: "fast" })).toMatchObject({
      cost: 0, known: false, reason: "fast-unpriced",
    });
    // The same override at standard speed prices from the override.
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, overrides).cost).toBeCloseTo(1, 10);
  });
});

describe("inference_geo (3.2 rules table)", () => {
  it("'us' multiplies all five rates by 1.1 on a 4.6+ model", () => {
    const us = { inferenceGeo: "us" } as const;
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, us).cost).toBeCloseTo(8.8, 10);
    expect(estimateCost("claude-fable-5-2", 0, M, 0, 0, undefined, undefined, us).cost).toBeCloseTo(44, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, M, 0, undefined, undefined, us).cost).toBeCloseTo(0.22, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, 0, M, undefined, undefined, us).cost).toBeCloseTo(11, 10);
    expect(
      estimateCost("claude-fable-5-2", 0, 0, 0, M, undefined, { ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: M }, us).cost,
    ).toBeCloseTo(17.6, 10);
  });

  it.each([null, undefined, "global", "not_available", "", "US", "us-east-1", "eu"])(
    "geo %j is x1: bit-identical to no options",
    (inferenceGeo) => {
      const base = estimateCost("claude-fable-5-2", ...ONE_M_EACH).cost;
      expect(estimateCost("claude-fable-5-2", ...ONE_M_EACH, undefined, undefined, { inferenceGeo }).cost).toBe(base);
    },
  );

  it("a model older than 4.6 has no US multiplier: 'us' is x1", () => {
    for (const id of ["claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-5-sonnet-20241022"]) {
      const base = estimateCost(id, ...ONE_M_EACH).cost;
      expect(estimateCost(id, ...ONE_M_EACH, undefined, undefined, { inferenceGeo: "us" }).cost).toBe(base);
    }
  });

  it.each([
    "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
    "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5",
    "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-mythos-5", "claude-mythos-5-1", "claude-mythos-5-2",
  ])("%s ('Claude 4.6 and later') carries the 1.1 US multiplier", (id) => {
    expect(lookupPricing(id)!.usGeoMultiplier).toBe(1.1);
    const base = estimateCost(id, ...ONE_M_EACH).cost;
    expect(estimateCost(id, ...ONE_M_EACH, undefined, undefined, { inferenceGeo: "us" }).cost).toBeCloseTo(base * 1.1, 9);
  });
});

describe("modifiers compose by multiplication (3.2)", () => {
  it("fast x us on Fable 5.2: 16 x 1.1 = 17.6 input, 80 x 1.1 = 88 output, cache stacked", () => {
    const both = { speed: "fast", inferenceGeo: "us" } as const;
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, both).cost).toBeCloseTo(17.6, 10);
    expect(estimateCost("claude-fable-5-2", 0, M, 0, 0, undefined, undefined, both).cost).toBeCloseTo(88, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, M, 0, undefined, undefined, both).cost).toBeCloseTo(0.44, 10);
    expect(estimateCost("claude-fable-5-2", 0, 0, 0, M, undefined, undefined, both).cost).toBeCloseTo(22, 10);
  });

  it("long context x us on Haiku 5.5: the page says the multiplier also applies to the over-100K prices", () => {
    // A 120K-token prompt: tier rates 0.50 / 2.50 / 0.05 / 0.625, then x 1.1.
    const opts = { longContext: true, inferenceGeo: "us" } as const;
    expect(estimateCost("claude-haiku-5-5", 0, M, 0, 0, undefined, undefined, opts).cost).toBeCloseTo(2.5 * 1.1, 10);
    expect(estimateCost("claude-haiku-5-5", M, 0, 0, 0, undefined, undefined, opts).cost).toBeCloseTo(0.5 * 1.1, 10);
    expect(estimateCost("claude-haiku-5-5", 0, 0, M, 0, undefined, undefined, opts).cost).toBeCloseTo(0.05 * 1.1, 10);
    // The base tier with us is 0.50 x 1.1, not the tier price.
    expect(estimateCost("claude-haiku-5-5", 0, M, 0, 0, undefined, undefined, { inferenceGeo: "us" }).cost).toBeCloseTo(0.5 * 1.1, 10);
  });

  it("long context x fast is multiplied too (no model has both today; the rule is uniform)", () => {
    const row: ModelPricing = {
      inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25, cacheWrite1hPerMillion: 2, ttlRateBasis: "parsed",
      fastMultiplier: 3,
      longContext: { thresholdTokens: 10, rates: { inputPerMillion: 5, outputPerMillion: 10, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6, cacheWrite1hPerMillion: 10 } },
    };
    const overrides = { first_party: { "claude-test-1": row } } as const;
    expect(estimateCost("claude-test-1", 0, M, 0, 0, overrides, undefined, { longContext: true, speed: "fast" }).cost).toBeCloseTo(30, 10);
    expect(estimateCost("claude-test-1", 0, M, 0, 0, overrides, undefined, { longContext: false, speed: "fast" }).cost).toBeCloseTo(6, 10);
  });

  it("the TTL rules still agree to the last bit under a modifier (rule 1 vs rule 2 with a 0/0 split)", () => {
    const opts = { speed: "fast", inferenceGeo: "us" } as const;
    const r1 = estimateCost("claude-fable-5-2", 123, 456, 789, 1011, undefined, undefined, opts);
    const r2 = estimateCost("claude-fable-5-2", 123, 456, 789, 1011, undefined, { ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0 }, opts);
    expect(r2.cost).toBe(r1.cost);
  });
});

describe("resolveRequestPricing", () => {
  it("returns the row scaled, the base row untouched in `resolved`, and a key that separates modifiers", () => {
    const r = resolveRequestPricing("claude-fable-5-2", { speed: "fast", inferenceGeo: "us" });
    expect(r.pricing!.inputPerMillion).toBeCloseTo(17.6, 10);
    expect(r.resolved.pricing!.inputPerMillion).toBe(8);
    expect(r.reason).toBeUndefined();
    const keys = new Set([
      costOptionsKey(undefined),
      costOptionsKey({ longContext: true }),
      costOptionsKey({ inferenceGeo: "us" }),
      costOptionsKey({ speed: "fast" }),
    ]);
    expect(keys.size).toBe(4);
    // Every spelling of "no modifier" shares one key (one cache entry, one rate row).
    for (const spelled of [{ speed: "standard", inferenceGeo: "global", longContext: false }, { speed: null, inferenceGeo: null }, {}, { inferenceGeo: "eu" }]) {
      expect(costOptionsKey(spelled)).toBe(costOptionsKey(undefined));
    }
    // An unknown speed is its own key: it is refused, so it must not share a rate row with standard.
    expect(costOptionsKey({ speed: "turbo" })).not.toBe(costOptionsKey(undefined));
  });

  it("a refusal carries its reason and no rates", () => {
    expect(resolveRequestPricing("claude-sonnet-5", { speed: "fast" })).toMatchObject({ pricing: null, reason: "fast-unpriced" });
  });
});

describe("the fetched cache keeps the built-in multipliers (3.2)", () => {
  /** A fetched row carries the five rates and nothing else, as `pricing.json` does. */
  const fetched = (id: string, over: Partial<ModelPricing> = {}): ModelPricing => {
    const { fastMultiplier: _f, usGeoMultiplier: _g, longContext: _l, ...rates } = lookupPricing(id)!;
    return { ...rates, ...over };
  };

  it("a refreshed row without multiplier fields still prices fast and US", () => {
    applyPricingCache({ "claude-fable-5-2": fetched("claude-fable-5-2") }, "2026-11-11");
    const p = lookupPricing("claude-fable-5-2")!;
    expect(p.fastMultiplier).toBe(2);
    expect(p.usGeoMultiplier).toBe(1.1);
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, { speed: "fast" }).cost).toBeCloseTo(16, 10);
  });

  it("a repriced row (different input rate) does NOT inherit the old multiplier: fast is refused, not stale", () => {
    applyPricingCache({ "claude-fable-5-2": fetched("claude-fable-5-2", { inputPerMillion: 6 }) }, "2026-11-11");
    expect(lookupPricing("claude-fable-5-2")!.fastMultiplier).toBeUndefined();
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, { speed: "fast" })).toMatchObject({
      known: false, reason: "fast-unpriced",
    });
  });

  it("a VALID fetched multiplier wins over the inherited one", () => {
    applyPricingCache({ "claude-fable-5-2": fetched("claude-fable-5-2", { fastMultiplier: 3, usGeoMultiplier: 1.25 }) }, "2026-11-11");
    const p = lookupPricing("claude-fable-5-2")!;
    expect(p.fastMultiplier).toBe(3);
    expect(p.usGeoMultiplier).toBe(1.25);
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, { speed: "fast" }).cost).toBeCloseTo(24, 10);
    expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, { inferenceGeo: "us" }).cost).toBeCloseTo(10, 10);
  });

  it("a malformed multiplier on a REPRICED row ends undefined: nothing to inherit, nothing trusted", () => {
    for (const bad of [0, 0.5, Number.NaN, "2" as unknown as number]) {
      applyPricingCache({ "claude-fable-5-2": fetched("claude-fable-5-2", { inputPerMillion: 6, fastMultiplier: bad, usGeoMultiplier: bad }) }, "2026-11-11");
      const p = lookupPricing("claude-fable-5-2")!;
      expect(p.inputPerMillion).toBe(6);
      expect(p.fastMultiplier).toBeUndefined();
      expect(p.usGeoMultiplier).toBeUndefined();
      expect(estimateCost("claude-fable-5-2", M, 0, 0, 0, undefined, undefined, { speed: "fast" })).toMatchObject({ known: false, reason: "fast-unpriced" });
    }
  });

  it("a malformed multiplier is dropped, never trusted (and falls back to the shipped one)", () => {
    for (const bad of [0, 0.5, -2, Number.NaN, Infinity, "2" as unknown as number]) {
      applyPricingCache({ "claude-fable-5-2": fetched("claude-fable-5-2", { fastMultiplier: bad, usGeoMultiplier: bad }) }, "2026-11-11");
      const p = lookupPricing("claude-fable-5-2")!;
      expect(p.fastMultiplier).toBe(2);
      expect(p.usGeoMultiplier).toBe(1.1);
    }
  });

  it("a fetched row for a model with no shipped multiplier gains none", () => {
    applyPricingCache({ "claude-fable-5-1": fetched("claude-fable-5-1") }, "2026-11-11");
    expect(lookupPricing("claude-fable-5-1")!.fastMultiplier).toBeUndefined();
  });
});

// ─── Properties ──────────────────────────────────────────────────────────────

const MODEL_IDS = [
  "claude-fable-5-2", "claude-mythos-5-2", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", // fast + geo
  "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-7", // geo only
  "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", // neither
  "anthropic.claude-fable-5-2", "claude-fable-5-2[1m]", "claude-haiku-5-5-20260101",
] as const;
const FAST_MODELS = new Set(["claude-fable-5-2", "claude-mythos-5-2", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "anthropic.claude-fable-5-2", "claude-fable-5-2[1m]"]);
const tokens = fc.integer({ min: 0, max: 5_000_000 });
const FC = { seed: 20261110, numRuns: 400 };

const rowArb = fc.record({
  model: fc.constantFrom(...MODEL_IDS),
  input: tokens, output: tokens, read: tokens, create: tokens,
  split: fc.option(fc.record({ m5: tokens, h1: tokens }), { nil: undefined }),
});
interface Row {
  model: (typeof MODEL_IDS)[number];
  input: number;
  output: number;
  read: number;
  create: number;
  split: { m5: number; h1: number } | undefined;
}
const cost = (r: Row, opts?: Parameters<typeof estimateCost>[7]) =>
  estimateCost(
    r.model, r.input, r.output, r.read, r.create, undefined,
    r.split ? { ephemeral5mCacheTokens: r.split.m5, ephemeral1hCacheTokens: r.split.h1 } : undefined,
    { longContext: isLongContextRequest(r.model, r.input, r.read, r.create), ...opts },
  );

describe("properties (fast-check, fixed seed)", () => {
  it("standard, absent or null speed with a non-US geo equals the unmodified result exactly", () => {
    fc.assert(
      fc.property(
        rowArb,
        fc.constantFrom(undefined, null, "standard"),
        fc.constantFrom(undefined, null, "global", "not_available", ""),
        (r, speed, geo) => {
          const plain = cost(r);
          const modified = cost(r, { speed, inferenceGeo: geo });
          expect(modified).toEqual(plain);
        },
      ),
      FC,
    );
  });

  it("fast equals exactly 2x standard where priced, and is refused where not", () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        const std = cost(r);
        const fast = cost(r, { speed: "fast" });
        if (!std.known) {
          expect(fast.known).toBe(false);
          expect(fast.reason).toBeUndefined(); // unknown model, not a refusal
        } else if (FAST_MODELS.has(r.model)) {
          expect(fast.known).toBe(true);
          expect(fast.cost).toBe(std.cost * 2); // doubling is exact in binary floating point
        } else {
          expect(fast).toMatchObject({ cost: 0, known: false, reason: "fast-unpriced" });
        }
      }),
      FC,
    );
  });

  it("US geo equals 1.1x standard on a 4.6+ model, and exactly standard on an older one", () => {
    const OLD = new Set(["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]);
    fc.assert(
      fc.property(rowArb, (r) => {
        const std = cost(r);
        const us = cost(r, { inferenceGeo: "us" });
        expect(us.known).toBe(std.known);
        if (OLD.has(r.model)) expect(us.cost).toBe(std.cost);
        else expect(us.cost).toBeCloseTo(std.cost * 1.1, 6);
      }),
      FC,
    );
  });

  it("fast x US composes: 2.2x standard on a fast-priced model", () => {
    fc.assert(
      fc.property(rowArb.filter((r) => FAST_MODELS.has(r.model)), (r) => {
        const std = cost(r);
        const both = cost(r, { speed: "fast", inferenceGeo: "us" });
        expect(both.cost).toBeCloseTo(std.cost * 2.2, 6);
      }),
      FC,
    );
  });

  it("an unknown speed is refused for every known model", () => {
    fc.assert(
      fc.property(rowArb, fc.string().filter((s) => s !== "standard" && s !== "fast"), (r, speed) => {
        const res = cost(r, { speed });
        if (cost(r).known) expect(res).toMatchObject({ cost: 0, known: false, reason: "speed-unknown" });
        else expect(res.known).toBe(false);
      }),
      FC,
    );
  });

  it("a modifier never lowers a price (multipliers are >= 1): standard <= geo, standard <= fast where priced", () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        const std = cost(r);
        expect(cost(r, { inferenceGeo: "us" }).cost).toBeGreaterThanOrEqual(std.cost);
        const fast = cost(r, { speed: "fast" });
        if (fast.known) expect(fast.cost).toBeGreaterThanOrEqual(std.cost);
      }),
      FC,
    );
  });
});
