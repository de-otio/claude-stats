/**
 * The task-class decision procedure (spec §5.7).
 *
 * A pure, first-match rule chain over `TaskClassFeatures`. It never throws,
 * never reads a clock, never calls `Math.random`, and always returns a member
 * of the closed union — the same total-function contract the shipped archetype
 * classifier holds itself to.
 *
 * `unknown` is an OUTCOME, not a failure. The whole reason this module exists
 * is that its output feeds a per-class before/after delta a developer will show
 * their manager, and a confidently-wrong class survives into that delta with no
 * way for the reader to audit it. Abstaining is the cheaper error.
 */
import type { TaskClass, CoarseTaskClass, Confidence } from "../types/insight.js";
import {
  BASH_MIN_CALLS,
  BASH_MUTATION_CEILING,
  BASH_SHARE_FLOOR,
  COARSE_OF,
  CONFIG_SHARE_FLOOR,
  DEBUG_MAX_FILES,
  ERROR_MIN_COUNT,
  ERROR_RATE_FLOOR,
  GREENFIELD_MIN_WRITES,
  GREENFIELD_WRITE_SHARE,
  HIGH_BASH_CALLS,
  HIGH_CONFIG_FILES,
  HIGH_ERROR_RATE,
  HIGH_EXPLORE_CALLS,
  HIGH_REFACTOR_EDITS,
  HIGH_REFACTOR_FILES,
  HIGH_WRITE_CALLS,
  HIGH_WRITE_SHARE,
  MIN_TOOL_CALLS,
  PROSE_SHARE_FLOOR,
  REFACTOR_MIN_EDITS,
  REFACTOR_MIN_FILES,
  TASK_CLASS_VERSION,
  type TaskClassAbstainReason,
  type TaskClassFeatures,
  type TaskClassRule,
  type TaskClassification,
} from "./types.js";

/** Non-negative integer coercion — a malformed upstream row must not throw. */
function n(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Safe share; a zero denominator yields 0 rather than NaN. */
function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function decided(
  fine: Exclude<TaskClass, "unknown">,
  rule: TaskClassRule,
  confidence: Confidence,
): TaskClassification {
  return {
    version: TASK_CLASS_VERSION,
    fine,
    // By construction, never by a second rule chain: the two columns cannot
    // disagree if only one of them is ever decided independently (spec §5.5).
    coarse: COARSE_OF[fine],
    confidence,
    rule,
    abstainReason: null,
  };
}

/**
 * Abstain, fixing the coarse class AT THE ABSTENTION SITE (spec §5.5).
 *
 * There is deliberately no second, independent coarse rule chain. Each of the
 * three abstentions has exactly one defensible coarse answer — `sparse` knows
 * nothing, `prose-dominant` and `below-threshold` both demonstrably changed
 * files — so a parallel chain would add a way for the two stored columns to
 * diverge in exchange for no reachable outcome it cannot already produce.
 */
function abstained(
  reason: TaskClassAbstainReason,
  coarse: CoarseTaskClass,
): TaskClassification {
  return {
    version: TASK_CLASS_VERSION,
    fine: "unknown",
    coarse,
    confidence: "low",
    rule: reason,
    abstainReason: reason,
  };
}

/**
 * Classify one session from its feature vector.
 *
 * Rule order is load-bearing and argued in spec §5.7:
 *  R0 sparse · R1 diagnosis · R2 write-dominant · R3 config-dominant ·
 *  R4 prose-dominant · R5 multi-file-sweep · R6 non-mutating · R7 fallback.
 *
 * R1 precedes the build rules so error-driven work is not diluted into the
 * sweep class, bounded by a narrow-surface conjunct. R4 precedes R5 so a
 * documentation sweep abstains instead of being reported as a code refactor.
 */
export function classifyTaskClass(features: TaskClassFeatures): TaskClassification {
  const toolCalls = n(features.toolCalls);
  const editCalls = n(features.editCalls);
  const writeCalls = n(features.writeCalls);
  const bashCalls = n(features.bashCalls);
  // Rules key on files the session CHANGED, never on files it merely read:
  // reading ten files while editing one is a focused change, not a sweep.
  const editedFiles = n(features.editedFiles);
  const configFiles = n(features.configFiles);
  const proseFiles = n(features.proseFiles);
  const toolErrors = n(features.toolErrors);

  const mutatingCalls = editCalls + writeCalls;
  const mutatingShare = share(mutatingCalls, toolCalls);
  const bashShare = share(bashCalls, toolCalls);
  const errorRate = share(toolErrors, toolCalls);
  const configShare = share(configFiles, editedFiles);
  const proseShare = share(proseFiles, editedFiles);
  const writeShare = share(writeCalls, mutatingCalls);
  // Rows ingested before schema V10 carry no file paths at all. Every rule
  // below that reads a file count needs a POSITIVE one — the shares have a zero
  // denominator and the sweep floor is unreachable — so pre-V10 history cannot
  // be read as "changed zero files"; it simply abstains.
  const pathEvidence = editedFiles > 0;

  // R0 — too little activity to carry any structural signal.
  if (toolCalls < MIN_TOOL_CALLS) return abstained("sparse", "unknown");

  // R1 — diagnosis. Two independent shapes (spec §5.7).
  const failureDriven =
    toolErrors >= ERROR_MIN_COUNT &&
    errorRate >= ERROR_RATE_FLOOR &&
    (mutatingCalls === 0 || editedFiles <= DEBUG_MAX_FILES);
  const executionDominant =
    bashCalls >= BASH_MIN_CALLS &&
    bashShare >= BASH_SHARE_FLOOR &&
    mutatingShare <= BASH_MUTATION_CEILING;
  if (failureDriven || executionDominant) {
    const strong = errorRate >= HIGH_ERROR_RATE || bashCalls >= HIGH_BASH_CALLS;
    return decided("debug", "diagnosis", strong ? "high" : "medium");
  }

  // R2 — write-dominant: the session's mutation is mostly creating new files.
  if (
    mutatingCalls > 0 &&
    writeCalls >= GREENFIELD_MIN_WRITES &&
    writeShare >= GREENFIELD_WRITE_SHARE
  ) {
    const strong = writeShare >= HIGH_WRITE_SHARE && writeCalls >= HIGH_WRITE_CALLS;
    return decided("greenfield", "write-dominant", strong ? "high" : "medium");
  }

  // R3 — config-dominant. Dominance, not incidence: a config file edited in
  // passing during a code change must not carry the whole session.
  if (mutatingCalls > 0 && pathEvidence && configShare >= CONFIG_SHARE_FLOOR) {
    const strong = configShare === 1 && configFiles >= HIGH_CONFIG_FILES;
    return decided("config-chore", "config-dominant", strong ? "high" : "medium");
  }

  // R4 — prose-dominant. There is no documentation class in the fixed
  // vocabulary, so a doc sweep abstains rather than being labelled a code
  // refactor. Coarse still says `build`: it demonstrably changed files.
  if (mutatingCalls > 0 && pathEvidence && proseShare >= PROSE_SHARE_FLOOR) {
    return abstained("prose-dominant", "build");
  }

  // R5 — broad multi-file edit sweep. Operationally "broad sweep", not
  // "refactor" in the intentional sense (spec §5.4).
  if (editedFiles >= REFACTOR_MIN_FILES && editCalls >= REFACTOR_MIN_EDITS) {
    const strong = editedFiles >= HIGH_REFACTOR_FILES && editCalls >= HIGH_REFACTOR_EDITS;
    return decided("refactor-multi-file", "multi-file-sweep", strong ? "high" : "medium");
  }

  // R6 — non-mutating. Contains BOTH exploration and review: no stored signal
  // separates them once prompt text is excluded (spec §5.4).
  if (mutatingCalls === 0) {
    return decided("explore", "non-mutating", toolCalls >= HIGH_EXPLORE_CALLS ? "high" : "medium");
  }

  // R7 — mutating, but no build rule fired: typically a small targeted edit,
  // which the fixed vocabulary has no member for. Abstain at the fine grain and
  // let the coarse grain carry it.
  return abstained("below-threshold", "build");
}
