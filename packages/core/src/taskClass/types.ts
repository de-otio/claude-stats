/**
 * Task-class classifier — closed contract, thresholds, and version stamp.
 *
 * Spec: doc/analysis/constraint-impact/05-task-class-spec.md. Read it before
 * changing a number in this file; every constant here is argued there, and the
 * spec's §5.8 release thresholds are what a rule change is held to.
 *
 * PRIVACY (load-bearing): no type in this module may carry prompt text, a file
 * path, a project name, or a session id. `TaskClassFeatures` is a vector of
 * COUNTS derived from paths, never the paths themselves, and prompt text is not
 * a classifier input at all (spec §5.2). These values flow to the store, the
 * read-only MCP server, and the `serve` LAN path.
 */
import type { TaskClass, CoarseTaskClass, Confidence } from "../types/insight.js";

/**
 * Classifier version, stamped on every stored classification.
 *
 * BUMP THIS whenever a rule, a threshold, a path set, or the feature derivation
 * changes in a way that could move a session between classes. The version is
 * the invalidation mechanism: the classify pass selects sessions with no row or
 * a row below the current version, so a bump reclassifies exactly the affected
 * corpus with no manual purge, and a store holding two versions can say so
 * rather than silently mixing them in a before/after comparison (spec §5.9).
 */
export const TASK_CLASS_VERSION = 1;

/**
 * Which rule decided. A closed enum, not free text — it is stored, and it is
 * the audit trail a reader follows from a per-class delta back to a reason.
 * `sparse` / `prose-dominant` / `below-threshold` are the three abstentions.
 */
export type TaskClassRule =
  | "sparse"
  | "diagnosis"
  | "write-dominant"
  | "config-dominant"
  | "prose-dominant"
  | "multi-file-sweep"
  | "non-mutating"
  | "below-threshold";

/** Why the classifier declined. Null whenever `fine !== "unknown"`. */
export type TaskClassAbstainReason = "sparse" | "prose-dominant" | "below-threshold";

/**
 * Order-independent aggregates over one session's messages (spec §5.3).
 *
 * Every field is a count or a boolean. Shares are derived in the classifier
 * rather than stored here so there is exactly one place a denominator can be
 * wrong.
 */
export interface TaskClassFeatures {
  readonly toolCalls: number;
  readonly editCalls: number;
  readonly writeCalls: number;
  readonly readCalls: number;
  readonly searchCalls: number;
  readonly bashCalls: number;
  /**
   * Distinct file paths seen anywhere in the session, INCLUDING files that were
   * only read. Breadth of attention, not breadth of change — reported for
   * context; no rule keys on it.
   */
  readonly filesTouched: number;
  /**
   * Distinct file paths the session appears to have MODIFIED.
   *
   * This, not `filesTouched`, is what every file-count rule reads. A session
   * that reads ten files and edits one heavily is a focused change informed by
   * wide reading, and keying the sweep rule on files-touched would report it as
   * a multi-file refactor — a confidently wrong label in the class most likely
   * to be quoted in a tier argument.
   */
  readonly editedFiles: number;
  /** Of `editedFiles`, how many match the config/infra path rule. */
  readonly configFiles: number;
  /** Of `editedFiles`, how many match the prose path rule. */
  readonly proseFiles: number;
  readonly toolErrors: number;
  /** Real user turns (Σ is_turn_start), falling back to assistant-message count. */
  readonly turns: number;
}

/** One classification. Everything a stored row needs, and nothing identifying. */
export interface TaskClassification {
  readonly version: number;
  readonly fine: TaskClass;
  readonly coarse: CoarseTaskClass;
  readonly confidence: Confidence;
  readonly rule: TaskClassRule;
  readonly abstainReason: TaskClassAbstainReason | null;
}

// ─── Thresholds (spec §5.7) ──────────────────────────────────────────────────

/** Below this many tool calls the shares are noise, not signal. */
export const MIN_TOOL_CALLS = 3;

/** Both required: an error RATE computed off one call is not evidence. */
export const ERROR_MIN_COUNT = 2;
export const ERROR_RATE_FLOOR = 0.12;

/** Narrow-surface bound on the error clause — keeps broad sweeps out of `debug`. */
export const DEBUG_MAX_FILES = 3;

/** Execution-dominant investigation: lots of running, almost no changing. */
export const BASH_MIN_CALLS = 6;
export const BASH_SHARE_FLOOR = 0.5;
export const BASH_MUTATION_CEILING = 0.15;

/** One `Write` beside many `Edit`s is a refactor that added a file, not greenfield. */
export const GREENFIELD_MIN_WRITES = 2;
export const GREENFIELD_WRITE_SHARE = 0.5;

/** Dominance, not incidence — a config file touched in passing must not win. */
export const CONFIG_SHARE_FLOOR = 0.75;
export const PROSE_SHARE_FLOOR = 0.75;

/**
 * Deliberately the same 4 that `cost-per-task/efficiency/types.ts` uses for
 * `MULTI_FILE_THRESHOLD`: two classifiers in one product must not disagree
 * about what "multi-file" means.
 */
export const REFACTOR_MIN_FILES = 4;
export const REFACTOR_MIN_EDITS = 5;

// Confidence-upgrade thresholds (spec §5.7 "Confidence").
export const HIGH_ERROR_RATE = 0.25;
export const HIGH_BASH_CALLS = 12;
export const HIGH_WRITE_SHARE = 0.7;
export const HIGH_WRITE_CALLS = 3;
export const HIGH_CONFIG_FILES = 2;
export const HIGH_REFACTOR_FILES = 6;
export const HIGH_REFACTOR_EDITS = 8;
export const HIGH_EXPLORE_CALLS = 8;

/**
 * Fine → coarse map (spec §5.5). The coarse class of a DECIDED fine class is
 * its image here, applied by construction, so the two columns can never
 * disagree — a property test pins it.
 */
export const COARSE_OF: Readonly<Record<TaskClass, CoarseTaskClass>> = {
  debug: "diagnose",
  greenfield: "build",
  "refactor-multi-file": "build",
  "config-chore": "build",
  review: "support",
  explore: "support",
  unknown: "unknown",
};
