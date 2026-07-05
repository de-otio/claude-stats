/**
 * Envelope-key keystone tests (reviews F2/B3/F10).
 *  - DEK wrap/unwrap round-trips for device, passphrase, and mixed recipient sets
 *  - wrong key -> clean error, not a crash
 *  - recovery-key entropy/format + normalize round-trip (F10)
 *  - key-rotation + NEW-DEVICE ENROLLMENT unwraps the DEK from the manifest (B3)
 *  - revoking a device denies it the rotated DEK (F2)
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  generateWrapKeyPair,
  generateDek,
  deriveMaster,
  wrapDek,
  unwrapDek,
  rotateDek,
  revokeDevices,
  generateRecoveryKey,
  normalizeRecoverySecret,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt, randomBytes } from "@claude-stats/core/crypto/random";
import {
  DEK_BYTES,
  RECOVERY_ENTROPY_BITS,
  type Argon2idParams,
  type WrapRecipient,
} from "@claude-stats/core/crypto/types";

// Reduced Argon2id cost keeps the property/round-trip tests fast; production
// uses the pinned ARGON2ID_PARAMS. (m >= 8*p; dkLen 32.)
const TEST_ARGON: Argon2idParams = {
  memoryKiB: 256,
  iterations: 1,
  parallelism: 1,
  keyLengthBytes: 32,
};

describe("DEK generation", () => {
  it("generates a 256-bit DEK and fresh DEKs differ", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(DEK_BYTES);
    expect(a).not.toEqual(b);
  });
});

describe("wrapDek / unwrapDek", () => {
  it("device recipient round-trips", () => {
    const device = generateWrapKeyPair();
    const dek = generateDek();
    const wrapped = wrapDek(dek, [{ kind: "device", wrapPublicKey: device.publicKey }]);
    const out = unwrapDek(wrapped, { kind: "device", wrapSecretKey: device.secretKey });
    expect(out).toEqual(dek);
  });

  it("passphrase recipient round-trips", () => {
    const master = deriveMaster(randomBytes(20), generateKdfSalt(), TEST_ARGON);
    const dek = generateDek();
    const wrapped = wrapDek(dek, [{ kind: "passphrase", masterKey: master }]);
    const out = unwrapDek(wrapped, { kind: "passphrase", masterKey: master });
    expect(out).toEqual(dek);
  });

  it("a single mixed envelope is openable by every recipient (multi-recipient)", () => {
    const a = generateWrapKeyPair();
    const b = generateWrapKeyPair();
    const master = deriveMaster(randomBytes(20), generateKdfSalt(), TEST_ARGON);
    const dek = generateDek();
    const wrapped = wrapDek(dek, [
      { kind: "device", wrapPublicKey: a.publicKey },
      { kind: "device", wrapPublicKey: b.publicKey },
      { kind: "passphrase", masterKey: master },
    ]);
    expect(unwrapDek(wrapped, { kind: "device", wrapSecretKey: a.secretKey })).toEqual(dek);
    expect(unwrapDek(wrapped, { kind: "device", wrapSecretKey: b.secretKey })).toEqual(dek);
    expect(unwrapDek(wrapped, { kind: "passphrase", masterKey: master })).toEqual(dek);
  });

  it("a non-recipient device gets a clean error, not a crash", () => {
    const enrolled = generateWrapKeyPair();
    const outsider = generateWrapKeyPair();
    const dek = generateDek();
    const wrapped = wrapDek(dek, [{ kind: "device", wrapPublicKey: enrolled.publicKey }]);
    expect(() => unwrapDek(wrapped, { kind: "device", wrapSecretKey: outsider.secretKey })).toThrowError(
      /no recipient stanza matched/i,
    );
  });

  it("the wrong master key gets a clean error", () => {
    const master = deriveMaster(randomBytes(20), generateKdfSalt(), TEST_ARGON);
    const wrong = deriveMaster(randomBytes(20), generateKdfSalt(), TEST_ARGON);
    const wrapped = wrapDek(generateDek(), [{ kind: "passphrase", masterKey: master }]);
    expect(() => unwrapDek(wrapped, { kind: "passphrase", masterKey: wrong })).toThrow();
  });

  it("rejects malformed wrapped-DEK bytes cleanly", () => {
    const device = generateWrapKeyPair();
    expect(() => unwrapDek(new Uint8Array(0), { kind: "device", wrapSecretKey: device.secretKey })).toThrow();
    expect(() =>
      unwrapDek(new Uint8Array([9, 1, 1, 0, 0, 0, 1, 7]), { kind: "device", wrapSecretKey: device.secretKey }),
    ).toThrowError(/version/i);
  });

  it("rejects an empty recipient set", () => {
    expect(() => wrapDek(generateDek(), [])).toThrowError(/recipient count/i);
  });

  it("property: device wrap/unwrap round-trips for random DEKs", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: DEK_BYTES, maxLength: DEK_BYTES }), (dekBytes) => {
        const device = generateWrapKeyPair();
        const wrapped = wrapDek(dekBytes, [{ kind: "device", wrapPublicKey: device.publicKey }]);
        expect(unwrapDek(wrapped, { kind: "device", wrapSecretKey: device.secretKey })).toEqual(dekBytes);
      }),
      { numRuns: 60, seed: 8080 },
    );
  });
});

describe("deriveMaster", () => {
  it("is deterministic in (secret, salt, params) and salt-sensitive", () => {
    const secret = randomBytes(20);
    const salt = generateKdfSalt();
    const m1 = deriveMaster(secret, salt, TEST_ARGON);
    const m2 = deriveMaster(secret, salt, TEST_ARGON);
    expect(m1).toEqual(m2);
    expect(m1.length).toBe(TEST_ARGON.keyLengthBytes);
    const m3 = deriveMaster(secret, generateKdfSalt(), TEST_ARGON);
    expect(m3).not.toEqual(m1);
  });
});

describe("recovery key (F10)", () => {
  it("generates >=128-bit base32 keys of the documented shape", () => {
    const rk = generateRecoveryKey();
    expect(rk.entropyBits).toBeGreaterThanOrEqual(RECOVERY_ENTROPY_BITS);
    // Hyphen-grouped uppercase RFC4648 base32.
    expect(rk.key).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{2,4})+$/);
    const bare = rk.key.replace(/-/g, "");
    expect(bare.length).toBeGreaterThanOrEqual(Math.ceil(RECOVERY_ENTROPY_BITS / 5));
  });

  it("two generated keys differ", () => {
    expect(generateRecoveryKey().key).not.toBe(generateRecoveryKey().key);
  });

  it("normalize is case/whitespace/hyphen insensitive and canonical", () => {
    const rk = generateRecoveryKey();
    const bare = rk.key.replace(/-/g, "");
    const spacedLower = rk.key.toLowerCase().replace(/-/g, " ");
    expect(normalizeRecoverySecret(rk.key)).toEqual(normalizeRecoverySecret(spacedLower));
    expect(new TextDecoder().decode(normalizeRecoverySecret(rk.key))).toBe(bare);
  });

  it("rejects a too-short recovery secret", () => {
    expect(() => normalizeRecoverySecret("ABCD-EF")).toThrowError(/too short/i);
  });
});

describe("new-device enrollment via the manifest (B3)", () => {
  it("a second device recovers the DEK from the passphrase-wrapped blob using only the recovery key", () => {
    // --- device A, first-time setup: produces what the manifest stores ---
    const dek = generateDek();
    const salt = generateKdfSalt(); // manifest.kdfSalt
    const recovery = generateRecoveryKey(); // shown to the user once
    const masterA = deriveMaster(normalizeRecoverySecret(recovery.key), salt, TEST_ARGON);
    const passphraseWrappedDek = wrapDek(dek, [{ kind: "passphrase", masterKey: masterA }]);

    // --- device B: has ONLY the recovery key + the (public) manifest fields ---
    const masterB = deriveMaster(normalizeRecoverySecret(recovery.key), salt, TEST_ARGON);
    const recovered = unwrapDek(passphraseWrappedDek, { kind: "passphrase", masterKey: masterB });
    expect(recovered).toEqual(dek);

    // Enrolling B = wrap the SAME dek to B's device key (no content re-encryption).
    const deviceB = generateWrapKeyPair();
    const bWrapped = wrapDek(recovered, [{ kind: "device", wrapPublicKey: deviceB.publicKey }]);
    expect(unwrapDek(bWrapped, { kind: "device", wrapSecretKey: deviceB.secretKey })).toEqual(dek);
  });
});

describe("DEK rotation + device revocation (F2)", () => {
  it("revoking a device denies it the rotated DEK while survivors keep access", () => {
    const deviceA = generateWrapKeyPair();
    const deviceB = generateWrapKeyPair();
    const master = deriveMaster(normalizeRecoverySecret(generateRecoveryKey().key), generateKdfSalt(), TEST_ARGON);

    const recipients: WrapRecipient[] = [
      { kind: "device", wrapPublicKey: deviceA.publicKey },
      { kind: "device", wrapPublicKey: deviceB.publicKey },
      { kind: "passphrase", masterKey: master },
    ];

    const dek1 = generateDek();
    const wrapped1 = wrapDek(dek1, recipients);
    // Baseline: A can read the current DEK.
    expect(unwrapDek(wrapped1, { kind: "device", wrapSecretKey: deviceA.secretKey })).toEqual(dek1);

    // Revoke A: drop its recipient, ROTATE the DEK, re-wrap to survivors.
    const survivors = revokeDevices(recipients, [deviceA.publicKey]);
    expect(survivors).toHaveLength(2);
    const dek2 = rotateDek();
    expect(dek2).not.toEqual(dek1);
    const wrapped2 = wrapDek(dek2, survivors);

    // A is denied the rotated DEK (its stanza is gone).
    expect(() => unwrapDek(wrapped2, { kind: "device", wrapSecretKey: deviceA.secretKey })).toThrow();
    // B and the recovery passphrase keep access.
    expect(unwrapDek(wrapped2, { kind: "device", wrapSecretKey: deviceB.secretKey })).toEqual(dek2);
    expect(unwrapDek(wrapped2, { kind: "passphrase", masterKey: master })).toEqual(dek2);
  });
});
