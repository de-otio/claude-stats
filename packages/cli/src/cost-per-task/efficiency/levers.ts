/**
 * Lever derivation for the value-per-cost efficiency frontier (Phase 1).
 *
 * Produces a ranked list of actionable `Lever` values from the frontier result.
 * Pure function: no I/O, no Date.now, no Math.random, no free-text strings.
 *
 * Security (plan §1 / F1 / F2): the `Lever` type carries ONLY enum kind values,
 * model-name strings, and numbers — no prompt text, file paths, project names, or
 * session ids. Human-readable descriptions are rendered at the template/CLI layer
 * from `kind`; they are never stored in the payload here.
 *
 * Plan: ../../../../../plans/value-per-cost/README.md
 */
import type { ArchetypeFrontier, Lever } from './types.js';

/**
 * Derive ranked levers from the frontier result.
 *
 * For each non-abstained archetype where a frontier model exists and
 * `recoverableWaste > 0`, emits a `route_by_archetype` lever carrying the
 * frontier model as `toModel` and the recoverable waste as `estSavingUsd`.
 * Levers are sorted by `estSavingUsd` descending (highest saving first).
 *
 * The `default_effort_down`, `cache_hygiene`, and `stop_after_repairs` kinds
 * are reserved for future inputs (plan §7-E) and are not emitted here since
 * their input signals are not yet available in this slice.
 *
 * @param frontier - Object with `byArchetype` array from `computeFrontier`.
 * @returns Ranked array of levers; empty when no archetype qualifies.
 */
export function deriveLevers(frontier: {
  readonly byArchetype: readonly ArchetypeFrontier[];
}): Lever[] {
  const levers: Lever[] = [];

  for (const row of frontier.byArchetype) {
    if (row.abstained) continue;
    if (row.frontierModel === null) continue;
    if (row.recoverableWaste <= 0) continue;

    levers.push({
      kind: 'route_by_archetype',
      archetype: row.archetype,
      toModel: row.frontierModel,
      estSavingUsd: row.recoverableWaste,
    });
  }

  // Rank by estimated saving, highest first.
  levers.sort((a, b) => (b.estSavingUsd ?? 0) - (a.estSavingUsd ?? 0));

  return levers;
}
