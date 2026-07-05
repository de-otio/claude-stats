/**
 * Phase E wiring glue: THIS device's backup identity + the first-enrollment
 * crypto bootstrap. Composes only already-vetted Phase B primitives
 * (`generateWrapKeyPair`/`generateSignKeyPair`/`generateDek`/`deriveMaster`/
 * `wrapDek`) — no new cryptography — so the onboarding UX (Phase E) has
 * something real to call instead of a stub.
 *
 * Persistence: a device's identity keypairs are generated ONCE and cached in
 * whichever `KeyStore` the host provides (VS Code `SecretStorage` in the
 * extension, the `0600` file fallback in the CLI) under one JSON blob, keyed by
 * {@link IDENTITY_KEYSTORE_KEY}. Losing this store means the device must be
 * re-enrolled (a fresh identity — the old one can be revoked from a survivor).
 *
 * SCOPE: this covers first-enrollment (this device MINTS the DEK, caching its
 * OWN identity) AND — via {@link recoverBackupCrypto} — recovery-key-only
 * bootstrap onto an EXISTING bundle. The latter is possible because the KDF
 * salt/params + passphrase-wrapped DEK now live in the manifest's PLAINTEXT key
 * envelope (`core/bundle/manifest.ts`, format v2), so a fresh device holding
 * only the recovery key can derive the DEK before opening the sealed body
 * (review B3). The second-device state machine in `ux/onboarding.ts` drives this.
 */

import { randomUUID } from "node:crypto";

import type { KeyStore } from "@claude-stats/core/crypto/types";
import { ARGON2ID_PARAMS, type Argon2idParams } from "@claude-stats/core/crypto/types";
import {
  deriveMaster,
  generateDek,
  generateSignKeyPair,
  generateWrapKeyPair,
  unwrapDek,
  wrapDek,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import { serializeJson, deserializeJson, toBase64, fromBase64 } from "@claude-stats/core/bundle";
import { assertDeviceId, type DeviceId, type Manifest } from "@claude-stats/core/types/shard";

import type { BackupCrypto, DeviceIdentity } from "./backup.js";

/** The single keystore entry a device's identity material is cached under. */
export const IDENTITY_KEYSTORE_KEY = "device-identity-v1";

/** This device's full identity: public identity (for the manifest) + BOTH secret keys. */
export interface DeviceIdentityMaterial {
  readonly identity: DeviceIdentity;
  /** X25519 secret key — needed to unwrap a DEK addressed to this device (rotation/re-enrollment). */
  readonly wrapSecretKey: Uint8Array;
}

interface IdentityWire {
  readonly deviceId: string;
  readonly wrapPublicKey: string;
  readonly wrapSecretKey: string;
  readonly signPublicKey: string;
  readonly signingSecretKey: string;
}

/** Generate a fresh RFC-4122 v4 UUID device id (always passes `assertDeviceId`). */
export function generateDeviceId(): DeviceId {
  return assertDeviceId(randomUUID());
}

/** Generate a brand-new device identity (fresh wrap + sign keypairs). */
export function generateDeviceIdentityMaterial(deviceId: DeviceId): DeviceIdentityMaterial {
  const wrap = generateWrapKeyPair();
  const sign = generateSignKeyPair();
  return {
    identity: {
      deviceId,
      wrapPublicKey: wrap.publicKey,
      signPublicKey: sign.publicKey,
      signingSecretKey: sign.secretKey,
    },
    wrapSecretKey: wrap.secretKey,
  };
}

function encodeIdentityMaterial(m: DeviceIdentityMaterial): Uint8Array {
  const wire: IdentityWire = {
    deviceId: m.identity.deviceId,
    wrapPublicKey: toBase64(m.identity.wrapPublicKey),
    wrapSecretKey: toBase64(m.wrapSecretKey),
    signPublicKey: toBase64(m.identity.signPublicKey),
    signingSecretKey: toBase64(m.identity.signingSecretKey),
  };
  return serializeJson(wire);
}

function decodeIdentityMaterial(bytes: Uint8Array): DeviceIdentityMaterial {
  const w = deserializeJson<IdentityWire>(bytes);
  return {
    identity: {
      deviceId: assertDeviceId(w.deviceId),
      wrapPublicKey: fromBase64(w.wrapPublicKey),
      signPublicKey: fromBase64(w.signPublicKey),
      signingSecretKey: fromBase64(w.signingSecretKey),
    },
    wrapSecretKey: fromBase64(w.wrapSecretKey),
  };
}

/**
 * Load this device's cached identity, or mint + persist a fresh one. Idempotent
 * across calls/restarts as long as the underlying `KeyStore` persists (OS
 * keychain, or the `0600` file). `deviceId` is only used the FIRST time (a
 * fresh identity); on subsequent calls the cached identity — including its
 * original deviceId — wins.
 */
export async function loadOrCreateDeviceIdentity(
  keystore: KeyStore,
  deviceId: DeviceId,
): Promise<DeviceIdentityMaterial> {
  const existing = await keystore.get(IDENTITY_KEYSTORE_KEY);
  if (existing) return decodeIdentityMaterial(existing);
  const material = generateDeviceIdentityMaterial(deviceId);
  await keystore.set(IDENTITY_KEYSTORE_KEY, encodeIdentityMaterial(material));
  return material;
}

/** Remove this device's cached identity (used by purge / data removal). */
export async function destroyDeviceIdentity(keystore: KeyStore): Promise<void> {
  await keystore.delete(IDENTITY_KEYSTORE_KEY);
}

/**
 * Mint a brand-new backup crypto envelope for a FIRST enrollment: a fresh DEK,
 * a fresh KDF salt, and the DEK wrapped to the passphrase (recovery-key)
 * recipient. Only valid when THIS device is establishing a bundle from
 * scratch (no existing manifest to preserve) — plan Phase E "3 taps" flow.
 */
export function bootstrapBackupCrypto(
  recoverySecret: Uint8Array,
  argon2Params: Argon2idParams = ARGON2ID_PARAMS,
): BackupCrypto {
  const dek = generateDek();
  const kdfSalt = generateKdfSalt();
  const master = deriveMaster(recoverySecret, kdfSalt, argon2Params);
  const passphraseWrappedDek = wrapDek(dek, [{ kind: "passphrase", masterKey: master }]);
  return { dek, passphraseWrappedDek, kdfSalt, kdfParams: argon2Params };
}

/**
 * Recover the bundle's {@link BackupCrypto} from an EXISTING manifest using only
 * the recovery key (review B3). This is the second-device / disaster-recovery
 * bootstrap: it reads the KDF salt/params + passphrase-wrapped DEK from the
 * manifest's PLAINTEXT key envelope, derives the master key, and unwraps the
 * DEK — no prior device access required. The returned envelope is the bundle's
 * CANONICAL one (read straight from the manifest), preserving the invariant on
 * {@link BackupCrypto}. Throws cleanly (no key material) on a wrong recovery key.
 *
 * After this returns, the caller opens the sealed body with the recovered DEK
 * (`openManifest`) and enrolls THIS device (`ensureDevice` + `writeManifest`).
 */
export function recoverBackupCrypto(manifest: Manifest, recoverySecret: Uint8Array): BackupCrypto {
  const { passphraseWrappedDek, kdfSalt, kdfParams } = manifest.keyEnvelope;
  const master = deriveMaster(recoverySecret, kdfSalt, kdfParams);
  const dek = unwrapDek(passphraseWrappedDek, { kind: "passphrase", masterKey: master });
  return { dek, passphraseWrappedDek, kdfSalt, kdfParams };
}
