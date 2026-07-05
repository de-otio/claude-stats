/**
 * Manifest: a small PLAINTEXT header + an ENCRYPTED, SIGNED body (F1/F4).
 *
 * The header carries only what a reader needs to dispatch (format version + the
 * pinned AEAD label). Everything trust- or metadata-bearing — the device list
 * with public keys, the wrapped DEKs, the KDF salt/params, and the per-file
 * encryption-state index — lives in the body, which is:
 *   1. serialized canonically,
 *   2. SEALED with the DEK (so the device list and file paths never leak — F4),
 *   3. SIGNED (Ed25519) over the sealed bytes by the writing device (F1).
 * A reader verifies the signature and decrypts BEFORE trusting any field.
 *
 * Archive PATH COMPONENTS are encrypted too ({@link encryptPathComponents}) so a
 * project/session name never appears as a store key even in the file index.
 *
 * BOOTSTRAP NOTE (Phase C scope): possession of the DEK is the read
 * authorization. The common case reads the DEK from the OS keychain; recovery /
 * new-device enrollment (unwrapping a DEK from the body via the passphrase
 * recipient) is layered in Phase D, which supplies an EXTERNAL trusted-device
 * key set to {@link openManifest}. Here, when no external key is supplied, the
 * body self-authenticates against the signer's own embedded entry — an attacker
 * without the DEK cannot produce a body that both decrypts and verifies.
 */

import type {
  DeviceEntry,
  DeviceId,
  FileEncryptionState,
  FileIndexEntry,
  Manifest,
  ManifestBody,
  ManifestHeader,
} from "../types/shard.js";
import type { Argon2idParams } from "../crypto/types.js";
import { AEAD_ALGORITHM } from "../crypto/types.js";
import { open, seal } from "../crypto/aead.js";
import { sign, verify } from "../crypto/sign.js";
import {
  deserializeJson,
  fromBase64,
  fromBase64Url,
  serializeJson,
  toBase64,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "./serialize.js";

/** Manifest wire-format version (bump on a breaking layout change). */
export const MANIFEST_FORMAT_VERSION = 1;

/** The default plaintext header (format version + pinned AEAD label). */
export function manifestHeader(): ManifestHeader {
  return { formatVersion: MANIFEST_FORMAT_VERSION, aead: AEAD_ALGORITHM };
}

// ─── ManifestBody ⇄ canonical bytes (base64 for the Uint8Array fields) ────────

interface DeviceEntryWire {
  readonly deviceId: string;
  readonly wrapPublicKey: string;
  readonly signPublicKey: string;
  readonly wrappedDek: string;
  readonly enrolledAt: number;
  readonly revoked?: boolean;
}

interface ManifestBodyWire {
  readonly devices: readonly DeviceEntryWire[];
  readonly passphraseWrappedDek: string;
  readonly kdfSalt: string;
  readonly kdfParams: Argon2idParams;
  readonly files: readonly FileIndexEntry[];
}

function deviceToWire(d: DeviceEntry): DeviceEntryWire {
  const wire: DeviceEntryWire = {
    deviceId: d.deviceId,
    wrapPublicKey: toBase64(d.wrapPublicKey),
    signPublicKey: toBase64(d.signPublicKey),
    wrappedDek: toBase64(d.wrappedDek),
    enrolledAt: d.enrolledAt,
  };
  return d.revoked ? { ...wire, revoked: true } : wire;
}

function deviceFromWire(w: DeviceEntryWire): DeviceEntry {
  const base: DeviceEntry = {
    deviceId: w.deviceId as DeviceId,
    wrapPublicKey: fromBase64(w.wrapPublicKey),
    signPublicKey: fromBase64(w.signPublicKey),
    wrappedDek: fromBase64(w.wrappedDek),
    enrolledAt: w.enrolledAt,
  };
  return w.revoked ? { ...base, revoked: true } : base;
}

/** Canonical serialization of a {@link ManifestBody} (the plaintext SEALED payload). */
export function serializeManifestBody(body: ManifestBody): Uint8Array {
  const wire: ManifestBodyWire = {
    devices: body.devices.map(deviceToWire),
    passphraseWrappedDek: toBase64(body.passphraseWrappedDek),
    kdfSalt: toBase64(body.kdfSalt),
    kdfParams: body.kdfParams,
    files: body.files,
  };
  return serializeJson(wire);
}

/** Parse a canonical manifest-body serialization back to a {@link ManifestBody}. */
export function deserializeManifestBody(bytes: Uint8Array): ManifestBody {
  const w = deserializeJson<ManifestBodyWire>(bytes);
  return {
    devices: w.devices.map(deviceFromWire),
    passphraseWrappedDek: fromBase64(w.passphraseWrappedDek),
    kdfSalt: fromBase64(w.kdfSalt),
    kdfParams: w.kdfParams,
    files: w.files,
  };
}

// ─── seal + sign / verify + open ──────────────────────────────────────────────

export interface SealManifestOptions {
  readonly dek: Uint8Array;
  /** Ed25519 signing secret key of `signedBy`. */
  readonly signingSecretKey: Uint8Array;
  /** The device signing the manifest body. MUST have an entry in `body.devices`. */
  readonly signedBy: DeviceId;
  readonly header?: ManifestHeader;
}

/**
 * Seal + sign a {@link ManifestBody} into the on-store {@link Manifest}. The body
 * is sealed with the DEK, then the SEALED bytes are Ed25519-signed by `signedBy`.
 */
export function sealManifest(body: ManifestBody, options: SealManifestOptions): Manifest {
  const sealedBody = seal(serializeManifestBody(body), options.dek);
  const bodySignature = sign(sealedBody, options.signingSecretKey);
  return {
    header: options.header ?? manifestHeader(),
    sealedBody,
    bodySignature,
    signedBy: options.signedBy,
  };
}

export interface OpenManifestOptions {
  readonly dek: Uint8Array;
  /**
   * OPTIONAL external trust anchor: the Ed25519 public key `signedBy` must match.
   * Phase D passes the key from its trusted-device set. When omitted, the body
   * self-authenticates against the signer's own embedded `signPublicKey` (see
   * the bootstrap note above).
   */
  readonly signPublicKey?: Uint8Array;
}

/**
 * Verify a {@link Manifest}'s body signature and decrypt the body. Throws on a
 * signature or decrypt failure — never returns an untrusted body.
 */
export function openManifest(manifest: Manifest, options: OpenManifestOptions): ManifestBody {
  if (options.signPublicKey) {
    if (!verify(manifest.sealedBody, manifest.bodySignature, options.signPublicKey)) {
      throw new Error("openManifest: manifest signature did not verify against the trusted key");
    }
  }
  // Decrypt first (possession of the DEK authorizes the read); throws cleanly on
  // a wrong DEK or a tampered body.
  const body = deserializeManifestBody(open(manifest.sealedBody, options.dek));
  if (!options.signPublicKey) {
    const signer = body.devices.find((d) => d.deviceId === manifest.signedBy);
    if (!signer) {
      throw new Error("openManifest: signing device is not present in the manifest device list");
    }
    if (!verify(manifest.sealedBody, manifest.bodySignature, signer.signPublicKey)) {
      throw new Error("openManifest: manifest signature did not verify against the embedded key");
    }
  }
  return body;
}

// ─── Manifest ⇄ store bytes ───────────────────────────────────────────────────

interface ManifestWire {
  readonly header: ManifestHeader;
  readonly sealedBody: string;
  readonly bodySignature: string;
  readonly signedBy: string;
}

/** Serialize a {@link Manifest} to the bytes written to the store as `manifest.json`. */
export function encodeManifest(manifest: Manifest): Uint8Array {
  const wire: ManifestWire = {
    header: manifest.header,
    sealedBody: toBase64(manifest.sealedBody),
    bodySignature: toBase64(manifest.bodySignature),
    signedBy: manifest.signedBy,
  };
  return serializeJson(wire);
}

/** Parse store bytes back into a {@link Manifest}. Throws on malformed input. */
export function decodeManifest(bytes: Uint8Array): Manifest {
  const w = deserializeJson<ManifestWire>(bytes);
  return {
    header: w.header,
    sealedBody: fromBase64(w.sealedBody),
    bodySignature: fromBase64(w.bodySignature),
    signedBy: w.signedBy as DeviceId,
  };
}

// ─── Encrypted path components (F4) ───────────────────────────────────────────

/**
 * Encrypt each `/`-separated component of a bundle-relative logical path so a
 * project/session name never appears as a store key. Each component is sealed
 * under the DEK and URL-safe-base64-encoded; the random per-seal nonce makes the
 * output non-deterministic, which is fine — the manifest file index (itself
 * sealed) records the logical→stored mapping, and {@link decryptPathComponents}
 * recovers the plaintext for the holder of the DEK.
 *
 * A leading `<device-id>/` segment is normally NOT passed here (device ids are
 * already opaque + path-validated); callers encrypt only the sensitive tail
 * (e.g. `<project>/<session>.jsonl`).
 */
export function encryptPathComponents(logicalPath: string, dek: Uint8Array): string {
  return logicalPath
    .split("/")
    .map((component) => (component.length === 0 ? "" : toBase64Url(seal(utf8Encode(component), dek))))
    .join("/");
}

/** Inverse of {@link encryptPathComponents}. Throws on a wrong DEK or tampering. */
export function decryptPathComponents(storedPath: string, dek: Uint8Array): string {
  return storedPath
    .split("/")
    .map((component) => (component.length === 0 ? "" : utf8Decode(open(fromBase64Url(component), dek))))
    .join("/");
}

// ─── Body mutation helpers (immutable — return a new body) ────────────────────

/** An empty manifest body seeded with the passphrase-wrapped DEK + KDF params. */
export function emptyManifestBody(seed: {
  readonly passphraseWrappedDek: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: Argon2idParams;
}): ManifestBody {
  return {
    devices: [],
    passphraseWrappedDek: seed.passphraseWrappedDek,
    kdfSalt: seed.kdfSalt,
    kdfParams: seed.kdfParams,
    files: [],
  };
}

/** Insert or replace a device entry (matched by `deviceId`). Returns a new body. */
export function upsertDevice(body: ManifestBody, entry: DeviceEntry): ManifestBody {
  const devices = body.devices.filter((d) => d.deviceId !== entry.deviceId);
  return { ...body, devices: [...devices, entry] };
}

/** Insert or replace a file-index entry (matched by `path`). Returns a new body. */
export function upsertFileIndex(body: ManifestBody, entry: FileIndexEntry): ManifestBody {
  const files = body.files.filter((f) => f.path !== entry.path);
  return { ...body, files: [...files, entry] };
}

/** Remove a file-index entry by `path`. Returns a new body. */
export function removeFileIndex(body: ManifestBody, path: string): ManifestBody {
  return { ...body, files: body.files.filter((f) => f.path !== path) };
}

/** The recorded encryption state of a bundle file, or `undefined` if unindexed. */
export function fileState(body: ManifestBody, path: string): FileEncryptionState | undefined {
  return body.files.find((f) => f.path === path)?.state;
}
