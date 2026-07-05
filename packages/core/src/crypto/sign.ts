/**
 * Ed25519 signatures for shards and the manifest body (reviews F1/F4).
 *
 * Every shard and the manifest body are signed by the writing device's Ed25519
 * key; readers MUST `verify` against an already-trusted device public key before
 * trusting any bytes. This is what stops an attacker with cloud-folder write
 * access from injecting a rogue device/shard that the merge would otherwise
 * trust (F1).
 *
 * `verify` is TOTAL: it returns `false` for a bad signature, a wrong key, OR
 * malformed/short signature bytes — it never throws. Shard data is attacker-
 * controlled, so a verifier that threw on malformed input would be a trivial
 * DoS / crash vector.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

/** Ed25519 signature length in bytes. */
export const SIGNATURE_BYTES = 64;

/** Ed25519 public-key length in bytes. */
export const SIGN_PUBLIC_KEY_BYTES = 32;

/** Ed25519-sign `message` with a device signing secret key. */
export function sign(message: Uint8Array, signingSecretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, signingSecretKey);
}

/**
 * Verify an Ed25519 `signature` over `message` against `signPublicKey`.
 * @returns `true` iff valid; `false` on any failure (bad sig, wrong key, or
 *   malformed inputs) — never throws.
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  signPublicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, signPublicKey);
  } catch {
    // Malformed signature/key bytes from an untrusted shard => not valid.
    return false;
  }
}
