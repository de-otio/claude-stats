/**
 * Account-attribution engine (Phase 2 A).
 *
 * Pure interval + assignment functions (observations + sessions in,
 * assignments out, no clock) plus the clock-injected observation writer and
 * the `reattribute` orchestrator. The clock is threaded through the writer and
 * `reattribute` only; the interval/assignment functions are pure.
 */
export { buildCliIntervals, intervalAt } from "./intervals.js";
export type { AccountInterval } from "./intervals.js";

export { assignAccounts } from "./assign.js";
export type {
  Assignment,
  AssignInput,
  AssignResult,
  ExternalAccountInfo,
  MessageOverride,
} from "./assign.js";

export { writeObservation, hashEmail } from "./observer.js";

export { reattribute } from "./reattribute.js";
export type { ReattributeOptions, ReattributeSummary } from "./reattribute.js";

export { resolveOwner, ownerOf, matchGlob } from "./ownership.js";
export type { OwnerMatchInput } from "./ownership.js";

export { clusterProjects } from "./clustering.js";
export type { ClusterInput } from "./clustering.js";

export { enrichClusters, planApply } from "./classify.js";
export type { ClassifiedCluster, ClassifyAssignment, ApplyPlan } from "./classify.js";
