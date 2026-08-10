/**
 * `computeContextCarry` — the context-carry-cost arithmetic (context-carry-cost
 * Phase B2).
 *
 * The load-bearing test in this suite is the PARTITION IDENTITY:
 *
 *     Σ_turns increment × remainingRequestsInCycle === Σ_rows totalContext(row)
 *
 * It is an equality, not a tolerance, and it is what pins the two decisions the
 * rest of the module hangs off:
 *
 *  1. `remainingRequestsInCycle` is INCLUSIVE of the adding turn. An exclusive
 *     count undercounts by the entire distinct volume (every turn's own
 *     increment), so the identity fails immediately.
 *  2. The cycle runs to the NEXT RESET, not to the end of the session. Running
 *     to session end multiplies every pre-reset increment by volume that was
 *     thrown away at the reset, so the near-reset attribution inflates and the
 *     paired near-reset/early-in-cycle test fails.
 *
 * Both were mutation-checked (each mutation applied, suite re-run, the named
 * test observed to fail, mutation reverted) — see the run report.
 *
 * Every fixture is synthetic: round token counts, `/w/<letter>` project paths,
 * `s<n>` session ids. No figure here is copied from a real window.
 *
 * Shipped rates used by the hand arithmetic below (`claude-opus-5`):
 *   input 5.00, cacheRead 0.50, cacheWrite (5m) 6.25, output 25.00 per MTok.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { computeContextCarry, type ContextCarryResult, type ContextCarryTurn, type ContextCycle } from "@claude-stats/core/contextCarry";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";
import type { ModelPricing, RateOverrides } from "@claude-stats/core/pricing";
import { Store } from "../store/index.js";
import { computeContextCarryForWindow } from "../contextCarry/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

const T0 = 1_767_571_200_000; // FIXED_NOW, matches fixtures/synthetic.ts
const MIN = 60_000;
const K = 1_000;

/** `claude-opus-5` on the shipped table. */
const READ_RATE = 0.5; // $/MTok
const WRITE_5M_RATE = 6.25; // $/MTok

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

type ChainSpec = Partial<HygieneMessageRow>;

/** One session's messages, one minute apart. */
function chain(sessionId: string, specs: readonly ChainSpec[]): HygieneMessageRow[] {
  return specs.map((spec, i) =>
    row({ sessionId, uuid: `${sessionId}-m${i}`, timestamp: T0 + i * MIN, ...spec }),
  );
}

/** A session whose turns carry the given total contexts, all as cache READS —
 *  the ordinary shape of a carried context. */
function contexts(sessionId: string, totals: readonly number[], extra: ChainSpec = {}): HygieneMessageRow[] {
  return chain(
    sessionId,
    totals.map((t) => ({ cacheReadTokens: t, ...extra })),
  );
}

function sumContext(rows: readonly HygieneMessageRow[]): number {
  return rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens, 0);
}

/** The left-hand side of the partition identity, read back off the result. */
function attributedVolume(result: ContextCarryResult): number {
  return result.turns.reduce((n, t) => n + t.increment * t.remainingRequestsInCycle, 0);
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

/** Every non-finite number reachable in `value`, with the path that reached it.
 *  Walks the OBJECT, not its JSON: `JSON.stringify` emits `NaN`/`Infinity` as
 *  `null`, which is precisely the confusion this module's `number | null`
 *  convention exists to prevent, so a check on the serialized form alone would
 *  see nothing. */
function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${path} = ${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

// ─── Fixtures, with the arithmetic worked out in the comment ─────────────────

/**
 * One session, ten turns, contexts in K:
 *
 *   idx 0  1   2   3   4   5  | 6  7  8   9
 *       40 100 160 200 260 320| 60 90 120 150
 *
 * A reset lands at idx 6 (60K after 320K: a 81% drop from above the 150K
 * floor). Cycle 1 = idx 0-5 (6 requests, CLOSED); cycle 2 = idx 6-9 (4
 * requests, OPEN — no reset follows).
 *
 * Cycle 1 increments 40/60/60/40/60/60 × remaining 6/5/4/3/2/1
 *   = 240+300+240+120+120+60 = 1,080K = Σ context over idx 0-5. ✓
 * Cycle 2 increments 60/30/30/30 × remaining 4/3/2/1
 *   = 240+90+60+30 = 420K = Σ context over idx 6-9. ✓
 * Σ context over the window = 1,500K.
 */
const TWO_CYCLE_TOTALS = [40 * K, 100 * K, 160 * K, 200 * K, 260 * K, 320 * K, 60 * K, 90 * K, 120 * K, 150 * K];
function twoCycles(): HygieneMessageRow[] {
  return contexts("s1", TWO_CYCLE_TOTALS);
}

describe("computeContextCarry — the partition identity", () => {
  it("attributes exactly the carried volume: Σ increment × remainingRequestsInCycle === Σ totalContext", () => {
    const rows = twoCycles();
    const result = computeContextCarry(rows);

    expect(result.carriedTokens).toBe(1_500 * K);
    // The identity, as an equality. Every term is an integer, so no tolerance
    // is warranted and none is given.
    expect(attributedVolume(result)).toBe(sumContext(rows));
    expect(attributedVolume(result)).toBe(1_500 * K);
  });

  it("holds cycle by cycle, not merely in aggregate", () => {
    const result = computeContextCarry(twoCycles());
    expect(result.cycles).toEqual([
      { sessionId: "s1", requests: 6, open: false },
      { sessionId: "s1", requests: 4, open: true },
    ]);

    const cycleOne = result.turns.slice(0, 6);
    const cycleTwo = result.turns.slice(6);
    expect(cycleOne.reduce((n, t) => n + t.increment * t.remainingRequestsInCycle, 0)).toBe(1_080 * K);
    expect(cycleTwo.reduce((n, t) => n + t.increment * t.remainingRequestsInCycle, 0)).toBe(420 * K);
  });

  it("counts the adding turn itself — the first turn of an N-turn cycle sees N, the last sees 1", () => {
    const result = computeContextCarry(twoCycles());
    expect(result.turns.map((t) => t.remainingRequestsInCycle)).toEqual([6, 5, 4, 3, 2, 1, 4, 3, 2, 1]);
  });

  it("still partitions exactly when a turn shrinks the context", () => {
    // 100K → 90K is a shrink (not steep enough to be a reset), 90K → 130K grows.
    const rows = contexts("s1", [100 * K, 90 * K, 130 * K]);
    const result = computeContextCarry(rows);
    // increments 100 / -10 / +40 × remaining 3/2/1 = 300 - 20 + 40 = 320K.
    expect(result.turns.map((t) => t.increment)).toEqual([100 * K, -10 * K, 40 * K]);
    expect(attributedVolume(result)).toBe(sumContext(rows));
    expect(attributedVolume(result)).toBe(320 * K);
  });

  it("partitions exactly across several sessions and a null-timestamp break", () => {
    const rows = [
      ...contexts("s1", [50 * K, 120 * K]),
      row({ sessionId: "s2", uuid: "s2-m0", timestamp: T0, cacheReadTokens: 30 * K }),
      row({ sessionId: "s2", uuid: "s2-null", timestamp: null, cacheReadTokens: 7 * K }),
      row({ sessionId: "s2", uuid: "s2-m2", timestamp: T0 + MIN, cacheReadTokens: 80 * K }),
    ];
    const result = computeContextCarry(rows);
    // The null row is billed (it is in `carriedTokens`) but has no place in an
    // ordering, so it holds no slot in a cycle — the identity is against the
    // timestamped subset.
    expect(result.carriedTokens).toBe(287 * K);
    expect(result.excludedRows).toBe(1);
    expect(attributedVolume(result)).toBe(287 * K - 7 * K);
    expect(result.turns.map((t) => t.uuid)).toEqual(["s1-m0", "s1-m1", "s2-m0", "s2-m2"]);
  });
});

describe("computeContextCarry — the cycle runs to the next reset", () => {
  it("prices a token added just before a reset near zero, and the same token added early expensively", () => {
    const result = computeContextCarry(twoCycles());
    const early = result.turns[1]!; // +60K, 5 requests left in the cycle
    const nearReset = result.turns[5]!; // +60K, 1 request left, then the reset

    // The SAME 60K increment, at two points in one cycle.
    expect(early.increment).toBe(60 * K);
    expect(nearReset.increment).toBe(60 * K);

    // early: 60,000 × 5 × 0.50 / 1e6 = $0.15
    expect(early.carryCost).toBeCloseTo(0.15, 10);
    // near-reset: 60,000 × 1 × 0.50 / 1e6 = $0.03, plus the reset request's own
    // cost (60K cache-read = $0.03) per review A-4 = $0.06.
    expect(nearReset.carryCost).toBeCloseTo(0.06, 10);
    expect(nearReset.carryCost!).toBeLessThan(early.carryCost! / 2);
    // Paired positive: it is near zero, not zero — the turn really did pay for
    // its own context once, and it really did help force the reset.
    expect(nearReset.carryCost!).toBeGreaterThan(0);
  });

  it("adds the reset's own request cost to the increment that preceded it, and to no other turn", () => {
    // 300K → 90K is a reset (a 70% drop from above the 150K floor); 90K → 120K
    // grows. Cycle 1 is the single 300K turn; cycle 2 is the last two.
    const rows = contexts("s1", [300 * K, 90 * K, 120 * K]);
    const result = computeContextCarry(rows);

    expect(result.resets).toHaveLength(1);
    const reset = result.resets[0]!;
    expect(reset.beforeTokens).toBe(300 * K);
    expect(reset.afterTokens).toBe(90 * K);
    expect(reset.requestsInCycle).toBe(1);
    // The reset request is a real request with a real token split — priced
    // normally, not at the carry lower bound: 90,000 × 0.50 / 1e6 = $0.045.
    expect(reset.resetRequestCost).toBeCloseTo(0.045, 10);

    const bareCarry = (300 * K * 1 * READ_RATE) / 1e6; // $0.15
    expect(result.turns[0]!.carryCost).toBeCloseTo(bareCarry + reset.resetRequestCost, 10);
    expect(result.turns[0]!.carryCost!).toBeGreaterThan(bareCarry);
    // Paired: a turn that does NOT precede a reset is the bare carry term and
    // nothing else — 90,000 × 2 × 0.50 / 1e6 = $0.09.
    expect(result.turns[1]!.carryCost).toBeCloseTo(0.09, 10);
  });

  it("marks a cycle with no following reset as open, and one closed by a reset as closed", () => {
    const noReset = computeContextCarry(contexts("s1", [40 * K, 80 * K, 120 * K]));
    expect(noReset.resets).toEqual([]);
    expect(noReset.cycles).toEqual([{ sessionId: "s1", requests: 3, open: true }]);
    expect(noReset.sawtooth).toBeNull();

    const withReset = computeContextCarry(twoCycles());
    expect(withReset.cycles.map((c) => c.open)).toEqual([false, true]);
  });
});

describe("computeContextCarry — carryCost is a lower bound", () => {
  it("prices carried tokens at the cache-READ rate, strictly below what the same tokens were billed", () => {
    // Every turn's whole context arrives as a cache WRITE — the shape a token
    // takes each time it crosses a cache-expiry boundary. One session, one
    // open cycle, one model, no output tokens, so `sumCost` over the window IS
    // the billed cost of exactly these carried tokens.
    const rows = contexts("s1", [], {}).concat(
      chain("s1", [50 * K, 100 * K, 150 * K, 200 * K].map((t) => ({ cacheCreationTokens: t }))),
    );
    const result = computeContextCarry(rows);

    expect(result.carriedTokens).toBe(500 * K);
    // Positive assertion on the same code path: with one model and one cycle
    // the identity makes the dollar figure exactly `carried × readRate`.
    const carryTotal = (500 * K * READ_RATE) / 1e6; // $0.25
    expect(result.totalCarryCost).toBeCloseTo(carryTotal, 10);

    // What those same tokens actually cost, from `messageCost`'s rates.
    const billed = (500 * K * WRITE_5M_RATE) / 1e6; // $3.125
    expect(result.totalCarryCost!).toBeLessThan(billed);
    // And by how much: the read rate is 8% of the 5-minute write rate, so on a
    // window whose context is re-written every turn this understates by 92%.
    // (The motivating window is a mix of reads and writes, where the gap is
    // nearer 50% — either way the direction is one-sided and known.)
    expect(result.totalCarryCost! / billed).toBeCloseTo(READ_RATE / WRITE_5M_RATE, 10);
  });

  it("derives the rate from the resolved pricing table rather than a constant", () => {
    const rows = twoCycles();
    const shipped = computeContextCarry(rows);
    const tenfold = computeContextCarry(rows, { rateOverrides: opusRates({ cacheReadPerMillion: 5 }) });

    // Carried volume at the read rate ($0.75) plus the reset's own request
    // cost, which A-4 folds into the increment that preceded it ($0.03).
    expect(shipped.totalCarryCost).toBeCloseTo((1_500 * K * READ_RATE) / 1e6 + shipped.resets[0]!.resetRequestCost, 10);
    expect(shipped.totalCarryCost).toBeCloseTo(0.78, 10);
    expect(tenfold.totalCarryCost).toBeCloseTo(shipped.totalCarryCost! * 10, 10);
    // The reset's own request is re-priced too — it goes through the same table.
    expect(tenfold.resets[0]!.resetRequestCost).toBeCloseTo(shipped.resets[0]!.resetRequestCost * 10, 10);
    expect(tenfold.aboveCap[0]!.cost).toBeCloseTo(shipped.aboveCap[0]!.cost * 10, 10);
  });
});

describe("computeContextCarry — unpriced and null-model rows", () => {
  it("counts an unpriced row in the cycle length but never in a dollar figure", () => {
    const priced = contexts("s1", [40 * K, 100 * K, 160 * K, 200 * K]);
    const withNullModel = priced.map((r, i) => (i === 1 ? { ...r, model: null } : r));

    const a = computeContextCarry(priced);
    const b = computeContextCarry(withNullModel);

    // The multiplier is untouched: the context really was carried on that turn.
    expect(b.turns.map((t) => t.remainingRequestsInCycle)).toEqual(a.turns.map((t) => t.remainingRequestsInCycle));
    expect(b.turns.map((t) => t.increment)).toEqual(a.turns.map((t) => t.increment));
    expect(b.carriedTokens).toBe(a.carriedTokens);

    // Only the dollar half degrades.
    expect(b.turns[1]!.carryCost).toBeNull();
    expect(a.turns[1]!.carryCost).not.toBeNull();
    expect(b.unpricedRows).toBe(1);
    expect(b.unpricedTokens).toBe(100 * K);
    expect(a.unpricedRows).toBe(0);
    expect(b.totalCarryCost).toBeCloseTo(a.totalCarryCost! - a.turns[1]!.carryCost!, 10);
  });

  it("reports totalCarryCost as null — never a partial sum, never 0 — when nothing is priced", () => {
    const rows = contexts("s1", [40 * K, 100 * K]).map((r) => ({ ...r, model: null }));
    const result = computeContextCarry(rows);
    expect(result.totalCarryCost).toBeNull();
    expect(result.turns.every((t) => t.carryCost === null)).toBe(true);
    // Paired positive: the token volume is still fully real.
    expect(result.carriedTokens).toBe(140 * K);
    expect(result.unpricedTokens).toBe(140 * K);
  });
});

describe("computeContextCarry — distinct content and amplification", () => {
  it("sums growth, session-start and post-reset increments, and never a shrink", () => {
    // 100K start, +50K growth, -10K shrink, +60K growth, reset to 50K, +30K.
    const rows = contexts("s1", [100 * K, 150 * K, 140 * K, 200 * K, 50 * K, 80 * K]);
    const result = computeContextCarry(rows);

    // 100 + 50 + 60 + 50 + 30 = 290K. Including the shrink would give 280K.
    expect(result.distinctTokensEstimate).toBe(290 * K);
    expect(result.carriedTokens).toBe(720 * K);
    expect(result.amplificationEstimate).toBeCloseTo(720 / 290, 10);
  });

  it("uses the FLOORLESS drop rule for the denominator and the FLOORED one for cycles", () => {
    // 100K → 30K is a 70% drop, so `contextIncrements` calls it "post-reset"
    // and counts the whole 30K as distinct — but 100K is under the 150K floor,
    // so it is NOT a reset: no cycle boundary, no ledger entry, no sawtooth.
    const small = computeContextCarry(contexts("s1", [100 * K, 30 * K, 40 * K]));
    expect(small.resets).toEqual([]);
    expect(small.cycles).toEqual([{ sessionId: "s1", requests: 3, open: true }]);
    expect(small.distinctTokensEstimate).toBe(140 * K); // 100 + 30 + 10
    // The carry increment follows the CYCLE, so it is the signed difference
    // here — which is what keeps the partition exact.
    expect(small.turns.map((t) => t.increment)).toEqual([100 * K, -70 * K, 10 * K]);
    expect(attributedVolume(small)).toBe(170 * K);

    // The same shape above the floor: now it is a reset on both rules.
    const large = computeContextCarry(contexts("s1", [300 * K, 90 * K, 120 * K]));
    expect(large.resets).toHaveLength(1);
    expect(large.cycles).toEqual([
      { sessionId: "s1", requests: 1, open: false },
      { sessionId: "s1", requests: 2, open: true },
    ]);
    expect(large.distinctTokensEstimate).toBe(420 * K); // 300 + 90 + 30
    expect(large.turns.map((t) => t.increment)).toEqual([300 * K, 90 * K, 30 * K]);
    expect(attributedVolume(large)).toBe(510 * K);
  });
});

describe("computeContextCarry — sawtooth", () => {
  /** `n` back-to-back cycles of `peak` then a drop to `floor`, each cycle
   *  `perCycle` requests long. */
  function sawtoothRows(n: number, perCycle: number, floorTokens: number, peakTokens: number): HygieneMessageRow[] {
    const totals: number[] = [];
    for (let c = 0; c < n + 1; c++) {
      for (let i = 0; i < perCycle; i++) totals.push(i === perCycle - 1 ? peakTokens : floorTokens);
    }
    return contexts("s1", totals);
  }

  it("is null on fewer than 3 resets and never averages two events", () => {
    const two = computeContextCarry(sawtoothRows(2, 2, 60 * K, 300 * K));
    expect(two.resets).toHaveLength(2);
    expect(two.sawtooth).toBeNull();
  });

  it("reports mean floor, peak and cycle length once 3 resets exist", () => {
    const three = computeContextCarry(sawtoothRows(3, 2, 60 * K, 300 * K));
    expect(three.resets).toHaveLength(3);
    expect(three.sawtooth).toEqual({ floorTokens: 60 * K, peakTokens: 300 * K, requestsPerCycle: 2 });
    // The open final cycle is excluded from `requestsPerCycle` — it has no
    // "next reset" to measure to.
    expect(three.cycles.filter((c) => c.open)).toHaveLength(1);
    expect(three.cycles.filter((c) => !c.open)).toHaveLength(3);
  });
});

describe("computeContextCarry — caps and size bands", () => {
  it("yields 0, not undefined, for a cap above every observed context", () => {
    const result = computeContextCarry(twoCycles(), { capsTokens: [100 * K, 1_000 * K] });
    const high = result.aboveCap[1]!;
    expect(high.capTokens).toBe(1_000 * K);
    expect(high.tokensAbove).toBe(0);
    expect(high.cost).toBe(0);
    expect(high.share).toBe(0); // 0 of a real total is 0, not "not computed"

    // Paired positive on the same code path: a cap the window really exceeds.
    // Excess over 100K: 60+100+160+220+20+50 = 610K.
    const low = result.aboveCap[0]!;
    expect(low.tokensAbove).toBe(610 * K);
    expect(low.cost).toBeCloseTo((610 * K * READ_RATE) / 1e6, 10);
    expect(low.share).toBeCloseTo(610 / 1_500, 10);
    expect(result.capCaveat).toContain("not the cost of capping");
  });

  it("bands every request exactly once, with locale-independent labels", () => {
    const result = computeContextCarry(twoCycles());
    expect(result.sizeBands.map((b) => b.label)).toEqual([
      "0-20K",
      "20K-50K",
      "50K-100K",
      "100K-200K",
      "200K-500K",
      "500K+",
    ]);
    expect(result.sizeBands.reduce((n, b) => n + b.requests, 0)).toBe(10);
    // 40K and 60K land in 20K-50K and 50K-100K respectively; 100/120/150/160
    // in 100K-200K; 200/260/320 in 200K-500K; 90K in 50K-100K.
    expect(result.sizeBands.map((b) => b.requests)).toEqual([0, 1, 2, 4, 3, 0]);
    const shares = result.sizeBands.map((b) => b.shareOfVolume!);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // An empty band divides no cost by no requests: null, never a $0/request
    // that reads as "free".
    expect(result.sizeBands[0]!.costPerRequest).toBeNull();
    expect(result.sizeBands[3]!.costPerRequest).toBeGreaterThan(0);
  });

  it("honours caller-supplied band edges and always partitions from zero", () => {
    // Out of order, duplicated, and with no zero edge — sorted, de-duplicated,
    // and floored at 0 so no request falls outside every band.
    const result = computeContextCarry(twoCycles(), { sizeBandEdges: [200 * K, 50 * K, 200 * K] });
    expect(result.sizeBands.map((b) => b.label)).toEqual(["0-50K", "50K-200K", "200K+"]);
    expect(result.sizeBands.map((b) => b.requests)).toEqual([1, 6, 3]);
    expect(result.sizeBands.reduce((n, b) => n + b.requests, 0)).toBe(10);
  });

  it("labels a fractional band edge without a locale-formatted number", () => {
    const result = computeContextCarry(twoCycles(), { sizeBandEdges: [0, 25_500] });
    expect(result.sizeBands.map((b) => b.label)).toEqual(["0-25.5K", "25.5K+"]);
  });

  it("falls back to the default edges when the supplied list has nothing usable", () => {
    // Unlike `capsTokens`, an empty edge list is not a preference that can be
    // honoured — it would leave every request in no band at all.
    const result = computeContextCarry(twoCycles(), { sizeBandEdges: [Number.NaN, -1] });
    expect(result.sizeBands.map((b) => b.minTokens)).toEqual([0, 20 * K, 50 * K, 100 * K, 200 * K, 500 * K]);
    expect(result.sizeBands.reduce((n, b) => n + b.requests, 0)).toBe(10);
  });
});

describe("computeContextCarry — prelude", () => {
  /** `n` fresh sessions with the given first-request context, plus optionally
   *  one much larger RESUMED session (a restored conversation, not a prelude). */
  function preludeRows(n: number, freshTokens: number, resumedTokens?: number): HygieneMessageRow[] {
    const rows = Array.from({ length: n }, (_, i) =>
      contexts(`s${i}`, [freshTokens, freshTokens + 10 * K]),
    ).flat();
    if (resumedTokens !== undefined) rows.push(...contexts("s-resumed", [resumedTokens, resumedTokens + 10 * K]));
    return rows;
  }

  it("is a median, so one resumed session among ten fresh ones does not move it", () => {
    const fresh = computeContextCarry(preludeRows(10, 10 * K));
    const withResumed = computeContextCarry(preludeRows(10, 10 * K, 500 * K));

    expect(fresh.prelude.medianFirstRequestTokens).toBe(10 * K);
    expect(fresh.prelude.sessions).toBe(10);
    expect(withResumed.prelude.medianFirstRequestTokens).toBe(10 * K);
    expect(withResumed.prelude.sessions).toBe(11);

    // What a mean would have reported on the same input — the reason A-8 says
    // median. (10 × 10K + 500K) / 11 ≈ 54.5K, 5.45× the median.
    const meanFirstRequest = (10 * 10 * K + 500 * K) / 11;
    expect(meanFirstRequest).toBeGreaterThan(5 * withResumed.prelude.medianFirstRequestTokens);
  });

  it("still tracks a genuine shift in the population", () => {
    const higher = computeContextCarry(preludeRows(10, 30 * K, 500 * K));
    expect(higher.prelude.medianFirstRequestTokens).toBe(30 * K);
  });

  it("prices the prelude at each session's own model's cache-read rate", () => {
    const rows = [...contexts("s0", [20 * K]), ...contexts("s1", [20 * K])];
    const mixed = rows.map((r, i) => (i === 1 ? { ...r, model: "claude-sonnet-5" } : r));
    const result = computeContextCarry(mixed);
    expect(result.prelude.medianFirstRequestTokens).toBe(20 * K);
    // opus cacheRead 0.50 + sonnet-5 cacheRead 0.20, each on 20K.
    expect(result.prelude.cost).toBeCloseTo((20 * K * 0.5) / 1e6 + (20 * K * 0.2) / 1e6, 10);
    expect(result.prelude.shareOfCarriedVolume).toBeCloseTo(1, 10);
  });

  it("takes the midpoint of an even-sized sample", () => {
    const rows = [10 * K, 20 * K, 30 * K, 40 * K].flatMap((t, i) => contexts(`s${i}`, [t]));
    expect(computeContextCarry(rows).prelude.medianFirstRequestTokens).toBe(25 * K);
  });

  it("keeps a session with no usable timestamp out of the per-project series but in the median", () => {
    const rows = [
      ...contexts("s-timed", [40 * K]),
      row({ sessionId: "s-untimed", uuid: "s-untimed-m0", timestamp: null, cacheReadTokens: 40 * K }),
    ];
    const result = computeContextCarry(rows);
    // No timestamp anywhere in that session ⇒ nothing to place it on a trend
    // line with, so it is left out rather than ordered against a made-up epoch.
    expect(result.preludeByProject).toEqual([
      { projectPath: "/w/alpha", sessions: [{ startedAt: T0, firstRequestTokens: 40 * K }] },
    ]);
    // Paired positive: it is not erased — its first request still counts toward
    // the median, and its tokens toward the carried volume.
    expect(result.prelude.sessions).toBe(2);
    expect(result.prelude.medianFirstRequestTokens).toBe(40 * K);
    expect(result.carriedTokens).toBe(80 * K);
    expect(result.excludedRows).toBe(1);
  });

  it("groups the per-project baseline by project and orders each series by start time", () => {
    const rows = [
      ...contexts("s-late", [80 * K]).map((r) => ({ ...r, projectPath: "/w/alpha", timestamp: T0 + 10 * MIN })),
      ...contexts("s-early", [40 * K]).map((r) => ({ ...r, projectPath: "/w/alpha", timestamp: T0 })),
      ...contexts("s-beta", [60 * K]).map((r) => ({ ...r, projectPath: "/w/beta", timestamp: T0 + 5 * MIN })),
    ];
    const result = computeContextCarry(rows);
    expect(result.preludeByProject).toEqual([
      {
        projectPath: "/w/alpha",
        sessions: [
          { startedAt: T0, firstRequestTokens: 40 * K },
          { startedAt: T0 + 10 * MIN, firstRequestTokens: 80 * K },
        ],
      },
      { projectPath: "/w/beta", sessions: [{ startedAt: T0 + 5 * MIN, firstRequestTokens: 60 * K }] },
    ]);
  });
});

describe("computeContextCarry — concentration", () => {
  it("ranks sessions by carried volume with a data-determined tie-break", () => {
    const rows = [
      ...contexts("s-small", [10 * K]),
      ...contexts("s-big", [200 * K, 300 * K]),
      ...contexts("s-mid", [90 * K]),
    ];
    const result = computeContextCarry(rows);
    expect(result.concentration.map((c) => c.sessionId)).toEqual(["s-big", "s-mid", "s-small"]);
    expect(result.concentration[0]).toEqual({
      sessionId: "s-big",
      requests: 2,
      meanContext: 250 * K,
      share: (500 * K) / (600 * K),
    });
  });

  it("orders equal-volume sessions by id, so the ranking is a function of the data alone", () => {
    const forwards = [...contexts("s-b", [50 * K]), ...contexts("s-a", [50 * K])];
    const backwards = [...contexts("s-a", [50 * K]), ...contexts("s-b", [50 * K])];
    expect(computeContextCarry(forwards).concentration.map((c) => c.sessionId)).toEqual(["s-a", "s-b"]);
    expect(computeContextCarry(backwards).concentration.map((c) => c.sessionId)).toEqual(["s-a", "s-b"]);
  });
});

describe("computeContextCarry — no NaN, no Infinity, no fabricated zero", () => {
  it("returns nulls with denominators of zero on an empty window", () => {
    const result = computeContextCarry([]);

    expect(nonFinitePaths(result)).toEqual([]);
    // A round-trip through JSON is the same check from the consumer's side: a
    // `NaN` anywhere would come back as `null` and break the equality.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    expect(result.carriedTokens).toBe(0);
    expect(result.distinctTokensEstimate).toBe(0);
    expect(result.amplificationEstimate).toBeNull();
    expect(result.totalCarryCost).toBeNull();
    expect(result.sawtooth).toBeNull();
    expect(result.prelude.shareOfCarriedVolume).toBeNull();
    expect(result.prelude.sessions).toBe(0);
    expect(result.sizeBands.every((b) => b.shareOfVolume === null && b.costPerRequest === null)).toBe(true);
    expect(result.aboveCap.every((c) => c.tokensAbove === 0 && c.share === null && c.cost === 0)).toBe(true);
    expect(result.turns).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  it("returns nulls on an all-zero-token window rather than 0/0", () => {
    const result = computeContextCarry(contexts("s1", [0, 0, 0]));

    expect(nonFinitePaths(result)).toEqual([]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    expect(result.carriedTokens).toBe(0);
    expect(result.amplificationEstimate).toBeNull();
    expect(result.sizeBands[0]!.shareOfVolume).toBeNull();
    expect(result.sizeBands[0]!.shareOfCost).toBeNull();
    // Three requests really did happen and really did cost $0 — that is a
    // measured zero, not an absent denominator.
    expect(result.sizeBands[0]!.requests).toBe(3);
    expect(result.sizeBands[0]!.costPerRequest).toBe(0);
    expect(result.concentration[0]!.meanContext).toBe(0);
    expect(result.concentration[0]!.share).toBeNull();
    // Paired positive: the same walker over a populated window finds nothing
    // either, and the ratio really is a finite number there.
    const populated = computeContextCarry(twoCycles());
    expect(nonFinitePaths(populated)).toEqual([]);
    expect(JSON.parse(JSON.stringify(populated))).toEqual(populated);
    expect(populated.amplificationEstimate).toBeGreaterThan(1);
  });
});

describe("computeContextCarry — hostile inputs", () => {
  it("treats a model whose resolved read rate is not a number as unpriced", () => {
    const rows = contexts("s1", [40 * K, 100 * K]);
    const result = computeContextCarry(rows, { rateOverrides: opusRates({ cacheReadPerMillion: Number.NaN }) });
    expect(result.unpricedRows).toBe(2);
    expect(result.totalCarryCost).toBeNull();
    expect(result.turns.every((t) => t.carryCost === null)).toBe(true);
    expect(nonFinitePaths(result)).toEqual([]);
    // Paired positive: the same rows with a usable rate are fully priced.
    const priced = computeContextCarry(rows);
    expect(priced.unpricedRows).toBe(0);
    expect(priced.totalCarryCost).toBeGreaterThan(0);
  });

  it("never emits a non-finite carryCost or ratio from a non-finite token count", () => {
    // Token coercion lives at the store boundary (`nonNegativeFiniteInt` in the
    // three `toHygieneMessageRow` mappers), so this input cannot arrive from
    // the shipped glue — but a non-finite number reaching a DOLLAR figure or a
    // share is the failure this module's `number | null` rule exists to stop,
    // and that guard has to be exercised to be worth keeping.
    const rows = contexts("s1", [40 * K, Number.POSITIVE_INFINITY, 90 * K]);
    const result = computeContextCarry(rows);
    expect(result.turns.every((t) => t.carryCost === null || Number.isFinite(t.carryCost))).toBe(true);
    expect(result.turns.some((t) => t.carryCost === null)).toBe(true);
    expect(result.amplificationEstimate).toBeNull();
    expect(result.sizeBands.every((b) => b.shareOfVolume === null)).toBe(true);
    expect(result.aboveCap.every((c) => c.share === null)).toBe(true);
    expect(result.concentration.every((c) => c.share === null)).toBe(true);
  });
});

describe("computeContextCarry — purity", () => {
  it("is a function of its input alone and mutates nothing", () => {
    const rows = twoCycles();
    const before = JSON.parse(JSON.stringify(rows));
    const first = computeContextCarry(rows);
    const second = computeContextCarry(rows);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before);
  });

  it("honours an explicitly empty caps list without falling back to the defaults", () => {
    const result = computeContextCarry(twoCycles(), { capsTokens: [] });
    expect(result.aboveCap).toEqual([]);
    // Paired: omitting the option gives the four documented defaults.
    expect(computeContextCarry(twoCycles()).aboveCap.map((c) => c.capTokens)).toEqual([100 * K, 200 * K, 300 * K, 500 * K]);
  });

  it("passes the reset knobs through to detectResets", () => {
    // 100K → 30K clears the default drop ratio but not the default 150K floor.
    const rows = contexts("s1", [100 * K, 30 * K, 40 * K]);
    expect(computeContextCarry(rows).resets).toEqual([]);
    const lowered = computeContextCarry(rows, { resetMinBeforeTokens: 50 * K });
    expect(lowered.resets).toHaveLength(1);
    expect(lowered.cycles).toEqual([
      { sessionId: "s1", requests: 1, open: false },
      { sessionId: "s1", requests: 2, open: true },
    ]);
    // And the carry increment follows the new cycle boundary.
    expect(lowered.turns.map((t) => t.increment)).toEqual([100 * K, 30 * K, 10 * K]);
    expect(attributedVolume(lowered)).toBe(170 * K);
  });
});

// ─── B3a — the turns/cycles invariant (autocompact-window-fit IMPLEMENTATION.md
// §0/C1, §4/B3a) ───────────────────────────────────────────────────────────
//
// `computeContextCarry` walks `cycleAccs` once, pushing one `cycles[]` entry
// then that cycle's `turns[]` entries in order (`contextCarry.ts:547-582`).
// That undocumented correspondence is what `computeAutoCompactFit` (Phase A,
// running concurrently with this test) will reconstruct `turns` slices from.
// If this test fails, Phase A's premise is invalid before Phase A finishes.
//
// The load-bearing property is NOT `Σ cycles[].requests === turns.length` —
// that sum is invariant under ANY PERMUTATION of either array and would not
// catch the one failure a refactor produces: reordering. The real invariant
// is that `turns` partitions into CONTIGUOUS slices, ONE PER `cycles[]` ENTRY,
// IN THE SAME ORDER, each running `remainingRequestsInCycle` as `n, n-1, ..., 1`
// and each carrying that cycle's own `sessionId`. Exercised through a real
// `Store` (`computeContextCarryForWindow`), not by calling `computeContextCarry`
// directly, per plan.
function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-turns-cycles-invariant-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function invariantSession(id: string, projectPath = "/w/alpha", overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath, sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: T0, lastTimestamp: T0 + 60_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-opus-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function invariantMessage(uuid: string, sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: T0, claudeVersion: "2.1.70",
    model: "claude-opus-5", stopReason: "end_turn",
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

/**
 * Walks `turns` as CONTIGUOUS slices sized by `cycles[].requests`, in
 * `cycles` order, and checks — per slice — the length, the descending
 * `remaining` sequence, and single-session-ness. This is the reconstruction
 * `computeAutoCompactFit` will need to do (C1's resolution): a slice that
 * does not line up this way is exactly what a reordering refactor produces,
 * and exactly what a bare count check (`Σ requests === turns.length`) cannot
 * see, because that sum is invariant under permuting either array.
 */
function checkTurnsCyclesInvariant(turns: readonly ContextCarryTurn[], cycles: readonly ContextCycle[]): void {
  let offset = 0;
  for (const cycle of cycles) {
    const slice = turns.slice(offset, offset + cycle.requests);
    expect(slice).toHaveLength(cycle.requests);
    expect(slice.map((t) => t.remainingRequestsInCycle)).toEqual(
      Array.from({ length: cycle.requests }, (_, i) => cycle.requests - i),
    );
    expect(slice.every((t) => t.sessionId === cycle.sessionId)).toBe(true);
    offset += cycle.requests;
  }
  expect(offset).toBe(turns.length);
}

describe("computeContextCarry — turns/cycles invariant (autocompact-window-fit B3a)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("partitions turns into contiguous per-cycle slices, in cycles order, each running remaining n..1, each single-session — across multiple sessions, a genuine reset, and an open cycle", () => {
    store.upsertSession(invariantSession("s1"));
    store.upsertSession(invariantSession("s2", "/w/beta"));
    store.upsertMessages([
      // s1 cycle 1 (CLOSED): 3 requests, peaking at 300K, then a genuine reset
      // (300K -> 40K is an 87% drop from above the 150K floor).
      invariantMessage("s1-m0", "s1", { inputTokens: 50_000 }),
      invariantMessage("s1-m1", "s1", { timestamp: T0 + 1 * MIN, inputTokens: 220_000 }),
      invariantMessage("s1-m2", "s1", { timestamp: T0 + 2 * MIN, inputTokens: 300_000 }),
      // s1 cycle 2 (OPEN): 2 requests, starting at the reset's after-row.
      invariantMessage("s1-m3", "s1", { timestamp: T0 + 3 * MIN, inputTokens: 40_000 }),
      invariantMessage("s1-m4", "s1", { timestamp: T0 + 4 * MIN, inputTokens: 90_000 }),
      // s2, a single OPEN cycle: 2 requests, no reset, a different session.
      invariantMessage("s2-m0", "s2", { timestamp: T0, inputTokens: 20_000 }),
      invariantMessage("s2-m1", "s2", { timestamp: T0 + 1 * MIN, inputTokens: 35_000 }),
    ]);

    const result = computeContextCarryForWindow(store, {});

    // Fixture sanity — the fixture must actually produce the shape the
    // invariant needs to be worth checking: a genuine reset, more than one
    // cycle, more than one session, and at least one open cycle. A
    // single-cycle fixture proves nothing (plan's own warning).
    expect(result.resets).toHaveLength(1);
    expect(result.cycles).toEqual([
      { sessionId: "s1", requests: 3, open: false },
      { sessionId: "s1", requests: 2, open: true },
      { sessionId: "s2", requests: 2, open: true },
    ]);
    expect(result.cycles.filter((c) => c.open)).toHaveLength(2);
    expect(new Set(result.cycles.map((c) => c.sessionId)).size).toBe(2);

    // 1. Sum of cycles[].requests === turns.length.
    const totalRequests = result.cycles.reduce((n, c) => n + c.requests, 0);
    expect(totalRequests).toBe(result.turns.length);
    expect(result.turns).toHaveLength(7);

    // 2-4. Contiguous per-cycle slices, in cycles order, remaining n..1,
    // single-session — the part a sum check cannot see.
    checkTurnsCyclesInvariant(result.turns, result.cycles);
  });

  // Reordering-detection check (plan's explicit instruction): verified by hand
  // during development, not left in the suite as a permanently-failing case.
  // A local copy of the assertion was made against `[...result.turns].reverse()`
  // in place of `result.turns` and the suite was re-run: `checkTurnsCyclesInvariant`
  // went RED immediately, on the very first cycle's `remaining` sequence
  // (`toEqual` failed: reversed turns put a `remaining: 1` where `3, 2, 1` was
  // expected). This is exactly the failure mode the C1 correction (plan §0)
  // says a bare `Σ cycles[].requests === turns.length` check would miss, since
  // that sum is invariant under the same reversal. The shuffle was removed
  // afterward; this comment is the record, not a second copy of the test.
});
