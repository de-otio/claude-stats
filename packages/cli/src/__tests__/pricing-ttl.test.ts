/**
 * TTL-aware cache-write pricing (Phase 0).
 *
 * The 1-hour prompt-cache TTL bills writes at 2× the base input rate where the
 * 5-minute TTL bills 1.25×. Until this change the table carried one write rate,
 * so every figure the tool produced understated cache-write cost on a 1h
 * workload — silently, and by a lot.
 *
 * Two properties carry the weight here:
 *
 *  - **byte-identical fallback.** A caller that passes no split, and a caller
 *    that passes an all-zero split, must agree to the last bit. They are
 *    different code paths, and the whole downstream wiring rests on the claim
 *    that adding the split to a shared aggregate changes nothing for rows that
 *    do not carry one.
 *  - **honest degradation.** A rate that was guessed rather than read is marked
 *    `synthesized`; a rate table that cannot be true is refused rather than
 *    averaged in.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  applyPricingCache,
  estimateCost,
  isCoherentPricing,
  lookupPricing,
  nonNegativeFiniteInt,
  PRICING_VERIFIED_DATE,
  type CacheWriteSplit,
  type ModelPricing,
  type RateOverrides,
} from "@claude-stats/core/pricing";
import { validatePricingConfig } from "../config.js";

/** Captured before any test applies a cache over the shipped table. */
const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

/** `applyPricingCache` mutates a module global; every test that calls it resets. */
function resetPricingTable(): void {
  applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
}

const MTOK = 1_000_000;

/** A complete rate row, so a test can vary one field without restating five. */
function row(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
    cacheWrite1hPerMillion: 10,
    ttlRateBasis: "parsed",
    ...overrides,
  };
}

// ─── Rule 1: no split ⇒ byte-identical to the pre-TTL behaviour ──────────────

describe("estimateCost — the no-split fallback", () => {
  const MODELS = ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-3-5-haiku", "claude-fable-5"];
  // Deliberately not round: a divergence between the two code paths would round
  // away on tidy inputs and show up on real ones.
  const CREATIONS = [0, 1, 4_901, 123_456, 9_999_999];

  it("agrees to the last bit with an all-zero split", () => {
    const zero: CacheWriteSplit = { ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0 };
    for (const model of MODELS) {
      for (const creation of CREATIONS) {
        const without = estimateCost(model, 1_234_567, 89_123, 456_789, creation);
        const withZero = estimateCost(model, 1_234_567, 89_123, 456_789, creation, undefined, zero);
        expect(withZero.cost, `${model} @ ${creation}`).toBe(without.cost);
        expect(without.unattributedWriteTokens).toBe(creation);
        expect(withZero.unattributedWriteTokens).toBe(creation);
        expect(without.overAttributedWriteTokens).toBe(0);
        expect(withZero.overAttributedWriteTokens).toBe(0);
      }
    }
  });

  it("prices the whole creation volume at the 5-minute rate, with no NaN", () => {
    const r = estimateCost("claude-opus-5", 0, 0, 0, 2 * MTOK);
    expect(r.cost).toBeCloseTo(12.5, 10); // 2 MTok × $6.25
    expect(Number.isNaN(r.cost)).toBe(false);
    expect(r.known).toBe(true);
    expect(r.unattributedWriteTokens).toBe(2 * MTOK);
  });
});

// ─── Rule 2: the split is priced per TTL ─────────────────────────────────────

describe("estimateCost — TTL-split cache writes", () => {
  it("prices a 1-hour write at 2× input and a 5-minute write at 1.25×", () => {
    const oneHour = estimateCost("claude-opus-5", 0, 0, 0, MTOK, undefined, {
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: MTOK,
    });
    expect(oneHour.cost).toBeCloseTo(10, 10); // 2 × $5 input
    expect(oneHour.unattributedWriteTokens).toBe(0);

    const fiveMin = estimateCost("claude-opus-5", 0, 0, 0, MTOK, undefined, {
      ephemeral5mCacheTokens: MTOK,
      ephemeral1hCacheTokens: 0,
    });
    expect(fiveMin.cost).toBeCloseTo(6.25, 10); // 1.25 × $5 input
  });

  it("prices a mixed message as the sum of its two parts", () => {
    const mixed = estimateCost("claude-opus-5", 0, 0, 0, 2 * MTOK, undefined, {
      ephemeral5mCacheTokens: MTOK,
      ephemeral1hCacheTokens: MTOK,
    });
    expect(mixed.cost).toBeCloseTo(6.25 + 10, 10);
    expect(mixed.unattributedWriteTokens).toBe(0);
    expect(mixed.overAttributedWriteTokens).toBe(0);
  });

  it("charges the residual at the 5-minute rate and reports it", () => {
    // 1 MTok of a 3 MTok write volume is unaccounted for by the split.
    const r = estimateCost("claude-opus-5", 0, 0, 0, 3 * MTOK, undefined, {
      ephemeral5mCacheTokens: MTOK,
      ephemeral1hCacheTokens: MTOK,
    });
    expect(r.cost).toBeCloseTo(6.25 + 10 + 6.25, 10);
    expect(r.unattributedWriteTokens).toBe(MTOK);
    expect(r.overAttributedWriteTokens).toBe(0);
  });

  it("reports an over-attributed split instead of clamping or throwing", () => {
    const r = estimateCost("claude-opus-5", 0, 0, 0, MTOK, undefined, {
      ephemeral5mCacheTokens: 800_000,
      ephemeral1hCacheTokens: 400_000,
    });
    // The split is priced as given: 0.8 MTok @ $6.25 + 0.4 MTok @ $10.
    expect(r.cost).toBeCloseTo(5 + 4, 10);
    expect(Number.isFinite(r.cost)).toBe(true);
    expect(r.unattributedWriteTokens).toBe(0);
    expect(r.overAttributedWriteTokens).toBe(200_000);
  });

  it("uses the configured 1-hour rate when partner rates are supplied", () => {
    const overrides: RateOverrides = {
      bedrock: { "claude-opus-5": row({ inputPerMillion: 6, cacheWrite1hPerMillion: 15 }) },
    };
    const r = estimateCost("anthropic.claude-opus-5", 0, 0, 0, MTOK, overrides, {
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: MTOK,
    });
    expect(r.rateBasis).toBe("configured");
    expect(r.cost).toBeCloseTo(15, 10);
  });
});

// ─── Input coercion: the ephemeral columns become cost-bearing ───────────────

describe("estimateCost — split-field coercion", () => {
  // `parser/session.ts` copies these out of JSONL unvalidated and
  // `sync-merge/apply.ts` copies them from another device's shard. A junk value
  // that is inert today would otherwise become NaN in every containing total.
  const junk: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["negative", -5_000],
    ["a numeric string", "1000000"],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(junk)("treats a %s 1h value as zero attributed tokens", (_label, value) => {
    const r = estimateCost("claude-opus-5", 0, 0, 0, MTOK, undefined, {
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: value,
    } as unknown as CacheWriteSplit);
    expect(Number.isNaN(r.cost)).toBe(false);
    // Nothing attributed ⇒ the whole volume falls to the 5-minute rate.
    expect(r.cost).toBeCloseTo(6.25, 10);
    expect(r.unattributedWriteTokens).toBe(MTOK);
    expect(r.overAttributedWriteTokens).toBe(0);
  });

  it.each(junk)("treats a %s 5m value as zero attributed tokens", (_label, value) => {
    const r = estimateCost("claude-opus-5", 0, 0, 0, MTOK, undefined, {
      ephemeral5mCacheTokens: value,
      ephemeral1hCacheTokens: 0,
    } as unknown as CacheWriteSplit);
    expect(Number.isNaN(r.cost)).toBe(false);
    expect(r.cost).toBeCloseTo(6.25, 10);
    expect(r.unattributedWriteTokens).toBe(MTOK);
  });

  it("keeps a valid sibling field when the other is junk", () => {
    const r = estimateCost("claude-opus-5", 0, 0, 0, 2 * MTOK, undefined, {
      ephemeral5mCacheTokens: Number.NaN,
      ephemeral1hCacheTokens: MTOK,
    } as unknown as CacheWriteSplit);
    // 1 MTok at the 1h rate, the remaining 1 MTok as unattributed residual.
    expect(r.cost).toBeCloseTo(10 + 6.25, 10);
    expect(r.unattributedWriteTokens).toBe(MTOK);
  });

  it("floors a fractional count rather than carrying it into the rate", () => {
    expect(nonNegativeFiniteInt(1234.9)).toBe(1234);
    expect(nonNegativeFiniteInt(0)).toBe(0);
    expect(nonNegativeFiniteInt(-0.5)).toBe(0);
    expect(nonNegativeFiniteInt("7")).toBe(0);
  });
});

// ─── Rule 4: unknown model ──────────────────────────────────────────────────

describe("estimateCost — unknown model", () => {
  it("attributes nothing, and says nothing was attributed", () => {
    const r = estimateCost("not-a-claude-model", 1_000, 2_000, 3_000, 40_000);
    expect(r.known).toBe(false);
    expect(r.cost).toBe(0);
    // 0 here would read as "fully attributed" — the opposite of the truth.
    expect(r.unattributedWriteTokens).toBe(40_000);
    expect(r.overAttributedWriteTokens).toBe(0);
  });

  it("still attributes nothing when a split IS supplied", () => {
    const r = estimateCost("not-a-claude-model", 0, 0, 0, 40_000, undefined, {
      ephemeral5mCacheTokens: 10_000,
      ephemeral1hCacheTokens: 30_000,
    });
    expect(r.known).toBe(false);
    expect(r.unattributedWriteTokens).toBe(40_000);
  });
});

// ─── applyPricingCache: per-row fill, before the whole-row merge ─────────────

describe("applyPricingCache — TTL defaulting", () => {
  afterEach(resetPricingTable);

  it("fills a fetched row that has no 1h rate, and marks it synthesized", () => {
    const incomplete = {
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 5,
    } as ModelPricing;
    applyPricingCache({ "claude-opus-5": incomplete }, "2026-01-01");

    const opus = lookupPricing("claude-opus-5")!;
    expect(opus.cacheWrite1hPerMillion).toBe(8); // 2 × input
    expect(opus.ttlRateBasis).toBe("synthesized");
    // And the fill happened per row, BEFORE the merge — the fetched row still won.
    expect(opus.inputPerMillion).toBe(4);
    expect(estimateCost("claude-opus-5", 0, 0, 0, MTOK).cost).toBeCloseTo(5, 10);
  });

  it("inherits DEFAULT_PRICING's verified 1h rate when the fetched row omits it but agrees on the input rate", () => {
    // THE REGRESSION THIS GUARDS. Every `pricing.json` written before the 1-hour
    // field existed lacks it, so on any machine that has ever run the CLI the
    // fetched cache overwrote all 15 verified rows with "synthesized" ones.
    // `ttlFit`'s D10 guard then withheld pricing on every model and the verdict
    // was permanently `insufficient-data` — the feature was dead on arrival for
    // existing users. Unit tests missed it entirely; only running the command
    // against a real store surfaced it.
    const preTtlCacheRow = {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    } as ModelPricing;
    applyPricingCache({ "claude-opus-5": preTtlCacheRow }, "2026-01-01");

    const opus = lookupPricing("claude-opus-5")!;
    expect(opus.cacheWrite1hPerMillion).toBe(10); // DEFAULT_PRICING's verified rate, not a guess
    expect(opus.ttlRateBasis).toBe("parsed"); // ⇒ ttlFit will PRICE this model, not withhold it
  });

  it("still synthesizes when the fetched row reprices the model", () => {
    // The paired positive/negative: a fetched row that DISAGREES on the input
    // rate must NOT inherit the default's absolute 1h figure — it may no longer
    // correspond to the new pricing, and a stale absolute rate is exactly the
    // wrong-but-plausible number this build guards against.
    const repriced = {
      inputPerMillion: 7,
      outputPerMillion: 35,
      cacheReadPerMillion: 0.7,
      cacheWritePerMillion: 8.75,
    } as ModelPricing;
    applyPricingCache({ "claude-opus-5": repriced }, "2026-01-01");

    const opus = lookupPricing("claude-opus-5")!;
    expect(opus.cacheWrite1hPerMillion).toBe(14); // 2 × the FETCHED input, not the default's 10
    expect(opus.ttlRateBasis).toBe("synthesized");
  });

  it("keeps a fetched 1h rate as parsed", () => {
    applyPricingCache({ "claude-opus-5": row({ cacheWrite1hPerMillion: 15 }) }, "2026-01-01");
    const opus = lookupPricing("claude-opus-5")!;
    expect(opus.cacheWrite1hPerMillion).toBe(15);
    expect(opus.ttlRateBasis).toBe("parsed");
  });

  it("preserves a parser-declared synthesized basis across the merge", () => {
    applyPricingCache(
      { "claude-opus-5": row({ cacheWrite1hPerMillion: 10, ttlRateBasis: "synthesized" }) },
      "2026-01-01",
    );
    expect(lookupPricing("claude-opus-5")!.ttlRateBasis).toBe("synthesized");
  });

  it("leaves models absent from the fetched table on their defaults", () => {
    applyPricingCache({ "claude-opus-5": row({ inputPerMillion: 4, cacheWritePerMillion: 5, cacheWrite1hPerMillion: 8, cacheReadPerMillion: 0.4, outputPerMillion: 20 }) }, "2026-01-01");
    expect(lookupPricing("claude-sonnet-4-6")!.cacheWrite1hPerMillion).toBe(6);
  });
});

// ─── The rate-coherence bound ───────────────────────────────────────────────

describe("rate coherence", () => {
  afterEach(resetPricingTable);

  it("accepts the shipped shape", () => {
    expect(isCoherentPricing(row())).toBe(true);
  });

  it.each([
    ["a 5m rate above the 1h rate", row({ cacheWritePerMillion: 12, cacheWrite1hPerMillion: 6 })],
    ["a read rate at or above the write rate", row({ cacheReadPerMillion: 6.25 })],
    ["a 1h/input ratio above 4", row({ cacheWrite1hPerMillion: 25 })],
    ["a 1h/input ratio below 1", row({ cacheWrite1hPerMillion: 4, cacheWritePerMillion: 3 })],
    ["a zero rate", row({ cacheReadPerMillion: 0 })],
    ["a non-finite rate", row({ cacheWrite1hPerMillion: Number.POSITIVE_INFINITY })],
    ["a negative rate", row({ cacheWritePerMillion: -6.25 })],
  ])("rejects %s", (_label, p) => {
    expect(isCoherentPricing(p)).toBe(false);
  });

  it("falls back to the DEFAULT_PRICING row rather than merging an incoherent one", () => {
    applyPricingCache({ "claude-opus-5": row({ cacheWritePerMillion: 12, cacheWrite1hPerMillion: 6 }) }, "2026-01-01");
    const opus = lookupPricing("claude-opus-5")!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10);
  });

  it("merges a coherent row — the bound is not simply refusing everything", () => {
    applyPricingCache({ "claude-opus-5": row({ cacheWrite1hPerMillion: 15 }) }, "2026-01-01");
    expect(lookupPricing("claude-opus-5")!.cacheWrite1hPerMillion).toBe(15);
  });

  it("drops an incoherent row for a model that has no default to fall back to", () => {
    applyPricingCache(
      {
        "claude-notional-9": row({ cacheWrite1hPerMillion: 40 }), // ratio 8 — refused
        "claude-notional-8": row({ cacheWrite1hPerMillion: 12 }), // ratio 2.4 — kept
      },
      "2026-01-01",
    );
    expect(lookupPricing("claude-notional-9")).toBeNull();
    expect(lookupPricing("claude-notional-8")!.cacheWrite1hPerMillion).toBe(12);
  });
});

// ─── validatePricingConfig: absent ⇒ synthesize, invalid ⇒ reject the row ────

describe("validatePricingConfig — the optional 1h rate", () => {
  const base = { inputPerMillion: 6, outputPerMillion: 30, cacheReadPerMillion: 0.6, cacheWritePerMillion: 7.5 };

  it("synthesizes 2× input when the field is absent", () => {
    const out = validatePricingConfig({ rates: { bedrock: { "claude-opus-5": base } } });
    const p = out.rates!.bedrock!["claude-opus-5"]!;
    expect(p.cacheWrite1hPerMillion).toBe(12);
    expect(p.ttlRateBasis).toBe("synthesized");
  });

  it("keeps a supplied 1h rate and marks it parsed", () => {
    const out = validatePricingConfig({
      rates: { bedrock: { "claude-opus-5": { ...base, cacheWrite1hPerMillion: 11 } } },
    });
    const p = out.rates!.bedrock!["claude-opus-5"]!;
    expect(p.cacheWrite1hPerMillion).toBe(11);
    expect(p.ttlRateBasis).toBe("parsed");
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "6.25"],
    ["null", null],
  ])("rejects the whole row when the supplied 1h rate is %s", (_label, value) => {
    const out = validatePricingConfig({
      rates: {
        bedrock: {
          "claude-opus-5": { ...base, cacheWrite1hPerMillion: value },
          "claude-sonnet-5": { ...base, cacheWrite1hPerMillion: 11 },
        },
      },
    });
    // The bad row is gone — NOT silently defaulted to 2× input, which would
    // publish a cost figure the user never configured.
    expect(Object.keys(out.rates!.bedrock!)).toEqual(["claude-sonnet-5"]);
  });

  it("keeps a __proto__ model key as an ordinary own property", () => {
    // Written as raw JSON, because that is how a hostile config.json actually
    // arrives — and JSON.parse makes `__proto__` an own property, where an
    // object literal would have quietly set the prototype instead.
    const hostile = JSON.parse(
      `{"rates":{"bedrock":{"__proto__":${JSON.stringify(base)}}}}`,
    ) as unknown;
    const out = validatePricingConfig(hostile);
    // Onto a plain `{}` accumulator this assignment would invoke the inherited
    // `__proto__` setter instead, leaving `Object.keys` empty and the whole
    // table silently dropped.
    expect(Object.keys(out.rates!.bedrock!)).toEqual(["__proto__"]);
  });
});
