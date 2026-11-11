/**
 * Cost per successful task by `(model, effort)` — the pure grouping.
 *
 * The same dominant-assignment rule `aggregateByModel` uses, one level finer:
 * success is a property of a task, not of a message, so each observable task is
 * assigned to the single `(model, effort)` cell that carried the largest share of
 * ITS cost, and the cell's rate and cost per successful task are computed over
 * the tasks assigned to it. The exact message-level spend per cell is reported
 * beside it (it does not depend on the assignment).
 *
 * Effort rules, the same as the rest of the effort reporting (`effort.ts`,
 * `effort-breakdown.ts`): the tier set is open, `null` means Claude Code
 * recorded no effort and is a bucket of its own, never folded into a tier, and
 * `effortTaggedShare` says how much of the spend sits outside that bucket.
 *
 * Gate: a cell with fewer observable tasks than the caller-supplied minimum is
 * `insufficient` and carries NO rate, mean or cost per successful task. The
 * caller passes `MIN_OBSERVABLE_FOR_MODEL_RATE`, the threshold the per-model
 * breakdown already uses; there is no second threshold.
 *
 * Pure; no I/O.
 */
import { compareEffort } from '@claude-stats/core/effort';
import type { CostByModelEffortEntry } from '../recap/types.js';
import type { TaskRecord } from './index.js';

/** `ok` rests on at least the minimum observable tasks; `insufficient` carries no figure. */
export type ModelEffortStatus = 'ok' | 'insufficient';

export interface ModelEffortCell {
  model: string;
  /** Reasoning-effort tier as Claude Code wrote it; `null` = not reported (its own row). */
  effort: string | null;
  /** Observable tasks whose dominant `(model, effort)` is this cell. */
  tasksObservable: number;
  /** Of those, the successful ones. */
  successCount: number;
  status: ModelEffortStatus;
  /** success / observable; null when `insufficient`. */
  successRate: number | null;
  /** Whole-task cost of the tasks assigned to this cell. */
  costObservable: number;
  /** Exact message-level cost in this cell across ALL observable tasks (independent of assignment). */
  costByCellExact: number;
  /** costObservable / tasksObservable; null when `insufficient`. */
  meanCostPerAttempt: number | null;
  /** costObservable / successCount; null when `insufficient` or nothing succeeded. */
  costPerSuccessfulTask: number | null;
}

export interface ModelEffortReport {
  /** Most expensive-to-succeed first (figures before `insufficient`), then model, then effort order. */
  cells: ModelEffortCell[];
  /** The minimum observable tasks a cell needs for a figure (echoed so a reader sees the gate). */
  minObservable: number;
  /**
   * Share of the observable tasks' exact message-level cost that sits on rows
   * carrying an effort tag (0 when there is no cost). The `effort: null` row is
   * the rest.
   */
  effortTaggedShare: number;
}

/**
 * The `(model, effort)` shares of a task's cost. A record built before the
 * per-effort split existed (or a cached digest item that lacks it) falls back to
 * its per-model split with `effort: null`: the effort is unknown, and unknown is
 * exactly what `null` means, so nothing is guessed into a tier.
 */
export function costByModelEffortOf(r: TaskRecord): readonly CostByModelEffortEntry[] {
  if (r.costByModelEffort !== undefined) return r.costByModelEffort;
  return Object.entries(r.costByModel).map(([model, cost]) => ({ model, effort: null, cost }));
}

/**
 * The cell carrying the largest share of a task's cost, or null when the task
 * has no priced model. Ties go to the lowest model id, then `compareEffort`, so
 * the choice never depends on input order.
 */
export function dominantModelEffort(
  entries: readonly CostByModelEffortEntry[],
): { model: string; effort: string | null } | null {
  let best: CostByModelEffortEntry | null = null;
  for (const e of entries) {
    if (best === null || e.cost > best.cost) {
      best = e;
    } else if (e.cost === best.cost) {
      const order = (e.model < best.model ? -1 : e.model > best.model ? 1 : 0) || compareEffort(e.effort, best.effort);
      if (order < 0) best = e;
    }
  }
  return best === null ? null : { model: best.model, effort: best.effort };
}

interface Acc {
  model: string;
  effort: string | null;
  tasksObservable: number;
  successCount: number;
  costObservable: number;
  costByCellExact: number;
}

/**
 * Group observable task records by `(model, effort)`.
 *
 * @param observableRecords  success ∪ failed records only (the caller filters;
 *   in-flight and unobservable tasks never enter a rate).
 * @param minObservable  the gate; pass `MIN_OBSERVABLE_FOR_MODEL_RATE`.
 */
export function aggregateByModelEffort(
  observableRecords: readonly TaskRecord[],
  minObservable: number,
): ModelEffortReport {
  // `\u0000` cannot occur in a model id or a shape-validated effort token, and
  // the trailing flag keeps `effort: null` apart from an effort named ''.
  const key = (model: string, effort: string | null): string =>
    `${model}\u0000${effort ?? ''}\u0000${effort === null ? 'n' : 's'}`;
  const cells = new Map<string, Acc>();
  const ensure = (model: string, effort: string | null): Acc => {
    const k = key(model, effort);
    let a = cells.get(k);
    if (!a) {
      a = { model, effort, tasksObservable: 0, successCount: 0, costObservable: 0, costByCellExact: 0 };
      cells.set(k, a);
    }
    return a;
  };

  let exactTotal = 0;
  let exactTagged = 0;
  for (const r of observableRecords) {
    const entries = costByModelEffortOf(r);
    const dom = dominantModelEffort(entries);
    if (dom !== null) {
      const a = ensure(dom.model, dom.effort);
      a.tasksObservable += 1;
      a.costObservable += r.cost;
      if (r.outcome === 'success') a.successCount += 1;
    }
    for (const e of entries) {
      ensure(e.model, e.effort).costByCellExact += e.cost;
      exactTotal += e.cost;
      if (e.effort !== null) exactTagged += e.cost;
    }
  }

  const rows: ModelEffortCell[] = [];
  for (const a of cells.values()) {
    // Placeholder-model cells (e.g. "<synthetic>") with nothing in them: skip, as
    // the per-model breakdown does.
    if (a.tasksObservable === 0 && a.costByCellExact === 0) continue;
    const enough = a.tasksObservable >= minObservable && a.tasksObservable > 0;
    rows.push({
      model: a.model,
      effort: a.effort,
      tasksObservable: a.tasksObservable,
      successCount: a.successCount,
      status: enough ? 'ok' : 'insufficient',
      successRate: enough ? a.successCount / a.tasksObservable : null,
      costObservable: a.costObservable,
      costByCellExact: a.costByCellExact,
      meanCostPerAttempt: enough ? a.costObservable / a.tasksObservable : null,
      costPerSuccessfulTask: enough && a.successCount > 0 ? a.costObservable / a.successCount : null,
    });
  }
  rows.sort(
    (x, y) =>
      (y.costPerSuccessfulTask ?? -1) - (x.costPerSuccessfulTask ?? -1) ||
      (x.model < y.model ? -1 : x.model > y.model ? 1 : 0) ||
      compareEffort(x.effort, y.effort),
  );
  return {
    cells: rows,
    minObservable,
    effortTaggedShare: exactTotal > 0 ? exactTagged / exactTotal : 0,
  };
}
