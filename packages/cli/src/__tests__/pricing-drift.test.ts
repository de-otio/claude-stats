/**
 * The suffix-shape rule, the three rate rows it exists alongside, and the drift
 * findings it raises (cost-correctness 2026-09, Lane A).
 *
 * The defect being regression-tested is silent by construction: a point-release
 * model id is a string *prefix extension* of its predecessor's id, so
 * longest-prefix matching resolved a NEW model to an OLD rate row and returned
 * `known: true` while doing it. Measured consequences at the time of writing:
 * `claude-opus-4-7` priced at retired Opus 4 rates (3×, 58,604 rows), and
 * `claude-fable-5-1` / `claude-mythos-5-1` priced at the 5.0 cache-read rate of
 * 1.00 instead of 0.25 (4× on ~99.6% of input volume).
 *
 * Two arms of the rule are easy to delete by accident and are asserted
 * explicitly here:
 *
 *   - `[1m]` context-tier ids MUST inherit the base row. 4.6-and-later models
 *     include the full 1M window at standard pricing. Refusing them would turn
 *     every 1M-context request into `cost: 0`.
 *   - The override table (`rateOverrides`) gets the same rule. A configured
 *     `claude-fable-5` row must not capture `claude-fable-5-1`.
 *
 * Note the tests are located with the other `pricing*.test.ts` files because
 * `vitest.config.ts` only includes `packages/cli/src/__tests__/**`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import {
  PRICING,
  PRICING_VERIFIED_DATE,
  resolvePricing,
  estimateCost,
  classifyModelIdSuffix,
  suffixShapeInherits,
  matchPricingTable,
  getPricingDriftFindings,
  clearPricingDriftFindings,
  type ModelPricing,
  type RateOverrides,
} from "@claude-stats/core/pricing";

/** input / 5m write / 1h write / cache hits / output, $ per MTok. */
type Rates = [number, number, number, number, number];

const ratesOf = (p: ModelPricing): Rates => [
  p.inputPerMillion,
  p.cacheWritePerMillion,
  p.cacheWrite1hPerMillion,
  p.cacheReadPerMillion,
  p.outputPerMillion,
];

const TOP_5_1: Rates = [10, 12.5, 20, 0.25, 50];
const TOP_5_0: Rates = [10, 12.5, 20, 1.0, 50];
const OPUS_CURRENT: Rates = [5, 6.25, 10, 0.5, 25];
const OPUS_RETIRED: Rates = [15, 18.75, 30, 1.5, 75];
const SONNET_5: Rates = [2, 2.5, 4, 0.2, 10];
const HAIKU_4_5: Rates = [1, 1.25, 2, 0.1, 5];
const SONNET_3_5: Rates = [3, 3.75, 6, 0.3, 15];

beforeEach(() => {
  clearPricingDriftFindings();
});

// ── The rate rows ────────────────────────────────────────────────────────────

describe("DEFAULT_PRICING rows added in this release", () => {
  it.each<[string, Rates]>([
    // The three new rows.
    ["claude-opus-4-7", OPUS_CURRENT],
    ["claude-fable-5-1", TOP_5_1],
    ["claude-mythos-5-1", TOP_5_1],
    // Their predecessors must be untouched — four of five rates are shared, and
    // the cache-hit cell is the entire defect.
    ["claude-fable-5", TOP_5_0],
    ["claude-mythos-5", TOP_5_0],
    ["claude-opus-4", OPUS_RETIRED],
    ["claude-opus-4-1", OPUS_RETIRED],
    ["claude-opus-5", OPUS_CURRENT],
    ["claude-opus-4-8", OPUS_CURRENT],
    ["claude-opus-4-6", OPUS_CURRENT],
    // Sonnet 5 stays at $2/$10 — the predicted 2026-09-01 increase did not
    // happen, and bumping it would be a 50% over-report.
    ["claude-sonnet-5", SONNET_5],
  ])("prices %s at the live published rates", (model, expected) => {
    const r = resolvePricing(model);
    expect(r.pricing, `${model} has no rate row`).not.toBeNull();
    expect(ratesOf(r.pricing!)).toEqual(expected);
  });

  it("distinguishes the 5.1 cache-hit rate from the 5.0 one (the whole defect)", () => {
    // 1.00 → 0.25 is not derivable from the other four rates, which are equal.
    expect(PRICING["claude-fable-5"]!.cacheReadPerMillion).toBe(1.0);
    expect(PRICING["claude-fable-5-1"]!.cacheReadPerMillion).toBe(0.25);
    expect(PRICING["claude-mythos-5"]!.cacheReadPerMillion).toBe(1.0);
    expect(PRICING["claude-mythos-5-1"]!.cacheReadPerMillion).toBe(0.25);

    // Every other rate IS equal — which is why only an explicit row can carry it.
    for (const family of ["fable", "mythos"] as const) {
      const [a, b] = [PRICING[`claude-${family}-5`]!, PRICING[`claude-${family}-5-1`]!];
      expect(a.inputPerMillion).toBe(b.inputPerMillion);
      expect(a.outputPerMillion).toBe(b.outputPerMillion);
      expect(a.cacheWritePerMillion).toBe(b.cacheWritePerMillion);
      expect(a.cacheWrite1hPerMillion).toBe(b.cacheWrite1hPerMillion);
    }
  });

  it("no longer charges Opus 4.7 at retired Opus 4 rates", () => {
    const cost = estimateCost("claude-opus-4-7", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(cost.known).toBe(true);
    // 5 + 25 + 0.50 + 6.25 = 36.75, against 15 + 75 + 1.50 + 18.75 = 110.25.
    expect(cost.cost).toBeCloseTo(36.75, 10);
  });

  it("stamps the shipped table's verification date", () => {
    expect(PRICING_VERIFIED_DATE).toBe("2026-09-12");
  });
});

// ── The suffix-shape rule ────────────────────────────────────────────────────

describe("classifyModelIdSuffix", () => {
  it.each([
    ["", "exact"],
    ["-20251001", "dated-snapshot"],
    ["-20240229", "dated-snapshot"],
    ["[1m]", "context-tier"],
    ["[200k]", "context-tier"],
    ["-1", "point-release-suffix"],
    ["-11", "point-release-suffix"],
    ["-7", "point-release-suffix"],
    // Everything else refuses.
    ["-123", "unknown-suffix-shape"],
    ["-1-20251001", "unknown-suffix-shape"],
    ["-1[1m]", "unknown-suffix-shape"],
    ["-preview", "unknown-suffix-shape"],
    ["[1M]", "unknown-suffix-shape"],
    ["-2025100", "unknown-suffix-shape"],
    ["x", "unknown-suffix-shape"],
  ])("classifies %o as %s", (remainder, shape) => {
    expect(classifyModelIdSuffix(remainder)).toBe(shape);
  });

  it("is total and never throws", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => classifyModelIdSuffix(s)).not.toThrow();
        expect(typeof classifyModelIdSuffix(s)).toBe("string");
      }),
    );
  });
});

describe("resolvePricing suffix-shape rule", () => {
  it.each<[string, Rates | null, string]>([
    // Exact.
    ["claude-opus-5", OPUS_CURRENT, "exact match"],
    ["claude-fable-5-1", TOP_5_1, "exact match on the new row"],
    // Context tier — MUST inherit. Refusing these zeroes every 1M request.
    ["claude-opus-5[1m]", OPUS_CURRENT, "context-window tier inherits"],
    ["claude-sonnet-5[1m]", SONNET_5, "context-window tier inherits"],
    ["claude-fable-5-1[1m]", TOP_5_1, "tier on top of a point release"],
    // Dated snapshot — inherits.
    ["claude-haiku-4-5-20251001", HAIKU_4_5, "dated snapshot inherits"],
    ["claude-opus-4-8-20260601", OPUS_CURRENT, "dated snapshot inherits"],
    // Partner id families still normalize then inherit.
    ["us.anthropic.claude-3-5-sonnet-20241022-v2:0", SONNET_3_5, "Bedrock legacy profile"],
    ["claude-opus-4-5@20251101", OPUS_CURRENT, "Vertex dated snapshot"],
    // Point release with no row of its own — REFUSE, do not inherit.
    ["claude-opus-5-1", null, "hypothetical point release refuses"],
    ["claude-sonnet-5-1", null, "hypothetical point release refuses"],
    ["claude-haiku-4-5-1", null, "hypothetical point release refuses"],
    // Unknown shapes refuse too.
    ["claude-opus-5-preview", null, "unknown suffix refuses"],
    // Bare aliases match no key at all and stay unknown.
    ["opus", null, "bare alias"],
    ["sonnet", null, "bare alias"],
    ["haiku", null, "bare alias"],
  ])("resolves %s (%s)", (model, expected) => {
    const r = resolvePricing(model);
    if (expected === null) {
      expect(r.pricing).toBeNull();
      expect(estimateCost(model, 1_000_000, 0, 0, 0).known).toBe(false);
    } else {
      expect(r.pricing, `${model} unexpectedly unpriced`).not.toBeNull();
      expect(ratesOf(r.pricing!)).toEqual(expected);
    }
  });

  it("a refused point release costs zero and says so, rather than inheriting silently", () => {
    // The pre-fix behaviour: `claude-opus-5-1` inherited Opus 5's rates with
    // `known: true`. A visibly missing number beats a confidently wrong one.
    const r = estimateCost("claude-opus-5-1", 1_000_000, 1_000_000, 0, 0);
    expect(r.cost).toBe(0);
    expect(r.known).toBe(false);
  });
});

// ── Drift findings ───────────────────────────────────────────────────────────

describe("pricing drift findings", () => {
  it("records the refused id, the row it would have inherited, and why", () => {
    resolvePricing("claude-opus-5-1");
    expect(getPricingDriftFindings()).toEqual([
      {
        kind: "unpriced-model-variant",
        modelId: "claude-opus-5-1",
        matchedKey: "claude-opus-5",
        reason: "point-release-suffix",
        table: "built-in",
      },
    ]);
  });

  it("reports the canonical id for a partner-platform variant, not the raw one", () => {
    resolvePricing("us.anthropic.claude-opus-5-1-v1:0");
    const [f] = getPricingDriftFindings();
    expect(f?.modelId).toBe("claude-opus-5-1");
    expect(f?.matchedKey).toBe("claude-opus-5");
  });

  it("distinguishes an unknown suffix shape from a point release", () => {
    resolvePricing("claude-opus-5-preview");
    expect(getPricingDriftFindings()[0]?.reason).toBe("unknown-suffix-shape");
  });

  it("raises nothing for ids that resolve, or that match no key at all", () => {
    resolvePricing("claude-opus-5");
    resolvePricing("claude-opus-5[1m]");
    resolvePricing("claude-haiku-4-5-20251001");
    resolvePricing("opus");
    resolvePricing("gpt-4");
    expect(getPricingDriftFindings()).toEqual([]);
  });

  it("dedupes across repeated calls and clears on demand", () => {
    for (let i = 0; i < 50; i++) resolvePricing("claude-opus-5-1");
    resolvePricing("claude-sonnet-5-1");
    expect(getPricingDriftFindings()).toHaveLength(2);
    clearPricingDriftFindings();
    expect(getPricingDriftFindings()).toEqual([]);
  });

  it("is bounded — a corpus full of junk ids cannot grow it without limit", () => {
    for (let i = 0; i < 500; i++) resolvePricing(`claude-opus-5-junk${i}`);
    expect(getPricingDriftFindings().length).toBeLessThanOrEqual(100);
  });

  it("hands back copies; mutating the snapshot cannot corrupt the accumulator", () => {
    resolvePricing("claude-opus-5-1");
    const first = getPricingDriftFindings();
    first[0]!.matchedKey = "tampered";
    expect(getPricingDriftFindings()[0]?.matchedKey).toBe("claude-opus-5");
  });
});

// ── The override table has the identical defect ──────────────────────────────

describe("configured rate overrides obey the same rule", () => {
  const fableOverride: RateOverrides = {
    bedrock: {
      "claude-fable-5": {
        inputPerMillion: 11,
        outputPerMillion: 55,
        cacheReadPerMillion: 1.1,
        cacheWritePerMillion: 13.75,
        cacheWrite1hPerMillion: 22,
        ttlRateBasis: "parsed",
      },
    },
  };

  it("applies a configured row to the model it names", () => {
    const r = resolvePricing("anthropic.claude-fable-5", fableOverride);
    expect(r.rateBasis).toBe("configured");
    expect(r.pricing?.inputPerMillion).toBe(11);
  });

  it("still applies it to a dated snapshot of that model", () => {
    const r = resolvePricing("anthropic.claude-fable-5-20260101", fableOverride);
    expect(r.rateBasis).toBe("configured");
    expect(r.pricing?.inputPerMillion).toBe(11);
  });

  it("does NOT let a `claude-fable-5` override capture `claude-fable-5-1`", () => {
    const r = resolvePricing("anthropic.claude-fable-5-1", fableOverride);
    // Refused by the override matcher, so it falls through to the built-in
    // table — the documented first-party-estimate path — with the CORRECT 5.1
    // cache-hit rate rather than the override's 5.0-shaped one.
    expect(r.rateBasis).toBe("first_party_fallback");
    expect(ratesOf(r.pricing!)).toEqual(TOP_5_1);
    expect(r.drift).toMatchObject({
      modelId: "claude-fable-5-1",
      matchedKey: "claude-fable-5",
      reason: "point-release-suffix",
      table: "override",
    });
    expect(getPricingDriftFindings()[0]?.table).toBe("override");
  });

  it("reports a refused override even when the built-in table has no row either", () => {
    const r = resolvePricing("anthropic.claude-fable-5-2", fableOverride);
    expect(r.pricing).toBeNull();
    // Two matchers refused; the built-in one explains the returned outcome.
    expect(r.drift?.table).toBe("built-in");
    expect(getPricingDriftFindings().map((f) => f.table).sort()).toEqual(["built-in", "override"]);
  });
});

// ── matchPricingTable as a pure function ─────────────────────────────────────

describe("matchPricingTable", () => {
  const table: Record<string, ModelPricing> = {
    "claude-x": {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
      cacheWrite1hPerMillion: 2,
      ttlRateBasis: "parsed",
    },
  };

  it("is pure — it returns the finding rather than recording it", () => {
    const m = matchPricingTable(table, "claude-x-1", "built-in");
    expect(m.pricing).toBeNull();
    expect(m.drift?.reason).toBe("point-release-suffix");
    expect(getPricingDriftFindings()).toEqual([]);
  });

  it("reports no key and no finding when nothing is a prefix", () => {
    expect(matchPricingTable(table, "claude-y", "built-in")).toEqual({
      matchedKey: null,
      pricing: null,
      shape: null,
      drift: null,
    });
  });

  it("prefers the longest matching key", () => {
    const longer: Record<string, ModelPricing> = {
      ...table,
      "claude-x-9": { ...table["claude-x"]!, inputPerMillion: 99 },
    };
    expect(matchPricingTable(longer, "claude-x-9", "built-in").pricing?.inputPerMillion).toBe(99);
    expect(matchPricingTable(longer, "claude-x-9-20260101", "built-in").pricing?.inputPerMillion).toBe(99);
  });
});

// ── The shape property ───────────────────────────────────────────────────────

describe("shape property", () => {
  /**
   * For ANY model id: either no rate is resolved at all, or the resolved key is
   * the canonical id exactly, or the remainder after the key is a dated
   * snapshot or a context-window tier.
   *
   * The context-tier arm is load-bearing. Stated without it the property is
   * FALSE — `claude-opus-5[1m]` legitimately inherits base Opus 5 rates — and a
   * green-test-chasing implementer would "fix" it by refusing `[1m]`, zeroing
   * every 1M-context request.
   */
  const SEGMENT = fc.constantFrom(
    "claude",
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "mythos",
    "3",
    "4",
    "5",
    "1",
    "6",
    "7",
    "8",
    "11",
    "20251001",
    "20240229",
    "preview",
    "latest",
    "x",
  );

  const MODEL_ID = fc
    .array(SEGMENT, { minLength: 1, maxLength: 6 })
    .map((parts) => parts.join("-"))
    .chain((id) =>
      fc.constantFrom("", "[1m]", "[200k]", "@20251101", "-v1:0").map((suffix) => id + suffix),
    )
    .chain((id) => fc.constantFrom("", "anthropic.", "us.anthropic.", "eu.").map((p) => p + id));

  it("resolves only by exact key, dated snapshot, or context tier", () => {
    fc.assert(
      fc.property(MODEL_ID, (raw) => {
        const r = resolvePricing(raw);
        if (!r.pricing) return; // unknown is always an acceptable answer
        const key = Object.keys(PRICING).find(
          (k) => r.canonical.startsWith(k) && PRICING[k] === r.pricing,
        );
        expect(key, `${raw} priced from no identifiable key`).toBeDefined();
        const remainder = r.canonical.slice(key!.length);
        expect(
          suffixShapeInherits(classifyModelIdSuffix(remainder)),
          `${raw} inherited ${key} across remainder ${JSON.stringify(remainder)}`,
        ).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws, whatever the id", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => estimateCost(raw, 1, 1, 1, 1)).not.toThrow();
      }),
    );
  });
});
