/**
 * Ed25519 sign/verify property tests (reviews F1/F4).
 *  - verify(msg, sign(msg, sk), pk) is true
 *  - tampered message / wrong key -> false
 *  - malformed signature bytes -> false (verify is TOTAL, never throws)
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sign, verify, SIGNATURE_BYTES } from "@claude-stats/core/crypto/sign";
import { generateSignKeyPair } from "@claude-stats/core/crypto/keys";
import { randomBytes } from "@claude-stats/core/crypto/random";

describe("ed25519 sign/verify", () => {
  it("property: a fresh signature verifies against its own public key", () => {
    const { publicKey, secretKey } = generateSignKeyPair();
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (message) => {
        const sig = sign(message, secretKey);
        expect(sig.length).toBe(SIGNATURE_BYTES);
        expect(verify(message, sig, publicKey)).toBe(true);
      }),
      { numRuns: 200, seed: 90210 },
    );
  });

  it("a tampered message does not verify", () => {
    const { publicKey, secretKey } = generateSignKeyPair();
    const message = new TextEncoder().encode("shard body v1");
    const sig = sign(message, secretKey);
    const tampered = Uint8Array.from(message);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(verify(tampered, sig, publicKey)).toBe(false);
  });

  it("a signature from another device is rejected (writer authentication, F1)", () => {
    const alice = generateSignKeyPair();
    const mallory = generateSignKeyPair();
    const message = new TextEncoder().encode("rogue shard");
    const sig = sign(message, mallory.secretKey);
    // Verifying Mallory's signature against Alice's trusted key must fail.
    expect(verify(message, sig, alice.publicKey)).toBe(false);
  });

  it("malformed / short signature bytes return false, never throw", () => {
    const { publicKey } = generateSignKeyPair();
    const message = new TextEncoder().encode("x");
    expect(verify(message, new Uint8Array(0), publicKey)).toBe(false);
    expect(verify(message, randomBytes(10), publicKey)).toBe(false);
    expect(verify(message, randomBytes(SIGNATURE_BYTES), publicKey)).toBe(false);
    expect(verify(message, randomBytes(SIGNATURE_BYTES), new Uint8Array(5))).toBe(false);
  });
});
