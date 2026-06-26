/**
 * T3 — the efficiency frontier core (`computeFrontier`).
 *
 * Proves the §4 honesty guards:
 *  1. Min-archetype-sample boundary: 7 tasks → abstain (counts only); 8 → frontier.
 *  2. Success-rate floor: a cheaper model below RATE_FLOOR is NEVER the frontier
 *     (and exactly RATE_FLOOR qualifies).
 *  3. Single-model / incumbent-already-cheapest → recoverableWaste = 0, no crash.
 *  4. Percentile edges: n=1, n=2 (no p90/p95); n ≥ 20 (p90/p95 present);
 *     nearest-rank values pinned.
 *  5. Property (seeded mulberry32): the top-level identity holds and
 *     0 ≤ recoverableWaste ≤ Σ cost. The suite deliberately avoids fast-check.
 *
 * All fixtures are synthetic, built via `makeTask`; no MCP-sampled data, no paths,
 * no prompt text — `ClassifiedTask` carries numbers, an enum, and model names only.
 */
import { describe, it, expect } from 'vitest';
import { computeFrontier } from '../cost-per-task/efficiency/frontier.js';
import { deriveLevers } from '../cost-per-task/efficiency/levers.js';
import {
  MIN_ARCHETYPE_SAMPLE,
  RATE_FLOOR,
  type Archetype,
  type ArchetypeFrontier,
  type ClassifiedTask,
  type FrontierResult,
} from '../cost-per-task/efficiency/types.js';
import type { TaskOutcome } from '../cost-per-task/outcome-types.js';

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

/** Synthetic task factory — neutral, no real data (security F3). */
function makeTask(over: Partial<ClassifiedTask> = {}): ClassifiedTask {
  return {
    cost: over.cost ?? 1,
    archetype: over.archetype ?? 'other',
    outcome: over.outcome ?? 'success',
    dominantModel: over.dominantModel === undefined ? 'model-a' : over.dominantModel,
  };
}

/** Build `n` identical tasks (each overridable). */
function repeat(n: number, over: Partial<ClassifiedTask> = {}): ClassifiedTask[] {
  return Array.from({ length: n }, () => makeTask(over));
}

/** Build tasks from an explicit cost list, sharing other fields. */
function fromCosts(costs: readonly number[], over: Partial<ClassifiedTask> = {}): ClassifiedTask[] {
  return costs.map((cost) => makeTask({ ...over, cost }));
}

/** Fetch the single archetype row, asserting it exists. */
function row(result: FrontierResult, archetype: Archetype): ArchetypeFrontier {
  const r = result.byArchetype.find((x) => x.archetype === archetype);
  if (r === undefined) throw new Error(`no row for ${archetype}`);
  return r;
}

describe('computeFrontier — empty + degenerate inputs', () => {
  it('returns zeroed totals and no rows for empty input', () => {
    const result = computeFrontier([]);
    expect(result.byArchetype).toEqual([]);
    expect(result.realisedCost).toBe(0);
    expect(result.frontierCost).toBe(0);
    expect(result.recoverableWaste).toBe(0);
  });

  it('emits one row per archetype PRESENT, in canonical order', () => {
    const tasks = [
      ...repeat(1, { archetype: 'debugging' }),
      ...repeat(1, { archetype: 'research_qa' }),
      ...repeat(1, { archetype: 'other' }),
    ];
    const result = computeFrontier(tasks);
    // canonical union order: research_qa < debugging < other
    expect(result.byArchetype.map((r) => r.archetype)).toEqual([
      'research_qa',
      'debugging',
      'other',
    ]);
  });
});

describe('computeFrontier — min-archetype-sample boundary', () => {
  it('abstains at 7 tasks: counts only, no frontier, no waste', () => {
    const result = computeFrontier(
      repeat(MIN_ARCHETYPE_SAMPLE - 1, { archetype: 'greenfield', cost: 10 }),
    );
    const r = row(result, 'greenfield');
    expect(r.n).toBe(7);
    expect(r.abstained).toBe(true);
    expect(r.frontierModel).toBeNull();
    expect(r.frontierCostP50).toBeNull();
    expect(r.recoverableWaste).toBe(0);
    // realisedCostP50 is suppressed (null) for abstained rows (counts-only contract)
    expect(r.realisedCostP50).toBeNull();
    expect(result.recoverableWaste).toBe(0);
    expect(result.frontierCost).toBe(0);
  });

  it('produces a frontier at exactly 8 tasks (single qualifying model)', () => {
    const result = computeFrontier(
      repeat(MIN_ARCHETYPE_SAMPLE, { archetype: 'greenfield', cost: 10, dominantModel: 'opus' }),
    );
    const r = row(result, 'greenfield');
    expect(r.n).toBe(8);
    expect(r.abstained).toBe(false);
    expect(r.frontierModel).toBe('opus');
    expect(r.frontierCostP50).toBe(10);
    // incumbent already at frontier → no waste
    expect(r.recoverableWaste).toBe(0);
  });
});

describe('computeFrontier — success-rate floor (C4)', () => {
  it('never picks a cheaper model whose success rate is below RATE_FLOOR', () => {
    // cheap-model: 10 units, cost 1, only 5 successes (rate 0.5) → disqualified
    const cheap = [
      ...repeat(5, { archetype: 'debugging', cost: 1, dominantModel: 'cheap-model', outcome: 'success' }),
      ...repeat(5, { archetype: 'debugging', cost: 1, dominantModel: 'cheap-model', outcome: 'failed' }),
    ];
    // good-model: 10 units, cost 5, all success (rate 1.0) → qualifies
    const good = repeat(10, {
      archetype: 'debugging',
      cost: 5,
      dominantModel: 'good-model',
      outcome: 'success',
    });
    const result = computeFrontier([...cheap, ...good]);
    const r = row(result, 'debugging');
    expect(r.frontierModel).toBe('good-model');
    expect(r.frontierCostP50).toBe(5);
  });

  it('qualifies a model whose success rate is exactly RATE_FLOOR', () => {
    expect(RATE_FLOOR).toBe(0.7);
    // 10 units, 7 successes → rate 0.7 == floor → qualifies
    const tasks = [
      ...repeat(7, { archetype: 'mechanical_edit', cost: 4, dominantModel: 'border-model', outcome: 'success' }),
      ...repeat(3, { archetype: 'mechanical_edit', cost: 4, dominantModel: 'border-model', outcome: 'failed' }),
    ];
    const r = row(computeFrontier(tasks), 'mechanical_edit');
    expect(r.frontierModel).toBe('border-model');
    expect(r.frontierCostP50).toBe(4);
  });

  it('emits no frontier when no model clears MIN_MODEL_UNITS or the rate floor', () => {
    // 8 tasks (≥ sample) but split so no single model has 8 units
    const tasks = [
      ...repeat(4, { archetype: 'other', cost: 2, dominantModel: 'a' }),
      ...repeat(4, { archetype: 'other', cost: 2, dominantModel: 'b' }),
    ];
    const r = row(computeFrontier(tasks), 'other');
    expect(r.abstained).toBe(false);
    expect(r.frontierModel).toBeNull();
    expect(r.frontierCostP50).toBeNull();
    expect(r.recoverableWaste).toBe(0);
  });

  it('ignores null-model tasks as frontier candidates but still counts them', () => {
    const tasks = [
      ...repeat(8, { archetype: 'greenfield', cost: 9, dominantModel: 'opus', outcome: 'success' }),
      ...repeat(4, { archetype: 'greenfield', cost: 1, dominantModel: null, outcome: 'success' }),
    ];
    const r = row(computeFrontier(tasks), 'greenfield');
    expect(r.n).toBe(12);
    expect(r.frontierModel).toBe('opus'); // null tasks cannot be the frontier
    expect(r.frontierCostP50).toBe(9);
  });
});

describe('computeFrontier — waste accounting', () => {
  it('single-model incumbent already cheapest → recoverableWaste = 0', () => {
    const r = row(
      computeFrontier(repeat(8, { archetype: 'mechanical_edit', cost: 3, dominantModel: 'sonnet' })),
      'mechanical_edit',
    );
    expect(r.frontierCostP50).toBe(3);
    expect(r.recoverableWaste).toBe(0);
  });

  it('single-model archetype with above/below-median spread yields zero waste, zero comparable cost, and NO lever (cross-model honesty case)', () => {
    // Every success is on the SAME model (which is therefore the frontier). The
    // costs straddle the median, so a within-model waste rule would fabricate a
    // saving — but there is no cheaper model to route to, so the cross-model rule
    // must report exactly zero recoverable spend and emit no lever.
    const result = computeFrontier(
      fromCosts([1, 2, 3, 4, 5, 6, 7, 8], {
        archetype: 'debugging',
        dominantModel: 'solo-model',
        outcome: 'success',
      }),
    );
    const r = row(result, 'debugging');
    expect(r.frontierModel).toBe('solo-model');
    expect(r.frontierCostP50).toBe(4); // nearest-rank p50 of [1..8] = rank 4 → 4
    // No cross-model units ⇒ no waste and no comparable spend contributed.
    expect(r.recoverableWaste).toBe(0);
    expect(result.recoverableWaste).toBe(0);
    expect(result.realisedCost).toBe(0);
    expect(result.frontierCost).toBe(0);
    // And therefore no actionable lever.
    expect(deriveLevers(result)).toEqual([]);
  });

  it('sums waste over success units only, above the frontier', () => {
    // frontier model 'cheap' qualifies at p50 = 2; an expensive success-heavy
    // run sits above it; a failed expensive task contributes NO waste.
    const cheap = fromCosts([2, 2, 2, 2, 2, 2, 2, 2], {
      archetype: 'debugging',
      dominantModel: 'cheap',
      outcome: 'success',
    });
    const pricySuccess = fromCosts([10, 10], {
      archetype: 'debugging',
      dominantModel: 'pricey',
      outcome: 'success',
    });
    const pricyFailed = fromCosts([10], {
      archetype: 'debugging',
      dominantModel: 'pricey',
      outcome: 'failed',
    });
    const result = computeFrontier([...cheap, ...pricySuccess, ...pricyFailed]);
    const r = row(result, 'debugging');
    expect(r.frontierModel).toBe('cheap');
    expect(r.frontierCostP50).toBe(2);
    // two success units above frontier: (10-2)*2 = 16; failed task excluded
    expect(r.recoverableWaste).toBe(16);
    expect(result.recoverableWaste).toBe(16);
  });
});

describe('computeFrontier — percentile edges (nearest-rank)', () => {
  it('n=1: abstains, no p90/p95', () => {
    const r = row(computeFrontier(fromCosts([7], { archetype: 'other' })), 'other');
    expect(r.n).toBe(1);
    expect(r.abstained).toBe(true);
    expect(r.costP90).toBeNull();
    expect(r.costP95).toBeNull();
    // realisedCostP50 suppressed (null) for abstained rows
    expect(r.realisedCostP50).toBeNull();
  });

  it('n=2: abstains, still no p90/p95 (n < 20)', () => {
    const r = row(computeFrontier(fromCosts([3, 9], { archetype: 'other' })), 'other');
    expect(r.n).toBe(2);
    expect(r.abstained).toBe(true);
    expect(r.costP90).toBeNull();
    expect(r.costP95).toBeNull();
    // realisedCostP50 suppressed (null) for abstained rows
    expect(r.realisedCostP50).toBeNull();
  });

  it('n≥20: emits p90/p95 with pinned nearest-rank values', () => {
    // costs 1..20, all success, single qualifying model
    const costs = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = row(
      computeFrontier(fromCosts(costs, { archetype: 'debugging', dominantModel: 'opus', outcome: 'success' })),
      'debugging',
    );
    expect(r.n).toBe(20);
    expect(r.abstained).toBe(false);
    // nearest-rank: p50 rank ceil(.5*20)=10→10; p90 rank 18→18; p95 rank 19→19
    expect(r.realisedCostP50).toBe(10);
    expect(r.frontierCostP50).toBe(10);
    expect(r.costP90).toBe(18);
    expect(r.costP95).toBe(19);
    // Single-model archetype (all successes on the frontier model 'opus'): there
    // is no cheaper model to route to, so recoverableWaste is 0 — the above-median
    // spread is within-model variance, not recoverable. p90/p95 are unaffected
    // (they describe the archetype's success-cost distribution regardless of model).
    expect(r.recoverableWaste).toBe(0);
  });

  it('exactly 19 tasks still suppresses p90/p95 (boundary below 20)', () => {
    const costs = Array.from({ length: 19 }, (_, i) => i + 1);
    const r = row(
      computeFrontier(fromCosts(costs, { archetype: 'debugging', dominantModel: 'opus' })),
      'debugging',
    );
    expect(r.n).toBe(19);
    expect(r.costP90).toBeNull();
    expect(r.costP95).toBeNull();
  });
});

describe('computeFrontier — top-level aggregation', () => {
  it('realisedCost is the COMPARABLE (CROSS-MODEL) subset: success cost of units on a pricier-than-frontier model', () => {
    // realisedCost is Σ cost over success units that ran on a model OTHER than the
    // archetype frontier (the routable units). Units on the frontier model itself,
    // failed units, abstained archetypes, and non-frontiered archetypes all
    // contribute nothing.
    const tasks = [
      // debugging: cheap frontier (8 success @2) + a pricier model's 5 successes @10.
      ...fromCosts([2, 2, 2, 2, 2, 2, 2, 2], { archetype: 'debugging', dominantModel: 'cheap', outcome: 'success' }),
      ...fromCosts([10, 10, 10, 10, 10], { archetype: 'debugging', dominantModel: 'pricey', outcome: 'success' }),
      // failed pricier unit: not a success ⇒ never counts.
      ...fromCosts([10], { archetype: 'debugging', dominantModel: 'pricey', outcome: 'failed' }),
      // abstained singleton: excluded entirely (no qualifying frontier).
      ...repeat(1, { archetype: 'other', cost: 99 }),
      // non-abstained but NO qualifying frontier (split models, neither reaches
      // MIN_MODEL_UNITS=8): excluded — no proven cheaper baseline ⇒ not comparable.
      ...repeat(4, { archetype: 'greenfield', cost: 7, dominantModel: 'a' }),
      ...repeat(4, { archetype: 'greenfield', cost: 7, dominantModel: 'b' }),
    ];
    const result = computeFrontier(tasks);
    const r = row(result, 'debugging');
    expect(r.frontierModel).toBe('cheap');
    expect(r.frontierCostP50).toBe(2);
    // only the 5 cross-model 'pricey' successes contribute: 5 * 10 = 50.
    // The 8 'cheap' frontier units and the failed 'pricey' unit add nothing.
    expect(result.realisedCost).toBe(50);
  });

  it('reconciling identity holds for a genuine cross-model case: frontierCost = realisedCost − recoverableWaste', () => {
    const tasks = [
      // greenfield: cheap frontier 'haiku' (8 success @3) + pricier 'opus' (4 success @8).
      ...fromCosts([3, 3, 3, 3, 3, 3, 3, 3], { archetype: 'greenfield', dominantModel: 'haiku', outcome: 'success' }),
      ...fromCosts([8, 8, 8, 8], { archetype: 'greenfield', dominantModel: 'opus', outcome: 'success' }),
      // an abstained singleton — contributes nothing.
      ...repeat(1, { archetype: 'other', cost: 99 }),
    ];
    const result = computeFrontier(tasks);
    const r = row(result, 'greenfield');
    expect(r.frontierModel).toBe('haiku');
    expect(r.frontierCostP50).toBe(3);
    // cross-model 'opus' successes: comparable cost 4 * 8 = 32; waste 4 * (8-3) = 20.
    expect(result.realisedCost).toBe(32);
    expect(result.recoverableWaste).toBe(20);
    expect(result.frontierCost).toBe(result.realisedCost - result.recoverableWaste);
    expect(result.frontierCost).toBe(12);
  });

  it('comparable realisedCost counts cross-model SUCCESS units only, not failed units (B)', () => {
    // The frontier is a DIFFERENT, cheaper model ('cheap', 8 success @2). The
    // routable pricier model ('pricey') has 8 successes @10 plus 3 failed @100.
    // Only the 8 pricey SUCCESS costs are comparable; the failed @100 must not
    // enter realisedCost (a group-length bug would add them).
    const tasks = [
      ...fromCosts([2, 2, 2, 2, 2, 2, 2, 2], { archetype: 'debugging', dominantModel: 'cheap', outcome: 'success' }),
      ...fromCosts([10, 10, 10, 10, 10, 10, 10, 10], { archetype: 'debugging', dominantModel: 'pricey', outcome: 'success' }),
      ...fromCosts([100, 100, 100], { archetype: 'debugging', dominantModel: 'pricey', outcome: 'failed' }),
    ];
    const result = computeFrontier(tasks);
    const r = row(result, 'debugging');
    expect(r.frontierModel).toBe('cheap'); // 'cheap' p50=2 beats 'pricey' p50=10
    expect(r.frontierCostP50).toBe(2);
    // realisedCost = Σ cross-model success = 8 * 10 = 80; the 3 failed @100 excluded.
    // A group-length bug would yield 8*10 + 3*100 = 380.
    expect(result.realisedCost).toBe(80);
    // waste = 8 * (10 - 2) = 64.
    expect(r.recoverableWaste).toBe(64);
  });
});

describe('computeFrontier — MIN_MODEL_UNITS 7-vs-8 boundary (C)', () => {
  it('a model with only 7 success units is below MIN_MODEL_UNITS and cannot be the frontier', () => {
    const tasks = [
      // cheap model-a: 7 success units @1 (rate 1.0) — but 7 < MIN_MODEL_UNITS=8.
      ...fromCosts([1, 1, 1, 1, 1, 1, 1], { archetype: 'debugging', dominantModel: 'model-a', outcome: 'success' }),
      // pricier model-b: 8 success units @9 (rate 1.0) — clears the unit floor.
      ...fromCosts([9, 9, 9, 9, 9, 9, 9, 9], { archetype: 'debugging', dominantModel: 'model-b', outcome: 'success' }),
    ];
    const r = row(computeFrontier(tasks), 'debugging');
    expect(r.frontierModel).toBe('model-b'); // model-a disqualified on unit count
    expect(r.frontierCostP50).toBe(9);
  });

  it('mirror: 8 success units of the cheap model make it the frontier', () => {
    const tasks = [
      // cheap model-a now has exactly 8 units → qualifies and wins on price.
      ...fromCosts([1, 1, 1, 1, 1, 1, 1, 1], { archetype: 'debugging', dominantModel: 'model-a', outcome: 'success' }),
      ...fromCosts([9, 9, 9, 9, 9, 9, 9, 9], { archetype: 'debugging', dominantModel: 'model-b', outcome: 'success' }),
    ];
    const r = row(computeFrontier(tasks), 'debugging');
    expect(r.frontierModel).toBe('model-a');
    expect(r.frontierCostP50).toBe(1);
  });
});

describe('computeFrontier — observable-only qualification denominator (D, review M2)', () => {
  it('(i) unobservable units do NOT enter the qualification denominator — model qualifies', () => {
    // 8 success + 0 failed + 5 unobservable. Observable = 8 (≥ MIN_MODEL_UNITS),
    // rate = 8/8 = 1.0. If unobservable wrongly entered the denominator the rate
    // would be 8/13 ≈ 0.62 < RATE_FLOOR and the model would be disqualified.
    const tasks = [
      ...fromCosts([4, 4, 4, 4, 4, 4, 4, 4], { archetype: 'other', dominantModel: 'opus', outcome: 'success' }),
      ...repeat(5, { archetype: 'other', dominantModel: 'opus', outcome: 'unobservable', cost: 4 }),
    ];
    const r = row(computeFrontier(tasks), 'other');
    expect(r.frontierModel).toBe('opus');
    expect(r.frontierCostP50).toBe(4);
  });

  it('(ii) a sub-floor success rate is disqualified even when padded with many unobservable units', () => {
    // 6 success + 4 failed → observable rate 6/10 = 0.6 < RATE_FLOOR. The 50
    // unobservable units must not count as successes (which would lift the rate
    // to 56/60) nor swell the denominator — either way the model stays disqualified.
    const tasks = [
      ...fromCosts([2, 2, 2, 2, 2, 2], { archetype: 'other', dominantModel: 'flaky', outcome: 'success' }),
      ...fromCosts([2, 2, 2, 2], { archetype: 'other', dominantModel: 'flaky', outcome: 'failed' }),
      ...repeat(50, { archetype: 'other', dominantModel: 'flaky', outcome: 'unobservable', cost: 2 }),
    ];
    const r = row(computeFrontier(tasks), 'other');
    expect(r.abstained).toBe(false); // n = 60 ≥ MIN_ARCHETYPE_SAMPLE
    expect(r.frontierModel).toBeNull();
    expect(r.frontierCostP50).toBeNull();
    expect(r.recoverableWaste).toBe(0);
  });
});

describe('computeFrontier — percentiles are numeric, order-independent (E, review M5/H5)', () => {
  it('nearest-rank p50/p90/p95 match the sorted-rank answer for shuffled costs', () => {
    // A permutation of 1..20 in deliberately non-sorted order, with a 10 sitting
    // next to a 2 so a lexicographic ("10" < "2") sort would give different ranks.
    const shuffled = [5, 1, 19, 7, 3, 12, 10, 2, 16, 8, 20, 4, 14, 6, 18, 9, 11, 13, 15, 17];
    expect(shuffled).toHaveLength(20);
    const r = row(
      computeFrontier(fromCosts(shuffled, { archetype: 'debugging', dominantModel: 'opus', outcome: 'success' })),
      'debugging',
    );
    // numeric nearest-rank: p50 rank 10 → 10; p90 rank 18 → 18; p95 rank 19 → 19.
    expect(r.realisedCostP50).toBe(10);
    expect(r.frontierCostP50).toBe(10);
    expect(r.costP90).toBe(18);
    expect(r.costP95).toBe(19);
  });
});

describe('computeFrontier — tail percentiles gate on SUCCESS count (F, review M4)', () => {
  it('n ≥ 20 total but fewer than 20 successes → p90/p95 null', () => {
    // 15 successes + 10 failed = 25 total tasks, but only 15 observed successes.
    const tasks = [
      ...fromCosts(Array.from({ length: 15 }, (_, i) => i + 1), {
        archetype: 'debugging',
        dominantModel: 'opus',
        outcome: 'success',
      }),
      ...repeat(10, { archetype: 'debugging', dominantModel: 'opus', outcome: 'failed', cost: 5 }),
    ];
    const r = row(computeFrontier(tasks), 'debugging');
    expect(r.n).toBe(25);
    expect(r.abstained).toBe(false);
    expect(r.costP90).toBeNull();
    expect(r.costP95).toBeNull();
  });

  it('≥ 20 successes → both p90 and p95 present', () => {
    const tasks = fromCosts(Array.from({ length: 20 }, (_, i) => i + 1), {
      archetype: 'debugging',
      dominantModel: 'opus',
      outcome: 'success',
    });
    const r = row(computeFrontier(tasks), 'debugging');
    expect(r.costP90).toBe(18);
    expect(r.costP95).toBe(19);
  });
});

describe('computeFrontier — per-unit waste clamp at zero (J, review M4-source)', () => {
  it('below-frontier cross-model successes contribute zero waste; only above-p50 excess is summed', () => {
    // The cheaper frontier model establishes p50; the routable (cross-model)
    // model's units straddle it. Below-frontier units must clamp to 0, not
    // subtract — that is the max(0, …) guard under test.
    const tasks = [
      // frontier 'frontier-model': 8 success @5 → p50 = 5 (only qualifier).
      ...fromCosts([5, 5, 5, 5, 5, 5, 5, 5], { archetype: 'other', dominantModel: 'frontier-model', outcome: 'success' }),
      // routable 'pricey-model': 7 success straddling the frontier (so it cannot
      // itself qualify: 7 < MIN_MODEL_UNITS=8). Costs 1,2,3,4 are below the
      // frontier; 6,7,100 are above.
      ...fromCosts([1, 2, 3, 4, 6, 7, 100], { archetype: 'other', dominantModel: 'pricey-model', outcome: 'success' }),
    ];
    const r = row(computeFrontier(tasks), 'other');
    expect(r.frontierModel).toBe('frontier-model');
    expect(r.frontierCostP50).toBe(5);
    // Above-frontier excess only: (6-5)+(7-5)+(100-5) = 1+2+95 = 98. The four
    // below-frontier rows (1,2,3,4) clamp to 0; without the max(0,…) clamp their
    // negative terms would drag the sum down to Σ(cost) − 7*5 = 123 − 35 = 88.
    expect(r.recoverableWaste).toBe(98);
  });
});

describe('computeFrontier — property (seeded mulberry32)', () => {
  const ARCHETYPES: readonly Archetype[] = [
    'research_qa',
    'greenfield',
    'mechanical_edit',
    'debugging',
    'multi_file_refactor',
    'other',
  ];
  const OUTCOMES: readonly TaskOutcome[] = ['success', 'failed', 'in_flight', 'unobservable'];
  const MODELS: readonly (string | null)[] = ['opus', 'sonnet', 'haiku', null];

  function pick<T>(arr: readonly T[], rnd: () => number): T {
    const v = arr[Math.floor(rnd() * arr.length)];
    if (v === undefined) throw new Error('empty pick array');
    return v;
  }

  it('reconciling identity (realisedCost − frontierCost = waste), per-archetype-sum, and bounds hold over random inputs', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const count = Math.floor(rnd() * 120); // 0..119 tasks
      const tasks: ClassifiedTask[] = Array.from({ length: count }, () =>
        makeTask({
          cost: rnd() * 100, // non-negative
          archetype: pick(ARCHETYPES, rnd),
          outcome: pick(OUTCOMES, rnd),
          dominantModel: pick(MODELS, rnd),
        }),
      );

      const result = computeFrontier(tasks);
      const sumCost = tasks.reduce((s, t) => s + t.cost, 0);

      // realisedCost is the COMPARABLE subset now (not Σ all cost): 0 ≤ realisedCost ≤ Σ cost.
      expect(result.realisedCost).toBeGreaterThanOrEqual(0);
      expect(result.realisedCost).toBeLessThanOrEqual(sumCost + 1e-9);

      // reconciling identity: realisedCost − frontierCost === recoverableWaste.
      expect(result.realisedCost - result.frontierCost).toBeCloseTo(result.recoverableWaste, 9);

      // frontierCost bounds: 0 ≤ frontierCost ≤ realisedCost.
      expect(result.frontierCost).toBeGreaterThanOrEqual(-1e-9);
      expect(result.frontierCost).toBeLessThanOrEqual(result.realisedCost + 1e-9);

      // waste identity: top-level == Σ per-archetype.
      const sumArchetypeWaste = result.byArchetype.reduce((s, r) => s + r.recoverableWaste, 0);
      expect(result.recoverableWaste).toBeCloseTo(sumArchetypeWaste, 9);

      // waste bounds: 0 ≤ waste ≤ realisedCost.
      expect(result.recoverableWaste).toBeGreaterThanOrEqual(0);
      expect(result.recoverableWaste).toBeLessThanOrEqual(result.realisedCost + 1e-9);

      // per-archetype structural invariants
      for (const r of result.byArchetype) {
        expect(r.abstained).toBe(r.n < MIN_ARCHETYPE_SAMPLE);
        expect(r.recoverableWaste).toBeGreaterThanOrEqual(0);
        if (r.abstained) {
          expect(r.frontierModel).toBeNull();
          expect(r.frontierCostP50).toBeNull();
          expect(r.recoverableWaste).toBe(0);
        }
        if (r.frontierCostP50 === null) {
          expect(r.recoverableWaste).toBe(0);
        }
        // tail percentiles only at n ≥ 20, and monotonic when present
        if (r.n < 20) {
          expect(r.costP90).toBeNull();
          expect(r.costP95).toBeNull();
        }
        if (r.costP90 !== null && r.costP95 !== null) {
          // Tail percentiles imply ≥ 20 observed successes ⇒ realisedCostP50 is non-null.
          expect(r.realisedCostP50).not.toBeNull();
          expect(r.costP90).toBeGreaterThanOrEqual(r.realisedCostP50 ?? 0);
          expect(r.costP95).toBeGreaterThanOrEqual(r.costP90);
        }
      }
    }
  });
});
