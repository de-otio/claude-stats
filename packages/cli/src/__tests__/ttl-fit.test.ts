/**
 * `computeTtlFit` — the cache-TTL fit arithmetic (cache-ttl-fit Phase B2).
 *
 * This suite exists because the arithmetic has been got wrong twice already:
 *
 *  1. An earlier model treated the 1-hour write premium as paid ONCE PER CACHE
 *     LIFETIME rather than per turn, which inverts the answer on any many-turn
 *     workload. Guarded by `totals.writeTokens` equalling a naive
 *     `Σ cacheCreationTokens` over the fixture, and by the sign flip being
 *     asserted in BOTH directions — a one-directional suite would not have
 *     caught it.
 *  2. The plan's own first revision computed the 5-minute saving from TOTAL
 *     cache-creation volume `W` instead of the 1-hour-written volume `W1h`
 *     (review finding C-1). The premium was only ever PAID on tokens written at
 *     the 1-hour TTL. Guarded by "a mixed window where W and W1h give opposite
 *     verdicts".
 *
 * Every rate multiplier is DERIVED from the resolved pricing table, never
 * hardcoded — guarded by the `rateOverrides` case, without which a regression
 * to literal 1.15/0.75/0.652 would leave every other test passing.
 *
 * Shipped rates used by the hand arithmetic below (`claude-opus-5`):
 *   input 5.00, cacheRead 0.50, cacheWrite (5m) 6.25, cacheWrite1h 10.00
 *   ⇒ write5m − read = 5.75/MTok, write1h − write5m = 3.75/MTok,
 *     break-even ratio = 3.75 / 5.75 = 0.652173913…
 */
import { describe, it, expect } from "vitest";
import { computeTtlFit, type TtlFitResult } from "@claude-stats/core/ttlFit";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";
import type { ModelPricing, RateOverrides } from "@claude-stats/core/pricing";

const T0 = 1_767_571_200_000; // FIXED_NOW, matches fixtures/synthetic.ts
const MIN = 60_000;

/** Derived premiums for `claude-opus-5` on the shipped table. */
const READ_TO_WRITE_PREMIUM = 6.25 - 0.5; // 5.75 per MTok
const ONE_HOUR_PREMIUM = 10 - 6.25; // 3.75 per MTok
const SHIPPED_BREAK_EVEN = ONE_HOUR_PREMIUM / READ_TO_WRITE_PREMIUM;

function row(overrides: Partial<HygieneMessageRow> & { sessionId: string; uuid: string }): HygieneMessageRow {
  return {
    projectPath: "/w/alpha",
    timestamp: T0,
    model: "claude-opus-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    toolErrorCount: 0,
    tools: [],
    ...overrides,
  };
}

type ChainSpec = Partial<HygieneMessageRow> & { gapMs?: number };

/** One session's messages, each `gapMs` after the previous (default 1 min).
 *  The first spec's `gapMs` is ignored — a session's first message has no
 *  preceding gap. */
function chain(sessionId: string, specs: readonly ChainSpec[]): HygieneMessageRow[] {
  let t = T0;
  return specs.map((spec, i) => {
    if (i > 0) t += spec.gapMs ?? MIN;
    const { gapMs: _gapMs, ...rest } = spec;
    return row({ sessionId, uuid: `${sessionId}-m${i}`, timestamp: t, ...rest });
  });
}

function repeat(n: number, spec: ChainSpec): ChainSpec[] {
  return Array.from({ length: n }, () => ({ ...spec }));
}

function naiveWriteTokens(rows: readonly HygieneMessageRow[]): number {
  return rows.reduce((n, r) => n + r.cacheCreationTokens, 0);
}

/** Cache-creation tokens attributed to one origin category. */
function originCreation(result: TtlFitResult, origin: string): number {
  return result.writesByOrigin.find((o) => o.origin === origin)!.creationTokens;
}

function bucket(result: TtlFitResult, label: string) {
  const hit = result.gapHistogram.find((b) => b.label === label);
  if (!hit) throw new Error(`no bucket labelled ${label}; got ${result.gapHistogram.map((b) => b.label).join(", ")}`);
  return hit;
}

function opusRates(over: Partial<ModelPricing>): RateOverrides {
  return {
    first_party: {
      "claude-opus-5": {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 6.25,
        cacheWrite1hPerMillion: 10,
        ttlRateBasis: "parsed",
        ...over,
      },
    },
  };
}

// ─── Fixtures whose arithmetic is computed by hand in the comments ──────────

/** 60 turns, one minute apart, every write at the 1-hour TTL, no break long
 *  enough for the 1-hour TTL to recover anything. R = 0, W = W1h = 6 MTok. */
function manyTurnsNoBreaks(): HygieneMessageRow[] {
  return chain(
    "s-turns",
    repeat(60, { gapMs: MIN, cacheReadTokens: 200_000, cacheCreationTokens: 100_000, ephemeral1hCacheTokens: 100_000 }),
  );
}

/** 60 turns, each resumed after a 30-minute break — squarely inside the band
 *  the 1-hour TTL survives and the 5-minute one does not. R = 59 × 500K =
 *  29.5 MTok, W = W1h = 6 MTok. */
function manyBreaks(): HygieneMessageRow[] {
  return chain(
    "s-breaks",
    repeat(60, { gapMs: 30 * MIN, cacheReadTokens: 500_000, cacheCreationTokens: 100_000, ephemeral1hCacheTokens: 100_000 }),
  );
}

describe("computeTtlFit — gap bucketing and origins", () => {
  const rows = chain("s1", [
    { cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
    { gapMs: 0, cacheCreationTokens: 0 },
    { gapMs: 4 * MIN, cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
    { gapMs: 5 * MIN - 1, cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
    { gapMs: 5 * MIN, cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
    { gapMs: 60 * MIN - 1, cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
    { gapMs: 60 * MIN, cacheCreationTokens: 1_000, ephemeral1hCacheTokens: 1_000 },
  ]);

  it("puts a gap of exactly shortTtlMs in the TTL-relevant band, not below it", () => {
    const result = computeTtlFit(rows);
    // Lower bound inclusive, upper bound exclusive — asserted on BOTH sides of
    // each boundary so an off-by-one in either direction fails.
    expect(bucket(result, "4-5 min").requests).toBe(2); // gap = 4 min, gap = 5 min − 1 ms
    expect(bucket(result, "5-60 min").requests).toBe(2); // gap = 5 min, gap = 60 min − 1 ms
  });

  it("puts a gap of exactly longTtlMs in the cold-under-either-TTL bucket", () => {
    const result = computeTtlFit(rows);
    expect(bucket(result, "60+ min").requests).toBe(1);
    expect(bucket(result, "<4 min").requests).toBe(1); // the zero-length gap
  });

  it("never buckets a session's first message — it has no preceding gap", () => {
    const result = computeTtlFit(rows);
    const bucketed = result.gapHistogram.reduce((n, b) => n + b.requests, 0);
    expect(bucketed).toBe(rows.length - 1);
    expect(originCreation(result, "session-start")).toBe(1_000);
  });

  it("classifies each origin by the same boundaries the buckets use", () => {
    const result = computeTtlFit(rows);
    expect(originCreation(result, "mid-work")).toBe(2_000); // the 0 ms gap wrote nothing
    expect(originCreation(result, "resume-short")).toBe(2_000);
    expect(originCreation(result, "resume-long")).toBe(1_000);
    const shares = result.writesByOrigin.reduce((n, o) => n + o.share, 0);
    expect(shares).toBeCloseTo(1, 10);
  });

  it("reports pctRebuilt per bucket — 0 where nothing was rewritten, 1 where everything was", () => {
    const result = computeTtlFit(rows);
    expect(bucket(result, "<4 min").pctRebuilt).toBe(0);
    expect(bucket(result, "4-5 min").pctRebuilt).toBe(1);
  });

  it("reports the near-boundary band as the same measurement the histogram's second bucket carries", () => {
    const result = computeTtlFit(rows);
    expect(result.nearBoundary.requests).toBe(bucket(result, "4-5 min").requests);
    expect(result.nearBoundary.readTokens).toBe(bucket(result, "4-5 min").readTokens);
    expect(result.nearBoundary.windowMs).toBe(MIN);
  });

  it("derives the bucket boundaries from the supplied TTLs rather than hardcoding 5/60 min", () => {
    const result = computeTtlFit(rows, { shortTtlMs: 10 * MIN, longTtlMs: 30 * MIN });
    expect(result.gapHistogram.map((b) => b.label)).toEqual(["<8 min", "8-10 min", "10-30 min", "30+ min"]);
    // The 5-minute gap is now ordinary mid-work; the 60-minute one is still cold.
    expect(bucket(result, "<8 min").requests).toBe(4); // 0 ms, 4 min, 5 min − 1 ms, 5 min
    expect(bucket(result, "10-30 min").requests).toBe(0);
    expect(bucket(result, "30+ min").requests).toBe(2); // 60 min − 1 ms, 60 min
    expect(result.nearBoundary.windowMs).toBe(2 * MIN);
  });

  it("labels a sub-minute boundary without dragging in the host locale's number format", () => {
    // 90 s short TTL ⇒ a 72 s near-boundary floor, i.e. 1.2 min. A prior CI
    // failure in this repo came from a host-locale-formatted number reaching an
    // assertion, so the decimal separator here is asserted, not assumed.
    const result = computeTtlFit(rows, { shortTtlMs: 90_000, longTtlMs: 10 * MIN });
    expect(result.gapHistogram.map((b) => b.label)).toEqual(["<1.2 min", "1.2-1.5 min", "1.5-10 min", "10+ min"]);
  });

  it("falls back to the documented defaults when the supplied TTL pair is incoherent", () => {
    const result = computeTtlFit(rows, { shortTtlMs: 60 * MIN, longTtlMs: 5 * MIN });
    expect(result.gapHistogram.map((b) => b.label)).toEqual(["<4 min", "4-5 min", "5-60 min", "60+ min"]);
  });
});

describe("computeTtlFit — null timestamps and unpriced rows", () => {
  const rows: HygieneMessageRow[] = [
    row({ sessionId: "s1", uuid: "m0", timestamp: T0, cacheCreationTokens: 10_000, ephemeral1hCacheTokens: 10_000 }),
    row({ sessionId: "s1", uuid: "m1", timestamp: null, cacheCreationTokens: 20_000, ephemeral1hCacheTokens: 20_000 }),
    row({ sessionId: "s1", uuid: "m2", timestamp: T0 + 60 * MIN, cacheCreationTokens: 30_000, ephemeral1hCacheTokens: 30_000 }),
    row({ sessionId: "s1", uuid: "m3", timestamp: T0 + 61 * MIN, model: null, cacheCreationTokens: 40_000 }),
    row({ sessionId: "s1", uuid: "m4", timestamp: T0 + 62 * MIN, model: "not-a-shipped-model", cacheCreationTokens: 50_000 }),
  ];

  it("counts null-timestamp rows in excludedRows instead of dropping them", () => {
    const result = computeTtlFit(rows);
    expect(result.excludedRows).toBe(1);
  });

  it("breaks the gap chain across a null timestamp rather than bridging it", () => {
    const result = computeTtlFit(rows);
    // m2 sits 60 minutes after m0. Bridging the null would score it a
    // `resume-long`; breaking the chain makes it the first measurable message
    // of the run. Both halves asserted so "adds nothing at all" cannot pass.
    expect(originCreation(result, "resume-long")).toBe(0);
    expect(originCreation(result, "session-start")).toBe(10_000 + 30_000);
    expect(originCreation(result, "mid-work")).toBe(40_000 + 50_000);
  });

  it("keeps totals.writeTokens equal to a naive sum of cacheCreationTokens over every row", () => {
    // The guard against regressing to one write per gap: `W` is per-turn
    // volume, not per-cache-lifetime volume, and null-timestamp and unpriced
    // rows are real volume too.
    const result = computeTtlFit(rows);
    expect(naiveWriteTokens(rows)).toBe(150_000);
    expect(result.totals.writeTokens).toBe(150_000);
  });

  it("routes null-model and unpriced-model rows to unpricedRows, never to byModel", () => {
    const result = computeTtlFit(rows);
    expect(result.unpricedRows).toBe(2);
    expect(result.unpricedWriteTokens).toBe(40_000 + 50_000);
    expect(result.byModel.map((m) => m.model)).toEqual(["claude-opus-5"]);
    expect(result.byModel[0]!.writeTokens).toBe(60_000);
    // Never a `"null"` string model row, and never a row for a model with no rate.
    expect(result.byModel.some((m) => m.model === "null" || m.model === "not-a-shipped-model")).toBe(false);
  });

  it("still counts unpriced rows' token volume in the gap histogram — those tokens are real", () => {
    const result = computeTtlFit(rows);
    expect(bucket(result, "<4 min").creationTokens).toBe(40_000 + 50_000);
  });
});

describe("computeTtlFit — the sign flip, in both directions", () => {
  it("prefers the 5-minute TTL on a many-turn workload with no recoverable breaks", () => {
    const rows = manyTurnsNoBreaks();
    const result = computeTtlFit(rows);

    expect(result.observedTtl).toBe("1h");
    expect(result.totals.recoveredReadTokens).toBe(0);
    expect(result.totals.writeTokens).toBe(6_000_000);
    expect(result.totals.writeTokens).toBe(naiveWriteTokens(rows));
    expect(result.totals.writeTokens1h).toBe(6_000_000);

    // extra = 0 × 5.75 = 0 ; saved = 6 MTok × 3.75 = $22.50 ; net = −$22.50
    expect(result.byModel[0]!.extraCostAtShortTtl).toBeCloseTo(0, 10);
    expect(result.byModel[0]!.savedOnWritesAtShortTtl).toBeCloseTo(22.5, 10);
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(-22.5, 10);
    expect(result.windowCost).toBeCloseTo(66, 10);
    expect(result.recommendation.verdict).toBe("prefer-5m");
  });

  it("prefers the 1-hour TTL on a workload of repeated 30-minute breaks", () => {
    const rows = manyBreaks();
    const result = computeTtlFit(rows);

    // 59 of the 60 messages follow a 30-minute gap; the first has no gap.
    expect(result.totals.recoveredReadTokens).toBe(59 * 500_000);
    expect(result.totals.writeTokens).toBe(6_000_000);
    expect(result.totals.writeTokens1h).toBe(6_000_000);

    // extra = 29.5 MTok × 5.75 = $169.625 ; saved = $22.50 ; net = +$147.125
    expect(result.byModel[0]!.extraCostAtShortTtl).toBeCloseTo(169.625, 10);
    expect(result.byModel[0]!.savedOnWritesAtShortTtl).toBeCloseTo(22.5, 10);
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(147.125, 10);
    expect(result.recommendation.verdict).toBe("prefer-1h");
  });

  it("recovers reads only on requests recorded at the 1-hour TTL", () => {
    // Same 30-minute breaks, but every write recorded at the 5-minute TTL: a
    // gap in that band had ALREADY rebuilt, so its reads were never recovered
    // by the 1-hour TTL and must not count toward R.
    const rows = chain(
      "s-5m",
      repeat(60, { gapMs: 30 * MIN, cacheReadTokens: 500_000, cacheCreationTokens: 100_000, ephemeral5mCacheTokens: 100_000 }),
    );
    const result = computeTtlFit(rows);
    expect(result.observedTtl).toBe("5m");
    expect(result.totals.recoveredReadTokens).toBe(0);
    expect(result.totals.writeTokens1h).toBe(0);
    // Nothing recovered and no 1-hour premium paid ⇒ the two TTLs cost the same.
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(0, 10);
    expect(result.recommendation.verdict).toBe("too-close-to-call");
  });
});

describe("computeTtlFit — C-1: the saving is the premium ACTUALLY PAID (W1h), not total W", () => {
  // Two sessions in one window:
  //   s-1h: 31 messages recorded at the 1-hour TTL. Message 0 writes 1 MTok;
  //         messages 1-30 each resume after 30 minutes and read 100K back.
  //   s-5m: 20 messages recorded at the 5-minute TTL, one minute apart,
  //         writing 400K each and reading nothing.
  //
  //   R    = 30 × 100K              =  3.0 MTok
  //   W1h  = 1 MTok                 =  1.0 MTok
  //   W    = 1 MTok + 20 × 400K     =  9.0 MTok
  //
  //   extra        = 3.0 × 5.75                   = $17.25
  //   saved (W1h)  = 1.0 × 3.75                   =  $3.75  ⇒ net = +$13.50 → prefer-1h
  //   saved (W)    = 9.0 × 3.75                   = $33.75  ⇒ net = −$16.50 → prefer-5m
  //
  // The two give OPPOSITE verdicts, and both clear the 5% margin
  // (window cost $61.50 ⇒ margin $3.075), so this fixture cannot pass by
  // accident under either reading.
  const rows = [
    ...chain("s-1h", [
      { cacheCreationTokens: 1_000_000, ephemeral1hCacheTokens: 1_000_000 },
      ...repeat(30, { gapMs: 30 * MIN, cacheReadTokens: 100_000 }),
    ]),
    ...chain("s-5m", repeat(20, { gapMs: MIN, cacheCreationTokens: 400_000, ephemeral5mCacheTokens: 400_000 })),
  ];

  it("reports both W and W1h so the reader can check which one the cost term used", () => {
    const result = computeTtlFit(rows);
    expect(result.observedTtl).toBe("mixed");
    expect(result.totals.recoveredReadTokens).toBe(3_000_000);
    expect(result.totals.writeTokens).toBe(9_000_000);
    expect(result.totals.writeTokens).toBe(naiveWriteTokens(rows));
    expect(result.totals.writeTokens1h).toBe(1_000_000);
  });

  it("prices the saving from W1h — using total W would invert this window's verdict", () => {
    const result = computeTtlFit(rows);
    expect(result.byModel[0]!.extraCostAtShortTtl).toBeCloseTo(17.25, 10);
    expect(result.byModel[0]!.savedOnWritesAtShortTtl).toBeCloseTo(3.75, 10);
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(13.5, 10);
    expect(result.totals.netCostOfShortTtl!).toBeGreaterThan(0);
    expect(result.recommendation.verdict).toBe("prefer-1h");

    // Pin the counterfactual explicitly: the same window priced off total W
    // would report −$16.50 and recommend the opposite TTL.
    const savedFromTotalW = (result.totals.writeTokens * ONE_HOUR_PREMIUM) / 1e6;
    expect(result.byModel[0]!.extraCostAtShortTtl! - savedFromTotalW).toBeCloseTo(-16.5, 10);
    expect(Math.abs(-16.5)).toBeGreaterThan(0.05 * result.windowCost);
  });

  it("recovers a warm read on a request that wrote nothing of its own, from its session's TTL", () => {
    // Messages 1-30 of `s-1h` carry no ephemeral columns (they wrote nothing);
    // on the motivating window that is >90% of the 5-60 min band. Their reads
    // still count toward R because their session is unambiguously 1-hour.
    const result = computeTtlFit(rows);
    expect(result.totals.recoveredReadTokens).toBe(3_000_000);
    // And the 5-minute session's messages never do, whatever their gaps.
    expect(bucket(result, "<4 min").requests).toBe(19);
  });
});

describe("computeTtlFit — rates are derived from the resolved table, never hardcoded", () => {
  // read 0.2× input, write5m 1.5× input, write1h 2.5× input — a table whose
  // ratios differ from the shipped 0.1× / 1.25× / 2×.
  //   write5m − read   = 7.5 − 1.0 = 6.5/MTok   (shipped: 5.75)
  //   write1h − write5m = 12.5 − 7.5 = 5.0/MTok (shipped: 3.75)
  //   break-even        = 5.0 / 6.5 = 0.769…    (shipped: 0.652…)
  const overrides = opusRates({ cacheReadPerMillion: 1, cacheWritePerMillion: 7.5, cacheWrite1hPerMillion: 12.5 });

  it("reports the shipped break-even ratio when no overrides are supplied", () => {
    const result = computeTtlFit(manyBreaks());
    expect(result.byModel[0]!.breakEvenRatio).toBeCloseTo(SHIPPED_BREAK_EVEN, 12);
    expect(result.byModel[0]!.breakEvenRatio).toBeCloseTo(0.652173913, 8);
  });

  it("moves breakEvenRatio and the net with a rateOverrides table of different ratios", () => {
    const result = computeTtlFit(manyBreaks(), { rateOverrides: overrides });
    expect(result.byModel[0]!.breakEvenRatio).toBeCloseTo(5 / 6.5, 12);
    expect(result.byModel[0]!.breakEvenRatio).not.toBeCloseTo(SHIPPED_BREAK_EVEN, 4);

    // extra = 29.5 MTok × 6.5 = $191.75 ; saved = 6 MTok × 5.0 = $30.00
    expect(result.byModel[0]!.extraCostAtShortTtl).toBeCloseTo(191.75, 10);
    expect(result.byModel[0]!.savedOnWritesAtShortTtl).toBeCloseTo(30, 10);
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(161.75, 10);
    // Hardcoded 1.15/0.75 × input would have reproduced the shipped $147.125.
    expect(result.totals.netCostOfShortTtl).not.toBeCloseTo(147.125, 3);
  });

  it("prices the window cost through the same overrides", () => {
    const result = computeTtlFit(manyBreaks(), { rateOverrides: overrides });
    // 60 × (500K read × 1.00 + 100K write1h × 12.50) per MTok = 60 × $1.75
    expect(result.windowCost).toBeCloseTo(105, 10);
  });
});

describe("computeTtlFit — the D10 rate-coherence guard", () => {
  it("prices a model whose 1-hour rate was reported", () => {
    // The positive half of the two guards below: identical rates, `"parsed"`.
    const result = computeTtlFit(manyTurnsNoBreaks(), { rateOverrides: opusRates({}) });
    expect(result.byModel[0]!.netCostOfShortTtl).toBeCloseTo(-22.5, 10);
    expect(result.byModel[0]!.breakEvenRatio).toBeCloseTo(SHIPPED_BREAK_EVEN, 12);
    expect(result.recommendation.verdict).toBe("prefer-5m");
  });

  it("nulls the whole pricing half of a model whose 1-hour rate was synthesized", () => {
    const result = computeTtlFit(manyTurnsNoBreaks(), { rateOverrides: opusRates({ ttlRateBasis: "synthesized" }) });
    const model = result.byModel[0]!;
    // Token counts stay real — it is the signed dollar figure that is a guess.
    expect(model.model).toBe("claude-opus-5");
    expect(model.writeTokens).toBe(6_000_000);
    expect(model.writeTokens1h).toBe(6_000_000);
    expect(model.extraCostAtShortTtl).toBeNull();
    expect(model.savedOnWritesAtShortTtl).toBeNull();
    expect(model.netCostOfShortTtl).toBeNull();
    expect(model.breakEvenRatio).toBeNull();
    expect(result.totals.netCostOfShortTtl).toBeNull();
    expect(result.recommendation.verdict).toBe("insufficient-data");
  });

  it("nulls the pricing half of a model whose resolved rates are incoherent", () => {
    // Reads costlier than 5-minute writes: `write5m − read` is not positive, so
    // a "recovered read becomes a write" term would be negative — a signed
    // figure from a table we do not believe.
    const result = computeTtlFit(manyTurnsNoBreaks(), { rateOverrides: opusRates({ cacheReadPerMillion: 8 }) });
    expect(result.byModel[0]!.writeTokens).toBe(6_000_000);
    expect(result.byModel[0]!.netCostOfShortTtl).toBeNull();
    expect(result.totals.netCostOfShortTtl).toBeNull();
    expect(result.recommendation.verdict).toBe("insufficient-data");
  });

  it("nulls the pricing half when the 1-hour rate is below the 5-minute one", () => {
    const result = computeTtlFit(manyTurnsNoBreaks(), { rateOverrides: opusRates({ cacheWrite1hPerMillion: 1 }) });
    expect(result.byModel[0]!.netCostOfShortTtl).toBeNull();
    expect(result.recommendation.verdict).toBe("insufficient-data");
  });
});

describe("computeTtlFit — observedTtl unknown", () => {
  const rows = chain("s-unknown", repeat(60, { gapMs: MIN, cacheReadTokens: 200_000, cacheCreationTokens: 100_000 }));

  it("still computes the gap half", () => {
    const result = computeTtlFit(rows);
    expect(result.observedTtl).toBe("unknown");
    expect(bucket(result, "<4 min").requests).toBe(59);
    expect(result.totals.writeTokens).toBe(6_000_000);
    expect(result.byModel[0]!.writeTokens).toBe(6_000_000);
    expect(result.windowCost).toBeGreaterThan(0);
  });

  it("nulls every pricing-derived field rather than reporting a zero net", () => {
    // A `0` here would read as "the two TTLs cost the same", which is not what
    // an absent column means.
    const result = computeTtlFit(rows);
    expect(result.byModel[0]!.extraCostAtShortTtl).toBeNull();
    expect(result.byModel[0]!.savedOnWritesAtShortTtl).toBeNull();
    expect(result.byModel[0]!.netCostOfShortTtl).toBeNull();
    expect(result.byModel[0]!.breakEvenRatio).toBeNull();
    expect(result.totals.netCostOfShortTtl).toBeNull();
  });

  it("returns insufficient-data naming the missing columns, never a guessed prefer-*", () => {
    const result = computeTtlFit(rows);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reason).toMatch(/ephemeral_5m_cache_tokens/);
    expect(result.recommendation.reason).toMatch(/ephemeral_1h_cache_tokens/);
  });
});

describe("computeTtlFit — insufficient data", () => {
  it("reports insufficient-data on a 10-message window, and names the request count", () => {
    const rows = chain(
      "s-small",
      repeat(10, { gapMs: 30 * MIN, cacheReadTokens: 5_000_000, cacheCreationTokens: 1_000_000, ephemeral1hCacheTokens: 1_000_000 }),
    );
    const result = computeTtlFit(rows);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reason).toMatch(/timestamp/i);
    // The gap half still ran — the verdict is withheld, not the measurement.
    expect(result.totals.recoveredReadTokens).toBe(9 * 5_000_000);
  });

  it("reports insufficient-data below 5 MTok of TTL-attributed write volume", () => {
    const thin = chain("s-thin", repeat(60, { gapMs: MIN, cacheCreationTokens: 10_000, ephemeral1hCacheTokens: 10_000 }));
    const thinResult = computeTtlFit(thin);
    expect(thinResult.totals.writeTokens).toBe(600_000);
    expect(thinResult.recommendation.verdict).toBe("insufficient-data");
    expect(thinResult.recommendation.reason).toMatch(/cache-creation/);

    // Paired positive on the same code path: ten times the volume, same shape,
    // and the verdict lands.
    const thick = chain("s-thick", repeat(60, { gapMs: MIN, cacheCreationTokens: 100_000, ephemeral1hCacheTokens: 100_000 }));
    expect(computeTtlFit(thick).recommendation.verdict).toBe("prefer-5m");
  });
});

describe("computeTtlFit — too-close-to-call", () => {
  it("falls back to too-close-to-call when the net is under 5% of the window's cost", () => {
    // R = 10 × 385K = 3.85 MTok ; W1h = 50 × 115K = 5.75 MTok
    // extra = $22.1375 ; saved = $21.5625 ; net = +$0.575
    // window cost = $57.50 writes + $1.925 reads = $59.425 ⇒ 5% = $2.971
    const rows = chain("s-close", [
      { cacheCreationTokens: 115_000, ephemeral1hCacheTokens: 115_000 },
      ...repeat(10, { gapMs: 30 * MIN, cacheReadTokens: 385_000 }),
      ...repeat(49, { gapMs: MIN, cacheCreationTokens: 115_000, ephemeral1hCacheTokens: 115_000 }),
    ]);
    const result = computeTtlFit(rows);
    expect(result.totals.recoveredReadTokens).toBe(3_850_000);
    expect(result.totals.writeTokens1h).toBe(5_750_000);
    expect(result.totals.netCostOfShortTtl).toBeCloseTo(0.575, 10);
    expect(result.windowCost).toBeCloseTo(59.425, 10);
    expect(result.nearBoundary.impliedSwing).toBe(0);
    expect(result.recommendation.verdict).toBe("too-close-to-call");
    expect(result.recommendation.reason).toMatch(/5%/);
  });

  it("falls back to too-close-to-call when the net is smaller than the near-boundary swing", () => {
    // Same shape, but R is larger (net = +$5.75, clearing the 5% margin) and
    // three requests sit in the 4-5 min band carrying 1.5 MTok of reads:
    //   impliedSwing = 1.5 MTok × 5.75 = $8.625 > $5.75.
    const nearBand = repeat(3, { gapMs: 4 * MIN + 30_000, cacheReadTokens: 500_000 });
    const base: ChainSpec[] = [
      { cacheCreationTokens: 115_000, ephemeral1hCacheTokens: 115_000 },
      ...repeat(10, { gapMs: 30 * MIN, cacheReadTokens: 475_000 }),
    ];
    const tail = repeat(49, { gapMs: MIN, cacheCreationTokens: 115_000, ephemeral1hCacheTokens: 115_000 });

    const withBand = computeTtlFit(chain("s-swing", [...base, ...nearBand, ...tail]));
    expect(withBand.nearBoundary.requests).toBe(3);
    expect(withBand.nearBoundary.readTokens).toBe(1_500_000);
    expect(withBand.nearBoundary.impliedSwing).toBeCloseTo(8.625, 10);
    expect(withBand.totals.netCostOfShortTtl).toBeCloseTo(5.75, 10);
    // The 5% rule alone would NOT have downgraded this one.
    expect(Math.abs(withBand.totals.netCostOfShortTtl!)).toBeGreaterThan(0.05 * withBand.windowCost);
    expect(withBand.recommendation.verdict).toBe("too-close-to-call");
    expect(withBand.recommendation.reason).toMatch(/near-boundary/);

    // Paired positive on the same code path: remove only the near-boundary
    // band and the identical net becomes a verdict.
    const withoutBand = computeTtlFit(chain("s-swing", [...base, ...tail]));
    expect(withoutBand.nearBoundary.impliedSwing).toBe(0);
    expect(withoutBand.totals.netCostOfShortTtl).toBeCloseTo(5.75, 10);
    expect(withoutBand.recommendation.verdict).toBe("prefer-1h");
  });
});

describe("computeTtlFit — multiple models", () => {
  const rows = [
    ...chain(
      "s-opus",
      repeat(30, { gapMs: 30 * MIN, cacheReadTokens: 200_000, cacheCreationTokens: 100_000, ephemeral1hCacheTokens: 100_000 }),
    ),
    ...chain(
      "s-sonnet",
      repeat(30, {
        gapMs: 30 * MIN,
        model: "claude-sonnet-5",
        cacheReadTokens: 100_000,
        cacheCreationTokens: 200_000,
        ephemeral1hCacheTokens: 200_000,
      }),
    ),
  ];

  it("sums per-model rows to the totals", () => {
    const result = computeTtlFit(rows);
    expect(result.byModel.map((m) => m.model).sort()).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(result.unpricedRows).toBe(0);

    const sum = (pick: (m: (typeof result.byModel)[number]) => number) => result.byModel.reduce((n, m) => n + pick(m), 0);
    expect(sum((m) => m.recoveredReadTokens)).toBe(result.totals.recoveredReadTokens);
    expect(sum((m) => m.writeTokens)).toBe(result.totals.writeTokens);
    expect(sum((m) => m.writeTokens1h)).toBe(result.totals.writeTokens1h);
    expect(sum((m) => m.netCostOfShortTtl!)).toBeCloseTo(result.totals.netCostOfShortTtl!, 10);
  });

  it("prices each model at its own rates rather than one blended rate", () => {
    const result = computeTtlFit(rows);
    const opus = result.byModel.find((m) => m.model === "claude-opus-5")!;
    const sonnet = result.byModel.find((m) => m.model === "claude-sonnet-5")!;
    // opus-5: R = 29 × 200K = 5.8 MTok, W1h = 3 MTok
    expect(opus.extraCostAtShortTtl).toBeCloseTo((5_800_000 * READ_TO_WRITE_PREMIUM) / 1e6, 10);
    expect(opus.savedOnWritesAtShortTtl).toBeCloseTo((3_000_000 * ONE_HOUR_PREMIUM) / 1e6, 10);
    // sonnet-5: read 0.20, write5m 2.50, write1h 4.00 ⇒ premiums 2.30 and 1.50
    expect(sonnet.extraCostAtShortTtl).toBeCloseTo((2_900_000 * (2.5 - 0.2)) / 1e6, 10);
    expect(sonnet.savedOnWritesAtShortTtl).toBeCloseTo((6_000_000 * (4 - 2.5)) / 1e6, 10);
    expect(sonnet.breakEvenRatio).toBeCloseTo(1.5 / 2.3, 12);
    // Same structural ratio, different absolute rates — so the two break-evens
    // coincide on the shipped table. That is a property of the table, not an
    // assumption in the code: the overrides case above proves it moves.
    expect(sonnet.breakEvenRatio).toBeCloseTo(opus.breakEvenRatio!, 12);
  });
});

describe("computeTtlFit — purity", () => {
  it("returns the same result for the same input and never mutates the caller's rows", () => {
    const rows = manyBreaks();
    const before = JSON.stringify(rows);
    const first = computeTtlFit(rows);
    const second = computeTtlFit(rows);
    expect(second).toEqual(first);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("survives a window with no rows at all", () => {
    const result = computeTtlFit([]);
    expect(result.totals.writeTokens).toBe(0);
    expect(result.totals.netCostOfShortTtl).toBeNull();
    expect(result.byModel).toEqual([]);
    expect(result.windowCost).toBe(0);
    expect(result.writesByOrigin.every((o) => o.share === 0)).toBe(true);
    expect(result.recommendation.verdict).toBe("insufficient-data");
  });

  it("coerces a corrupt token count to zero rather than poisoning every total", () => {
    // The ephemeral columns reach here unvalidated from JSONL and from another
    // device's sync shard; a single NaN would otherwise reach the dashboard.
    const rows = manyTurnsNoBreaks();
    const poisoned = rows.map((r, i) => {
      if (i === 0) return { ...r, ephemeral1hCacheTokens: Number.NaN };
      if (i === 1) return { ...r, cacheCreationTokens: -5 };
      return r;
    });
    const result = computeTtlFit(poisoned);
    expect(Number.isFinite(result.totals.netCostOfShortTtl!)).toBe(true);
    expect(Number.isFinite(result.windowCost)).toBe(true);
    // Row 0's 1-hour column and row 1's creation count both collapse to 0.
    expect(result.totals.writeTokens).toBe(59 * 100_000);
    expect(result.totals.writeTokens1h).toBe(59 * 100_000);
  });
});
