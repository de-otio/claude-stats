/**
 * Efficiency-frontier report assembler (pure DI orchestrator, T5).
 *
 * Consumes already-classified tasks and delegates to injected pure functions
 * (`computeFrontier`, `deriveLevers`). The archetype classification step is
 * intentionally excluded: `classify` needs `DailyDigestItem` fields
 * (`toolHistogram`, `filePathsTouched`, `duration`) that are not present on
 * `ClassifiedTask`, so classification runs upstream (T6) where those fields
 * are in scope. This preserves the structural privacy gate (plan A5): this
 * module never imports `DailyDigestItem`.
 *
 * Plan: ../../../../plans/value-per-cost/README.md §1
 * Privacy: plan A4/A5, security F1/F2/F6 — every `EfficiencyReport` leaf is
 * a number or a fixed-enum string. No prompt text, file paths, project names,
 * or session ids may flow through this function.
 */
import type {
  ClassifiedTask,
  EfficiencyDeps,
  EfficiencyReport,
} from './types.js';

/**
 * Assemble an `EfficiencyReport` from pre-classified tasks.
 *
 * **Signature rationale (recorded assumption for T6):** the full
 * `EfficiencyDeps` interface includes `classify`, which accepts a
 * `ClassifyInput` (fields from `DailyDigestItem`). Those fields are not
 * carried by `ClassifiedTask`, so `classify` cannot be called here. T6 runs
 * `deps.classify` per item before calling this function and passes the
 * resulting `ClassifiedTask[]` directly. This function therefore takes only
 * `Pick<EfficiencyDeps, 'computeFrontier' | 'deriveLevers'>`.
 *
 * @param tasks   Pre-classified tasks. Each carries `cost`, `archetype`,
 *                `outcome`, and `dominantModel`. Order is irrelevant.
 * @param deps    `computeFrontier` + `deriveLevers` from `EfficiencyDeps`.
 *                Pass the real implementations in production; pass stubs in
 *                tests (see `cost-per-task-efficiency.test.ts`).
 */
export function buildEfficiencyReport(
  tasks: readonly ClassifiedTask[],
  deps: Pick<EfficiencyDeps, 'computeFrontier' | 'deriveLevers'>,
): EfficiencyReport {
  const frontier = deps.computeFrontier(tasks);
  const levers = deps.deriveLevers(frontier);
  return {
    basis: 'completion_proxy',
    realisedCost: frontier.realisedCost,
    frontierCost: frontier.frontierCost,
    recoverableWaste: frontier.recoverableWaste,
    byArchetype: frontier.byArchetype,
    levers,
  };
}
