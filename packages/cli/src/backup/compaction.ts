/**
 * Compaction — by the OWNING device ONLY.
 *
 * Old shards accumulate as a device pushes incrementally. Compaction folds this
 * device's shards into a single fresh shard (next `seq`), then deletes the old
 * ones. Because ONLY the owning device ever writes its own `<device-id>/`
 * subtree, compaction is as conflict-free as a normal push — no other device is
 * touching these files. Re-sealing the merged shard requires the origin device's
 * Ed25519 signing key, which structurally is the ONLY device that can compact
 * this subtree; {@link assertOwningDevice} makes that explicit.
 *
 * The merged shard is written and the manifest updated BEFORE the old files are
 * deleted, so a reader never sees a manifest that points at deleted bytes.
 */

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import type {
  DeviceId,
  FileEncryptionState,
  ManifestBody,
  Shard,
  StampedRecord,
} from "@claude-stats/core/types/shard";
import {
  decodeShardFile,
  encodeShardFile,
  openShard,
  removeFileIndex,
  sealShard,
  SHARD_SCHEMA_VERSION,
  upsertFileIndex,
} from "@claude-stats/core/bundle";
import {
  ensureDevice,
  loadOrSeedBody,
  shardKey,
  writeManifest,
  type BackupCrypto,
  type DeviceIdentity,
} from "./backup.js";
import type { SessionExportPayload } from "./records.js";

/** Guard: refuse to compact a subtree this device does not own. */
export function assertOwningDevice(originDevice: DeviceId, identity: DeviceIdentity): void {
  if (originDevice !== identity.deviceId) {
    throw new Error("compaction: only the owning device may compact its own shards");
  }
}

export interface CompactOptions {
  readonly transport: StorageTransport;
  readonly identity: DeviceIdentity;
  readonly crypto: BackupCrypto;
  /** Encryption state for the merged shard (the current per-class policy). */
  readonly encryptSyncData: boolean;
  /** Enrollment wall-clock (injected) — only used if the device entry is absent. */
  readonly enrolledAt: number;
}

export interface CompactResult {
  readonly compacted: boolean;
  readonly mergedShardKey?: string;
  readonly recordCount?: number;
  readonly removed: readonly string[];
}

function isOwnSyncShard(path: string, deviceId: string): boolean {
  return path.startsWith(`${deviceId}/`) && /\/sessions-\d+\.json(\.age)?$/.test(path);
}

/**
 * Merge this device's sync-data shards into one. A no-op (compacted=false) when
 * there is 0 or 1 shard — nothing to fold.
 */
export async function compact(options: CompactOptions): Promise<CompactResult> {
  const { transport, identity, crypto } = options;
  const deviceId = identity.deviceId;

  let body: ManifestBody = await loadOrSeedBody(transport, crypto);
  const own = body.files
    .filter((f) => f.originDevice === deviceId && isOwnSyncShard(f.path, deviceId))
    .sort((a, b) => a.seq - b.seq);

  if (own.length <= 1) return { compacted: false, removed: [] };

  for (const entry of own) assertOwningDevice(entry.originDevice, identity);

  // Read + open every shard, concatenating records in seq order (stable).
  const records: StampedRecord<SessionExportPayload>[] = [];
  for (const entry of own) {
    const raw = await transport.get(entry.path);
    if (!raw) continue; // tolerate a missing file (a prior interrupted run)
    const shard = openShard<SessionExportPayload>(decodeShardFile(raw), {
      signPublicKey: identity.signPublicKey,
      dek: crypto.dek,
    });
    records.push(...shard.records);
  }

  const encryption: FileEncryptionState = options.encryptSyncData ? "encrypted" : "plaintext";
  const newSeq = Math.max(...own.map((e) => e.seq)) + 1;
  const merged: Shard<SessionExportPayload> = {
    header: { schemaVersion: SHARD_SCHEMA_VERSION, originDevice: deviceId, seq: newSeq },
    records,
  };
  const newKey = shardKey(deviceId, newSeq, encryption === "encrypted");
  const file = sealShard(merged, {
    encryption,
    signingSecretKey: identity.signingSecretKey,
    dek: crypto.dek,
  });
  await transport.put(newKey, encodeShardFile(file));

  // Update the manifest: add the merged shard, drop the old entries, ensure the
  // device entry — THEN delete the old files.
  body = ensureDevice(body, identity, crypto, options.enrolledAt);
  body = upsertFileIndex(body, { path: newKey, state: encryption, originDevice: deviceId, seq: newSeq });
  for (const entry of own) body = removeFileIndex(body, entry.path);
  await writeManifest(transport, body, identity, crypto);

  const removed: string[] = [];
  for (const entry of own) {
    await transport.delete(entry.path);
    removed.push(entry.path);
  }

  return { compacted: true, mergedShardKey: newKey, recordCount: records.length, removed };
}
