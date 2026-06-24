/**
 * T3 — pure evidence combiner (`combineOutcome`).
 *
 * Proves the five safety invariants from the plan:
 *  1. No-signal-never-failed: a held-out base with [] signals stays the base.
 *  2. Abstain-band edges: exactly ±τ decides; strictly inside abstains (>= vs >).
 *  3. Contradictory signals cancel → abstain → base.
 *  4. Decisive base is never flipped, however strong the opposing signals.
 *  5. Monotonicity + dual: a +value signal never lowers score; a -value signal
 *     never raises it.
 *
 * Deterministic: property checks use an inline seeded mulberry32 RNG (the suite
 * deliberately avoids fast-check). All values are synthetic. No prompt text ever
 * enters a signal — `evidence` is an enum tag only.
 */
import { describe, it, expect } from 'vitest';
import { combineOutcome } from '../cost-per-task/combine.js';
import {
  SIGNAL_REGISTRY,
  TAU_HI,
  TAU_LO,
  type CombineInput,
  type OutcomeSignal,
  type SignalId,
  type TaskOutcome,
} from '../cost-per-task/outcome-types.js';

/** Inline seeded RNG — no external deps, fully deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIGNAL_IDS = Object.keys(SIGNAL_REGISTRY) as SignalId[];
const HELD_OUT = ['in_flight', 'unobservable'] as const;

/** Index helper that satisfies noUncheckedIndexedAccess for non-empty arrays. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[((i % arr.length) + arr.length) % arr.length];
  if (v === undefined) throw new Error('empty array');
  return v;
}

/** A signal built so that weight*value === contribution, using base_ladder. */
function signalContributing(
  contribution: number,
  weights: Record<string, number>,
): OutcomeSignal {
  // base_ladder default weight is 1.0; pin it to 1 so value === contribution and
  // value stays inside the [-1,+1] clamp for |contribution| <= 1.
  weights.base_ladder = 1;
  return { id: 'base_ladder', value: contribution, evidence: 'base_ladder' };
}

describe('combineOutcome — decisive base (never flipped)', () => {
  it('base success returns success with score +weight(base_ladder), evidence [base_ladder]', () => {
    const out = combineOutcome({ base: 'success', signals: [] });
    expect(out.outcome).toBe('success');
    expect(out.labelled).toBe(false);
    expect(out.score).toBe(SIGNAL_REGISTRY.base_ladder.defaultWeight);
    expect(out.evidence).toEqual(['base_ladder']);
  });

  it('base failed returns failed with score -weight(base_ladder)', () => {
    const out = combineOutcome({ base: 'failed', signals: [] });
    expect(out.outcome).toBe('failed');
    expect(out.score).toBe(-SIGNAL_REGISTRY.base_ladder.defaultWeight);
    expect(out.evidence).toEqual(['base_ladder']);
  });

  it('honours a weight override for base_ladder in the decisive branch', () => {
    const out = combineOutcome({
      base: 'success',
      signals: [],
      weights: { base_ladder: 2.5 },
    });
    expect(out.score).toBe(2.5);
  });

  it('Invariant 4: base success not flipped by strong negative signals', () => {
    const strongNeg: OutcomeSignal[] = [
      { id: 'repair_turn', value: -1, evidence: 'repair_turn' },
      { id: 'rework_abandoned', value: -1, evidence: 'rework_abandoned' },
      { id: 'truncation_high', value: -1, evidence: 'truncation_high' },
    ];
    const out = combineOutcome({ base: 'success', signals: strongNeg });
    expect(out.outcome).toBe('success');
    // Signals ignored: evidence is just the base ladder, score is +weight.
    expect(out.evidence).toEqual(['base_ladder']);
    expect(out.score).toBe(SIGNAL_REGISTRY.base_ladder.defaultWeight);
  });

  it('Invariant 4 dual: base failed not flipped by strong positive signals', () => {
    const strongPos: OutcomeSignal[] = [
      { id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' },
      { id: 'base_ladder', value: 1, evidence: 'base_ladder' },
    ];
    const out = combineOutcome({ base: 'failed', signals: strongPos });
    expect(out.outcome).toBe('failed');
    expect(out.evidence).toEqual(['base_ladder']);
    expect(out.score).toBe(-SIGNAL_REGISTRY.base_ladder.defaultWeight);
  });
});

describe('combineOutcome — held-out base refinement', () => {
  it('Invariant 1: no signals → outcome equals the held-out base, score 0', () => {
    for (const base of HELD_OUT) {
      const out = combineOutcome({ base, signals: [] });
      expect(out.outcome).toBe(base);
      expect(out.score).toBe(0);
      expect(out.evidence).toEqual([]);
    }
  });

  it('Invariant 1 (property): random weight maps never push [] signals off base', () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 500; i++) {
      const weights: Record<string, number> = {};
      for (const id of SIGNAL_IDS) {
        // span negative, zero, and large weights
        weights[id] = (rng() - 0.5) * 20;
      }
      const base = at(HELD_OUT, i);
      const out = combineOutcome({ base, signals: [], weights });
      expect(out.outcome).toBe(base);
      expect(out.outcome).not.toBe('success');
      expect(out.outcome).not.toBe('failed');
      expect(out.score).toBe(0);
    }
  });

  it('collects evidence tags in signal order (enum tags only, no prompt text)', () => {
    const signals: OutcomeSignal[] = [
      { id: 'truncation_high', value: -0.1, evidence: 'truncation_high' },
      { id: 'acceptance_turn', value: 0.1, evidence: 'acceptance_turn' },
    ];
    const out = combineOutcome({ base: 'in_flight', signals });
    expect(out.evidence).toEqual(['truncation_high', 'acceptance_turn']);
  });
});

describe('combineOutcome — abstain-band edges (Invariant 2)', () => {
  it('score exactly TAU_HI → success (>=), and just below → base', () => {
    for (const base of HELD_OUT) {
      const w: Record<string, number> = {};
      const atHi = combineOutcome({
        base,
        signals: [signalContributing(TAU_HI, w)],
        weights: w,
      });
      expect(atHi.score).toBeCloseTo(TAU_HI, 12);
      expect(atHi.outcome).toBe('success');

      const w2: Record<string, number> = {};
      const justBelow = combineOutcome({
        base,
        signals: [signalContributing(TAU_HI - 1e-9, w2)],
        weights: w2,
      });
      expect(justBelow.outcome).toBe(base);
    }
  });

  it('score exactly TAU_LO → failed (<=), and just above → base', () => {
    for (const base of HELD_OUT) {
      const w: Record<string, number> = {};
      const atLo = combineOutcome({
        base,
        signals: [signalContributing(TAU_LO, w)],
        weights: w,
      });
      expect(atLo.score).toBeCloseTo(TAU_LO, 12);
      expect(atLo.outcome).toBe('failed');

      const w2: Record<string, number> = {};
      const justAbove = combineOutcome({
        base,
        signals: [signalContributing(TAU_LO + 1e-9, w2)],
        weights: w2,
      });
      expect(justAbove.outcome).toBe(base);
    }
  });

  it('strictly between TAU_LO and TAU_HI → base (abstain)', () => {
    const w: Record<string, number> = {};
    const mid = combineOutcome({
      base: 'unobservable',
      signals: [signalContributing(0, w)],
      weights: w,
    });
    expect(mid.outcome).toBe('unobservable');
  });
});

describe('combineOutcome — contradictory signals (Invariant 3)', () => {
  it('a + and a - of equal weight cancel → abstain → base', () => {
    // Same id, opposite values, default weight → exact cancellation to 0.
    const signals: OutcomeSignal[] = [
      { id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' },
      { id: 'acceptance_turn', value: -1, evidence: 'acceptance_turn' },
    ];
    const out = combineOutcome({ base: 'in_flight', signals });
    expect(out.score).toBe(0);
    expect(out.outcome).toBe('in_flight');
  });

  it('different ids with equal-magnitude opposing contributions cancel', () => {
    // repair_turn (w 0.6) at -1 vs an override making acceptance_turn contribute +0.6.
    const signals: OutcomeSignal[] = [
      { id: 'repair_turn', value: -1, evidence: 'repair_turn' },
      { id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' },
    ];
    const out = combineOutcome({
      base: 'unobservable',
      signals,
      weights: { repair_turn: 0.6, acceptance_turn: 0.6 },
    });
    expect(out.score).toBeCloseTo(0, 12);
    expect(out.outcome).toBe('unobservable');
  });
});

describe('combineOutcome — monotonicity + dual (Invariant 5, property)', () => {
  function randomSignals(rng: () => number, n: number): OutcomeSignal[] {
    const out: OutcomeSignal[] = [];
    for (let i = 0; i < n; i++) {
      const id = at(SIGNAL_IDS, Math.floor(rng() * SIGNAL_IDS.length));
      const value = rng() * 2 - 1; // [-1, +1]
      out.push({ id, value, evidence: id });
    }
    return out;
  }

  function randomWeights(rng: () => number): Record<string, number> {
    const w: Record<string, number> = {};
    for (const id of SIGNAL_IDS) w[id] = rng() * 3; // non-negative weights
    return w;
  }

  it('adding a positive-value signal never lowers the score', () => {
    const rng = mulberry32(0x1234abcd);
    for (let i = 0; i < 500; i++) {
      const weights = randomWeights(rng);
      const base: TaskOutcome = at(HELD_OUT, i);
      const signals = randomSignals(rng, Math.floor(rng() * 5));
      const baseInput: CombineInput = { base, signals, weights };
      const before = combineOutcome(baseInput).score;

      const id = at(SIGNAL_IDS, Math.floor(rng() * SIGNAL_IDS.length));
      const posSignal: OutcomeSignal = {
        id,
        value: rng(), // [0, 1) — non-negative
        evidence: id,
      };
      const after = combineOutcome({
        base,
        signals: [...signals, posSignal],
        weights,
      }).score;

      expect(after).toBeGreaterThanOrEqual(before - 1e-9);
    }
  });

  it('adding a negative-value signal never raises the score', () => {
    const rng = mulberry32(0x55aa55aa);
    for (let i = 0; i < 500; i++) {
      const weights = randomWeights(rng);
      const base: TaskOutcome = at(HELD_OUT, i);
      const signals = randomSignals(rng, Math.floor(rng() * 5));
      const before = combineOutcome({ base, signals, weights }).score;

      const id = at(SIGNAL_IDS, Math.floor(rng() * SIGNAL_IDS.length));
      const negSignal: OutcomeSignal = {
        id,
        value: -rng(), // (-1, 0]
        evidence: id,
      };
      const after = combineOutcome({
        base,
        signals: [...signals, negSignal],
        weights,
      }).score;

      expect(after).toBeLessThanOrEqual(before + 1e-9);
    }
  });
});
