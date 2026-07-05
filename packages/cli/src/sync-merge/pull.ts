/**
 * Phase D — PULL every device's shards from the transport (imperative shell).
 *
 * Convergence is only as trustworthy as its inputs, so pull is the enforcement
 * point for F1 (authentication) and S8 (truncation tolerance):
 *
 *   F1 — VERIFY, then TRUST. The shared manifest (itself sealed + signed) is the
 *   trust root: it lists the enrolled devices with their Ed25519 verify keys. A
 *   shard is accepted ONLY if its `<device-id>/` prefix names a KNOWN, NON-REVOKED
 *   device AND its signature verifies against that device's key (via
 *   {@link openShard}, which checks the signature BEFORE it spends a decrypt). A
 *   shard sitting under an unknown/rogue device directory — the exact thing an
 *   attacker with cloud-folder write access would drop in — is REJECTED, never
 *   merged.
 *
 *   S8 — TOLERATE a half-synced shard. A paused cloud client can expose a
 *   partially-written file: truncated bytes that fail to JSON-decode, fail the
 *   signature, or fail to decrypt. Any such shard is SKIPPED (recorded as
 *   deferred), the good shards still merge, and the partial one is picked up on
 *   the next pull once the cloud finishes writing it — no throw, no crash.
 *
 * Shards are enumerated by LISTING the transport (not by trusting the manifest
 * file index), so a shard that landed before the manifest caught up is still
 * seen — and its authorship is still gated on the trusted-device set.
 */

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import type {
  DeviceId,
  ManifestBody,
  StampedRecord,
} from "@claude-stats/core/types/shard";
import { isValidDeviceId } from "@claude-stats/core/types/shard";
import { decodeManifest, decodeShardFile, openManifest, openShard } from "@claude-stats/core/bundle";
import type { SessionExportPayload } from "../backup/records.js";
import { MANIFEST_KEY } from "../backup/backup.js";

/** A trusted device's verification material, distilled from the manifest body. */
export interface TrustedDevice {
  readonly signPublicKey: Uint8Array;
  readonly revoked: boolean;
}

/** Matches `<device-id>/sessions-<seq>.json` or `…​.json.age`. */
const SHARD_KEY_RE = /^([^/]+)\/sessions-(\d+)\.json(\.age)?$/;

export interface PullOptions {
  readonly transport: StorageTransport;
  /** The trust root: enrolled device id → verify key + revocation state (F1). */
  readonly trustedDevices: ReadonlyMap<DeviceId, TrustedDevice>;
  /** DEK — required to open any ENCRYPTED shard (and always to open the manifest). */
  readonly dek?: Uint8Array;
}

export interface PullResult {
  /** Verified, decrypted records from every accepted shard (unmerged, unordered). */
  readonly records: readonly StampedRecord<SessionExportPayload>[];
  /** Shard keys accepted (signature verified against a trusted device). */
  readonly accepted: readonly string[];
  /** Shards under an UNKNOWN or REVOKED device directory — rejected (F1). */
  readonly rejectedUnknownDevice: readonly string[];
  /** Shards whose signature did not verify against the claimed device (F1). */
  readonly rejectedBadSignature: readonly string[];
  /** Shards that failed to decode/decrypt — truncated/half-synced, retried later (S8). */
  readonly deferredTruncated: readonly string[];
  /** Every device id that authored at least one shard file present in the store. */
  readonly devicesSeen: ReadonlySet<DeviceId>;
}

/**
 * Open the shared manifest and distill its device list into the trusted-device
 * map used to authenticate shards. Returns an empty map when no manifest exists
 * yet (nothing to trust ⇒ nothing to pull). Requires the DEK (the manifest body
 * is always sealed, independent of the per-shard encryption choice).
 */
export async function loadTrustedDevices(
  transport: StorageTransport,
  dek: Uint8Array,
): Promise<Map<DeviceId, TrustedDevice>> {
  const raw = await transport.get(MANIFEST_KEY);
  if (!raw) return new Map();
  const body: ManifestBody = openManifest(decodeManifest(raw), { dek });
  return trustedDevicesFromBody(body);
}

/** Distill a manifest body's device list into the trusted-device map (F1 root). */
export function trustedDevicesFromBody(body: ManifestBody): Map<DeviceId, TrustedDevice> {
  const map = new Map<DeviceId, TrustedDevice>();
  for (const d of body.devices) {
    map.set(d.deviceId, { signPublicKey: d.signPublicKey, revoked: d.revoked === true });
  }
  return map;
}

/**
 * Pull + authenticate + decrypt every shard on the transport. Never throws on a
 * hostile or half-written shard: each failure mode is CATEGORIZED into the
 * result so the caller (and status) can report it, and merge only ever sees
 * records from accepted, signature-verified shards.
 */
export async function pullShards(options: PullOptions): Promise<PullResult> {
  const { transport, trustedDevices, dek } = options;

  const records: StampedRecord<SessionExportPayload>[] = [];
  const accepted: string[] = [];
  const rejectedUnknownDevice: string[] = [];
  const rejectedBadSignature: string[] = [];
  const deferredTruncated: string[] = [];
  const devicesSeen = new Set<DeviceId>();

  const keys = await transport.list();
  for (const key of keys) {
    if (key === MANIFEST_KEY) continue;
    const match = SHARD_KEY_RE.exec(key);
    if (!match) continue; // not a sync-data shard (archive files, stray keys)

    const rawDeviceId = match[1]!;
    // Directory names are attacker-controlled; validate before trusting as an id.
    if (!isValidDeviceId(rawDeviceId)) {
      rejectedUnknownDevice.push(key);
      continue;
    }
    const deviceId = rawDeviceId as DeviceId;
    devicesSeen.add(deviceId);

    // F1: authorship must be a KNOWN, NON-REVOKED device — else reject outright.
    const trusted = trustedDevices.get(deviceId);
    if (!trusted || trusted.revoked) {
      rejectedUnknownDevice.push(key);
      continue;
    }

    // S8: a missing/half-synced file (get→null or a truncated read) is deferred.
    let raw: Uint8Array | null;
    try {
      raw = await transport.get(key);
    } catch {
      deferredTruncated.push(key);
      continue;
    }
    if (!raw) {
      deferredTruncated.push(key);
      continue;
    }

    // Truncated bytes fail to JSON-decode → defer (retry next pull).
    let file;
    try {
      file = decodeShardFile(raw);
    } catch {
      deferredTruncated.push(key);
      continue;
    }

    // openShard VERIFIES the signature (F1) before it decrypts. A verify failure
    // on a known device means a forged/tampered body ⇒ reject; a decrypt failure
    // on a verified body means truncated ciphertext ⇒ defer.
    try {
      const shard = openShard<SessionExportPayload>(file, {
        signPublicKey: trusted.signPublicKey,
        dek,
      });
      records.push(...shard.records);
      accepted.push(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/signature/i.test(message)) {
        rejectedBadSignature.push(key); // F1 — did not authenticate.
      } else {
        deferredTruncated.push(key); // decrypt/parse failure — treat as half-synced (S8).
      }
    }
  }

  return {
    records,
    accepted,
    rejectedUnknownDevice,
    rejectedBadSignature,
    deferredTruncated,
    devicesSeen,
  };
}
