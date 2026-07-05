/**
 * Mode-switch (plaintext ⇄ encrypted) — resumable, idempotent, leftover-free.
 *
 * Switching a target's sync-data class re-writes THIS device's shards to the
 * other encryption state. Three properties, all load-bearing:
 *
 *  - **Resumable/idempotent (F12):** progress is the manifest per-file state.
 *    Each file is converted then the manifest is persisted, so a re-run skips
 *    files already at the target and continues the rest. Running it twice is a
 *    no-op.
 *  - **No version-history link (F3):** the converted output is written to a NEW
 *    filename (`…​.json` ⇄ `…​.json.age`) and the OLD file deleted — never an
 *    in-place overwrite — so a cloud provider's version history holds no chain
 *    from the ciphertext back to the plaintext blob.
 *  - **Zero plaintext leftovers (F3):** after conversion a reconcile sweep
 *    deletes any file in this device's subtree NOT referenced by the (updated)
 *    manifest index. So even if a previous run was interrupted after writing the
 *    new file but before deleting the old, the orphan is still removed.
 *
 * LIMITATION (documented, not silently ignored): the underlying `delete` is a
 * best-effort unlink. On a copy-on-write filesystem or a cloud client with
 * server-side version history, bytes may survive deletion; the UX layer (Phase
 * E) warns the user to purge provider-side history. We cannot securely erase
 * remote bytes from here.
 *
 * Only this device's OWN subtree is converted — re-sealing requires the origin
 * device's Ed25519 signing key, which only it holds. Other devices convert their
 * own subtrees when they run (the sync-group agrees on the on/off state).
 */

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import type { FileEncryptionState, ManifestBody, Shard } from "@claude-stats/core/types/shard";
import {
  decodeShardFile,
  encodeShardFile,
  openShard,
  removeFileIndex,
  sealShard,
  upsertFileIndex,
} from "@claude-stats/core/bundle";
import {
  loadOrSeedBody,
  shardKey,
  writeManifest,
  type BackupCrypto,
  type DeviceIdentity,
  MANIFEST_KEY,
} from "./backup.js";
import type { SessionExportPayload } from "./records.js";

export interface SwitchModeOptions {
  readonly transport: StorageTransport;
  readonly identity: DeviceIdentity;
  readonly crypto: BackupCrypto;
  /** Desired encryption state for this device's sync-data shards. */
  readonly target: FileEncryptionState;
}

export interface SwitchModeResult {
  /** Files re-written to the target state this run. */
  readonly converted: readonly string[];
  /** Files already at the target (skipped — idempotent). */
  readonly skipped: readonly string[];
  /** Orphan files deleted by the reconcile sweep (leftover plaintext/ciphertext). */
  readonly swept: readonly string[];
}

/** Is this file-index path one of THIS device's sync-data shards? */
function isOwnSyncShard(path: string, deviceId: string): boolean {
  return path.startsWith(`${deviceId}/`) && /\/sessions-\d+\.json(\.age)?$/.test(path);
}

/**
 * Convert this device's sync-data shards to `target`, resumably and without
 * leaving plaintext behind. Safe to call repeatedly.
 */
export async function switchMode(options: SwitchModeOptions): Promise<SwitchModeResult> {
  const { transport, identity, crypto, target } = options;
  const deviceId = identity.deviceId;

  let body: ManifestBody = await loadOrSeedBody(transport, crypto);
  const converted: string[] = [];
  const skipped: string[] = [];

  // Snapshot the entries to convert (we mutate `body` as we go).
  const targets = body.files.filter(
    (f) => f.originDevice === deviceId && isOwnSyncShard(f.path, deviceId),
  );

  for (const entry of targets) {
    if (entry.state === target) {
      skipped.push(entry.path);
      continue;
    }
    const oldRaw = await transport.get(entry.path);
    if (!oldRaw) {
      // File already gone (e.g. a prior interrupted run) — drop the stale index
      // entry so the sweep/state is consistent, then move on.
      body = removeFileIndex(body, entry.path);
      await writeManifest(transport, body, identity, crypto);
      continue;
    }

    const oldFile = decodeShardFile(oldRaw);
    const shard: Shard<SessionExportPayload> = openShard(oldFile, {
      signPublicKey: identity.signPublicKey,
      dek: crypto.dek,
    });
    const newFile = sealShard(shard, {
      encryption: target,
      signingSecretKey: identity.signingSecretKey,
      dek: crypto.dek,
    });
    const newKey = shardKey(deviceId, entry.seq, target === "encrypted");

    // Write NEW filename first, then update the manifest, then delete the old
    // file. If we crash between the manifest write and the delete, the reconcile
    // sweep below (or on the next run) removes the orphan.
    await transport.put(newKey, encodeShardFile(newFile));
    body = upsertFileIndex(body, { path: newKey, state: target, originDevice: deviceId, seq: entry.seq });
    if (newKey !== entry.path) {
      body = removeFileIndex(body, entry.path);
    }
    await writeManifest(transport, body, identity, crypto);
    if (newKey !== entry.path) {
      await transport.delete(entry.path);
    }
    converted.push(newKey);
  }

  const swept = await reconcileSweep(transport, body, deviceId);
  return { converted, skipped, swept };
}

/**
 * Delete every file in this device's subtree that the manifest index does NOT
 * reference — the guarantee that no plaintext (or stale ciphertext) leftover
 * survives an interrupted switch (F3).
 */
async function reconcileSweep(
  transport: StorageTransport,
  body: ManifestBody,
  deviceId: string,
): Promise<string[]> {
  const referenced = new Set<string>(body.files.map((f) => f.path));
  referenced.add(MANIFEST_KEY);
  const present = await transport.list(deviceId);
  const orphans = present.filter((key) => !referenced.has(key));
  for (const key of orphans) await transport.delete(key);
  return orphans;
}
