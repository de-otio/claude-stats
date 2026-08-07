/**
 * Deterministic, version-stamped task-class classifier.
 *
 * Spec: doc/analysis/constraint-impact/05-task-class-spec.md
 *
 * The comparison in constraint-impact/02 runs WITHIN a task class, so that a
 * workload shift cannot masquerade as policy damage. That only works if a
 * session's class is stable across a months-long boundary — hence: pure, no
 * clock, no RNG, no model call, and a version stamp so a rule change is itself
 * a detectable event rather than a silent re-drawing of the buckets.
 */
export {
  TASK_CLASS_VERSION,
  COARSE_OF,
  type TaskClassFeatures,
  type TaskClassification,
  type TaskClassRule,
  type TaskClassAbstainReason,
} from "./types.js";
export { deriveFeatures, isConfigPath, isProsePath, type TaskClassMessage } from "./features.js";
export { classifyTaskClass } from "./classify.js";

import { deriveFeatures, type TaskClassMessage } from "./features.js";
import { classifyTaskClass } from "./classify.js";
import type { TaskClassification } from "./types.js";

/** Derive-and-classify in one step — the shape every caller actually wants. */
export function classifySession(messages: readonly TaskClassMessage[]): TaskClassification {
  return classifyTaskClass(deriveFeatures(messages));
}
