/**
 * Personal-plane SYNC + MERGE (Phase D — convergence-critical).
 *
 * Backup (Phase C) pushed this device's signed shards; sync PULLS every device's
 * shards, VERIFIES each against the manifest trust root (F1), and MERGES them
 * into SQLite conflict-free — LWW keyed on the origin logical clock with a
 * deterministic device-id tiebreak, NEVER the DB `updated_at` (B2). A truncated/
 * half-synced shard is tolerated and retried (S8); a never-before-seen device
 * fires a "rotate your recovery key" notification (F13); the whole cycle runs
 * ambiently off the collector.
 *
 * Layering: `merge.ts` is the PURE convergent core; `pull`/`apply`/`sync`/
 * `ambient` are the imperative shell around it.
 */

export {
  compareClock,
  laterClock,
  combineSession,
  mergeRecords,
  originDevicesOf,
} from "./merge.js";
export type { MergedSession } from "./merge.js";

export {
  loadTrustedDevices,
  trustedDevicesFromBody,
  pullShards,
} from "./pull.js";
export type { PullOptions, PullResult, TrustedDevice } from "./pull.js";

export {
  rowToSessionRecord,
  rowToMessageRecord,
  applyMerged,
} from "./apply.js";
export type { ApplyOptions, ApplyResult } from "./apply.js";

export {
  detectNewDevices,
  MemoryKnownDeviceRegistry,
  FileKnownDeviceRegistry,
} from "./device-registry.js";
export type { KnownDeviceRegistry } from "./device-registry.js";

export {
  syncOnce,
  newDeviceMessage,
  formatSyncStatus,
} from "./sync.js";
export type {
  SyncDeps,
  SyncStatus,
  NewDeviceNotifier,
  NewDeviceEvent,
} from "./sync.js";

export { attachAmbientSync } from "./ambient.js";
export type { CollectSignal, AmbientSyncOptions, AmbientSyncHandle } from "./ambient.js";
