/**
 * `computeAutoCompactFit` — the auto-compact window fit (autocompact-window-fit
 * Phase A).
 *
 * The five things this suite exists to hold down are the corrections the plan
 * reviews found, every one of which produces plausible-looking output when it is
 * wrong:
 *
 *  - **C6** — the simulated context starts each cycle at `0`, not at the floor
 *    (a cycle's first `carryIncrement` IS the whole context), and never cuts on
 *    a cycle's first increment. Pinned by `savedTokens === 0` on a cycle that
 *    never exceeds the window (seating), and by the exact cut COUNT at a
 *    candidate below the first increment (guard).
 *  - **C7** — `extraResets` is the simulated cut count, with no observed-reset
 *    subtraction. Pinned by a window that cuts only some cycles: the subtraction
 *    would make it negative.
 *  - **C9** — the drop filter uses `max(resets[].beforeTokens)`, not
 *    `sawtooth.peakTokens`, which is a MEAN. Pinned on a fixture whose mean and
 *    max differ by 142.5K.
 *  - **C10** — the conservative end scans ALL candidates (`netSaving` is not
 *    monotone), and no range is computed unless the aggressive end's `netSaving`
 *    is non-null and strictly positive.
 *  - **C11 / SR-4** — signed increments are clamped at `0`, and every consumed
 *    numeric field is checked finite before it is used.
 *
 * Every fixture is synthetic: round token counts, `s<n>` session ids,
 * `/w/<letter>` project paths. No figure here is copied from a real window.
 *
 * Shipped rate used by the hand arithmetic below (`claude-opus-5`):
 * cacheRead 0.50 $/MTok.
 */
import { describe, it, expect } from "vitest";
import {
  computeAutoCompactFit,
  type AutoCompactFitResult,
} from "@claude-stats/core/autoCompactFit";
import { computeContextCarry, type ContextCarryResult } from "@claude-stats/core/contextCarry";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";
import type { RateOverrides } from "@claude-stats/core/pricing";

const K = 1_000;
/** `claude-opus-5` on the shipped table, $/MTok. */
const READ_RATE = 0.5;

interface CycleSpec {
  increments: number[];
  open?: boolean;
  model?: string | null;
  /** Overrides the reset's `beforeTokens` (defaults to the cycle's telescoped
   *  total). Used where the observed peak must differ from what the increments
   *  reconstruct — a legitimate input, since `detectResets` measures
   *  `beforeTokens` off the rows, not off this module's increments. */
  beforeTokens?: number;
  resetCost?: number;
}

interface BuildOptions {
  floorTokens?: number;
  resetCost?: number;
  /** Added to `carriedTokens` on top of the cycles' volume — the null-timestamp
   *  rows that sit in no cycle at all. */
  extraCarriedTokens?: number;
  totalCarryCost?: number | null;
}

/**
 * A `ContextCarryResult` shaped exactly the way `computeContextCarry` shapes
 * one: `turns` is the concatenation of each cycle's turn list in `cycles` order,
 * with `remainingRequestsInCycle` running `n…1` per cycle.
 */
function buildCarry(specs: readonly CycleSpec[], options: BuildOptions = {}): ContextCarryResult {
  const floorTokens = options.floorTokens ?? 10 * K;
  const defaultResetCost = options.resetCost ?? 0.05;

  const turns: ContextCarryResult["turns"] = [];
  const cycles: ContextCarryResult["cycles"] = [];
  const resets: ContextCarryResult["resets"] = [];
  let carriedTokens = options.extraCarriedTokens ?? 0;
  let totalCarryCost = 0;
  let anyPriced = false;

  specs.forEach((spec, j) => {
    const n = spec.increments.length;
    const sessionId = `s${j}`;
    const model = spec.model === undefined ? "claude-opus-5" : spec.model;
    const open = spec.open ?? false;
    const resetCost = spec.resetCost ?? defaultResetCost;
    cycles.push({ sessionId, requests: n, open });
    let telescoped = 0;
    spec.increments.forEach((increment, i) => {
      const remaining = n - i;
      telescoped += increment;
      carriedTokens += increment * remaining;
      let carryCost: number | null = null;
      if (model !== null) {
        anyPriced = true;
        carryCost = (increment * remaining * READ_RATE) / 1e6;
        if (!open && i === n - 1) carryCost += resetCost;
        totalCarryCost += carryCost;
      }
      turns.push({
        sessionId,
        uuid: `${sessionId}-t${i}`,
        model,
        increment,
        remainingRequestsInCycle: remaining,
        carryCost,
      });
    });
    if (!open) {
      resets.push({
        sessionId,
        beforeTokens: spec.beforeTokens ?? telescoped,
        afterTokens: floorTokens,
        requestsInCycle: n,
        resetRequestCost: resetCost,
      });
    }
  });

  const closed = cycles.filter((c) => !c.open);
  const sawtooth =
    resets.length < 3
      ? null
      : {
          floorTokens,
          peakTokens: resets.reduce((a, r) => a + r.beforeTokens, 0) / resets.length,
          requestsPerCycle: closed.reduce((a, c) => a + c.requests, 0) / closed.length,
        };

  return {
    carriedTokens,
    distinctTokensEstimate: 0,
    amplificationEstimate: null,
    sizeBands: [],
    aboveCap: [],
    capCaveat: "",
    resets,
    cycles,
    sawtooth,
    prelude: { medianFirstRequestTokens: 0, shareOfCarriedVolume: null, cost: 0, sessions: 0 },
    preludeByProject: [],
    concentration: [],
    turns,
    totalCarryCost:
      options.totalCarryCost !== undefined ? options.totalCarryCost : anyPriced ? totalCarryCost : null,
    excludedRows: 0,
    unpricedRows: 0,
    unpricedTokens: 0,
  };
}

function repeat(increments: number[], count: number, extra: Partial<CycleSpec> = {}): CycleSpec[] {
  return Array.from({ length: count }, () => ({ increments, ...extra }));
}

/**
 * The reference fixture: ten identical cycles of `[150K, 60K, 60K, 60K, 60K]`
 * over a 10K floor. Telescoped context per cycle: 150 / 210 / 270 / 330 / 390 K;
 * carried volume per cycle 1,350K (`Σ increment × remaining` = 150×5 + 60×10),
 * so 13.5M across the window. 50 turns — exactly the minimum.
 */
const RAMP = [150 * K, 60 * K, 60 * K, 60 * K, 60 * K];
function rampCarry(options: BuildOptions = {}): ContextCarryResult {
  return buildCarry(repeat(RAMP, 10), options);
}

function windowsOf(result: AutoCompactFitResult): number[] {
  return result.candidates.map((c) => c.windowTokens);
}

function candidateAt(result: AutoCompactFitResult, windowTokens: number) {
  const hit = result.candidates.find((c) => c.windowTokens === windowTokens);
  if (hit === undefined) throw new Error(`no candidate at ${windowTokens}`);
  return hit;
}

/** Every number anywhere in the result, for the "never NaN, never Infinity"
 *  check (`JSON.stringify` emits both as `null`, which is indistinguishable
 *  from D6's "nothing was priced"). */
function allNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allNumbers(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) allNumbers(v, out);
  return out;
}

describe("computeAutoCompactFit — the simulation (§3.1)", () => {
  it("reproduces the hand arithmetic on the reference ramp, candidate by candidate", () => {
    const result = computeAutoCompactFit(rampCarry());

    // Baseline: `Σ increment × remaining` over the closed cycles (C3/D10),
    // 1,350K per cycle × 10.
    expect(result.closedCycleCarriedTokens).toBe(13_500_000);
    expect(result.openCycleCarriedTokens).toBe(0);
    expect(result.excludedRowCarriedTokens).toBe(0);
    expect(result.observedMedianCycleRequests).toBe(5);

    // Hand replay of one cycle (floor 10K), simulated context per turn:
    //   C=100K: 150 |  70 |  70 |  70 |  70   carried 430K, 4 cuts
    //   C=150K: 150 |  70 | 130 |  70 | 130   carried 550K, 2 cuts
    //   C=200K: 150 |  70 | 130 | 190 |  70   carried 610K, 2 cuts
    //   C=250K: 150 | 210 |  70 | 130 | 190   carried 750K, 1 cut
    //   C=300K: 150 | 210 | 270 |  70 | 130   carried 830K, 1 cut
    // saved = 1,350K − carried, × 10 cycles.
    const expected = [
      { windowTokens: 100 * K, savedTokens: 9_200_000, extraResets: 40, medianCycleRequests: 1 },
      { windowTokens: 150 * K, savedTokens: 8_000_000, extraResets: 20, medianCycleRequests: 2 },
      { windowTokens: 200 * K, savedTokens: 7_400_000, extraResets: 20, medianCycleRequests: 1 },
      { windowTokens: 250 * K, savedTokens: 6_000_000, extraResets: 10, medianCycleRequests: 2.5 },
      { windowTokens: 300 * K, savedTokens: 5_200_000, extraResets: 10, medianCycleRequests: 2.5 },
    ];
    expect(result.candidates.map(({ netSaving: _n, ...rest }) => rest)).toEqual(expected);

    // netSaving = savedTokens × 0.5/MTok − cuts × $0.05.
    expect(candidateAt(result, 100 * K).netSaving).toBeCloseTo(4.6 - 2.0, 10);
    expect(candidateAt(result, 300 * K).netSaving).toBeCloseTo(2.6 - 0.5, 10);
  });

  it("C6: never cuts on a cycle's first increment, even when that increment alone exceeds the window", () => {
    // The first increment is 150K — larger than the 100K candidate. Cutting on
    // it would add one cut per cycle (50, not 40) and seat every cycle's first
    // turn at the floor instead of at its real post-compaction baseline.
    const result = computeAutoCompactFit(rampCarry());
    const smallest = candidateAt(result, 100 * K);
    expect(smallest.extraResets).toBe(40);
    // Paired positive: cuts on the LATER increments are taken — the guard is
    // "not the first", not "never".
    expect(smallest.extraResets).toBeGreaterThan(0);
    expect(smallest.savedTokens).toBe(9_200_000);
  });

  it("C6: a cycle that never exceeds the window saves exactly zero — the simulation starts at 0, not at the floor", () => {
    // Nine cycles peaking at 200K and three at 390K. At a 300K window the small
    // cycles never cut, so their simulated context IS their observed context and
    // they contribute exactly 0. Seating `ctx` at the floor instead would make
    // each of them contribute −(floor × turns) and the total would be negative.
    const mixed = buildCarry([...repeat([40 * K, 40 * K, 40 * K, 40 * K, 40 * K], 9), ...repeat(RAMP, 3)]);
    const result = computeAutoCompactFit(mixed);
    // Only the three ramp cycles cut, 520K saved each.
    expect(candidateAt(result, 300 * K).savedTokens).toBe(3 * 520_000);
    // Paired positive: a window the small cycles DO exceed moves them.
    expect(candidateAt(result, 100 * K).savedTokens).toBeGreaterThan(3 * 520_000);
  });

  it("C6: only turns from the cut onward carry the floor, so raising the floor costs exactly those turns", () => {
    // At a 300K window each ramp cycle cuts once, before its 4th turn. Turns 4
    // and 5 restart from the floor; turns 1-3 do not. Raising the floor by 5K
    // must therefore cost 5K × 2 turns × 10 cycles = 100K of saving — no more.
    // Seating the whole cycle at the floor would cost 5K × 5 turns × 10 = 250K.
    const low = computeAutoCompactFit(rampCarry({ floorTokens: 10 * K }));
    const high = computeAutoCompactFit(rampCarry({ floorTokens: 15 * K }));
    expect(candidateAt(low, 300 * K).savedTokens).toBe(5_200_000);
    expect(candidateAt(high, 300 * K).savedTokens).toBe(5_100_000);
  });

  it("C11: a negative increment after a cut is clamped at zero rather than subtracting volume", () => {
    // Per cycle, telescoped context: 200 / 350 / 170 / 210 / 250 K.
    // At a 200K window: turn 1 seats at 200K (first, no cut); turn 2 would reach
    // 350K so it cuts and seats at floor+150 = 160K; turn 3's −180K would take
    // the simulated context to −20K and is clamped to 0; turns 4-5 climb to 40K
    // and 80K. Saved per turn: 0 / 190 / 170 / 170 / 170 = 700K.
    // Unclamped it would be 0 / 190 / 190 / 190 / 190 = 760K — MORE saving from
    // a negative context.
    const shrink = buildCarry(repeat([200 * K, 150 * K, -180 * K, 40 * K, 40 * K], 10));
    const result = computeAutoCompactFit(shrink, { candidatesTokens: [200 * K] });
    expect(windowsOf(result)).toEqual([200 * K]);
    expect(candidateAt(result, 200 * K).savedTokens).toBe(7_000_000);
    // Paired positive: the cut itself still happened — one per cycle.
    expect(candidateAt(result, 200 * K).extraResets).toBe(10);
  });

  it("C7: extraResets is the simulated cut count, never net of the observed resets", () => {
    // Twelve closed cycles; at a 300K window only the three ramp cycles cut.
    // The rev-1 formula (Σ cuts − observed closed resets) would report 3 − 12 =
    // −9 and inflate netSaving by 12 × meanResetCost.
    const mixed = buildCarry([...repeat([40 * K, 40 * K, 40 * K, 40 * K, 40 * K], 9), ...repeat(RAMP, 3)]);
    const result = computeAutoCompactFit(mixed);
    expect(mixed.cycles.filter((c) => !c.open)).toHaveLength(12);
    expect(candidateAt(result, 300 * K).extraResets).toBe(3);
    // Paired positive: a smaller window cuts every cycle — 9 × 2 + 3 × 4.
    expect(candidateAt(result, 100 * K).extraResets).toBe(30);
  });

  it("open cycles are excluded from every aggregate — and a closed one is not", () => {
    const base = computeAutoCompactFit(rampCarry());
    const withOpen = computeAutoCompactFit(buildCarry([...repeat(RAMP, 10), { increments: RAMP, open: true }]));
    const withClosed = computeAutoCompactFit(buildCarry(repeat(RAMP, 11)));

    expect(withOpen.candidates).toEqual(base.candidates);
    expect(withOpen.closedCycleCarriedTokens).toBe(base.closedCycleCarriedTokens);
    expect(withOpen.openCyclesExcluded).toBe(1);
    expect(withOpen.openCycleCarriedTokens).toBe(1_350_000);

    // Paired positive (CR-18): a stub returning a constant passes the negative
    // half byte-identically. An eleventh CLOSED cycle MUST move the figures.
    expect(withClosed.openCyclesExcluded).toBe(0);
    expect(withClosed.closedCycleCarriedTokens).toBe(11 * 1_350_000);
    expect(candidateAt(withClosed, 300 * K).savedTokens).toBe(11 * 520_000);
  });

  it("reports the three volume components so the denominator reconciles (C3/CR-12)", () => {
    const carry = rampCarry({ extraCarriedTokens: 250_000 });
    const withOpen = buildCarry([...repeat(RAMP, 10), { increments: RAMP, open: true }], {
      extraCarriedTokens: 250_000,
    });
    const result = computeAutoCompactFit(withOpen);
    expect(result.excludedRowCarriedTokens).toBe(250_000);
    expect(
      result.closedCycleCarriedTokens + result.openCycleCarriedTokens + result.excludedRowCarriedTokens,
    ).toBe(withOpen.carriedTokens);
    // Paired: without the extra rows the third component is 0, not a residue.
    expect(computeAutoCompactFit(rampCarry()).excludedRowCarriedTokens).toBe(0);
    expect(carry.carriedTokens).toBe(13_750_000);
  });
});

describe("computeAutoCompactFit — the candidate grid (§3.2)", () => {
  it("C9: filters on the MAX observed peak, not the mean", () => {
    // Nine cycles peaking at 200K, three at 390K: mean peak 247.5K, max 390K.
    // Filtering on the mean would drop 250K and 300K — candidates that still cut
    // every cycle whose own peak exceeded them.
    const mixed = buildCarry([...repeat([40 * K, 40 * K, 40 * K, 40 * K, 40 * K], 9), ...repeat(RAMP, 3)]);
    const result = computeAutoCompactFit(mixed);
    expect(result.observedPeakTokens).toBe(247_500);
    expect(result.observedMaxPeakTokens).toBe(390_000);
    expect(windowsOf(result)).toContain(250 * K);
    expect(windowsOf(result)).toContain(300 * K);
    expect(candidateAt(result, 250 * K).savedTokens).toBeGreaterThan(0);
    // Paired: candidates at or above the MAX peak are still dropped.
    expect(result.droppedCandidates).toContainEqual({ windowTokens: 400 * K, reason: "at-or-above-peak" });
  });

  it("drops candidates at or below 1.5× the floor, and says so", () => {
    // A floor of 700K puts 1.5× above the top of the settable range: every
    // candidate is a crash loop.
    const result = computeAutoCompactFit(rampCarry({ floorTokens: 700 * K }));
    expect(result.candidates).toEqual([]);
    expect(result.droppedCandidates.every((d) => d.reason === "below-floor")).toBe(true);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("grid-empty-below-floor");
    // Paired positive: at a 60K floor exactly the candidates at or below 90K are
    // dropped, and the rest survive.
    const lower = computeAutoCompactFit(rampCarry({ floorTokens: 60 * K }));
    expect(windowsOf(lower)).toEqual([100 * K, 150 * K, 200 * K, 250 * K, 300 * K]);
  });

  it("drops out-of-range candidates rather than rounding them in", () => {
    const result = computeAutoCompactFit(rampCarry(), {
      candidatesTokens: [50 * K, 200 * K, 2_000 * K],
    });
    expect(windowsOf(result)).toEqual([200 * K]);
    expect(result.droppedCandidates).toEqual([
      { windowTokens: 50 * K, reason: "out-of-range" },
      { windowTokens: 2_000 * K, reason: "out-of-range" },
    ]);
    expect(result.settableRange).toEqual([100_000, 1_000_000]);
  });

  it("SR-8: caps the normalised candidate list at 64 and records the overflow", () => {
    const seventy = Array.from({ length: 70 }, (_, i) => 100 * K + i * 4 * K);
    const result = computeAutoCompactFit(rampCarry(), { candidatesTokens: seventy });
    expect(result.candidates).toHaveLength(64);
    expect(result.droppedCandidates).toHaveLength(6);
    expect(result.droppedCandidates.every((d) => d.reason === "out-of-range")).toBe(true);
    expect(result.droppedCandidates.map((d) => d.windowTokens)).toEqual(seventy.slice(64));
    // Paired positive: a 60-entry list is not truncated at all.
    const sixty = seventy.slice(0, 60);
    const under = computeAutoCompactFit(rampCarry(), { candidatesTokens: sixty });
    expect(under.candidates).toHaveLength(60);
    expect(under.droppedCandidates).toEqual([]);
  });

  it("honours an explicitly empty candidate list; only `undefined` falls back to the grid", () => {
    const empty = computeAutoCompactFit(rampCarry(), { candidatesTokens: [] });
    expect(empty.candidates).toEqual([]);
    expect(empty.droppedCandidates).toEqual([]);
    // An empty list drops nothing, so "already tuned" would be a fabrication.
    expect(empty.recommendation.verdict).toBe("insufficient-data");
    expect(empty.recommendation.reasonCode).toBe("grid-empty-below-floor");
    // Paired positive: `undefined` uses the default grid.
    expect(windowsOf(computeAutoCompactFit(rampCarry(), {}))).toEqual([
      100 * K,
      150 * K,
      200 * K,
      250 * K,
      300 * K,
    ]);
  });
});

describe("computeAutoCompactFit — SR-4, the finite-input guard", () => {
  it("rejects a non-finite increment", () => {
    const carry = rampCarry();
    carry.turns[7]!.increment = Number.NaN;
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("non-finite-input");
    expect(result.candidates).toEqual([]);
    // The offending field is reported as a NUMBER (SR-2), and the index is real.
    expect(result.recommendation.reasonFacts["index"]).toBe(7);
    // Paired positive: the same fixture with a finite increment is priced.
    expect(computeAutoCompactFit(rampCarry()).recommendation.verdict).toBe("recommend-window");
  });

  it("rejects a non-finite floor — the case that makes every `>` comparison silently false", () => {
    const carry = rampCarry();
    carry.sawtooth!.floorTokens = Number.NaN;
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.reasonCode).toBe("non-finite-input");
    expect(result.observedFloorTokens).toBeNull();
    // Paired positive: a finite floor produces a floor-derived drop set.
    const ok = computeAutoCompactFit(rampCarry({ floorTokens: 80 * K }));
    expect(ok.observedFloorTokens).toBe(80_000);
    expect(ok.droppedCandidates).toContainEqual({ windowTokens: 100 * K, reason: "below-floor" });
  });

  it("rejects a cycle-request count outside the non-negative safe integers, ahead of the partition check", () => {
    // A naive `Σ cycles[].requests === turns.length` check passes this input:
    // −5 and 15 still sum to 50. The numeric-domain check must fire FIRST, so
    // the reason names the invariant the input actually broke.
    const carry = rampCarry();
    carry.cycles[0]!.requests = -5;
    carry.cycles[1]!.requests = 15;
    expect(carry.cycles.reduce((a, c) => a + c.requests, 0)).toBe(carry.turns.length);
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.reasonCode).toBe("non-finite-input");
    // Paired positive: with in-domain counts the same shape is a valid partition.
    expect(computeAutoCompactFit(rampCarry()).recommendation.reasonCode).toBe("recommended");
  });

  it("rejects a remaining-request count that is not a positive safe integer", () => {
    // `remaining` indexes the partition; a fractional or zero value would slip
    // past the `=== 1` slice terminator and silently mis-attribute volume.
    const fractional = rampCarry();
    fractional.turns[1]!.remainingRequestsInCycle = 3.5;
    expect(computeAutoCompactFit(fractional).recommendation.reasonCode).toBe("non-finite-input");
    const zero = rampCarry();
    zero.turns[1]!.remainingRequestsInCycle = 0;
    expect(computeAutoCompactFit(zero).recommendation.reasonCode).toBe("non-finite-input");
    // Paired positive: `n…1` integers partition.
    expect(computeAutoCompactFit(rampCarry()).recommendation.reasonCode).toBe("recommended");
  });

  it("rejects a non-finite peak and a non-finite carry cost", () => {
    const badPeak = rampCarry();
    badPeak.sawtooth!.peakTokens = Number.NaN;
    const peakResult = computeAutoCompactFit(badPeak);
    expect(peakResult.recommendation.reasonCode).toBe("non-finite-input");
    expect(peakResult.observedPeakTokens).toBeNull();

    const badCost = rampCarry({ totalCarryCost: Number.POSITIVE_INFINITY });
    expect(computeAutoCompactFit(badCost).recommendation.reasonCode).toBe("non-finite-input");

    // Paired positive: a `null` carry cost is NOT a domain violation — it is
    // the honest "nothing was priced" signal, and gets its own reason.
    expect(computeAutoCompactFit(rampCarry({ totalCarryCost: null })).recommendation.reasonCode).toBe(
      "nothing-priced",
    );
  });

  it("rejects a non-finite reset cost and a non-finite carried-token total", () => {
    const badReset = rampCarry();
    badReset.resets[2]!.resetRequestCost = Number.POSITIVE_INFINITY;
    expect(computeAutoCompactFit(badReset).recommendation.reasonCode).toBe("non-finite-input");

    const badCarried = rampCarry();
    badCarried.carriedTokens = Number.NaN;
    expect(computeAutoCompactFit(badCarried).recommendation.reasonCode).toBe("non-finite-input");

    // Paired positive: both fields in domain, and the result reports them.
    const ok = computeAutoCompactFit(rampCarry());
    expect(ok.recommendation.reasonCode).toBe("recommended");
    expect(ok.closedCycleCarriedTokens).toBe(13_500_000);
  });

  it("never emits NaN or Infinity anywhere in the result", () => {
    const results = [
      computeAutoCompactFit(rampCarry()),
      computeAutoCompactFit(rampCarry({ floorTokens: 700 * K })),
      computeAutoCompactFit(buildCarry(repeat(RAMP, 10, { model: null }))),
    ];
    for (const result of results) {
      for (const n of allNumbers(result)) expect(Number.isFinite(n)).toBe(true);
    }
    // Paired positive: the numbers are actually there to check.
    expect(allNumbers(results[0]!).length).toBeGreaterThan(20);
  });
});

describe("computeAutoCompactFit — C1, the turns/cycles partition", () => {
  it("rejects a `remaining` sequence that does not run n…1", () => {
    const carry = rampCarry();
    carry.turns[2]!.remainingRequestsInCycle = 4; // should be 3
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("partition-invalid");
    expect(result.candidates).toEqual([]);
    // Paired positive: the untouched fixture partitions.
    expect(computeAutoCompactFit(rampCarry()).candidates).toHaveLength(5);
  });

  it("rejects a turns array whose last slice has no terminator", () => {
    const carry = rampCarry();
    carry.turns[carry.turns.length - 1]!.remainingRequestsInCycle = 2;
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");
    // Paired positive: restoring the terminator restores the partition.
    carry.turns[carry.turns.length - 1]!.remainingRequestsInCycle = 1;
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("recommended");
  });

  it("rejects a reordering that a count check cannot see", () => {
    // Two cycles of different lengths, swapped in `cycles` only. `Σ requests`
    // is unchanged — the check the plan rejected as theatre passes this.
    const carry = buildCarry([
      { increments: [200 * K, 60 * K, 60 * K, 60 * K] },
      ...repeat(RAMP, 10),
      { increments: [200 * K, 60 * K, 60 * K, 60 * K, 60 * K, 60 * K] },
    ]);
    const before = carry.cycles.reduce((a, c) => a + c.requests, 0);
    const first = carry.cycles[0]!;
    carry.cycles[0] = carry.cycles[carry.cycles.length - 1]!;
    carry.cycles[carry.cycles.length - 1] = first;
    expect(carry.cycles.reduce((a, c) => a + c.requests, 0)).toBe(before);
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");
  });

  it("rejects a cycle whose request count disagrees with its slice's length", () => {
    // The slice is five turns long; `cycles[0]` claims four. Everything else
    // lines up — this is the cross-check between the two arrays, and without it
    // the module would simply believe `turns` and ignore the disagreement.
    const carry = rampCarry();
    carry.cycles[0]!.requests = 4;
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");
    // Paired positive: the agreeing count partitions.
    carry.cycles[0]!.requests = 5;
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("recommended");
  });

  it("rejects trailing turns that no cycle terminates, even when the counts still line up", () => {
    // Ten slices, ten cycles — but two turns hang off the end with no
    // `remaining === 1` terminator. Without the offset check they would be
    // silently dropped from the analysis and the result would look complete.
    const carry = rampCarry();
    carry.turns.push(
      { sessionId: "s9", uuid: "s9-x0", model: "claude-opus-5", increment: 10 * K, remainingRequestsInCycle: 3, carryCost: 0 },
      { sessionId: "s9", uuid: "s9-x1", model: "claude-opus-5", increment: 10 * K, remainingRequestsInCycle: 2, carryCost: 0 },
    );
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");
    // Paired positive: terminate the trailing run and it is a valid eleventh
    // slice — which needs an eleventh cycle to zip against.
    carry.turns.push(
      { sessionId: "s9", uuid: "s9-x2", model: "claude-opus-5", increment: 10 * K, remainingRequestsInCycle: 1, carryCost: 0 },
    );
    carry.cycles.push({ sessionId: "s9", requests: 3, open: false });
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("recommended");
  });

  it("rejects more slices than cycles without reaching for a cycle that is not there", () => {
    // `cycles[j]` would be `undefined` for the extra slice. The check must
    // return a verdict, not throw.
    const carry = rampCarry();
    carry.cycles.pop();
    expect(() => computeAutoCompactFit(carry)).not.toThrow();
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");

    // And the mirror case: more cycles than slices, which zips cleanly for the
    // slices that exist and would silently ignore the surplus.
    const extra = rampCarry();
    extra.cycles.push({ sessionId: "s10", requests: 0, open: false });
    expect(computeAutoCompactFit(extra).recommendation.reasonCode).toBe("partition-invalid");
  });

  it("rejects a slice whose session id disagrees with its cycle", () => {
    const carry = rampCarry();
    carry.cycles[3]!.sessionId = "s99";
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("partition-invalid");
    // Paired positive: agreeing ids partition.
    carry.cycles[3]!.sessionId = "s3";
    expect(computeAutoCompactFit(carry).recommendation.reasonCode).toBe("recommended");
  });

  it("accepts what `computeContextCarry` itself produces", () => {
    // The invariant is `computeContextCarry`'s, not this module's — so the
    // reconstruction is exercised against the real producer, not only against
    // hand-built inputs.
    const carry = computeContextCarry(realRows());
    expect(carry.sawtooth).not.toBeNull();
    expect(carry.turns.length).toBeGreaterThanOrEqual(50);
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.reasonCode).not.toBe("partition-invalid");
    expect(result.recommendation.reasonCode).not.toBe("non-finite-input");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.closedCycleCarriedTokens).toBeGreaterThan(0);
  });
});

/** Rows that produce three resets and more than fifty turns through the real
 *  `computeContextCarry` path: contexts ramp from 40K past the 150K reset floor
 *  to 400K, then drop to 20K. */
function realRows(): HygieneMessageRow[] {
  const rows: HygieneMessageRow[] = [];
  const minute = 60_000;
  const t0 = 1_767_571_200_000;
  let i = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let step = 0; step < 15; step++) {
      const context = 20 * K + step * 30 * K;
      rows.push({
        sessionId: "s0",
        uuid: `s0-m${i}`,
        projectPath: "/w/alpha",
        timestamp: t0 + i * minute,
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 100,
        cacheReadTokens: context,
        cacheCreationTokens: 0,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        toolErrorCount: 0,
        tools: [],
      });
      i++;
    }
  }
  return rows;
}

describe("computeAutoCompactFit — the verdict ladder (§3.4)", () => {
  it("insufficient-data when there is no sawtooth", () => {
    const carry = buildCarry(repeat(RAMP, 10));
    carry.sawtooth = null;
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation).toMatchObject({
      verdict: "insufficient-data",
      reasonCode: "no-sawtooth",
      recommendedTokens: null,
      range: null,
    });
    expect(result.observedFloorTokens).toBeNull();
    expect(result.candidates).toEqual([]);
    // Paired positive: with a sawtooth the same window is measured.
    expect(computeAutoCompactFit(rampCarry()).observedFloorTokens).toBe(10_000);
  });

  it("insufficient-data below fifty turns — and reports the floor and peak it does know", () => {
    const nine = computeAutoCompactFit(buildCarry(repeat(RAMP, 9)));
    expect(nine.recommendation.verdict).toBe("insufficient-data");
    expect(nine.recommendation.reasonCode).toBe("too-few-rows");
    expect(nine.recommendation.reasonFacts).toEqual({ turns: 45, minTurns: 50 });
    expect(nine.observedFloorTokens).toBe(10_000);
    expect(nine.observedPeakTokens).toBe(390_000);
    // Paired positive: the tenth cycle takes it to exactly fifty and it computes.
    expect(computeAutoCompactFit(rampCarry()).recommendation.verdict).toBe("recommend-window");
  });

  it("insufficient-data with a populated candidate table when nothing is priced", () => {
    const unpriced = computeAutoCompactFit(buildCarry(repeat(RAMP, 10, { model: null })));
    expect(unpriced.recommendation.verdict).toBe("insufficient-data");
    expect(unpriced.recommendation.reasonCode).toBe("nothing-priced");
    // The token half is real and IS reported; only the dollar half degrades —
    // to `null`, never `0` (D6).
    expect(unpriced.candidates).toHaveLength(5);
    expect(unpriced.candidates.every((c) => c.netSaving === null)).toBe(true);
    expect(candidateAt(unpriced, 100 * K).savedTokens).toBe(9_200_000);
    expect(unpriced.modelMix).toEqual({ uniform: true, models: [], unknownModels: 1 });
    // Paired positive: the priced twin reports dollars.
    expect(candidateAt(computeAutoCompactFit(rampCarry()), 100 * K).netSaving).toBeCloseTo(2.6, 10);
  });

  it("insufficient-data when only an OPEN cycle is priced — the closed ones carry no rate", () => {
    // `totalCarryCost` is non-null (the open cycle priced), but every cycle this
    // module simulates is unpriced, so no dollar figure may be produced.
    const carry = buildCarry([
      ...repeat(RAMP, 10, { model: null }),
      { increments: RAMP, open: true, model: "claude-opus-5" },
    ]);
    expect(carry.totalCarryCost).not.toBeNull();
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("nothing-priced");
    expect(result.candidates.every((c) => c.netSaving === null)).toBe(true);
    // Paired positive: price the closed cycles and a saving appears.
    const priced = computeAutoCompactFit(
      buildCarry([...repeat(RAMP, 10), { increments: RAMP, open: true, model: "claude-opus-5" }]),
    );
    expect(candidateAt(priced, 100 * K).netSaving).toBeCloseTo(2.6, 10);
  });

  it("already-tuned when the max peak sits within 15% of a surviving candidate", () => {
    // Max peak 390K; 350K is 10.3% below it.
    const result = computeAutoCompactFit(rampCarry(), { candidatesTokens: [350 * K] });
    expect(result.recommendation.verdict).toBe("already-tuned");
    expect(result.recommendation.reasonCode).toBe("peak-at-candidate");
    expect(result.recommendation.recommendedTokens).toBeNull();
    expect(result.recommendation.range).toBeNull();
    expect(result.recommendation.reasonFacts["nearestWindowTokens"]).toBe(350_000);
    // Paired positive: 300K is 23% below the peak and IS recommended against.
    const further = computeAutoCompactFit(rampCarry(), { candidatesTokens: [300 * K] });
    expect(further.recommendation.verdict).toBe("recommend-window");
    expect(further.recommendation.recommendedTokens).toBe(300_000);
  });

  it("already-tuned when every candidate was dropped for sitting at or above the peak", () => {
    // Reachable only via caller-supplied candidates (or a caller-supplied reset
    // floor): under defaults `beforeTokens > 150K` always, so the max peak
    // always exceeds the 100K bottom of the grid.
    const low = buildCarry(repeat(RAMP, 10, { beforeTokens: 90 * K }));
    const result = computeAutoCompactFit(low, { candidatesTokens: [100 * K] });
    expect(result.recommendation.verdict).toBe("already-tuned");
    expect(result.recommendation.reasonCode).toBe("peaks-below-smallest-window");
    expect(result.droppedCandidates).toEqual([{ windowTokens: 100 * K, reason: "at-or-above-peak" }]);
    // Paired positive: a mixed drop set is NOT already-tuned — a below-floor
    // drop means the grid emptied for a reason this rung cannot speak to.
    const mixed = computeAutoCompactFit(low, { candidatesTokens: [12 * K, 100 * K] });
    expect(mixed.recommendation.reasonCode).toBe("grid-empty-below-floor");
  });

  it("too-close-to-call when the best saving is under 5% of the carry cost", () => {
    // Best netSaving on the reference fixture is $3.00. Against a $1,000 carry
    // cost the 5% margin is $50 and nothing clears it.
    const result = computeAutoCompactFit(rampCarry({ totalCarryCost: 1_000 }));
    expect(result.recommendation.verdict).toBe("too-close-to-call");
    expect(result.recommendation.reasonCode).toBe("saving-under-margin");
    expect(result.recommendation.recommendedTokens).toBeNull();
    expect(result.recommendation.range).toBeNull();
    expect(result.recommendation.reasonFacts["totalCarryCost"]).toBe(1_000);
    // Paired positive: against the fixture's own $7.25 carry cost, $3.00 clears
    // the $0.36 margin.
    const real = computeAutoCompactFit(rampCarry());
    expect(real.recommendation.verdict).toBe("recommend-window");
  });

  it("recommend-window names the conservative end and the range it came from", () => {
    const result = computeAutoCompactFit(rampCarry());
    expect(result.recommendation.verdict).toBe("recommend-window");
    // netSaving: 2.60 / 3.00 / 2.70 / 2.50 / 2.10 — threshold 1.30, so every
    // candidate qualifies and the conservative end is the largest.
    expect(result.recommendation.recommendedTokens).toBe(300_000);
    expect(result.recommendation.range).toEqual([300_000, 100_000]);
    expect(result.recommendation.reasonFacts["aggressiveTokens"]).toBe(100_000);
    expect(Object.values(result.recommendation.reasonFacts).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("computeAutoCompactFit — C10, the range gate", () => {
  it("computes no range when the aggressive end saves nothing", () => {
    // Peaks are recorded at 600K while the increments telescope to 500K, so a
    // 500K window never cuts: savedTokens 0, extraResets 0, netSaving exactly 0.
    // A zero threshold would make every candidate qualify and recommend the top
    // of the grid.
    const flat = buildCarry(repeat([100 * K, 100 * K, 100 * K, 100 * K, 100 * K], 10, { beforeTokens: 600 * K }));
    const result = computeAutoCompactFit(flat, { candidatesTokens: [500 * K] });
    expect(candidateAt(result, 500 * K).savedTokens).toBe(0);
    expect(candidateAt(result, 500 * K).extraResets).toBe(0);
    expect(candidateAt(result, 500 * K).netSaving).toBe(0);
    expect(result.recommendation.verdict).toBe("too-close-to-call");
    expect(result.recommendation.recommendedTokens).toBeNull();
    expect(result.recommendation.range).toBeNull();
    // Paired positive: a 300K window on the same fixture does cut, and is
    // recommended.
    const cutting = computeAutoCompactFit(flat, { candidatesTokens: [300 * K] });
    expect(cutting.candidates[0]!.savedTokens).toBeGreaterThan(0);
    expect(cutting.recommendation.verdict).toBe("recommend-window");
  });

  it("computes no range when a zero saving meets a non-positive carry cost", () => {
    // With `totalCarryCost <= 0` the 5% margin is itself non-positive, so the
    // margin comparison alone would let a zero saving through to a range built
    // from a zero threshold — i.e. a recommendation of the top of the grid.
    const flat = buildCarry(repeat([100 * K, 100 * K, 100 * K, 100 * K, 100 * K], 10, { beforeTokens: 600 * K }), {
      totalCarryCost: -5,
    });
    const result = computeAutoCompactFit(flat, { candidatesTokens: [500 * K] });
    expect(candidateAt(result, 500 * K).netSaving).toBe(0);
    expect(result.recommendation.verdict).toBe("too-close-to-call");
    expect(result.recommendation.recommendedTokens).toBeNull();
    // Paired positive: the same non-positive carry cost with a real saving still
    // does not recommend — the gate is on the saving, not on the sign of the
    // denominator alone.
    const cutting = computeAutoCompactFit(
      buildCarry(repeat([100 * K, 100 * K, 100 * K, 100 * K, 100 * K], 10, { beforeTokens: 600 * K }), {
        totalCarryCost: 40,
      }),
      { candidatesTokens: [300 * K] },
    );
    expect(cutting.recommendation.verdict).toBe("recommend-window");
  });

  it("computes no range when every netSaving is negative", () => {
    // A $100 reset cost makes every candidate a loss.
    const result = computeAutoCompactFit(rampCarry({ resetCost: 100, totalCarryCost: 7.25 }));
    expect(result.candidates.every((c) => (c.netSaving ?? 0) < 0)).toBe(true);
    expect(result.recommendation.verdict).toBe("too-close-to-call");
    expect(result.recommendation.range).toBeNull();
    expect(result.recommendation.recommendedTokens).toBeNull();
    // Paired positive: a cheap reset on the same trajectory recommends.
    expect(computeAutoCompactFit(rampCarry()).recommendation.range).toEqual([300_000, 100_000]);
  });

  it("scans ALL candidates for the conservative end — netSaving is not monotone", () => {
    // Three cycles of ten 100K increments (peak 1M) and ten near-flat cycles of
    // [190K, 5K × 9] (peak 235K), over a 110K floor with a $0.20 reset. The
    // qualifying set is NOT a contiguous prefix: 250K falls below half the
    // aggressive end's saving while every larger candidate clears it.
    const carry = buildCarry(
      [
        ...repeat(Array.from({ length: 10 }, () => 100 * K), 3),
        ...repeat([190 * K, ...Array.from({ length: 9 }, () => 5 * K)], 10),
      ],
      { floorTokens: 110 * K, resetCost: 0.2 },
    );
    const result = computeAutoCompactFit(carry);
    expect(windowsOf(result)).toEqual([200 * K, 250 * K, 300 * K, 400 * K, 500 * K, 750 * K]);

    const aggressive = result.candidates[0]!.netSaving!;
    const threshold = 0.5 * aggressive;
    const qualifies = result.candidates.map((c) => c.netSaving !== null && c.netSaving >= threshold);
    // The gap is the point of the fixture: assert it explicitly, so a fixture
    // that degenerates into a monotone one fails here rather than silently
    // turning this into a duplicate of the ramp test.
    expect(qualifies).toEqual([true, false, true, true, true, true]);

    // A prefix scan would stop at the gap and recommend 200K.
    expect(result.recommendation.recommendedTokens).toBe(750_000);
    expect(result.recommendation.range).toEqual([750_000, 200_000]);
  });
});

describe("computeAutoCompactFit — pricing", () => {
  it("excludes unpriced resets from the mean reset cost", () => {
    // Five resets at $0.40 and five at $0 (`messageCost` returns 0 for an
    // unpriced model). The mean over the PRICED five is $0.40; averaging all ten
    // would give $0.20 and quietly double the reported saving at every candidate
    // that cuts.
    const specs = repeat(RAMP, 10).map((spec, i) => ({ ...spec, resetCost: i < 5 ? 0.4 : 0 }));
    const result = computeAutoCompactFit(buildCarry(specs, { totalCarryCost: 7.25 }));
    // savedTokens 9.2M × $0.50/MTok = $4.60; 40 cuts × $0.40 = $16.00.
    expect(candidateAt(result, 100 * K).netSaving).toBeCloseTo(4.6 - 16.0, 10);
    // Paired positive: with every reset priced at $0.40 the arithmetic is the
    // same, which is what "excluded, not counted as zero" means.
    const allPriced = computeAutoCompactFit(rampCarry({ resetCost: 0.4, totalCarryCost: 7.25 }));
    expect(candidateAt(allPriced, 100 * K).netSaving).toBeCloseTo(4.6 - 16.0, 10);
  });

  it("prices per model, and honours rateOverrides", () => {
    const overrides: RateOverrides = {
      first_party: {
        "claude-opus-5": {
          inputPerMillion: 10,
          outputPerMillion: 50,
          cacheWritePerMillion: 12.5,
          cacheReadPerMillion: 5,
          cacheWrite1hPerMillion: 20,
          ttlRateBasis: "parsed",
        },
      },
    };
    const base = computeAutoCompactFit(rampCarry());
    const overridden = computeAutoCompactFit(rampCarry(), { rateOverrides: overrides });
    // Ten times the cache-read rate: 9.2M × $5/MTok = $46.00, less 40 × $0.05.
    expect(candidateAt(overridden, 100 * K).netSaving).toBeCloseTo(46.0 - 2.0, 10);
    expect(candidateAt(base, 100 * K).netSaving).toBeCloseTo(4.6 - 2.0, 10);
    // Token figures are rate-independent.
    expect(candidateAt(overridden, 100 * K).savedTokens).toBe(candidateAt(base, 100 * K).savedTokens);
  });

  it("counts a mixed window's unpriced turns without naming them", () => {
    // A raw transcript model id can be a Bedrock ARN (account id + region), a
    // gateway alias named after whoever provisioned it, or a self-hosted alias
    // encoding an internal hostname. None of them may leave this module.
    const carry = buildCarry([
      ...repeat(RAMP, 5),
      ...repeat(RAMP, 3, { model: "us.anthropic.claude-opus-5-v1:0" }),
      // The 12-digit account id is AWS's own documentation placeholder; the
      // alias segment stands in for a provisioning team's name.
      ...repeat(RAMP, 2, { model: "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/team-alias" }),
    ]);
    const result = computeAutoCompactFit(carry);
    expect(result.modelMix.models).toEqual(["claude-opus-5"]);
    expect(result.modelMix.unknownModels).toBe(1);
    expect(result.modelMix.uniform).toBe(false);

    // A VALUE test, not a key-name test: a key-name assertion cannot see an id
    // hidden inside a string or inside `reasonFacts`.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("arn:");
    expect(serialised).not.toContain("team-alias");
    expect(serialised).not.toContain("123456789012");
    expect(serialised).not.toContain("eu-north-1");
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    // Paired positive (CR-18): the negative half above passes on an empty
    // payload, so assert the payload is really there.
    expect(serialised).toContain("claude-opus-5");
    expect(serialised).toContain("\"windowTokens\":100000");
  });

  it("reports a uniform mix as uniform", () => {
    const result = computeAutoCompactFit(rampCarry());
    expect(result.modelMix).toEqual({ uniform: true, models: ["claude-opus-5"], unknownModels: 0 });
  });
});

describe("computeAutoCompactFit — disclosure and purity", () => {
  it("carries the reset-floor divergence (D13) and defaults it to the detector's own floor", () => {
    expect(computeAutoCompactFit(rampCarry()).resetFloorUsed).toBe(150_000);
    expect(computeAutoCompactFit(rampCarry()).resetFloorDefault).toBe(150_000);
    const adaptive = computeAutoCompactFit(rampCarry(), { resetFloorUsed: 40_000 });
    expect(adaptive.resetFloorUsed).toBe(40_000);
    expect(adaptive.resetFloorDefault).toBe(150_000);
    // A non-finite or non-positive floor falls back rather than being reported.
    expect(computeAutoCompactFit(rampCarry(), { resetFloorUsed: Number.NaN }).resetFloorUsed).toBe(150_000);
    expect(computeAutoCompactFit(rampCarry(), { resetFloorUsed: 0 }).resetFloorUsed).toBe(150_000);
  });

  it("attaches the saving caveat to every result, degraded ones included", () => {
    const ok = computeAutoCompactFit(rampCarry());
    const degraded = computeAutoCompactFit(buildCarry(repeat(RAMP, 2)));
    expect(ok.savingCaveat).toContain("Upper bound");
    expect(ok.savingCaveat).toContain("rework");
    // C8: the margin's denominator is itself a lower bound, and the caveat says
    // which way that biases the verdict.
    expect(ok.savingCaveat).toContain("biased toward recommending");
    expect(degraded.savingCaveat).toBe(ok.savingCaveat);
    expect(degraded.settableRange).toEqual(ok.settableRange);
  });

  it("is deterministic: same input, same output", () => {
    const carry = rampCarry();
    expect(computeAutoCompactFit(carry)).toEqual(computeAutoCompactFit(carry));
    expect(computeAutoCompactFit(rampCarry())).toEqual(computeAutoCompactFit(rampCarry()));
    // And it does not mutate its input.
    const before = JSON.stringify(carry);
    computeAutoCompactFit(carry);
    expect(JSON.stringify(carry)).toBe(before);
  });
});
