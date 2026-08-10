/**
 * Model-id normalization and per-source rates (F5).
 *
 * The defect this covers is quiet and expensive: `lookupPricing` matched
 * `startsWith("claude-…")`, so every Bedrock and Vertex model id fell through
 * to "unknown" and costed exactly zero. Nothing errored — a metered Enterprise
 * or Bedrock team, the audience for whom these figures are real invoiced money,
 * would have seen a confident $0.00 and no indication anything was wrong.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  normalizeModelId,
  resolvePricing,
  lookupPricing,
  estimateCost,
  modelTier,
  type RateOverrides,
} from "@claude-stats/core/pricing";
import { MODELS } from "./fixtures/synthetic.js";

describe("normalizeModelId", () => {
  it.each([
    ["claude-opus-5", "claude-opus-5", "first_party"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "first_party"],
    ["anthropic.claude-opus-5", "claude-opus-5", "bedrock"],
    ["anthropic.claude-sonnet-5", "claude-sonnet-5", "bedrock"],
    ["us.anthropic.claude-opus-5", "claude-opus-5", "bedrock"],
    ["eu.anthropic.claude-sonnet-4-6", "claude-sonnet-4-6", "bedrock"],
    ["apac.anthropic.claude-haiku-4-5", "claude-haiku-4-5", "bedrock"],
    ["anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", "bedrock"],
    ["us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", "bedrock"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5", "vertex"],
    ["claude-sonnet-5", "claude-sonnet-5", "first_party"],
  ])("normalizes %s", (raw, canonical, source) => {
    const n = normalizeModelId(raw);
    expect(n.canonical).toBe(canonical);
    expect(n.source).toBe(source);
    expect(n.raw).toBe(raw);
  });

  it("leaves an unrecognised id alone rather than mangling it", () => {
    const n = normalizeModelId("some-other-model");
    expect(n.canonical).toBe("some-other-model");
    expect(n.source).toBe("first_party");
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    fc.assert(
      fc.property(fc.constantFrom(...MODELS), (id) => {
        const once = normalizeModelId(id).canonical;
        expect(normalizeModelId(once).canonical).toBe(once);
      }),
    );
  });
});

describe("pricing across served platforms", () => {
  it("prices every model family in the fixture corpus (none silently free)", () => {
    for (const model of MODELS) {
      const r = estimateCost(model, 1_000_000, 100_000, 0, 0);
      expect(r.known, `${model} priced as unknown`).toBe(true);
      expect(r.cost).toBeGreaterThan(0);
    }
  });

  it("flags partner usage as an estimate when no partner rates are configured", () => {
    const bedrock = resolvePricing("anthropic.claude-opus-5");
    expect(bedrock.source).toBe("bedrock");
    expect(bedrock.rateBasis).toBe("first_party_fallback");

    const firstParty = resolvePricing("claude-opus-5");
    expect(firstParty.rateBasis).toBe("first_party");
  });

  it("prefers configured partner rates over the first-party fallback", () => {
    const overrides: RateOverrides = {
      bedrock: {
        "claude-opus-5": {
          inputPerMillion: 6,
          outputPerMillion: 30,
          cacheReadPerMillion: 0.6,
          cacheWritePerMillion: 7.5,
          cacheWrite1hPerMillion: 12,
          ttlRateBasis: "parsed",
        },
      },
    };
    const r = resolvePricing("anthropic.claude-opus-5", overrides);
    expect(r.rateBasis).toBe("configured");
    expect(r.pricing?.inputPerMillion).toBe(6);

    // The same override must not leak into first-party pricing.
    expect(resolvePricing("claude-opus-5", overrides).pricing?.inputPerMillion).toBe(5);

    const cost = estimateCost("anthropic.claude-opus-5", 1_000_000, 0, 0, 0, overrides);
    expect(cost.cost).toBeCloseTo(6, 10);
    expect(cost.rateBasis).toBe("configured");
  });

  it("still reports known:false for a genuinely unknown model", () => {
    const r = estimateCost("not-a-claude-model", 1_000_000, 0, 0, 0);
    expect(r.known).toBe(false);
    expect(r.cost).toBe(0);
  });

  it("keeps the legacy two-arg lookup working", () => {
    expect(lookupPricing("claude-opus-5")).not.toBeNull();
    expect(lookupPricing("anthropic.claude-opus-5")).not.toBeNull();
  });

  it("ignores an override table that has no entry for the model", () => {
    const overrides: RateOverrides = {
      bedrock: {
        "claude-sonnet-5": { inputPerMillion: 9, outputPerMillion: 9, cacheReadPerMillion: 9, cacheWritePerMillion: 9, cacheWrite1hPerMillion: 9, ttlRateBasis: "parsed" },
      },
    };
    // Opus on Bedrock has no configured row → falls back, and says so.
    const r = resolvePricing("anthropic.claude-opus-5", overrides);
    expect(r.rateBasis).toBe("first_party_fallback");
    expect(r.pricing?.inputPerMillion).toBe(5);
  });

  it("reports the source even when the model is unknown", () => {
    const r = resolvePricing("anthropic.not-a-model");
    expect(r.pricing).toBeNull();
    expect(r.source).toBe("bedrock");
    expect(r.canonical).toBe("not-a-model");
  });

  it("matches the longest model prefix, not the first", () => {
    // `claude-opus-4-5` must not be shadowed by a shorter `claude-opus-4` key.
    expect(resolvePricing("claude-opus-4-5").pricing?.inputPerMillion).toBe(5);
    expect(resolvePricing("claude-opus-4-1").pricing?.inputPerMillion).toBe(15);
  });

  it("prices the current flagship models (they were missing entirely)", () => {
    expect(resolvePricing("claude-opus-5").pricing?.outputPerMillion).toBe(25);
    expect(resolvePricing("claude-fable-5").pricing?.outputPerMillion).toBe(50);
  });

  it("costs scale linearly with tokens", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODELS),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 10 }),
        (model, tokens, factor) => {
          const one = estimateCost(model, tokens, 0, 0, 0).cost;
          const many = estimateCost(model, tokens * factor, 0, 0, 0).cost;
          expect(many).toBeCloseTo(one * factor, 6);
        },
      ),
    );
  });
});

// ─── modelTier (D2 — tier-mismatch detector's input) ───────────────────────

describe("modelTier", () => {
  it.each([
    ["claude-opus-5", "top"],
    ["claude-opus-4-8", "top"],
    ["claude-fable-5", "top"],
    ["claude-mythos-5", "top"],
    ["claude-sonnet-5", "mid"],
    ["claude-sonnet-4-6", "mid"],
    ["claude-haiku-4-5", "low"],
    ["claude-3-5-haiku-20241022", "low"],
    ["some-other-vendor-model", "unknown"],
  ])("tiers %s as %s", (raw, tier) => {
    expect(modelTier(raw)).toBe(tier);
  });

  it("tiers Bedrock and Vertex ids by normalizing first (the tier survives the id-family transform)", () => {
    expect(modelTier("anthropic.claude-opus-5")).toBe("top");
    expect(modelTier("us.anthropic.claude-sonnet-4-6")).toBe("mid");
    expect(modelTier("claude-opus-4-5@20251101")).toBe("top");
  });
});
