/**
 * The envelope-key keystone (reviews F1/F2/F4/B3/F6/F8/F10).
 *
 * Model (age-style multi-recipient, built on `@noble` primitives):
 *  - Each device has an X25519 **wrap** keypair and an Ed25519 **sign** keypair.
 *  - A random 256-bit **DEK** encrypts file content (see `aead.ts`).
 *  - The DEK is **wrapped to a recipient set** — every enrolled device's X25519
 *    wrap public key PLUS a passphrase recipient derived (Argon2id) from the
 *    recovery key. Wrapping the small DEK (not the content) is what makes
 *    new-device enrollment + recovery possible WITHOUT re-encrypting content
 *    (F2/B3), and lets revocation = rotate-DEK + re-wrap to the survivors (F2).
 *
 * DEK wrapping is a compact self-describing envelope with one stanza per
 * recipient:
 *  - **device** stanza: an X25519 sealed box — ephemeral ECDH → HKDF-SHA256 →
 *    XChaCha20-Poly1305 wrap of the DEK. (Standard sealed-box construction, the
 *    same shape age's X25519 stanza / NaCl `crypto_box_seal` / HPKE use; no
 *    novel primitive.)
 *  - **passphrase** stanza: XChaCha20-Poly1305 of the DEK under the already-
 *    derived 32-byte master key.
 *
 * Why not `age`'s own recipients: `age@0.3` exports only its bare index, so
 * under Node16/NodeNext its `X25519Recipient`/`ScryptRecipient` are not
 * importable; and its high-level `Encrypter` can neither wrap to a pre-derived
 * symmetric master key (the `WrapRecipient.passphrase.masterKey` contract) nor
 * mix X25519 + passphrase recipients in one envelope. We therefore compose the
 * vetted `@noble` primitives (which `age` is itself built on) directly.
 *
 * Key material is raw `Uint8Array` and is NEVER logged or put in an error.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  ARGON2ID_PARAMS,
  DEK_BYTES,
  RECOVERY_ENTROPY_BITS,
  type Argon2idParams,
  type CryptoProvider,
  type Dek,
  type MasterKey,
  type SignKeyPair,
  type WrapIdentity,
  type WrapKeyPair,
  type WrapRecipient,
  type WrappedDek,
} from "./types.js";
import { KEY_BYTES, open, seal } from "./aead.js";
import { randomBytes } from "./random.js";
import { sign, verify } from "./sign.js";

// ─── low-level byte helpers ──────────────────────────────────────────────────

function concatBytes(...arrays: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

const UTF8 = new TextEncoder();

/** Constant-time-ish equality (inputs here are public keys — not secret). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ─── device identity + DEK generation ────────────────────────────────────────

/** Generate a device X25519 wrap keypair (raw 32-byte public/secret). */
export function generateWrapKeyPair(): WrapKeyPair {
  const kp = x25519.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Generate a device Ed25519 signing keypair (raw public/secret). */
export function generateSignKeyPair(): SignKeyPair {
  const kp = ed25519.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Generate a fresh random 256-bit DEK. */
export function generateDek(): Dek {
  return randomBytes(DEK_BYTES);
}

/**
 * Rotate the DEK: a brand-new random DEK. Callers MUST re-wrap it to the current
 * recipient set and **re-encrypt** all content sealed under the old DEK — that
 * re-encryption is what denies a revoked device access to data going forward
 * (F2). Rotation alone (without re-encrypt) does not revoke.
 */
export function rotateDek(): Dek {
  return generateDek();
}

// ─── master-key derivation (Argon2id) ────────────────────────────────────────

/**
 * Derive the 32-byte master key from the recovery secret + salt via Argon2id.
 * `params` defaults to the pinned {@link ARGON2ID_PARAMS}; a bundle carrying its
 * own params passes them so old bundles stay readable. The salt is the random
 * 128-bit value stored (non-secret) in the manifest (F8).
 */
export function deriveMaster(
  recoverySecret: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams = ARGON2ID_PARAMS,
): MasterKey {
  return argon2id(recoverySecret, salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    dkLen: params.keyLengthBytes,
  });
}

// ─── DEK wrapping envelope ────────────────────────────────────────────────────

const ENVELOPE_VERSION = 1;
const STANZA_DEVICE = 1;
const STANZA_PASSPHRASE = 2;
/** Domain separator bound into the sealed-box KDF (prevents cross-use). */
const SEALBOX_INFO = UTF8.encode("claude-stats/personal-plane/dek-wrap/x25519-v1");

interface Stanza {
  readonly kind: number;
  readonly body: Uint8Array;
}

function encodeEnvelope(stanzas: readonly Stanza[]): WrappedDek {
  if (stanzas.length === 0 || stanzas.length > 255) {
    throw new Error("wrapDek: recipient count must be between 1 and 255");
  }
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(2);
  head[0] = ENVELOPE_VERSION;
  head[1] = stanzas.length;
  parts.push(head);
  for (const s of stanzas) {
    const meta = new Uint8Array(5);
    meta[0] = s.kind;
    new DataView(meta.buffer).setUint32(1, s.body.length, false);
    parts.push(meta, s.body);
  }
  return concatBytes(...parts);
}

function decodeEnvelope(wrapped: Uint8Array): readonly Stanza[] {
  if (wrapped.length < 2) throw new Error("unwrapDek: wrapped DEK is truncated");
  const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
  const version = view.getUint8(0);
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`unwrapDek: unsupported wrapped-DEK version ${version}`);
  }
  const count = view.getUint8(1);
  const stanzas: Stanza[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    if (offset + 5 > wrapped.length) throw new Error("unwrapDek: truncated stanza header");
    const kind = view.getUint8(offset);
    const len = view.getUint32(offset + 1, false);
    offset += 5;
    if (offset + len > wrapped.length) throw new Error("unwrapDek: truncated stanza body");
    stanzas.push({ kind, body: wrapped.subarray(offset, offset + len) });
    offset += len;
  }
  if (offset !== wrapped.length) throw new Error("unwrapDek: trailing bytes after last stanza");
  return stanzas;
}

// X25519 sealed box (ephemeral-static ECDH → HKDF → AEAD) over the DEK.
function sealBoxWrap(dek: Dek, recipientWrapPublicKey: Uint8Array): Uint8Array {
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, recipientWrapPublicKey);
  const wrapKey = hkdf(
    sha256,
    shared,
    undefined,
    concatBytes(SEALBOX_INFO, ephemeral.publicKey, recipientWrapPublicKey),
    KEY_BYTES,
  );
  return concatBytes(ephemeral.publicKey, seal(dek, wrapKey));
}

function sealBoxUnwrap(body: Uint8Array, wrapSecretKey: Uint8Array): Dek {
  const ephemeralPublicKey = body.subarray(0, 32);
  const sealed = body.subarray(32);
  const recipientPublicKey = x25519.getPublicKey(wrapSecretKey);
  const shared = x25519.getSharedSecret(wrapSecretKey, ephemeralPublicKey);
  const wrapKey = hkdf(
    sha256,
    shared,
    undefined,
    concatBytes(SEALBOX_INFO, ephemeralPublicKey, recipientPublicKey),
    KEY_BYTES,
  );
  return open(sealed, wrapKey);
}

/**
 * Wrap `dek` to `recipients` (device X25519 pubkeys and/or the passphrase
 * master key), producing one opaque {@link WrappedDek} envelope. Wrapping the
 * DEK — not the content — is what makes enrollment/recovery cheap (F2/B3).
 */
export function wrapDek(dek: Dek, recipients: readonly WrapRecipient[]): WrappedDek {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`wrapDek: DEK must be ${DEK_BYTES} bytes (got ${dek.length})`);
  }
  const stanzas = recipients.map((r): Stanza =>
    r.kind === "device"
      ? { kind: STANZA_DEVICE, body: sealBoxWrap(dek, r.wrapPublicKey) }
      : { kind: STANZA_PASSPHRASE, body: seal(dek, r.masterKey) },
  );
  return encodeEnvelope(stanzas);
}

/**
 * Unwrap a DEK from a {@link WrappedDek} using a device wrap secret key OR the
 * passphrase master key. Tries every stanza matching the identity's kind and
 * returns the DEK from the first that opens; throws a CLEAN error (no key
 * material) when none match — i.e. wrong key, or a revoked device whose stanza
 * was dropped from the re-wrapped envelope.
 */
export function unwrapDek(wrapped: WrappedDek, identity: WrapIdentity): Dek {
  const stanzas = decodeEnvelope(wrapped);
  for (const s of stanzas) {
    try {
      if (identity.kind === "device" && s.kind === STANZA_DEVICE) {
        return sealBoxUnwrap(s.body, identity.wrapSecretKey);
      }
      if (identity.kind === "passphrase" && s.kind === STANZA_PASSPHRASE) {
        return open(s.body, identity.masterKey);
      }
    } catch {
      // Wrong stanza for this identity; keep trying the rest.
    }
  }
  throw new Error("unwrapDek: no recipient stanza matched this identity (wrong key or revoked)");
}

// ─── device revocation (recipient-set surgery) ───────────────────────────────

/**
 * Drop the given device wrap public keys from a recipient set (passphrase
 * recipients are always kept). Revoking a device is: `revokeDevices` →
 * {@link rotateDek} → {@link wrapDek} to the survivors → re-encrypt content
 * under the new DEK (F2). This helper is the pure recipient-set step.
 */
export function revokeDevices(
  recipients: readonly WrapRecipient[],
  revokedWrapPublicKeys: readonly Uint8Array[],
): WrapRecipient[] {
  return recipients.filter(
    (r) =>
      r.kind !== "device" ||
      !revokedWrapPublicKeys.some((pk) => bytesEqual(pk, r.wrapPublicKey)),
  );
}

// ─── recovery key (≥128-bit, RFC4648 base32 — F10) ───────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 160 bits of entropy (> the 128-bit floor), encodes to exactly 32 base32 chars. */
const RECOVERY_ENTROPY_BYTES = 20;
/** ceil(128/5) = 26 base32 chars is the minimum for the pinned entropy floor. */
const MIN_RECOVERY_CHARS = Math.ceil(RECOVERY_ENTROPY_BITS / 5);

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/** A generated recovery key + its entropy. Format: hyphen-grouped base32. */
export interface RecoveryKey {
  /** Display/paste form, e.g. `ABCD-EFGH-...` (uppercase base32, 4-char groups). */
  readonly key: string;
  /** Entropy in bits (≥ {@link RECOVERY_ENTROPY_BITS}). */
  readonly entropyBits: number;
}

/**
 * Generate a recovery key: 160 bits from the CSPRNG, RFC4648 base32, grouped in
 * fours for readability. The user safeguards this; losing it (and all devices)
 * means the encrypted backup is unrecoverable — that is the zero-knowledge
 * tradeoff, stated plainly in the UX (F10).
 */
export function generateRecoveryKey(): RecoveryKey {
  const raw = randomBytes(RECOVERY_ENTROPY_BYTES);
  const encoded = base32Encode(raw);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += 4) groups.push(encoded.slice(i, i + 4));
  return { key: groups.join("-"), entropyBits: RECOVERY_ENTROPY_BYTES * 8 };
}

/**
 * Canonicalize a user-entered recovery key into the bytes fed to
 * {@link deriveMaster}: uppercase, strip anything outside the base32 alphabet
 * (hyphens, spaces), and require enough length to carry the entropy floor.
 * Feeding the canonical string bytes (not decoded bytes) to Argon2id is fine —
 * the entropy is identical either way — and avoids a decoder.
 */
export function normalizeRecoverySecret(key: string): Uint8Array {
  const canonical = key.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (canonical.length < MIN_RECOVERY_CHARS) {
    throw new Error(
      `recovery key too short: need >=${MIN_RECOVERY_CHARS} base32 chars for >=${RECOVERY_ENTROPY_BITS} bits`,
    );
  }
  return UTF8.encode(canonical);
}

// ─── the assembled CryptoProvider ────────────────────────────────────────────

/**
 * A concrete {@link CryptoProvider} wiring keys + `aead` + `sign` together. This
 * is the seam Phases C/D consume; all methods are async per the interface even
 * where the underlying `@noble` calls are synchronous.
 */
export function createCryptoProvider(): CryptoProvider {
  return {
    async generateWrapKeyPair() {
      return generateWrapKeyPair();
    },
    async generateSignKeyPair() {
      return generateSignKeyPair();
    },
    generateDek() {
      return generateDek();
    },
    async deriveMaster(recoverySecret, salt, params) {
      return deriveMaster(recoverySecret, salt, params);
    },
    async wrapDek(dek, recipients) {
      return wrapDek(dek, recipients);
    },
    async unwrapDek(wrapped, identity) {
      return unwrapDek(wrapped, identity);
    },
    async seal(plaintext, dek) {
      return seal(plaintext, dek);
    },
    async open(ciphertext, dek) {
      return open(ciphertext, dek);
    },
    async sign(message, signingSecretKey) {
      return sign(message, signingSecretKey);
    },
    async verify(message, signature, signPublicKey) {
      return verify(message, signature, signPublicKey);
    },
  };
}
