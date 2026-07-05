/**
 * Extension SecretStorage KeyStore tests. Uses a fake in-memory SecretStorage so
 * the impl is exercised without a live VS Code host. Verifies the byte<->base64
 * bridge and namespacing behaviour (get/set/delete round-trip, null on miss).
 */
import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import {
  SecretStorageKeyStore,
  createSecretStorageKeyStore,
} from "../../extension/keystore-secretstorage.js";
import { randomBytes } from "@claude-stats/core/crypto/random";

class FakeSecretStorage {
  readonly map = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  // `onDidChange` is part of the interface but unused here.
  onDidChange = (() => ({ dispose() {} })) as unknown as vscode.SecretStorage["onDidChange"];
}

describe("SecretStorageKeyStore", () => {
  it("round-trips a device secret through base64 storage", async () => {
    const fake = new FakeSecretStorage();
    const store = new SecretStorageKeyStore(fake as unknown as vscode.SecretStorage);
    const secret = randomBytes(64);
    await store.set("device", secret);
    expect(await store.get("device")).toEqual(secret);
  });

  it("returns null for a missing key", async () => {
    const fake = new FakeSecretStorage();
    const store = new SecretStorageKeyStore(fake as unknown as vscode.SecretStorage);
    expect(await store.get("missing")).toBeNull();
  });

  it("delete removes the secret", async () => {
    const fake = new FakeSecretStorage();
    const store = new SecretStorageKeyStore(fake as unknown as vscode.SecretStorage);
    await store.set("device", randomBytes(32));
    await store.delete("device");
    expect(await store.get("device")).toBeNull();
  });

  it("namespaces keys under a claude-stats prefix (no bare-key collisions)", async () => {
    const fake = new FakeSecretStorage();
    const store = new SecretStorageKeyStore(fake as unknown as vscode.SecretStorage);
    await store.set("device", randomBytes(16));
    // The underlying store key is prefixed, not the bare logical key.
    expect(fake.map.has("device")).toBe(false);
    expect([...fake.map.keys()].every((k) => k.startsWith("claude-stats.deviceKey."))).toBe(true);
  });

  it("factory builds a store from an extension context", async () => {
    const fake = new FakeSecretStorage();
    const store = createSecretStorageKeyStore({ secrets: fake as unknown as vscode.SecretStorage });
    const secret = randomBytes(24);
    await store.set("device", secret);
    expect(await store.get("device")).toEqual(secret);
  });
});
