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
import type { TaskClass, CoarseTaskClass, Confidence } from "../types/insight.js";

/** Derive-and-classify in one step — the shape every caller actually wants. */
export function classifySession(messages: readonly TaskClassMessage[]): TaskClassification {
  return classifyTaskClass(deriveFeatures(messages));
}

/**
 * Fine class if its confidence supports it (medium/high), the coarse class
 * otherwise — the rule `core/hygiene/tierMismatch.ts` established for the
 * identical problem: a session at LOW confidence should contribute to the
 * coarser, more reliable bucket rather than dilute a fine class that might be
 * wrong. Centralised here so a later comparison (constraint-impact and any
 * that follow) cannot silently diverge from tier-mismatch on what "confident
 * enough to trust at the fine grain" means. Structural input — any object
 * with these three fields satisfies it, so `core/hygiene`'s own
 * `TierMismatchClassification` (a downstream consumer of task-class, not a
 * dependency of it) works here without an import.
 */
export function classificationGrain(c: {
  readonly fine: TaskClass;
  readonly coarse: CoarseTaskClass;
  readonly confidence: Confidence;
}): { readonly classKey: string; readonly grain: "fine" | "coarse" } {
  if (c.confidence !== "low") return { classKey: c.fine, grain: "fine" };
  return { classKey: `coarse:${c.coarse}`, grain: "coarse" };
}
