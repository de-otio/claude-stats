/**
 * Per-file content AEAD: seal/open with a 32-byte key (the DEK, or any wrap key).
 *
 * Algorithm = **XChaCha20-Poly1305** (the pinned {@link AEAD_ALGORITHM}), from
 * `@noble/ciphers`. XChaCha's 192-bit (24-byte) nonce makes a freshly-random
 * nonce per seal collision-safe even under a long-lived DEK — this is exactly
 * why AES-GCM / 96-bit-nonce AEADs are forbidden (review F7). Every `seal`
 * draws a new nonce from the CSPRNG; a repeated nonce under one key would be a
 * catastrophic break, and the nonce-uniqueness property test guards it.
 *
 * Wire form: `nonce(24) || ciphertext||tag`. `open` authenticates before
 * returning; on any tag mismatch, wrong key, or truncation it throws a CLEAN
 * error (never returns unauthenticated bytes, never leaks key material).
 *
 * NOTE ON `age`: the plan named `age-encryption` for the envelope, but
 * `age@0.3`'s `exports` is the bare `./dist/index.js`, so under the repo's
 * pinned Node16/NodeNext resolution its low-level `encryptSTREAM` /
 * `X25519Recipient` / `ScryptRecipient` symbols are NOT importable, and its
 * `Encrypter` cannot (a) seal to a raw pre-derived key nor (b) mix X25519 +
 * passphrase recipients in one envelope. We therefore use `@noble/ciphers`
 * (which `age` itself is built on) directly — no custom primitive, just the
 * standard AEAD, and it matches the pinned "XChaCha20-Poly1305" label exactly.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "./random.js";
import { DEK_BYTES } from "./types.js";

/** XChaCha20-Poly1305 nonce length in bytes (192-bit — random-nonce safe, F7). */
export const NONCE_BYTES = 24;

/** Poly1305 authentication-tag length in bytes. */
export const TAG_BYTES = 16;

/** The 32-byte symmetric-key length seal/open require (DEK / master / wrap key). */
export const KEY_BYTES = DEK_BYTES;

function assertKey(key: Uint8Array, op: string): void {
  if (key.length !== KEY_BYTES) {
    // Never include the key (or its bytes) in the message.
    throw new Error(`${op}: key must be ${KEY_BYTES} bytes (got ${key.length})`);
  }
}

/**
 * AEAD-seal `plaintext` under `key` with a fresh random 24-byte nonce.
 * @returns `nonce(24) || ciphertext||tag`.
 */
export function seal(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  assertKey(key, "seal");
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/**
 * AEAD-open a `nonce(24) || ciphertext||tag` blob under `key`.
 * @throws a clean error on wrong key, tampering, or truncation — NEVER returns
 *   unauthenticated plaintext.
 */
export function open(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  assertKey(key, "open");
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("open: ciphertext too short to contain a nonce and tag");
  }
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES);
  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    // Collapse noble's internal error into a stable, key-material-free message.
    throw new Error("open: authentication failed (wrong key or tampered ciphertext)");
  }
}
