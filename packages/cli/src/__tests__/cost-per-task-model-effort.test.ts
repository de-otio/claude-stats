/**
 * Cost per successful task by (model, effort): the pure grouping and the gate.
 *
 * Fixture: two models x three effort tiers, plus the untagged (`null`) bucket for
 * each. Per-cell task counts and costs are chosen so every assertion is a
 * literal that a wrong grouping, a folded `null`, or a moved gate would change.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  MIN_OBSERVABLE_FOR_MODEL_RATE,
  type TaskOutcome,
  type TaskRecord,
} from '../cost-per-task/index.js';
import {
  aggregateByModelEffort,
  costByModelEffortOf,
  dominantModelEffort,
  type ModelEffortCell,
} from '../cost-per-task/model-effort.js';
import type { CostByModelEffortEntry } from '../recap/types.js';

const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-2';
const MIN = MIN_OBSERVABLE_FOR_MODEL_RATE;

let n = 0;
/** A task whose whole cost sits in one (model, effort) cell. */
function task(model: string, effort: string | null, outcome: TaskOutcome, cost: number): TaskRecord {
  return taskOf([{ model, effort, cost }], outcome);
}
function taskOf(entries: CostByModelEffortEntry[], outcome: TaskOutcome): TaskRecord {
  const costByModel: Record<string, number> = {};
  let cost = 0;
  for (const e of entries) {
    costByModel[e.model] = (costByModel[e.model] ?? 0) + e.cost;
    cost += e.cost;
  }
  n += 1;
  return {
    id: `t${n}`,
    project: '/p',
    cost,
    costByModel,
    costByModelEffort: entries,
    dominantModel: null,
    outcome,
    labelled: false,
    confidence: 'low',
    archetype: 'other',
  };
}
/** `succ` successes and `fail` failures in a cell, each task costing `cost`. */
function cell(model: string, effort: string | null, succ: number, fail: number, cost: number): TaskRecord[] {
  return [
    ...Array.from({ length: succ }, () => task(model, effort, 'success', cost)),
    ...Array.from({ length: fail }, () => task(model, effort, 'failed', cost)),
  ];
}
function find(cells: ModelEffortCell[], model: string, effort: string | null): ModelEffortCell {
  const c = cells.find((x) => x.model === model && x.effort === effort);
  if (!c) throw new Error(`no cell ${model}/${effort}`);
  return c;
}

// Two models x three efforts + null each. Costs per task are distinct per cell.
const FIXTURE: TaskRecord[] = [
  ...cell(FABLE, 'low', 6, 4, 1), //      10 tasks (== MIN): 60% , 10/6
  ...cell(FABLE, 'medium', 12, 3, 2), //  15 tasks: 80%, 30/12 = 2.5
  ...cell(FABLE, 'high', 9, 6, 4), //     15 tasks: 60%, 60/9
  ...cell(FABLE, null, 10, 2, 3), //      12 tasks, untagged: 10/12, 36/10 = 3.6
  ...cell(OPUS, 'low', 3, 6, 1), //        9 tasks (== MIN - 1): insufficient
  ...cell(OPUS, 'medium', 14, 6, 3), //   20 tasks: 70%, 60/14
  ...cell(OPUS, 'high', 5, 5, 6), //      10 tasks: 50%, 60/5 = 12
  ...cell(OPUS, null, 2, 1, 5), //         3 tasks, untagged: insufficient
];

describe('aggregateByModelEffort: grouping', () => {
  const report = aggregateByModelEffort(FIXTURE, MIN);

  it('has one cell per (model, effort) pair seen, with null as its own row', () => {
    expect(report.cells).toHaveLength(8);
    const keys = report.cells.map((c) => `${c.model}/${c.effort}`).sort();
    expect(keys).toEqual(
      [
        `${FABLE}/high`, `${FABLE}/low`, `${FABLE}/medium`, `${FABLE}/null`,
        `${OPUS}/high`, `${OPUS}/low`, `${OPUS}/medium`, `${OPUS}/null`,
      ].sort(),
    );
    expect(report.minObservable).toBe(MIN);
  });

  it('reports per-cell task counts, successes and rates', () => {
    const fm = find(report.cells, FABLE, 'medium');
    expect(fm.tasksObservable).toBe(15);
    expect(fm.successCount).toBe(12);
    expect(fm.status).toBe('ok');
    expect(fm.successRate).toBeCloseTo(0.8, 12);

    const oh = find(report.cells, OPUS, 'high');
    expect(oh.tasksObservable).toBe(10);
    expect(oh.successCount).toBe(5);
    expect(oh.successRate).toBeCloseTo(0.5, 12);
  });

  it('reports per-cell cost and cost per successful task as total cell cost over successes', () => {
    const fm = find(report.cells, FABLE, 'medium'); // 15 tasks x $2 = $30, 12 successes
    expect(fm.costObservable).toBeCloseTo(30, 12);
    expect(fm.costByCellExact).toBeCloseTo(30, 12);
    expect(fm.meanCostPerAttempt).toBeCloseTo(2, 12);
    expect(fm.costPerSuccessfulTask).toBeCloseTo(2.5, 12);

    const oh = find(report.cells, OPUS, 'high'); // 10 x $6 = $60, 5 successes
    expect(oh.costObservable).toBeCloseTo(60, 12);
    expect(oh.costPerSuccessfulTask).toBeCloseTo(12, 12);

    const fl = find(report.cells, FABLE, 'low'); // 10 x $1, 6 successes
    expect(fl.costPerSuccessfulTask).toBeCloseTo(10 / 6, 12);
  });

  it('keeps the untagged bucket out of every tier: tier cells hold only their own tasks', () => {
    const untagged = find(report.cells, FABLE, null);
    expect(untagged.tasksObservable).toBe(12);
    expect(untagged.successCount).toBe(10);
    expect(untagged.costPerSuccessfulTask).toBeCloseTo(3.6, 12);
    // If null were folded into a tier these would be 22 / 27 / 27.
    expect(find(report.cells, FABLE, 'low').tasksObservable).toBe(10);
    expect(find(report.cells, FABLE, 'medium').tasksObservable).toBe(15);
    expect(find(report.cells, FABLE, 'high').tasksObservable).toBe(15);
    // And an effort literally named '' is not the null bucket.
    const withEmpty = aggregateByModelEffort([...FIXTURE, ...cell(FABLE, '', 10, 0, 1)], MIN);
    expect(find(withEmpty.cells, FABLE, null).tasksObservable).toBe(12);
    expect(find(withEmpty.cells, FABLE, '').tasksObservable).toBe(10);
  });

  it('reports the effort-tagged share of exact spend (null excluded)', () => {
    // Tagged: 10 + 30 + 60 + 9 + 60 + 60 = 229. Untagged: 36 + 15 = 51. Total 280.
    expect(report.effortTaggedShare).toBeCloseTo(229 / 280, 12);
  });

  it('conserves exact spend: cells sum to the per-model exact spend of the same records', () => {
    const cellsTotal = report.cells.reduce((s, c) => s + c.costByCellExact, 0);
    const byModel = aggregate(FIXTURE, 'month', 0, 0, true).byModel;
    expect(cellsTotal).toBeCloseTo(byModel.reduce((s, m) => s + m.costByModelExact, 0), 9);
    expect(cellsTotal).toBeCloseTo(280, 9);
  });
});

describe('aggregateByModelEffort: the minimum-sample gate', () => {
  const report = aggregateByModelEffort(FIXTURE, MIN);

  it('is ok at exactly the threshold', () => {
    const c = find(report.cells, FABLE, 'low'); // 10 observable == MIN
    expect(MIN).toBe(10);
    expect(c.tasksObservable).toBe(MIN);
    expect(c.status).toBe('ok');
    expect(c.successRate).not.toBeNull();
    expect(c.costPerSuccessfulTask).not.toBeNull();
  });

  it('is insufficient one below the threshold, with no rate, mean or cost figure', () => {
    const c = find(report.cells, OPUS, 'low'); // 9 observable == MIN - 1
    expect(c.tasksObservable).toBe(MIN - 1);
    expect(c.status).toBe('insufficient');
    expect(c.successRate).toBeNull();
    expect(c.meanCostPerAttempt).toBeNull();
    expect(c.costPerSuccessfulTask).toBeNull();
    // Counts and exact spend stay: they are what says why it is insufficient.
    expect(c.successCount).toBe(3);
    expect(c.costByCellExact).toBeCloseTo(9, 12);
  });

  it('gates the untagged row the same way', () => {
    const c = find(report.cells, OPUS, null); // 3 observable
    expect(c.status).toBe('insufficient');
    expect(c.costPerSuccessfulTask).toBeNull();
  });

  it('uses the gate it is given: the same data at a lower minimum turns the cell ok', () => {
    const lowered = aggregateByModelEffort(FIXTURE, 9);
    expect(find(lowered.cells, OPUS, 'low').status).toBe('ok');
    expect(find(lowered.cells, OPUS, 'low').costPerSuccessfulTask).toBeCloseTo(9 / 3, 12);
  });

  it('an ok cell with no successes has a rate of 0 and no cost per successful task', () => {
    const r = aggregateByModelEffort(cell(FABLE, 'high', 0, MIN, 4), MIN);
    const c = find(r.cells, FABLE, 'high');
    expect(c.status).toBe('ok');
    expect(c.successRate).toBe(0);
    expect(c.costPerSuccessfulTask).toBeNull();
  });
});

describe('aggregateByModelEffort: assignment and fallbacks', () => {
  it('assigns a mixed task to the cell carrying most of its cost, and still counts its spend in every cell', () => {
    const mixed = taskOf(
      [
        { model: FABLE, effort: 'medium', cost: 3 },
        { model: OPUS, effort: null, cost: 1 },
      ],
      'success',
    );
    const r = aggregateByModelEffort([mixed], MIN);
    const fm = find(r.cells, FABLE, 'medium');
    expect(fm.tasksObservable).toBe(1);
    expect(fm.costObservable).toBeCloseTo(4, 12); // whole-task cost goes to the dominant cell
    expect(fm.costByCellExact).toBeCloseTo(3, 12);
    const on = find(r.cells, OPUS, null);
    expect(on.tasksObservable).toBe(0); // dominated elsewhere: no task, but its spend is shown
    expect(on.costByCellExact).toBeCloseTo(1, 12);
  });

  it('breaks a cost tie by model then effort order, independent of input order', () => {
    const a: CostByModelEffortEntry = { model: FABLE, effort: 'high', cost: 1 };
    const b: CostByModelEffortEntry = { model: FABLE, effort: 'low', cost: 1 };
    const c: CostByModelEffortEntry = { model: OPUS, effort: 'low', cost: 1 };
    expect(dominantModelEffort([c, b, a])).toEqual({ model: FABLE, effort: 'low' });
    expect(dominantModelEffort([a, b, c])).toEqual({ model: FABLE, effort: 'low' });
    expect(dominantModelEffort([])).toBeNull();
  });

  it('reads a record with no per-effort split as effort unknown (null), never a tier', () => {
    const legacy: TaskRecord = { ...task(FABLE, 'high', 'success', 5), costByModelEffort: undefined, costByModel: { [FABLE]: 5 } };
    expect(costByModelEffortOf(legacy)).toEqual([{ model: FABLE, effort: null, cost: 5 }]);
    const r = aggregateByModelEffort(Array.from({ length: MIN }, () => ({ ...legacy })), MIN);
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]).toMatchObject({ model: FABLE, effort: null, status: 'ok' });
    expect(r.effortTaggedShare).toBe(0);
  });

  it('drops a cell with neither tasks nor spend (placeholder model), and reports 0 coverage for zero spend', () => {
    const r = aggregateByModelEffort(
      [taskOf([{ model: FABLE, effort: 'low', cost: 2 }, { model: '<synthetic>', effort: null, cost: 0 }], 'success')],
      MIN,
    );
    expect(r.cells.map((c) => c.model)).toEqual([FABLE]);
    const zero = aggregateByModelEffort([taskOf([{ model: '<synthetic>', effort: null, cost: 0 }], 'success')], MIN);
    expect(zero.effortTaggedShare).toBe(0);
    const empty = aggregateByModelEffort([], MIN);
    expect(empty.cells).toEqual([]);
    expect(empty.effortTaggedShare).toBe(0);
  });

  it('orders figures first (dearest per success first), then the insufficient cells', () => {
    const report = aggregateByModelEffort(FIXTURE, MIN);
    const withFigure = report.cells.filter((c) => c.costPerSuccessfulTask !== null);
    const figs = withFigure.map((c) => c.costPerSuccessfulTask as number);
    expect([...figs].sort((x, y) => y - x)).toEqual(figs);
    const firstInsufficient = report.cells.findIndex((c) => c.costPerSuccessfulTask === null);
    expect(report.cells.slice(firstInsufficient).every((c) => c.costPerSuccessfulTask === null)).toBe(true);
  });
});

describe('aggregate(..., groupBy)', () => {
  it("adds byModelEffort only for 'model_effort', and only over observable tasks", () => {
    const records = [
      ...FIXTURE,
      ...Array.from({ length: 40 }, () => task(FABLE, 'high', 'in_flight', 100)), // held out
      ...Array.from({ length: 40 }, () => task(FABLE, 'high', 'unobservable', 100)), // held out
    ];
    const plain = aggregate(records, 'month', 0, 0, true);
    expect(plain.byModelEffort).toBeUndefined();
    expect('byModelEffort' in plain).toBe(false);
    const model = aggregate(records, 'month', 0, 0, true, 'model');
    expect('byModelEffort' in model).toBe(false);

    const grouped = aggregate(records, 'month', 0, 0, true, 'model_effort');
    expect(grouped.byModelEffort).toBeDefined();
    // The held-out tasks would push Fable/high to 95 tasks if they leaked in.
    expect(find(grouped.byModelEffort!.cells, FABLE, 'high').tasksObservable).toBe(15);
    // The headline and the per-model rows are untouched by the new option.
    expect(grouped.byModel).toEqual(plain.byModel);
    expect(grouped.costPerSuccessfulTask).toBe(plain.costPerSuccessfulTask);
  });
});
