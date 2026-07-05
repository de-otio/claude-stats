/**
 * Shared contract for the value-per-cost efficiency frontier (Phase 1).
 *
 * This is the single dependency every other efficiency module builds against
 * (archetype classifier, frontier computation, lever derivation, the DI
 * orchestrator). It owns the closed archetype/effort/lever enums, the report
 * shape surfaced beside the cost-per-task headline, and the dependency-injection
 * seam (`EfficiencyDeps`) that keeps the four pure modules independently
 * testable.
 *
 * Plan: ../../../../plans/value-per-cost/README.md
 * Analysis: ../../../../doc/analysis/value-per-cost/
 *
 * PRIVACY (load-bearing, plan A4/A5, security F1/F2/F6): the outward-facing
 * types — `ArchetypeFrontier`, `Lever`, `EfficiencyReport` — may carry ONLY
 * numbers, model-name strings, and values from the fixed `Archetype` /
 * `EffortTier` / `Lever['kind']` enum sets. No prompt text, file paths, project
 * names, or session ids may appear in any of their leaves. These types flow to
 * the read-only MCP server and the `serve` LAN path; a single prompt substring
 * or path leaking into them would break the project's local-only guarantee.
 * `ClassifiedTask` is the INTERNAL intermediate and must never escape into a
 * report (see its doc comment).
 */
import type { TaskOutcome } from '../outcome-types.js';
import type { DailyDigestItem } from '../../recap/types.js';

/**
 * Closed set of task archetypes (plan §4). Rules-based, first-match,
 * deterministic over fields already on `DailyDigestItem`. `other` is the total
 * fallback when no rule fires.
 */
export type Archetype =
  | 'research_qa'
  | 'greenfield'
  | 'mechanical_edit'
  | 'debugging'
  | 'multi_file_refactor'
  | 'other';

/**
 * Effort tier — carried for the future effort axis (plan A2). It is `null` at
 * every use site in this slice (recording it needs a scanner/schema change +
 * backfill, §7-B); computing the frontier over `model × archetype` now keeps
 * that change purely additive later.
 */
export type EffortTier = 'low' | 'medium' | 'high';

/**
 * INTERNAL intermediate for the efficiency module's pure functions (plan §1,
 * security F2). It carries the minimal per-task projection the frontier needs.
 *
 * It MUST NOT carry `project`, `filePathsTouched`, `sessionIds`, or
 * `firstPrompt`, and it MUST NEVER appear inside `EfficiencyReport` or
 * `ArchetypeFrontier`. It exists only to flow between `classify` →
 * `computeFrontier`; the report leaves are numbers + enums only.
 */
export interface ClassifiedTask {
  readonly cost: number;
  readonly archetype: Archetype;
  readonly outcome: TaskOutcome;
  /** Model with the largest cost share for this task (proxy for who did it). */
  readonly dominantModel: string | null;
}

/**
 * Per-archetype frontier result — NUMBERS + enum only (security F1/F2). One row
 * per archetype present in the window.
 */
export interface ArchetypeFrontier {
  readonly archetype: Archetype;
  /** Number of tasks classified into this archetype (all outcomes). */
  readonly n: number;
  /** The qualifying frontier model (≥ MIN_MODEL_UNITS units, success ≥ RATE_FLOOR); null when none qualifies or abstained. */
  readonly frontierModel: string | null;
  /** p50 (median) cost-per-success of the frontier model; null when no frontier. */
  readonly frontierCostP50: number | null;
  /** Realised median cost-per-success across all models for this archetype; null when abstained or no observed successes (counts-only contract, review M3). */
  readonly realisedCostP50: number | null;
  /** Nearest-rank p90 cost — emitted only at n ≥ 20 (security F7), else null. */
  readonly costP90: number | null;
  /** Nearest-rank p95 cost — emitted only at n ≥ 20 (security F7), else null. */
  readonly costP95: number | null;
  /** Cross-model routing estimate: Σ over success units on a PRICIER model than the frontier of max(0, cost − frontierCostP50). Units already on the frontier model are excluded (within-model variance is not recoverable by routing). */
  readonly recoverableWaste: number;
  /** True when n < MIN_ARCHETYPE_SAMPLE: counts only, no frontier/waste/recommendation. */
  readonly abstained: boolean;
}

/**
 * A prescriptive lever — enum kind + numbers ONLY (security F1). There is NO
 * free-text `description`/`message` field: human-readable text is rendered at
 * the template/CLI layer from `kind`, never stored in the payload.
 */
export interface Lever {
  readonly kind:
    | 'route_by_archetype'
    | 'default_effort_down'
    | 'cache_hygiene'
    | 'stop_after_repairs';
  readonly archetype?: Archetype;
  readonly fromModel?: string;
  readonly toModel?: string;
  readonly estSavingUsd?: number;
  readonly percent?: number;
}

/**
 * The outward-facing efficiency block, attached additively to
 * `CostPerTaskReport`. Every leaf is a number or a fixed-enum value — no prompt
 * text, paths, project names, or session ids (plan §1, A4/A5).
 */
export interface EfficiencyReport {
  /** The frontier rests on the shipped four-state completion proxy, not survival (plan M1). */
  readonly basis: 'completion_proxy';
  /**
   * COMPARABLE spend: Σ cost of success units that ran on a pricier model than
   * their archetype's frontier (i.e. the routable, cross-model units). NOT total
   * spend — it is the base the savings estimate is measured against, so the trio
   * reconciles: `realisedCost − frontierCost = recoverableWaste` (review H1).
   * **0 when no archetype has a proven cheaper alternative** — e.g. a
   * single-model workload — in which case the surfaces show an
   * "insufficient model diversity" note rather than a fabricated saving.
   */
  readonly realisedCost: number;
  /** The irreducible floor of `realisedCost` after routing each comparable success to its archetype frontier; `= realisedCost − recoverableWaste`, so `0 ≤ frontierCost ≤ realisedCost`. */
  readonly frontierCost: number;
  /** Estimated recoverable spend: Σ over comparable success units of max(0, cost − archetype frontier p50). */
  readonly recoverableWaste: number;
  readonly byArchetype: readonly ArchetypeFrontier[];
  readonly levers: readonly Lever[];
}

/**
 * The aggregate output of the frontier computation (everything except the
 * derived levers). Named so `deriveLevers` has a precise input type and
 * `EfficiencyDeps.computeFrontier`'s return shape is shared.
 */
export interface FrontierResult {
  readonly byArchetype: readonly ArchetypeFrontier[];
  /** Comparable spend (see {@link EfficiencyReport.realisedCost}). */
  readonly realisedCost: number;
  /** = realisedCost − recoverableWaste (see {@link EfficiencyReport.frontierCost}). */
  readonly frontierCost: number;
  readonly recoverableWaste: number;
}

/**
 * The narrow projection the archetype classifier needs (plan §1/A3). Only
 * `toolHistogram`, `filePathsTouched`, and `duration` are read. Importing
 * `DailyDigestItem` solely for this `Pick` is fine — the type erases at
 * runtime; `buildEfficiencyReport` itself never takes a `DailyDigestItem`
 * (it takes `TaskRecord[]`, per A5).
 */
export type ClassifyInput = Pick<DailyDigestItem, 'toolHistogram' | 'filePathsTouched' | 'duration'>;

/**
 * Dependency-injection seam (plan §2/C3). `buildEfficiencyReport` takes
 * `deps: EfficiencyDeps = realDeps`, so each pure function is swappable with a
 * stub in tests and the four modules stay independently buildable.
 */
export interface EfficiencyDeps {
  readonly classify: (item: ClassifyInput) => Archetype;
  readonly computeFrontier: (tasks: readonly ClassifiedTask[]) => FrontierResult;
  readonly deriveLevers: (frontier: FrontierResult) => readonly Lever[];
}

/** Below this many tasks, an archetype row carries counts only — no frontier, no waste, no recommendation. */
export const MIN_ARCHETYPE_SAMPLE = 8;

/** A model must have ≥ this many observed units of an archetype to qualify as its frontier (success-rate floor, plan C4). */
export const MIN_MODEL_UNITS = 8;

/** A model qualifies as an archetype's frontier only if its success rate ≥ this floor (plan C4). */
export const RATE_FLOOR = 0.7;

/** filePathsTouched.length ≥ this marks a multi-file refactor — well below the 20-path cap (plan §4). */
export const MULTI_FILE_THRESHOLD = 4;
