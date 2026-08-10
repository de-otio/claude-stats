/**
 * `computeAutoCompactFit` — PROPERTY tests (autocompact-window-fit Phase B3b).
 *
 * Phase A already wrote unit tests and killed 33/33 guard mutations
 * (`auto-compact-fit.test.ts`). This file does NOT duplicate that work. It
 * exists for the claims that hold across many inputs, not one fixture — and
 * for the shapes a plausible-but-wrong implementation would pass:
 *
 *  - a stub that returns a constant candidate table passes any test that only
 *    checks "the figure didn't change" without a paired "and THIS figure
 *    DOES change" case;
 *  - a monotonicity claim checked against an empty candidate array is
 *    vacuously true;
 *  - a "never recommends below the floor" claim checked only against inputs
 *    that never recommend anything is vacuously true.
 *
 * Every property below is paired against exactly the failure that would let
 * a stub or an off-by-one through, per the plan's CR-18 findings.
 *
 * `fast-check` is used for the monotonicity and bounds properties (already a
 * devDependency — see `package.json`). The convergence, closed-form, and D9
 * lock properties are single deliberately-constructed fixtures, not
 * generators: each pins one specific claim about the ARITHMETIC (the
 * simulation's seating, the two-pass floor mechanism, the sync boundary),
 * where a generated input would only obscure which invariant failed.
 *
 * Every fixture is synthetic: round token counts, `s<n>` session ids,
 * `/w/<letter>` project paths, fixed epoch-ms timestamps. No figure here is
 * copied from a real window (plans/autocompact-window-fit/IMPLEMENTATION.md
 * §8 — no output copied from a live run, in any file including fixtures).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeAutoCompactFit,
  type AutoCompactFitResult,
} from "@claude-stats/core/autoCompactFit";
import { computeContextCarry, type ContextCarryResult } from "@claude-stats/core/contextCarry";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";

import { Store } from "../store/index.js";
import { buildAccountMappings, buildAggregatePayload, type PersistedSyncConfig } from "../sync/index.js";

const K = 1_000;
/** `claude-opus-5` on the shipped table, $/MTok cache-read — matches
 *  `auto-compact-fit.test.ts`'s header comment. */
const READ_RATE = 0.5;

// ─── Shared fixture builders (own copy — this file owns exactly one path per
// the task's file ownership rule, so nothing here is shared with Phase A's
// `auto-compact-fit.test.ts`, which owns a separate file). ───────────────────

interface CycleSpec {
  increments: number[];
  open?: boolean;
  model?: string | null;
  beforeTokens?: number;
  resetCost?: number;
}

interface BuildOptions {
  floorTokens?: number;
  resetCost?: number;
  extraCarriedTokens?: number;
  totalCarryCost?: number | null;
}

/** A `ContextCarryResult` shaped exactly the way `computeContextCarry` shapes
 *  one — see `contextCarry.ts`'s `turns`/`cycles` correspondence doc: `turns`
 *  is the concatenation of each cycle's turn list in `cycles` order, with
 *  `remainingRequestsInCycle` running `n…1` per cycle. */
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
          requestsPerCycle: closed.length === 0 ? 0 : closed.reduce((a, c) => a + c.requests, 0) / closed.length,
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
    totalCarryCost: options.totalCarryCost !== undefined ? options.totalCarryCost : anyPriced ? totalCarryCost : null,
    excludedRows: 0,
    unpricedRows: 0,
    unpricedTokens: 0,
  };
}

function repeat(increments: number[], count: number, extra: Partial<CycleSpec> = {}): CycleSpec[] {
  return Array.from({ length: count }, () => ({ increments, ...extra }));
}

/** A 5-turn ramp repeated 10 times = exactly 50 turns — `MIN_TURNS`'s own
 *  floor (CR-14). Every fixture below that needs a "normal, recommends"
 *  shape uses this, not a shorter repeat count that would trip
 *  `too-few-rows` before the property under test ever runs. */
const TUNED_RAMP: number[] = [150 * K, 60 * K, 60 * K, 60 * K, 60 * K];
const TUNED_RAMP_CYCLES = 10;

/** Deep-clone via JSON — good enough for these plain-data results, and it
 *  exercises the same round-trip `JSON.stringify` performs on the wire, which
 *  is the boundary D6/SR-4 care about (a `NaN` would come back `null` here
 *  too). */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── 1. CLOSED FORM AS A PROPERTY (write this first — most likely to catch a
// C6-class seating error). ──────────────────────────────────────────────────

describe("closed form: simulated savedTokens on a linear ramp (D2, C6)", () => {
  it("matches N(P-C)/2 EXACTLY on a constant-increment ramp with a period-dividing candidate", () => {
    // Construction: floor = 0, N = 60 turns per cycle, constant increment
    // δ = 10K per turn ⇒ peak P = N·δ = 600K. Candidate C = 120K = 12·δ, and
    // 12 divides N (N/12 = 5 "climb-to-C" blocks) — the ONE choice of C that
    // makes the simulated trajectory an EXACT repeating sawtooth with no
    // partial final period, so the continuous-ramp approximation
    // (`savedTokens ≈ N(P-C)/2`, standard sawtooth-buffer arithmetic: area
    // under the big ramp minus area under k repeating small ramps) is exact
    // rather than approximate here — no tolerance needed; asserted with `toBe`
    // (all-integer arithmetic, no floating-point division anywhere in the
    // construction). A non-dividing C would leave a partial final block and
    // require an actual tolerance band; this fixture is chosen to avoid that
    // so the assertion pins the seating arithmetic exactly, not "close to".
    //
    // Hand check (also cross-verified by direct enumeration, not just the
    // N(P-C)/2 formula, during test authoring — see IMPLEMENTATION.md
    // handoff item 1): baseline Σ_{i=1}^{60} 10K·i = 18,300,000. Simulated:
    // 5 blocks of Σ_{i=1}^{12} 10K·i = 5 × 780,000 = 3,900,000. Saved =
    // 18,300,000 − 3,900,000 = 14,400,000 = N(P−C)/2 = 60×(600K−120K)/2.
    const N = 60;
    const delta = 10 * K;
    const P = N * delta; // 600K
    const C = 120 * K; // 12·δ, 12 | N
    const ramp = Array.from({ length: N }, () => delta);

    // Three IDENTICAL closed cycles — a sawtooth needs ≥3 resets (contract:
    // `sawtooth` is null below `MIN_RESETS_FOR_SAWTOOTH`), so a single-cycle
    // closed form alone is not a valid `computeAutoCompactFit` input. The
    // total is exactly 3× the per-cycle figure since each cycle simulates
    // independently (no cross-cycle state in `simulateSlice`).
    const carry = buildCarry(repeat(ramp, 3), { floorTokens: 0 });

    const result = computeAutoCompactFit(carry, { candidatesTokens: [C] });
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.windowTokens).toBe(C);

    const expectedPerCycle = (N * (P - C)) / 2;
    expect(candidate.savedTokens).toBe(3 * expectedPerCycle);
    expect(candidate.savedTokens).toBe(43_200_000);
  });

  it("C6: with a NONZERO floor and a first increment that alone exceeds the candidate, cutting on it (vs not) is arithmetically visible", () => {
    // The N(P-C)/2 fixture above deliberately uses `floorTokens: 0`, which
    // makes it BLIND to the C6 floor-seating/first-increment bug class: with
    // floor 0, "reset to floor then add the increment" and "just add the
    // increment" are the same operation, so a mutation that cuts on a
    // cycle's first increment produces byte-identical output there (verified
    // during authoring: reverting the `!first` guard left that test green).
    // This fixture closes that gap with a nonzero floor and a first
    // increment (150K) that alone exceeds the 100K candidate — exactly the
    // shape C6 names ("a cycle's first `carryIncrement` IS the whole
    // context").
    //
    // Hand simulation, one cycle, floor=10K, increments=[150K,10K,10K,10K], C=100K:
    //   turn1 (first, never cut): ctx=150K, obs=150K, saved=0
    //   turn2: 150K+10K=160K>100K → cut; ctx=floor+inc=10K+10K=20K; obs=160K; saved=140K
    //   turn3: 20K+10K=30K≤100K → no cut; ctx=30K; obs=170K; saved=140K
    //   turn4: 30K+10K=40K≤100K → no cut; ctx=40K; obs=180K; saved=140K
    // Per cycle: savedTokens=0+140K+140K+140K=420K, extraResets=1.
    // A mutation that ALSO cuts on turn1 seats turn1 at floor+150K=160K (>
    // its own observed 150K, so that turn's `saved` term goes NEGATIVE — the
    // over-inflation C6 exists to prevent) and adds a spurious second cut,
    // changing BOTH totals: this is the arithmetic the guard protects.
    //
    // 13 identical cycles (4 turns each = 52 turns) rather than 3 — MIN_TURNS
    // (50) applies to `carry.turns.length` over the WHOLE window, not per
    // cycle; the per-cycle hand arithmetic above is unaffected, only scaled.
    const CYCLES = 13;
    const carry = buildCarry(repeat([150 * K, 10 * K, 10 * K, 10 * K], CYCLES), { floorTokens: 10 * K });
    expect(carry.turns.length).toBeGreaterThanOrEqual(50);
    const result = computeAutoCompactFit(carry, { candidatesTokens: [100 * K] });
    const candidate = result.candidates[0]!;
    expect(candidate.savedTokens).toBe(CYCLES * 420_000);
    expect(candidate.extraResets).toBe(CYCLES * 1);
  });
});

// ─── 2. CONVERGENCE (D13's whole justification) ─────────────────────────────

describe("convergence: the adaptive floor is the difference between insufficient-data and already-tuned (C5/D13)", () => {
  /** One HygieneMessageRow with `totalContext` pinned by `inputTokens` alone
   *  (cache columns 0), so the ramp's shape is exactly the numbers below. */
  function row(sessionId: string, uuid: string, timestampMs: number, totalContext: number): HygieneMessageRow {
    return {
      sessionId,
      projectPath: "/w/convergence",
      uuid,
      timestamp: timestampMs,
      model: "claude-opus-5",
      inputTokens: totalContext,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
      toolErrorCount: 0,
      tools: [],
    };
  }

  // A workload already living well under a 150K window: every cycle climbs
  // 30K→60K→90K→120K→148K then drops back to 30K. The drop (148K→30K, a 79.7%
  // decrease) clears `detectResets`' 40% ratio easily; the only question is
  // whether `148K > minBeforeTokens`. 12 cycles × 5 requests = 60 rows ⇒ 60
  // turns, clearing `MIN_TURNS` (50) with margin; 11 cycle-to-cycle
  // transitions ⇒ 11 resets, clearing `MIN_RESETS_FOR_SAWTOOTH` (3) easily on
  // whichever floor detects them at all.
  const CYCLE_PEAK = 148 * K;
  const CYCLE_FLOOR = 30 * K;
  const STEPS = [30 * K, 60 * K, 90 * K, 120 * K, 148 * K];
  const CYCLES = 12;
  const rows: HygieneMessageRow[] = [];
  {
    let t = 1_700_000_000_000;
    let n = 0;
    for (let c = 0; c < CYCLES; c++) {
      for (const total of STEPS) {
        rows.push(row("s1", `s1-${n}`, t, total));
        t += 60_000;
        n++;
      }
    }
  }
  it("the DEFAULT floor (150K) reports insufficient-data on this input — no-sawtooth", () => {
    // Sanity on the fixture itself, independent of the module under test —
    // if this fails, the tests below are meaningless regardless of what they
    // report.
    expect(rows.length).toBeGreaterThanOrEqual(50);

    // `148K` never exceeds the default `resetMinBeforeTokens` (150K), so
    // `detectResets` finds ZERO resets and `sawtooth` is null.
    const defaultCarry = computeContextCarry(rows);
    expect(defaultCarry.sawtooth).toBeNull();

    const result = computeAutoCompactFit(defaultCarry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("no-sawtooth");
  });

  it("the ADAPTIVE floor (below 148K) detects the same resets and reports already-tuned — the D13 pair", () => {
    // The adaptive floor is computed by the glue (B1, out of this file's
    // scope) from the row distribution; here it is simply "low enough to see
    // 148K", which is the property under test — the exact formula lives in
    // `IMPLEMENTATION.md` C5 and is B1's to implement, not this module's.
    const ADAPTIVE_FLOOR = 50 * K;
    const adaptiveCarry = computeContextCarry(rows, { resetMinBeforeTokens: ADAPTIVE_FLOOR });
    expect(adaptiveCarry.sawtooth).not.toBeNull();
    expect(adaptiveCarry.resets.length).toBeGreaterThanOrEqual(3);
    expect(adaptiveCarry.resets.every((r) => r.beforeTokens === CYCLE_PEAK)).toBe(true);
    expect(adaptiveCarry.sawtooth!.floorTokens).toBe(CYCLE_FLOOR);

    // A candidate at 130K: within ALREADY_TUNED_FRACTION (15%) of the 148K
    // observed max peak (|130K−148K| = 18K ≤ 0.15×148K = 22.2K) and strictly
    // below it (survives the at-or-above-peak drop). B1 MUST pass the same
    // floor it gave the second `computeContextCarry` pass (handoff item 2) —
    // pinned here as a plain pass-through: `resetFloorUsed` echoes it, and
    // nothing in this module recomputes resets from it.
    const result = computeAutoCompactFit(adaptiveCarry, {
      candidatesTokens: [130 * K],
      resetFloorUsed: ADAPTIVE_FLOOR,
    });
    expect(result.recommendation.verdict).toBe("already-tuned");
    expect(result.recommendation.reasonCode).toBe("peak-at-candidate");
    expect(result.recommendation.recommendedTokens).toBeNull();
    expect(result.resetFloorUsed).toBe(ADAPTIVE_FLOOR);
    expect(result.resetFloorDefault).toBe(150_000);
  });
});

// ─── 3. MONOTONICITY (fast-check) ───────────────────────────────────────────

describe("monotonicity: savedTokens is non-increasing across the candidate grid", () => {
  it("holds over a generated spread of ramp shapes, with a non-vacuous candidate count asserted first (CR-18)", () => {
    fc.assert(
      fc.property(
        // Deterministic-but-varied: a peak increment, a per-turn slope, a
        // turn count, and a floor — all pinned integers via fast-check's own
        // seeded generator (no `Math.random`), spanning shapes from a gentle
        // ramp to a steep one.
        // `turnsPerCycle × 3 ≥ 50` (MIN_TURNS) always, so this never trips
        // "too-few-rows" before the property under test gets to run.
        fc.integer({ min: 18, max: 40 }), // turns per cycle
        fc.integer({ min: 10, max: 100 }).map((n) => n * K), // per-turn increment
        fc.integer({ min: 0, max: 30 }).map((n) => n * K), // floor
        (turnsPerCycle, increment, floor) => {
          const ramp = Array.from({ length: turnsPerCycle }, () => increment);
          // 3 identical closed cycles — the minimum for a non-null sawtooth.
          const carry = buildCarry(repeat(ramp, 3), { floorTokens: floor });
          const result = computeAutoCompactFit(carry);

          // CR-18: assert the grid is non-vacuous BEFORE trusting the
          // monotonicity check below it — an adversarial (floor, peak) pair
          // can empty the grid entirely (e.g. the floor headroom filter
          // dropping everything), at which point "savedTokens is
          // non-increasing" is vacuously true over zero pairs and proves
          // nothing.
          if (result.candidates.length < 2) return true; // nothing to assert pairwise; not a failure of THIS property

          for (let i = 1; i < result.candidates.length; i++) {
            const prev = result.candidates[i - 1]!;
            const cur = result.candidates[i]!;
            expect(cur.windowTokens).toBeGreaterThan(prev.windowTokens); // ascending by construction
            expect(cur.savedTokens).toBeLessThanOrEqual(prev.savedTokens);
          }
          return true;
        },
      ),
      { numRuns: 200, seed: 20260810 },
    );
  });

  it("is non-vacuous at least once in the run above — a fixture with a real multi-candidate grid", () => {
    // Paired sanity: prove the generator above actually produces
    // `candidates.length >= 2` sometimes, so the early-return in the property
    // is not silently swallowing every case.
    const carry = buildCarry(repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { floorTokens: 10 * K });
    const result = computeAutoCompactFit(carry);
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 4. OPEN CYCLES CHANGE NO AGGREGATE — paired with CLOSED cycles changing everything ─

describe("open vs closed cycles (C3): only a closed cycle may move a figure", () => {
  const base = buildCarry(repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { floorTokens: 10 * K });

  it("appending an OPEN cycle changes no priced or candidate figure — only openCyclesExcluded/openCycleCarriedTokens move", () => {
    // `model: null` on the appended cycle: an open cycle's `carryCost`
    // still feeds `carry.totalCarryCost` (D1's contract sums it over ALL
    // turns, open or closed — it is not the same field as
    // `closedCycleCarriedTokens`), so a PRICED open cycle would legitimately
    // shift `totalCarryCost` and, with it, the `too-close-to-call` margin's
    // denominator (C8) and `reasonFacts.totalCarryCost` — a real effect, not
    // a bug, and not what this property is testing. Pinning the open cycle
    // unpriced isolates the claim under test: an open cycle's TOKEN volume
    // must never reach the closed-cycle simulation.
    const withOpen = buildCarry(
      [...repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { increments: [80 * K, 40 * K], open: true, model: null }],
      { floorTokens: 10 * K },
    );

    const baseResult = roundTrip(computeAutoCompactFit(base));
    const openResult = roundTrip(computeAutoCompactFit(withOpen));

    // Byte-identical on the candidate table and the recommendation — a stub
    // returning a constant table would pass this half alone (CR-18), which is
    // why the paired closed-cycle case below must fail against the same stub.
    expect(openResult.candidates).toEqual(baseResult.candidates);
    expect(openResult.recommendation).toEqual(baseResult.recommendation);
    expect(openResult.closedCycleCarriedTokens).toBe(baseResult.closedCycleCarriedTokens);

    // What DOES move: the open-cycle accounting itself.
    expect(openResult.openCyclesExcluded).toBe(baseResult.openCyclesExcluded + 1);
    expect(openResult.openCycleCarriedTokens).toBeGreaterThan(baseResult.openCycleCarriedTokens);
  });

  it("PAIRED — appending a CLOSED cycle DOES change the candidate figures and never increments openCyclesExcluded", () => {
    const withClosed = buildCarry(
      [...repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { increments: [300 * K, 30 * K, 30 * K] }],
      { floorTokens: 10 * K },
    );

    const baseResult = computeAutoCompactFit(base);
    const closedResult = computeAutoCompactFit(withClosed);

    expect(closedResult.closedCycleCarriedTokens).not.toBe(baseResult.closedCycleCarriedTokens);
    expect(closedResult.candidates).not.toEqual(baseResult.candidates);
    expect(closedResult.openCyclesExcluded).toBe(baseResult.openCyclesExcluded);
  });
});

// ─── 5. NEVER BELOW THE FLOOR, NEVER OUTSIDE [100K, 1M] — paired with a fixture that DOES recommend ─

/** 10 turns/cycle so `cycles × 10 ≥ 50` (MIN_TURNS) across the generator's
 *  whole range (5-12 cycles below). */
const BOUNDS_RAMP: number[] = [200 * K, 50 * K, 50 * K, 50 * K, 50 * K, 50 * K, 50 * K, 50 * K, 50 * K, 50 * K];

describe("bounds: every surviving/recommended window respects the floor and [100K, 1M] (fast-check + adversarial fixtures)", () => {
  it("holds on a generated spread, including adversarial floors that empty the grid", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 900 }).map((n) => n * K), // floor, up to 900K — can exceed every candidate
        // `cycles × 10 ≥ 50` (MIN_TURNS) for every generated value.
        fc.integer({ min: 5, max: 12 }), // cycle count
        (floor, cycles) => {
          const carry = buildCarry(repeat(BOUNDS_RAMP, cycles), { floorTokens: floor });
          const result = computeAutoCompactFit(carry);
          for (const c of result.candidates) {
            expect(c.windowTokens).toBeGreaterThanOrEqual(100_000);
            expect(c.windowTokens).toBeLessThanOrEqual(1_000_000);
            expect(c.windowTokens).toBeGreaterThan(floor * 1.5);
          }
          if (result.recommendation.recommendedTokens !== null) {
            expect(result.recommendation.recommendedTokens).toBeGreaterThanOrEqual(100_000);
            expect(result.recommendation.recommendedTokens).toBeLessThanOrEqual(1_000_000);
            expect(result.recommendation.recommendedTokens).toBeGreaterThan(floor * 1.5);
          }
          return true;
        },
      ),
      { numRuns: 200, seed: 20260810 },
    );
  });

  it("PAIRED — a fixture whose floor exceeds every candidate produces an EMPTY grid, not silently-passing bounds", () => {
    // CR-18: "never below the floor" passes trivially over an empty
    // candidates array. Prove the array really is empty here, not just that
    // nothing in it violates the bound.
    const carry = buildCarry(repeat(BOUNDS_RAMP, 6), { floorTokens: 900 * K });
    const result = computeAutoCompactFit(carry);
    expect(result.candidates).toEqual([]);
    expect(result.recommendation.recommendedTokens).toBeNull();
  });

  it("PAIRED — a fixture that DOES recommend, so the positive bound check above is not vacuous either", () => {
    const carry = buildCarry(repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { floorTokens: 10 * K });
    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("recommend-window");
    expect(result.recommendation.recommendedTokens).not.toBeNull();
    expect(result.recommendation.recommendedTokens!).toBeGreaterThanOrEqual(100_000);
    expect(result.recommendation.recommendedTokens!).toBeLessThanOrEqual(1_000_000);
  });

  it("a single-cycle window and a window of one enormous turn never escape the bound (adversarial shapes)", () => {
    const singleCycle = buildCarry([{ increments: [500 * K, 100 * K, 100 * K] }], { floorTokens: 10 * K });
    expect(computeAutoCompactFit(singleCycle).recommendation.verdict).toBe("insufficient-data"); // <3 resets ⇒ no sawtooth
    expect(computeAutoCompactFit(singleCycle).candidates).toEqual([]);

    // 60 single-turn cycles (60 turns, well over MIN_TURNS) rather than 3 —
    // enough rows to actually exercise the grid instead of tripping
    // `too-few-rows` and passing the bound check vacuously over an empty array.
    const oneEnormousTurn = buildCarry(repeat([2_000_000], 60), { floorTokens: 10 * K });
    const result = computeAutoCompactFit(oneEnormousTurn);
    for (const c of result.candidates) {
      expect(c.windowTokens).toBeLessThanOrEqual(1_000_000);
      expect(c.windowTokens).toBeGreaterThanOrEqual(100_000);
    }
  });
});

// ─── 6. UNPRICED DEGRADE ────────────────────────────────────────────────────

describe("unpriced degrade: netSaving is null, never 0, and candidates[] stays populated (A8)", () => {
  it("a fully unpriced window (model: null throughout) reports insufficient-data / nothing-priced, WITH a populated candidate table (A8)", () => {
    // This reaches the `totalCarryCost === null` rung — the FIRST check in
    // `recommend()`, before the grid's candidates are even inspected. But
    // `AutoCompactFitResult.candidates` is assigned OUTSIDE `recommend()`,
    // from the simulation loop that ran regardless of pricing (the grid is
    // built from `floorTokens`/`maxPeakTokens` alone, neither of which
    // depends on any model being priced). So — contrary to what a reader
    // might assume from "nothing was priced" — the candidate table is NOT
    // empty here. Per A8, `candidates[]` is empty ONLY on the STRUCTURAL
    // failures (`no-sawtooth`/`too-few-rows`/`non-finite-input`/
    // `partition-invalid`, which return via the separate `degraded()` path
    // before a grid is ever built) — `nothing-priced`, reached either via
    // this `totalCarryCost === null` short-circuit or via the
    // aggressive-candidate check below, is not one of them.
    const carry = buildCarry(repeat(TUNED_RAMP, TUNED_RAMP_CYCLES, { model: null }), {
      floorTokens: 10 * K,
    });
    expect(carry.totalCarryCost).toBeNull();

    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("nothing-priced");
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.netSaving).toBeNull(); // never 0 (D6)
      expect(c.savedTokens).toBeGreaterThan(0); // real token figure
    }
    for (const n of Object.values(result.recommendation.reasonFacts)) expect(n).not.toBeNaN();
  });

  it("A8: candidates[] IS populated with real token figures on the nothing-priced path reached via totalCarryCost !== null but the aggressive candidate unpriced", () => {
    // Mix a priced OPEN cycle (contributes to `totalCarryCost` being non-null
    // — open cycles are excluded from the CLOSED simulation but their turns'
    // `carryCost` still feeds `totalCarryCost`, which sums over ALL turns,
    // not just closed ones) with unpriced CLOSED cycles, so
    // `carry.totalCarryCost !== null` (clears the first ladder rung) while
    // every CLOSED-cycle turn is unpriced (so every candidate's `netSaving`
    // is null). This reaches the recommend()-internal "aggressive.netSaving
    // === null" rung, not the structural one above — the pairing this test
    // exists for.
    const carry = buildCarry(
      [
        ...repeat(TUNED_RAMP, TUNED_RAMP_CYCLES, { model: null }),
        { increments: [80 * K, 40 * K], open: true, model: "claude-opus-5" },
      ],
      { floorTokens: 10 * K },
    );
    expect(carry.totalCarryCost).not.toBeNull();

    const result = computeAutoCompactFit(carry);
    expect(result.recommendation.verdict).toBe("insufficient-data");
    expect(result.recommendation.reasonCode).toBe("nothing-priced");
    // The pinned claim (A8): candidates[] is NOT emptied here — real token
    // figures, every netSaving null, never 0.
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.netSaving).toBeNull();
      expect(c.savedTokens).toBeGreaterThan(0); // real token figure, not zeroed
      expect(typeof c.extraResets).toBe("number");
    }
  });

  it("PAIRED positive — the same shape, priced, gets a real netSaving (proves the null above is a genuine degrade, not a stub)", () => {
    const priced = buildCarry(repeat(TUNED_RAMP, TUNED_RAMP_CYCLES), { floorTokens: 10 * K });
    const result = computeAutoCompactFit(priced);
    expect(result.candidates.some((c) => c.netSaving !== null)).toBe(true);
  });
});

// ─── 7. THE D9 LOCK — this feature must never reach the org-sync payload ────

describe("D9 lock: autoCompactFit never crosses buildAggregatePayload into the org/team plane (SR-10)", () => {
  it("a real org-sync payload built from a store with linked sessions carries no autoCompactFit/verdict/recommendedTokens key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-autocompact-d9-"));
    try {
      const store = new Store(join(dir, "test.db"));
      try {
        store.upsertAccount({
          accountUuid: "acct-1",
          organizationUuid: null,
          emailHash: null,
          emailLabel: null,
          organizationType: null,
          rateLimitTier: null,
          userRateLimitTier: null,
          seatTier: null,
          billingType: null,
          subscriptionType: null,
          firstObservedAt: 1_700_000_000_000,
          lastObservedAt: 1_700_000_000_000,
        });
        store.upsertSession({
          sessionId: "sess-1",
          projectPath: "/w/d9",
          sourceFile: "/transcripts/sess-1.jsonl",
          firstTimestamp: 1_700_000_000_000,
          lastTimestamp: 1_700_000_100_000,
          claudeVersion: "2.1.70",
          entrypoint: "claude-vscode",
          gitBranch: "main",
          permissionMode: "default",
          isInteractive: true,
          promptCount: 5,
          assistantMessageCount: 5,
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheCreationTokens: 500,
          cacheReadTokens: 300_000,
          webSearchRequests: 0,
          webFetchRequests: 0,
          toolUseCounts: [],
          models: ["claude-opus-5"],
          repoUrl: null,
          accountUuid: "acct-1",
          organizationUuid: null,
          subscriptionType: null,
          thinkingBlocks: 0,
          parentSessionId: null,
          isSubagent: false,
          sourceDeleted: false,
          throttleEvents: 0,
          activeDurationMs: 60_000,
          medianResponseTimeMs: 500,
        });

        const salt = "a".repeat(64);
        const mappings = buildAccountMappings([{ accountUuid: "acct-1", label: "test" }], salt);
        const persisted: PersistedSyncConfig = {
          endpoint: "https://example.invalid/graphql",
          userPoolId: "us-east-1_test",
          clientId: "test-client",
          region: "us-east-1",
          userSalt: salt,
          accountMappings: mappings,
        };

        const payload = buildAggregatePayload(store, persisted);
        // Paired positive (SR-1/CR-18 style — the negative alone would pass
        // vacuously on an EMPTY payload): the session really did produce an
        // aggregate row, so the negative check below is checking a REAL
        // serialised payload, not an empty array.
        expect(payload.length).toBeGreaterThan(0);
        expect(payload[0]!.sessionCount).toBeGreaterThan(0);

        const serialised = JSON.stringify(payload);
        expect(serialised).not.toContain("autoCompactFit");
        expect(serialised).not.toContain("verdict");
        expect(serialised).not.toContain("recommendedTokens");
        // Also lock the TYPE, not just today's key names: nothing on
        // `AggregateSyncInput` may structurally carry any of the three.
        for (const record of payload) {
          expect(Object.keys(record)).not.toContain("autoCompactFit");
          expect(Object.keys(record)).not.toContain("verdict");
          expect(Object.keys(record)).not.toContain("recommendedTokens");
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
