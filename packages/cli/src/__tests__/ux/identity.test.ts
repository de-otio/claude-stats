/**
 * Phase E wiring glue: device identity mint/cache + first-enrollment crypto
 * bootstrap. Real crypto primitives, an in-memory `KeyStore` fake.
 */
import { describe, expect, it } from "vitest";
import type { KeyStore } from "@claude-stats/core/crypto/types";
import { deriveMaster, generateRecoveryKey, normalizeRecoverySecret, unwrapDek } from "@claude-stats/core/crypto/keys";
import {
  bootstrapBackupCrypto,
  destroyDeviceIdentity,
  generateDeviceId,
  generateDeviceIdentityMaterial,
  IDENTITY_KEYSTORE_KEY,
  loadOrCreateDeviceIdentity,
} from "../../backup/identity.js";

class MemoryKeyStore implements KeyStore {
  private readonly entries = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, secret: Uint8Array): Promise<void> {
    this.entries.set(key, secret);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

describe("generateDeviceId", () => {
  it("always produces a valid DeviceId (lowercase UUID v4)", () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("generates distinct ids on repeated calls", () => {
    expect(generateDeviceId()).not.toBe(generateDeviceId());
  });
});

describe("generateDeviceIdentityMaterial", () => {
  it("produces distinct wrap and sign keypairs, carrying the given deviceId", () => {
    const id = generateDeviceId();
    const m = generateDeviceIdentityMaterial(id);
    expect(m.identity.deviceId).toBe(id);
    expect(m.identity.wrapPublicKey).not.toEqual(m.identity.signPublicKey);
    expect(m.wrapSecretKey.length).toBeGreaterThan(0);
    expect(m.identity.signingSecretKey.length).toBeGreaterThan(0);
  });
});

describe("loadOrCreateDeviceIdentity", () => {
  it("mints a fresh identity on first call and caches it under IDENTITY_KEYSTORE_KEY", async () => {
    const store = new MemoryKeyStore();
    const id = generateDeviceId();
    const material = await loadOrCreateDeviceIdentity(store, id);
    expect(material.identity.deviceId).toBe(id);
    expect(await store.get(IDENTITY_KEYSTORE_KEY)).not.toBeNull();
  });

  it("returns the SAME identity on a second call, ignoring the newly-passed deviceId", async () => {
    const store = new MemoryKeyStore();
    const first = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    const second = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    expect(second.identity.deviceId).toBe(first.identity.deviceId);
    expect(second.identity.wrapPublicKey).toEqual(first.identity.wrapPublicKey);
    expect(second.wrapSecretKey).toEqual(first.wrapSecretKey);
  });

  it("round-trips through encode/decode: public and secret key bytes survive intact", async () => {
    const store = new MemoryKeyStore();
    const original = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    // Force a re-load from the persisted bytes (a fresh in-process "restart").
    const reloaded = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    expect(reloaded.identity.signPublicKey).toEqual(original.identity.signPublicKey);
    expect(reloaded.identity.signingSecretKey).toEqual(original.identity.signingSecretKey);
  });
});

describe("destroyDeviceIdentity", () => {
  it("clears the cached identity so the next load mints a new one", async () => {
    const store = new MemoryKeyStore();
    const first = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    await destroyDeviceIdentity(store);
    expect(await store.get(IDENTITY_KEYSTORE_KEY)).toBeNull();

    const second = await loadOrCreateDeviceIdentity(store, generateDeviceId());
    expect(second.identity.deviceId).not.toBe(first.identity.deviceId);
  });
});

describe("bootstrapBackupCrypto", () => {
  it("wraps a fresh DEK to the passphrase recipient such that the SAME recovery key unwraps it", () => {
    const recoveryKey = generateRecoveryKey();
    const secret = normalizeRecoverySecret(recoveryKey.key);
    const crypto = bootstrapBackupCrypto(secret);
    const master = deriveMaster(secret, crypto.kdfSalt, crypto.kdfParams);
    const recovered = unwrapDek(crypto.passphraseWrappedDek, { kind: "passphrase", masterKey: master });
    expect(recovered).toEqual(crypto.dek);
    // Argon2id is memory-hard by design; under v8 coverage instrumentation each
    // derivation runs several× slower, so give these a generous timeout.
  }, 30_000);

  it("a wrong recovery key fails to unwrap (never returns the wrong DEK silently)", () => {
    const secret = normalizeRecoverySecret(generateRecoveryKey().key);
    const wrongSecret = normalizeRecoverySecret(generateRecoveryKey().key);
    const crypto = bootstrapBackupCrypto(secret);
    const master = deriveMaster(wrongSecret, crypto.kdfSalt, crypto.kdfParams);
    expect(() => unwrapDek(crypto.passphraseWrappedDek, { kind: "passphrase", masterKey: master })).toThrow();
  }, 30_000);

  it("two bootstraps produce different DEKs and different salts (no reuse)", () => {
    const secret = normalizeRecoverySecret(generateRecoveryKey().key);
    const a = bootstrapBackupCrypto(secret);
    const b = bootstrapBackupCrypto(secret);
    expect(a.dek).not.toEqual(b.dek);
    expect(a.kdfSalt).not.toEqual(b.kdfSalt);
  }, 30_000);
});
