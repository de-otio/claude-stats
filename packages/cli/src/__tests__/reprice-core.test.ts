/**
 * Counterfactual repricing, the pure core (`@claude-stats/core/repricing`).
 *
 * Every dollar figure is hand-computed from the shipped rate rows (per MTok):
 *
 *   Opus 5.5    in 4    out 20  read 0.20  write5m 5     write1h 8    fast x2  us x1.1
 *   Fable 5.2   in 8    out 40  read 0.20  write5m 10    write1h 16   fast x2  us x1.1
 *   Sonnet 5.5  in 2    out 10  read 0.10  write5m 2.5   write1h 4    NO fast  us x1.1
 *   Haiku 5.5   in 0.10 out 0.50 read 0.01 write5m 0.125 write1h 0.20 NO fast us x1.1
 *               tier (prompt > 100,000): 0.50 / 2.50 / 0.05 / 0.625 / 1
 *
 * A test that re-derived the expectation from `estimateCost` alone would pass
 * with the rate swap broken, so the per-category figures are literals; the
 * `estimateCost` agreement test is an extra, not the proof.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { estimateCost, applyPricingCache, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
import {
  checkRepriceModel,
  isModelIdShape,
  longContextThresholdFor,
  modelMatchesRequested,
  repriceGroups,
  roundRepriceResult,
  type RepriceGroup,
} from "@claude-stats/core/repricing";

const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const M = 1_000_000;

// Pin the table to the shipped defaults (a fetched pricing cache must not move a literal).
applyPricingCache({}, PRICING_VERIFIED_DATE);

function group(over: Partial<RepriceGroup> & { model: string }): RepriceGroup {
  return {
    longContext: false,
    targetLongContext: false,
    speed: null,
    inferenceGeo: null,
    rows: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ephemeral5mTokens: 0,
    ephemeral1hTokens: 0,
    ...over,
  };
}

describe("repriceGroups: the rate swap, per token category", () => {
  it("prices every category at the serving model and at the target (Opus 5.5 -> Fable 5.2)", () => {
    const r = repriceGroups(
      [group({
        model: OPUS,
        rows: 3,
        inputTokens: M,
        outputTokens: M,
        cacheReadTokens: 10 * M,
        cacheCreationTokens: 2 * M,
        ephemeral5mTokens: M,
        ephemeral1hTokens: M,
      })],
      OPUS,
      FABLE,
    );
    expect(r.rows).toBe(3);
    expect(r.tokens).toEqual({ input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: 10 * M });
    // actual: 4 / 20 / 5 / 8 / 10 x 0.20
    expect(r.actual.input).toBeCloseTo(4, 9);
    expect(r.actual.output).toBeCloseTo(20, 9);
    expect(r.actual.cacheWrite5m).toBeCloseTo(5, 9);
    expect(r.actual.cacheWrite1h).toBeCloseTo(8, 9);
    expect(r.actual.cacheRead).toBeCloseTo(2, 9);
    expect(r.actual.total).toBeCloseTo(39, 9);
    // same tokens at Fable 5.2: 8 / 40 / 10 / 16 / 10 x 0.20
    expect(r.counterfactual.input).toBeCloseTo(8, 9);
    expect(r.counterfactual.output).toBeCloseTo(40, 9);
    expect(r.counterfactual.cacheWrite5m).toBeCloseTo(10, 9);
    expect(r.counterfactual.cacheWrite1h).toBeCloseTo(16, 9);
    expect(r.counterfactual.cacheRead).toBeCloseTo(2, 9);
    expect(r.counterfactual.total).toBeCloseTo(76, 9);
    expect(r.comparable).toEqual({ rows: 3, actualTotal: r.actual.total, counterfactualTotal: r.counterfactual.total });
    expect(r.unpriced.counterfactual.rows).toBe(0);
  });

  it("a fast row stays fast on a target that has a fast rate (Opus 5.5 -> Fable 5.2)", () => {
    const r = repriceGroups([group({ model: OPUS, speed: "fast", inputTokens: M, outputTokens: M })], OPUS, FABLE);
    expect(r.actual.total).toBeCloseTo((4 + 20) * 2, 9); // 48
    expect(r.counterfactual.total).toBeCloseTo((8 + 40) * 2, 9); // 96
  });

  it("a fast row on a target WITHOUT a fast rate is unpriced, disclosed, and not priced at standard (Opus 5.5 -> Sonnet 5.5)", () => {
    const r = repriceGroups([group({ model: OPUS, rows: 7, speed: "fast", inputTokens: M, outputTokens: M })], OPUS, SONNET);
    expect(r.actual.total).toBeCloseTo(48, 9);
    // Not $12 (standard Sonnet) and not $24 (invented 2x): nothing.
    expect(r.counterfactual.total).toBe(0);
    expect(r.unpriced.counterfactual.rows).toBe(7);
    expect(r.unpriced.counterfactual.byReason).toEqual({ "fast-unpriced": 7 });
    expect(r.unpriced.counterfactual.actualCost).toBeCloseTo(48, 9);
    expect(r.unpriced.actual.rows).toBe(0);
    expect(r.comparable).toEqual({ rows: 0, actualTotal: 0, counterfactualTotal: 0 });
  });

  it("splits a mixed window: only the fast rows go unpriced, the standard rows still reprice", () => {
    const r = repriceGroups(
      [
        group({ model: OPUS, rows: 2, inputTokens: M, outputTokens: M }), //                     actual 24, Sonnet 12
        group({ model: OPUS, rows: 5, speed: "fast", inputTokens: M, outputTokens: M }), //      actual 48, Sonnet unpriced
      ],
      OPUS,
      SONNET,
    );
    expect(r.actual.total).toBeCloseTo(72, 9);
    expect(r.counterfactual.total).toBeCloseTo(12, 9);
    expect(r.unpriced.counterfactual.rows).toBe(5);
    expect(r.comparable.rows).toBe(2);
    expect(r.comparable.actualTotal).toBeCloseTo(24, 9);
    expect(r.comparable.counterfactualTotal).toBeCloseTo(12, 9);
    // actual.total - unpriced actual cost == the comparable base
    expect(r.actual.total - r.unpriced.counterfactual.actualCost).toBeCloseTo(r.comparable.actualTotal, 9);
  });

  it("applies the US-geo multiplier to both sides (Opus 5.5 -> Sonnet 5.5)", () => {
    const r = repriceGroups([group({ model: OPUS, inferenceGeo: "us", inputTokens: M, outputTokens: M })], OPUS, SONNET);
    expect(r.actual.total).toBeCloseTo((4 + 20) * 1.1, 9); // 26.4
    expect(r.counterfactual.total).toBeCloseTo((2 + 10) * 1.1, 9); // 13.2
  });

  it("stacks fast and US geo (Opus 5.5 -> Fable 5.2)", () => {
    const r = repriceGroups(
      [group({ model: OPUS, speed: "fast", inferenceGeo: "us", inputTokens: M, outputTokens: M })],
      OPUS,
      FABLE,
    );
    expect(r.actual.total).toBeCloseTo((4 + 20) * 2 * 1.1, 9); // 52.8
    expect(r.counterfactual.total).toBeCloseTo((8 + 40) * 2 * 1.1, 9); // 105.6
  });

  it("long context: the serving side uses its own tier, the target none (Haiku 5.5 -> Opus 5.5)", () => {
    // 1K input + 119K read = a 120K prompt: over Haiku's 100K threshold, no tier on Opus.
    const r = repriceGroups(
      [group({ model: HAIKU, longContext: true, targetLongContext: false, inputTokens: 1_000, outputTokens: M, cacheReadTokens: 119_000 })],
      HAIKU,
      OPUS,
    );
    // tier: 1,000 x 0.50 + 1M x 2.50 + 119,000 x 0.05 = 0.0005 + 2.5 + 0.00595
    expect(r.actual.total).toBeCloseTo(2.50645, 9);
    // Opus base: 1,000 x 4 + 1M x 20 + 119,000 x 0.20 = 0.004 + 20 + 0.0238
    expect(r.counterfactual.total).toBeCloseTo(20.0278, 9);
  });

  it("long context: the target's tier applies even when the serving model has none (Opus 5.5 -> Haiku 5.5)", () => {
    const r = repriceGroups(
      [group({ model: OPUS, longContext: false, targetLongContext: true, inputTokens: 1_000, outputTokens: M, cacheReadTokens: 119_000 })],
      OPUS,
      HAIKU,
    );
    expect(r.actual.total).toBeCloseTo(20.0278, 9);
    expect(r.counterfactual.total).toBeCloseTo(2.50645, 9); // tier rates, whole request
  });

  it("long context + US geo compose on the tier rates (Haiku 5.5, tier x 1.1)", () => {
    const r = repriceGroups(
      [group({ model: HAIKU, longContext: true, targetLongContext: true, inferenceGeo: "us", inputTokens: 1_000, outputTokens: M, cacheReadTokens: 119_000 })],
      HAIKU,
      HAIKU,
    );
    expect(r.actual.total).toBeCloseTo(2.50645 * 1.1, 9);
    expect(r.counterfactual.total).toBeCloseTo(2.50645 * 1.1, 9);
  });

  it("an unrecognised speed value is unpriced on both sides, never standard", () => {
    const r = repriceGroups([group({ model: OPUS, rows: 4, speed: "turbo", inputTokens: M, outputTokens: M })], OPUS, FABLE);
    expect(r.actual.total).toBe(0);
    expect(r.counterfactual.total).toBe(0);
    expect(r.unpriced.actual.byReason).toEqual({ "speed-unknown": 4 });
    expect(r.unpriced.counterfactual.byReason).toEqual({ "speed-unknown": 4 });
  });
});

describe("repriceGroups: cache writes follow estimateCost's TTL rules", () => {
  it("prices the residual of the creation total over the TTL split at the 5-minute rate and reports it", () => {
    // 3M created, 1M known 5m + 1M known 1h => 1M residual at the 5m rate.
    const r = repriceGroups(
      [group({ model: OPUS, cacheCreationTokens: 3 * M, ephemeral5mTokens: M, ephemeral1hTokens: M })],
      OPUS,
      FABLE,
    );
    expect(r.cacheWriteUnattributedTokens).toBe(M);
    expect(r.tokens.cacheWrite5m).toBe(2 * M);
    expect(r.tokens.cacheWrite1h).toBe(M);
    expect(r.actual.cacheWrite5m).toBeCloseTo(2 * 5, 9);
    expect(r.counterfactual.cacheWrite5m).toBeCloseTo(2 * 10, 9);
  });

  it("with no TTL split every creation token is priced at the 5-minute rate", () => {
    const r = repriceGroups([group({ model: OPUS, cacheCreationTokens: 2 * M })], OPUS, FABLE);
    expect(r.cacheWriteUnattributedTokens).toBe(2 * M);
    expect(r.actual.cacheWrite5m).toBeCloseTo(10, 9);
    expect(r.actual.cacheWrite1h).toBe(0);
  });

  it("matches estimateCost to the last cent on a mixed group, both sides", () => {
    const g = group({
      model: OPUS,
      speed: "fast",
      inferenceGeo: "us",
      inputTokens: 123_456,
      outputTokens: 78_901,
      cacheReadTokens: 4_567_890,
      cacheCreationTokens: 250_000,
      ephemeral5mTokens: 100_000,
      ephemeral1hTokens: 50_000,
    });
    const r = repriceGroups([g], OPUS, FABLE);
    const opts = { longContext: false, speed: "fast", inferenceGeo: "us" };
    const split = { ephemeral5mCacheTokens: 100_000, ephemeral1hCacheTokens: 50_000 };
    const a = estimateCost(OPUS, 123_456, 78_901, 4_567_890, 250_000, undefined, split, opts);
    const b = estimateCost(FABLE, 123_456, 78_901, 4_567_890, 250_000, undefined, split, opts);
    expect(r.actual.total).toBeCloseTo(a.cost, 9);
    expect(r.counterfactual.total).toBeCloseTo(b.cost, 9);
  });
});

describe("repriceGroups: model selection and refusals", () => {
  it("ignores other models' groups and counts only the requested model's rows and tokens", () => {
    const r = repriceGroups(
      [
        group({ model: OPUS, rows: 2, inputTokens: M }),
        group({ model: SONNET, rows: 9, inputTokens: 5 * M }),
      ],
      OPUS,
      FABLE,
    );
    expect(r.rows).toBe(2);
    expect(r.tokens.input).toBe(M);
  });

  it("includes dated-snapshot and [1m] variants of the requested id, never a point release", () => {
    expect(modelMatchesRequested("claude-opus-5-5-20261101", "claude-opus-5-5")).toBe(true);
    expect(modelMatchesRequested("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true);
    expect(modelMatchesRequested("us.anthropic.claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    // `claude-opus-5-5` is a different model from `claude-opus-5`, with its own rates.
    expect(modelMatchesRequested("claude-opus-5-5", "claude-opus-5")).toBe(false);
    expect(modelMatchesRequested("claude-fable-5-2", "claude-fable-5")).toBe(false);
    expect(modelMatchesRequested("claude-sonnet-5-5", "claude-opus-5-5")).toBe(false);
  });

  it("an unknown target is every row unpriced with a reason, never a silent $0", () => {
    const r = repriceGroups([group({ model: OPUS, rows: 6, inputTokens: M })], OPUS, "claude-nonexistent-9");
    expect(r.counterfactual.total).toBe(0);
    expect(r.unpriced.counterfactual).toMatchObject({ rows: 6, byReason: { "unknown-model": 6 } });
  });

  it("checkRepriceModel refuses an id with no rate and a point-release id the table has no row for", () => {
    expect(checkRepriceModel(FABLE)).toBe(true);
    expect(checkRepriceModel("claude-opus-5-5-20261101")).toBe(true);
    expect(checkRepriceModel("claude-nonexistent-9")).toBe(false);
    // Prefix of `claude-fable-5` but a point release with no row: refused, not inherited.
    expect(checkRepriceModel("claude-fable-5-9")).toBe(false);
  });

  it("isModelIdShape accepts real id families and rejects payload-shaped strings", () => {
    for (const ok of [FABLE, "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-4-5@20251101", "anthropic.claude-opus-5"]) {
      expect(isModelIdShape(ok), ok).toBe(true);
    }
    for (const bad of ["", " claude-opus-5-5", "claude opus", "claude-opus-5-5; DROP TABLE messages", "claude\nopus", "'claude'", "-claude", "a".repeat(129), "../../etc/passwd x"]) {
      expect(isModelIdShape(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isModelIdShape(undefined)).toBe(false);
    expect(isModelIdShape(42)).toBe(false);
  });

  it("longContextThresholdFor reads the tier from the rate table", () => {
    expect(longContextThresholdFor(HAIKU)).toBe(100_000);
    expect(longContextThresholdFor(OPUS)).toBeNull();
    expect(longContextThresholdFor("claude-nonexistent-9")).toBeNull();
  });

  it("roundRepriceResult rounds to four places and keeps counts", () => {
    const r = roundRepriceResult(repriceGroups([group({ model: OPUS, rows: 3, inputTokens: 1 })], OPUS, FABLE));
    expect(r.actual.input).toBe(0);
    expect(r.rows).toBe(3);
  });
});

describe("repriceGroups: properties", () => {
  const tokens = fc.integer({ min: 0, max: 50 * M });
  it("repricing a model at itself is the identity, for any tokens and any modifiers it can price", () => {
    fc.assert(
      fc.property(
        tokens, tokens, tokens, tokens, fc.integer({ min: 0, max: 20 * M }), fc.integer({ min: 0, max: 20 * M }),
        fc.constantFrom<string | null>(null, "fast"), fc.constantFrom<string | null>(null, "us"), fc.boolean(),
        (input, output, read, create, w5, w1, speed, geo, lc) => {
          const r = repriceGroups(
            [group({ model: OPUS, speed, inferenceGeo: geo, longContext: lc, targetLongContext: lc, inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheCreationTokens: create, ephemeral5mTokens: w5, ephemeral1hTokens: w1 })],
            OPUS,
            OPUS,
          );
          expect(r.counterfactual.total).toBeCloseTo(r.actual.total, 6);
          expect(r.counterfactual.input).toBeCloseTo(r.actual.input, 6);
          expect(r.counterfactual.cacheWrite1h).toBeCloseTo(r.actual.cacheWrite1h, 6);
        },
      ),
    );
  });

  it("the categories always sum to the total", () => {
    fc.assert(
      fc.property(tokens, tokens, tokens, tokens, (input, output, read, create) => {
        const r = repriceGroups(
          [group({ model: OPUS, inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheCreationTokens: create })],
          OPUS,
          FABLE,
        );
        for (const side of [r.actual, r.counterfactual]) {
          expect(side.input + side.output + side.cacheWrite5m + side.cacheWrite1h + side.cacheRead).toBeCloseTo(side.total, 6);
        }
      }),
    );
  });
});
