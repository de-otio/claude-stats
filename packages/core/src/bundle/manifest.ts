/**
 * Manifest: a small PLAINTEXT header + a plaintext bootstrap KEY ENVELOPE + an
 * ENCRYPTED, SIGNED body (F1/F4/B3).
 *
 * Three sections:
 *   1. HEADER — plaintext dispatch info (format version + pinned AEAD label).
 *   2. KEY ENVELOPE — plaintext bootstrap material (KDF salt/params + the DEK
 *      wrapped to the passphrase recipient). This MUST be plaintext: a device
 *      holding only the recovery key needs it to derive the DEK, and a chicken-
 *      and-egg loop results if it is sealed under that very DEK (review B3). It
 *      is safe in the clear — the passphrase-wrapped DEK is an AEAD ciphertext
 *      keyed by `Argon2id(recoverySecret, salt)`, self-protecting against an
 *      attacker who lacks the recovery secret — and it is covered by the body
 *      signature so it cannot be substituted.
 *   3. BODY — the SENSITIVE metadata (device list with public keys + the per-file
 *      encryption-state index). Serialized canonically, SEALED with the DEK (so
 *      device/project/session names never leak — F4), and covered by the
 *      signature (F1).
 *
 * The signature (Ed25519, by the writing device) is over the header + the key
 * envelope + the sealed body TOGETHER, so tampering with ANY section is caught.
 * A reader verifies the signature and decrypts BEFORE trusting any field.
 *
 * Archive PATH COMPONENTS are encrypted too ({@link encryptPathComponents}) so a
 * project/session name never appears as a store key even in the file index.
 *
 * BOOTSTRAP / TRUST: possession of the DEK is the read authorization. The common
 * case reads the DEK from the OS keychain; recovery / new-device enrollment
 * derives it from the plaintext key envelope via the recovery key
 * (`recoverBackupCrypto` in the CLI backup layer), THEN opens the sealed body.
 * {@link openManifest} accepts an OPTIONAL external trusted-device key; when
 * omitted the body self-authenticates against the signer's own embedded entry —
 * an attacker without the DEK cannot produce a body that both decrypts and
 * verifies.
 */

import type {
  DeviceEntry,
  DeviceId,
  FileEncryptionState,
  FileIndexEntry,
  Manifest,
  ManifestBody,
  ManifestHeader,
  ManifestKeyEnvelope,
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

/**
 * Manifest wire-format version. Bumped 1→2 when the bootstrap material (KDF
 * salt/params + passphrase-wrapped DEK) moved OUT of the DEK-sealed body into
 * the plaintext {@link ManifestKeyEnvelope}, so a recovery-key-only device can
 * bootstrap the DEK (review B3). v1 manifests are not forward-readable.
 */
export const MANIFEST_FORMAT_VERSION = 2;

/** The default plaintext header (format version + pinned AEAD label). */
export function manifestHeader(): ManifestHeader {
  return { formatVersion: MANIFEST_FORMAT_VERSION, aead: AEAD_ALGORITHM };
}

// ─── ManifestKeyEnvelope ⇄ canonical bytes (plaintext bootstrap material) ─────

interface ManifestKeyEnvelopeWire {
  readonly passphraseWrappedDek: string;
  readonly kdfSalt: string;
  readonly kdfParams: Argon2idParams;
}

function keyEnvelopeToWire(env: ManifestKeyEnvelope): ManifestKeyEnvelopeWire {
  return {
    passphraseWrappedDek: toBase64(env.passphraseWrappedDek),
    kdfSalt: toBase64(env.kdfSalt),
    kdfParams: env.kdfParams,
  };
}

function keyEnvelopeFromWire(w: ManifestKeyEnvelopeWire): ManifestKeyEnvelope {
  return {
    passphraseWrappedDek: fromBase64(w.passphraseWrappedDek),
    kdfSalt: fromBase64(w.kdfSalt),
    kdfParams: w.kdfParams,
  };
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
    files: body.files,
  };
  return serializeJson(wire);
}

/** Parse a canonical manifest-body serialization back to a {@link ManifestBody}. */
export function deserializeManifestBody(bytes: Uint8Array): ManifestBody {
  const w = deserializeJson<ManifestBodyWire>(bytes);
  return {
    devices: w.devices.map(deviceFromWire),
    files: w.files,
  };
}

// ─── the signed representation (header + key envelope + sealed body) ──────────

/**
 * The exact bytes the manifest signature is computed over: a canonical JSON of
 * the header, the plaintext key envelope, and the base64 of the sealed body —
 * so a tamper to ANY of the three sections (including a substituted plaintext
 * key envelope) breaks the signature. Canonical JSON is unambiguous, so no
 * separate length-prefixing is needed.
 */
function manifestSigningInput(
  header: ManifestHeader,
  keyEnvelope: ManifestKeyEnvelope,
  sealedBody: Uint8Array,
): Uint8Array {
  return serializeJson({
    header,
    keyEnvelope: keyEnvelopeToWire(keyEnvelope),
    sealedBody: toBase64(sealedBody),
  });
}

// ─── seal + sign / verify + open ──────────────────────────────────────────────

export interface SealManifestOptions {
  readonly dek: Uint8Array;
  /** Plaintext bootstrap material carried in the clear so a keyless device can
   *  derive the DEK before opening the body (review B3). */
  readonly keyEnvelope: ManifestKeyEnvelope;
  /** Ed25519 signing secret key of `signedBy`. */
  readonly signingSecretKey: Uint8Array;
  /** The device signing the manifest body. MUST have an entry in `body.devices`. */
  readonly signedBy: DeviceId;
  readonly header?: ManifestHeader;
}

/**
 * Seal + sign a {@link ManifestBody} into the on-store {@link Manifest}. The body
 * is sealed with the DEK; the signature covers the header + the plaintext key
 * envelope + the sealed body together, so the envelope can't be substituted.
 */
export function sealManifest(body: ManifestBody, options: SealManifestOptions): Manifest {
  const header = options.header ?? manifestHeader();
  const sealedBody = seal(serializeManifestBody(body), options.dek);
  const bodySignature = sign(
    manifestSigningInput(header, options.keyEnvelope, sealedBody),
    options.signingSecretKey,
  );
  return {
    header,
    keyEnvelope: options.keyEnvelope,
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
 * Verify a {@link Manifest}'s signature and decrypt the body. Throws on a
 * signature or decrypt failure — never returns an untrusted body. The signature
 * is verified over the header + key envelope + sealed body, so a tampered
 * plaintext key envelope is rejected too.
 */
export function openManifest(manifest: Manifest, options: OpenManifestOptions): ManifestBody {
  const signingInput = manifestSigningInput(manifest.header, manifest.keyEnvelope, manifest.sealedBody);
  if (options.signPublicKey) {
    if (!verify(signingInput, manifest.bodySignature, options.signPublicKey)) {
      throw new Error("openManifest: manifest signature did not verify against the trusted key");
    }
  }
  // Decrypt (possession of the DEK authorizes the read); throws cleanly on a
  // wrong DEK or a tampered body.
  const body = deserializeManifestBody(open(manifest.sealedBody, options.dek));
  if (!options.signPublicKey) {
    const signer = body.devices.find((d) => d.deviceId === manifest.signedBy);
    if (!signer) {
      throw new Error("openManifest: signing device is not present in the manifest device list");
    }
    if (!verify(signingInput, manifest.bodySignature, signer.signPublicKey)) {
      throw new Error("openManifest: manifest signature did not verify against the embedded key");
    }
  }
  return body;
}

// ─── Manifest ⇄ store bytes ───────────────────────────────────────────────────

interface ManifestWire {
  readonly header: ManifestHeader;
  readonly keyEnvelope: ManifestKeyEnvelopeWire;
  readonly sealedBody: string;
  readonly bodySignature: string;
  readonly signedBy: string;
}

/** Serialize a {@link Manifest} to the bytes written to the store as `manifest.json`. */
export function encodeManifest(manifest: Manifest): Uint8Array {
  const wire: ManifestWire = {
    header: manifest.header,
    keyEnvelope: keyEnvelopeToWire(manifest.keyEnvelope),
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
    keyEnvelope: keyEnvelopeFromWire(w.keyEnvelope),
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

/**
 * An empty manifest body (no devices, no files). Bootstrap material (salt /
 * params / passphrase-wrapped DEK) is NOT part of the body any more — it travels
 * in the plaintext {@link ManifestKeyEnvelope} passed to {@link sealManifest}.
 */
export function emptyManifestBody(): ManifestBody {
  return { devices: [], files: [] };
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
