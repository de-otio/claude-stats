/**
 * The single, auditable CSPRNG choke point for the personal-plane crypto.
 *
 * Delegates to `@noble/hashes`'s `randomBytes`, which is a thin wrapper over the
 * platform WebCrypto `crypto.getRandomValues()` (throwing if no secure RNG is
 * available). Routing every random draw — DEKs, AEAD nonces, the recovery key,
 * KDF salts — through this one function keeps the entropy source in one place
 * and satisfies the "recovery key from `crypto.getRandomValues()`" rule (F10).
 *
 * NEVER seed or stub this in production. Tests that need determinism pin
 * fast-check inputs, not this generator: nonce-uniqueness (F7) is a REAL
 * property that must be exercised against a real CSPRNG.
 */

import { randomBytes as secureRandomBytes } from "@noble/hashes/utils.js";
import { KDF_SALT_BYTES } from "./types.js";

/** `length` cryptographically-secure random bytes (via `crypto.getRandomValues`). */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("randomBytes: length must be a non-negative integer");
  }
  return secureRandomBytes(length);
}

/** A fresh random 128-bit KDF salt (non-secret; stored in the manifest — F8). */
export function generateKdfSalt(): Uint8Array {
  return randomBytes(KDF_SALT_BYTES);
}
