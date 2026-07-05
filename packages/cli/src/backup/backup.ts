/**
 * Backup = PUSH (imperative shell).
 *
 * Seals + signs this device's records into a shard, writes it to the configured
 * {@link StorageTransport}, and updates the signed+encrypted manifest. This
 * device writes ONLY its own `<device-id>/` subtree, so two devices pushing at
 * once never touch the same file — conflict-free by construction. Sync (Phase D)
 * is this plus pull+merge.
 *
 * The manifest body (device list + per-file index) is ALWAYS sealed and signed,
 * independent of the per-class shard-encryption choice, so device/project/session
 * names never leak as store metadata (F4). The `encryptSyncData` flag only
 * controls whether the shard BODIES are sealed.
 */

import type { Argon2idParams, StorageTransport } from "@claude-stats/core/crypto/types";
import type {
  DeviceEntry,
  DeviceId,
  FileEncryptionState,
  Manifest,
  ManifestBody,
  Shard,
  StampedRecord,
} from "@claude-stats/core/types/shard";
import {
  decodeManifest,
  emptyManifestBody,
  encodeManifest,
  encodeShardFile,
  openManifest,
  sealManifest,
  sealShard,
  SHARD_SCHEMA_VERSION,
  upsertDevice,
  upsertFileIndex,
} from "@claude-stats/core/bundle";
import { wrapDek } from "@claude-stats/core/crypto/keys";
import type { SessionExportPayload } from "./records.js";

/** The bundle key of the shared manifest. */
export const MANIFEST_KEY = "manifest.json";

/** This device's identity: the keys that AUTHENTICATE its writes. */
export interface DeviceIdentity {
  readonly deviceId: DeviceId;
  readonly wrapPublicKey: Uint8Array;
  readonly signPublicKey: Uint8Array;
  readonly signingSecretKey: Uint8Array;
}

/** The envelope-crypto material a push needs (from Phase B; keys stay on-device). */
export interface BackupCrypto {
  readonly dek: Uint8Array;
  /** DEK wrapped to the passphrase (recovery) recipient — enrollment/recovery (B3). */
  readonly passphraseWrappedDek: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: Argon2idParams;
}

/** Logical bundle key for a sync-data shard. `.age` suffix ⇔ encrypted body. */
export function shardKey(deviceId: DeviceId, seq: number, encrypted: boolean): string {
  return `${deviceId}/sessions-${seq}.json${encrypted ? ".age" : ""}`;
}

export interface PushOptions {
  readonly transport: StorageTransport;
  readonly identity: DeviceIdentity;
  readonly crypto: BackupCrypto;
  /** Encrypt the shard BODY (the per-class sync-data choice). Manifest is always sealed. */
  readonly encryptSyncData: boolean;
  /** The records this device is publishing in this shard. */
  readonly records: readonly StampedRecord<SessionExportPayload>[];
  /** Monotonic per-device shard sequence (the `<seq>` in the filename). */
  readonly seq: number;
  /** Enrollment wall-clock (injected). Only used when first adding this device. */
  readonly enrolledAt: number;
}

export interface PushResult {
  readonly shardKey: string;
  readonly recordCount: number;
  readonly encryption: FileEncryptionState;
  readonly manifestKey: string;
}

/**
 * Load + decrypt the current manifest body, or seed a fresh one. Opening
 * self-authenticates against the signer's embedded key (Phase C); Phase D passes
 * an external trusted-device key set.
 */
export async function loadOrSeedBody(
  transport: StorageTransport,
  crypto: BackupCrypto,
): Promise<ManifestBody> {
  const raw = await transport.get(MANIFEST_KEY);
  if (raw) {
    return openManifest(decodeManifest(raw), { dek: crypto.dek });
  }
  return emptyManifestBody({
    passphraseWrappedDek: crypto.passphraseWrappedDek,
    kdfSalt: crypto.kdfSalt,
    kdfParams: crypto.kdfParams,
  });
}

/** Ensure this device has an up-to-date entry (fresh DEK wrap) in the body. */
export function ensureDevice(
  body: ManifestBody,
  identity: DeviceIdentity,
  crypto: BackupCrypto,
  enrolledAt: number,
): ManifestBody {
  const existing = body.devices.find((d) => d.deviceId === identity.deviceId);
  const entry: DeviceEntry = {
    deviceId: identity.deviceId,
    wrapPublicKey: identity.wrapPublicKey,
    signPublicKey: identity.signPublicKey,
    wrappedDek: wrapDek(crypto.dek, [{ kind: "device", wrapPublicKey: identity.wrapPublicKey }]),
    enrolledAt: existing?.enrolledAt ?? enrolledAt,
  };
  return upsertDevice(body, entry);
}

/** Write the sealed+signed manifest for `body`, signed by `identity`. */
export async function writeManifest(
  transport: StorageTransport,
  body: ManifestBody,
  identity: DeviceIdentity,
  crypto: BackupCrypto,
): Promise<Manifest> {
  const manifest = sealManifest(body, {
    dek: crypto.dek,
    signingSecretKey: identity.signingSecretKey,
    signedBy: identity.deviceId,
  });
  await transport.put(MANIFEST_KEY, encodeManifest(manifest));
  return manifest;
}

/**
 * Push one shard of records + refresh the manifest. Sequence: seal the shard,
 * write it, THEN update the manifest — so a reader that sees the manifest entry
 * can always find the shard bytes.
 */
export async function pushShard(options: PushOptions): Promise<PushResult> {
  const { transport, identity, crypto, records, seq } = options;
  const encryption: FileEncryptionState = options.encryptSyncData ? "encrypted" : "plaintext";

  const shard: Shard<SessionExportPayload> = {
    header: { schemaVersion: SHARD_SCHEMA_VERSION, originDevice: identity.deviceId, seq },
    records,
  };
  const file = sealShard(shard, {
    encryption,
    signingSecretKey: identity.signingSecretKey,
    dek: crypto.dek,
  });
  const key = shardKey(identity.deviceId, seq, encryption === "encrypted");
  await transport.put(key, encodeShardFile(file));

  let body = await loadOrSeedBody(transport, crypto);
  body = ensureDevice(body, identity, crypto, options.enrolledAt);
  body = upsertFileIndex(body, {
    path: key,
    state: encryption,
    originDevice: identity.deviceId,
    seq,
  });
  await writeManifest(transport, body, identity, crypto);

  return { shardKey: key, recordCount: records.length, encryption, manifestKey: MANIFEST_KEY };
}
