/**
 * Personal-plane BACKUP (Phase C, imperative shell): push signed+encrypted
 * shards to a `StorageTransport`, keep the manifest current, switch encryption
 * mode resumably, and compact — all driving the pure `@claude-stats/core/bundle`
 * format. Backup = push; Phase D adds pull + merge on top.
 */

export { DirectoryStorageTransport, createDirectoryTransport } from "./transport-dir.js";

export {
  MANIFEST_KEY,
  shardKey,
  loadOrSeedBody,
  ensureDevice,
  writeManifest,
  pushShard,
} from "./backup.js";
export type { DeviceIdentity, BackupCrypto, PushOptions, PushResult } from "./backup.js";

export {
  buildSessionRecords,
  nextCounterAfter,
} from "./records.js";
export type { SessionExportPayload, BuildRecordsOptions } from "./records.js";

export { loadExportInputs } from "./store-adapter.js";
export type { ExportInputs } from "./store-adapter.js";

export { switchMode } from "./mode-switch.js";
export type { SwitchModeOptions, SwitchModeResult } from "./mode-switch.js";

export { compact, assertOwningDevice } from "./compaction.js";
export type { CompactOptions, CompactResult } from "./compaction.js";

export {
  IDENTITY_KEYSTORE_KEY,
  generateDeviceId,
  generateDeviceIdentityMaterial,
  loadOrCreateDeviceIdentity,
  destroyDeviceIdentity,
  bootstrapBackupCrypto,
} from "./identity.js";
export type { DeviceIdentityMaterial } from "./identity.js";
