/**
 * The assembled CryptoProvider (the seam Phases C/D consume). Confirms the async
 * wiring round-trips across seal/open, wrap/unwrap, and sign/verify.
 */
import { describe, it, expect } from "vitest";
import { createCryptoProvider } from "@claude-stats/core/crypto/keys";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";

const TEST_ARGON: Argon2idParams = {
  memoryKiB: 256,
  iterations: 1,
  parallelism: 1,
  keyLengthBytes: 32,
};

describe("createCryptoProvider", () => {
  it("round-trips content sealing with a generated DEK", async () => {
    const p = createCryptoProvider();
    const dek = p.generateDek();
    const message = new TextEncoder().encode("phase C will call me");
    const sealed = await p.seal(message, dek);
    expect(await p.open(sealed, dek)).toEqual(message);
  });

  it("round-trips DEK wrapping to a device recipient", async () => {
    const p = createCryptoProvider();
    const device = await p.generateWrapKeyPair();
    const dek = p.generateDek();
    const wrapped = await p.wrapDek(dek, [{ kind: "device", wrapPublicKey: device.publicKey }]);
    const out = await p.unwrapDek(wrapped, { kind: "device", wrapSecretKey: device.secretKey });
    expect(out).toEqual(dek);
  });

  it("round-trips DEK wrapping to the passphrase recipient", async () => {
    const p = createCryptoProvider();
    const master = await p.deriveMaster(new TextEncoder().encode("recovery"), new Uint8Array(16), TEST_ARGON);
    const dek = p.generateDek();
    const wrapped = await p.wrapDek(dek, [{ kind: "passphrase", masterKey: master }]);
    expect(await p.unwrapDek(wrapped, { kind: "passphrase", masterKey: master })).toEqual(dek);
  });

  it("signs and verifies through the provider", async () => {
    const p = createCryptoProvider();
    const { publicKey, secretKey } = await p.generateSignKeyPair();
    const message = new TextEncoder().encode("manifest body");
    const sig = await p.sign(message, secretKey);
    expect(await p.verify(message, sig, publicKey)).toBe(true);
    const tampered = Uint8Array.from(message);
    tampered[0]! ^= 0xff;
    expect(await p.verify(tampered, sig, publicKey)).toBe(false);
  });
});
