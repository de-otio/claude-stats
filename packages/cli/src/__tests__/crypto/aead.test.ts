/**
 * AEAD seal/open property tests (reviews F7).
 *  - open(seal(x)) == x for arbitrary plaintext + key
 *  - tamper -> authentication failure (clean throw, never garbage)
 *  - wrong key -> clean error, not a crash
 *  - NONCE UNIQUENESS across many seals (the load-bearing F7 property)
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  seal,
  open,
  NONCE_BYTES,
  TAG_BYTES,
  KEY_BYTES,
} from "@claude-stats/core/crypto/aead";
import { randomBytes } from "@claude-stats/core/crypto/random";

const key32 = fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES });

describe("aead seal/open", () => {
  it("property: open(seal(x, k), k) === x for arbitrary plaintext and key", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), key32, (plaintext, key) => {
        const opened = open(seal(plaintext, key), key);
        expect(opened).toEqual(plaintext);
      }),
      { numRuns: 200, seed: 4711 },
    );
  });

  it("wrong key -> clean auth error (not a crash, no garbage)", () => {
    const a = randomBytes(KEY_BYTES);
    const b = randomBytes(KEY_BYTES);
    const sealed = seal(new TextEncoder().encode("secret payload"), a);
    expect(() => open(sealed, b)).toThrowError(/authentication failed/i);
  });

  it("property: any single-byte tamper fails authentication", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        key32,
        fc.nat(),
        (plaintext, key, idxSeed) => {
          const sealed = seal(plaintext, key);
          const i = idxSeed % sealed.length;
          const tampered = Uint8Array.from(sealed);
          tampered[i] = (tampered[i]! ^ 0x01) & 0xff;
          expect(() => open(tampered, key)).toThrow();
        },
      ),
      { numRuns: 200, seed: 1234 },
    );
  });

  it("NONCE UNIQUENESS: 1000 seals of the same plaintext+key yield 1000 distinct nonces (F7)", () => {
    const key = randomBytes(KEY_BYTES);
    const plaintext = new TextEncoder().encode("identical every time");
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const sealed = seal(plaintext, key);
      nonces.add(Buffer.from(sealed.subarray(0, NONCE_BYTES)).toString("hex"));
      ciphertexts.add(Buffer.from(sealed).toString("hex"));
    }
    expect(nonces.size).toBe(1000);
    // A fresh nonce every time => identical plaintext still yields distinct output.
    expect(ciphertexts.size).toBe(1000);
  });

  it("rejects a ciphertext too short to hold a nonce+tag", () => {
    const key = randomBytes(KEY_BYTES);
    expect(() => open(new Uint8Array(NONCE_BYTES + TAG_BYTES - 1), key)).toThrowError(/too short/i);
  });

  it("rejects a wrong-length key on seal and open", () => {
    const short = randomBytes(KEY_BYTES - 1);
    expect(() => seal(new Uint8Array([1, 2, 3]), short)).toThrowError(/key must be/i);
    expect(() => open(new Uint8Array(NONCE_BYTES + TAG_BYTES), short)).toThrowError(/key must be/i);
  });
});
