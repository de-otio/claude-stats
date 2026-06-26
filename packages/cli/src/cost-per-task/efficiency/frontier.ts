/**
 * T3 — the efficiency frontier core (`computeFrontier`).
 *
 * Pure. Groups classified tasks by archetype and, per archetype, finds the
 * QUALIFYING frontier model — the model that, on that archetype, has
 * ≥ MIN_MODEL_UNITS observed units AND a success rate ≥ RATE_FLOOR — then takes
 * its p50 (nearest-rank median) cost-per-success as the frontier cost. The whole
 * point of the rate floor (plan C4) is that a cheap-but-failing model can never
 * be picked as the frontier. `recoverableWaste` is a CROSS-MODEL routing
 * estimate: it sums, over success units that ran on a PRICIER model than the
 * frontier, how far each sat above the frontier cost. Units already on the
 * frontier model are excluded — within-model variance is not recoverable by
 * routing (and counting it fabricates savings on a single-model workload).
 *
 * Honesty guards (plan §4):
 *  - abstain below MIN_ARCHETYPE_SAMPLE tasks (counts only — no frontier/waste);
 *  - nearest-rank percentiles, pinned and deterministic;
 *  - tail percentiles (p90/p95) emitted only at archetype n ≥ 20 (security F7);
 *  - 0 ≤ recoverableWaste ≤ Σ cost, by construction (every waste term is
 *    max(0, cost − frontier) ≤ cost, summed over a subset of non-negative costs).
 *
 * PRIVACY: input `ClassifiedTask` is the internal projection; every field this
 * module emits is a number, a model-name string, or an `Archetype` enum — no
 * paths, prompt text, project names, or session ids (security F1/F2).
 *
 * Plan: ../../../../plans/value-per-cost/README.md (§4, task T3)
 */
import {
  MIN_ARCHETYPE_SAMPLE,
  MIN_MODEL_UNITS,
  RATE_FLOOR,
  type Archetype,
  type ArchetypeFrontier,
  type ClassifiedTask,
  type FrontierResult,
} from './types.js';

/**
 * Canonical, fixed archetype iteration order (the `Archetype` union order). Pins
 * `byArchetype` ordering so the output is deterministic regardless of input order.
 */
const ARCHETYPE_ORDER: readonly Archetype[] = [
  'research_qa',
  'greenfield',
  'mechanical_edit',
  'debugging',
  'multi_file_refactor',
  'other',
];

/** Tail percentiles (p90/p95) are emitted only when an archetype has ≥ this many tasks (security F7). */
const TAIL_PERCENTILE_MIN_N = 20;

/** Ascending numeric copy — never mutates the input. */
function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Nearest-rank percentile (the pinned method, plan H2). `sortedAsc` must be
 * ascending and non-empty; `p` is in (0, 100]. Rank = ceil(p/100 · n), 1-indexed,
 * clamped to [1, n]; returns the value at that rank.
 */
function nearestRank(sortedValues: readonly number[], p: number): number {
  const n = sortedValues.length;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank, 1), n) - 1;
  const v = sortedValues[idx];
  if (v === undefined) throw new Error('nearestRank: empty input');
  return v;
}

/**
 * Pick the qualifying frontier model for one archetype group. A model qualifies
 * iff it has ≥ MIN_MODEL_UNITS OBSERVABLE units (success ∪ failed) of that model
 * on this archetype AND its success rate (success / observable units) ≥
 * RATE_FLOOR. Held-out in_flight/unobservable units count neither for nor
 * against qualification (review M2 — matches the project's observable-only
 * success-rate convention). Among qualifiers, the one with the lowest p50
 * cost-per-success wins; ties broken by model name ascending (deterministic).
 * Null-model tasks cannot be a frontier.
 */
function selectFrontier(group: readonly ClassifiedTask[]): {
  readonly frontierModel: string | null;
  readonly frontierCostP50: number | null;
} {
  const byModel = new Map<string, ClassifiedTask[]>();
  for (const t of group) {
    if (t.dominantModel === null) continue;
    const arr = byModel.get(t.dominantModel);
    if (arr === undefined) byModel.set(t.dominantModel, [t]);
    else arr.push(t);
  }

  const entries = [...byModel.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  let frontierModel: string | null = null;
  let frontierCostP50: number | null = null;
  for (const [model, units] of entries) {
    // Gate over OBSERVABLE units (success ∪ failed); held-out outcomes are
    // excluded from both the min-units count and the rate denominator (M2).
    const observable = units.filter(
      (t) => t.outcome === 'success' || t.outcome === 'failed',
    );
    if (observable.length < MIN_MODEL_UNITS) continue;
    const successes = units.filter((t) => t.outcome === 'success');
    if (successes.length / observable.length < RATE_FLOOR) continue;
    // Qualifies ⇒ success rate ≥ RATE_FLOOR ⇒ successes.length > 0, so p50 exists.
    const p50 = nearestRank(sortedAsc(successes.map((t) => t.cost)), 50);
    if (frontierCostP50 === null || p50 < frontierCostP50) {
      frontierCostP50 = p50;
      frontierModel = model;
    }
  }
  return { frontierModel, frontierCostP50 };
}

/**
 * Compute the efficiency frontier across classified tasks. PURE; never mutates
 * `tasks`. See module header for the rules and invariants.
 */
export function computeFrontier(tasks: readonly ClassifiedTask[]): FrontierResult {
  const byArchetype: ArchetypeFrontier[] = [];

  // The headline trio ranges over the COMPARABLE set: success units in
  // non-abstained archetypes that have a qualifying cheaper frontier. Defining
  // realisedCost on that subset (not all spend) is what makes the three numbers
  // reconcile — realisedCost − frontierCost = recoverableWaste, with
  // frontierCost = realisedCost − recoverableWaste ≥ 0 (review H1).
  let realisedCost = 0;
  let totalRecoverableWaste = 0;

  for (const archetype of ARCHETYPE_ORDER) {
    const group = tasks.filter((t) => t.archetype === archetype);
    const n = group.length;
    if (n === 0) continue; // one row per archetype PRESENT in the window
    const abstained = n < MIN_ARCHETYPE_SAMPLE;

    const successUnits = group.filter((t) => t.outcome === 'success');
    const successCostsAsc = sortedAsc(successUnits.map((t) => t.cost));
    const hasSuccess = successCostsAsc.length > 0;

    // realisedCostP50: median cost-per-success — a descriptive stat, suppressed
    // (null) for abstained rows (counts-only contract, review M3) and when the
    // archetype has no observed successes.
    const realisedCostP50 =
      !abstained && hasSuccess ? nearestRank(successCostsAsc, 50) : null;

    // Tail percentiles share the success-unit cost set and are gated on the
    // SUCCESS count ≥ 20 (review M4) so they can never surface an individual
    // task's cost; never emitted for abstained rows.
    const tailEligible =
      !abstained && successCostsAsc.length >= TAIL_PERCENTILE_MIN_N;
    const costP90 = tailEligible ? nearestRank(successCostsAsc, 90) : null;
    const costP95 = tailEligible ? nearestRank(successCostsAsc, 95) : null;

    if (abstained) {
      byArchetype.push({
        archetype,
        n,
        frontierModel: null,
        frontierCostP50: null,
        realisedCostP50,
        costP90,
        costP95,
        recoverableWaste: 0,
        abstained: true,
      });
      continue;
    }

    const { frontierModel, frontierCostP50 } = selectFrontier(group);

    // recoverableWaste is a CROSS-MODEL routing estimate: Σ over success units
    // that ran on a PRICIER model than the archetype's frontier, of
    // max(0, cost − frontierCostP50). Units already on the frontier model are
    // excluded — their above-median spread is within-model task-size variance,
    // not recoverable by routing, and counting it fabricates a saving that
    // evaporates on a single-model workload (caught by exercising the feature).
    // Only the routable (cross-model) units contribute to the comparable
    // realisedCost, so the trio still reconciles.
    let recoverableWaste = 0;
    if (frontierModel !== null && frontierCostP50 !== null) {
      for (const u of successUnits) {
        if (u.dominantModel === frontierModel) continue; // nothing cheaper to route to
        const over = u.cost - frontierCostP50;
        if (over > 0) recoverableWaste += over;
        realisedCost += u.cost;
      }
      totalRecoverableWaste += recoverableWaste;
    }

    byArchetype.push({
      archetype,
      n,
      frontierModel,
      frontierCostP50,
      realisedCostP50,
      costP90,
      costP95,
      recoverableWaste,
      abstained: false,
    });
  }

  // frontierCost is the irreducible floor of the comparable spend after routing
  // each comparable success to its archetype frontier. By construction every
  // per-archetype waste term ≤ that archetype's comparable spend, so
  // 0 ≤ totalRecoverableWaste ≤ realisedCost and 0 ≤ frontierCost ≤ realisedCost.
  const frontierCost = realisedCost - totalRecoverableWaste;

  return {
    byArchetype,
    realisedCost,
    frontierCost,
    recoverableWaste: totalRecoverableWaste,
  };
}
