/**
 * 0600 file-fallback KeyStore tests (reviews F6/F8).
 *  - set/get/delete round-trip for a device secret
 *  - a WRONG recovery secret fails cleanly (never returns garbage)
 *  - the device secret is NOT at rest in the clear (sealed under an Argon2id key)
 *  - the file is 0600
 *  - rekey (recovery-secret change) re-wraps; the old secret stops working
 *  - the setup-time security warning is exposed for the UX phase
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileKeyStore,
  FILE_KEYSTORE_SECURITY_WARNING,
} from "../../crypto/keystore-file.js";
import {
  generateRecoveryKey,
  normalizeRecoverySecret,
} from "@claude-stats/core/crypto/keys";
import { randomBytes } from "@claude-stats/core/crypto/random";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";

const TEST_ARGON: Argon2idParams = {
  memoryKiB: 256,
  iterations: 1,
  parallelism: 1,
  keyLengthBytes: 32,
};

let dir: string;
let filePath: string;
const secret1 = normalizeRecoverySecret(generateRecoveryKey().key);

function makeStore(recoverySecret = secret1): FileKeyStore {
  return new FileKeyStore({ filePath, recoverySecret, argon2Params: TEST_ARGON });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-keystore-"));
  filePath = join(dir, "device-keys.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileKeyStore", () => {
  it("round-trips a stored device secret", async () => {
    const store = makeStore();
    const deviceSecret = randomBytes(64);
    await store.set("device", deviceSecret);
    expect(await store.get("device")).toEqual(deviceSecret);
  });

  it("returns null for a missing key and a non-existent file", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeNull(); // no file yet
    await store.set("present", randomBytes(32));
    expect(await store.get("absent")).toBeNull(); // file exists, key absent
  });

  it("delete removes a key", async () => {
    const store = makeStore();
    await store.set("device", randomBytes(32));
    await store.delete("device");
    expect(await store.get("device")).toBeNull();
    // deleting a missing key / missing file is a no-op
    await store.delete("device");
  });

  it("a wrong recovery secret fails cleanly, never returning garbage", async () => {
    const deviceSecret = randomBytes(48);
    await makeStore(secret1).set("device", deviceSecret);

    const wrongSecret = normalizeRecoverySecret(generateRecoveryKey().key);
    const wrongStore = makeStore(wrongSecret);
    await expect(wrongStore.get("device")).rejects.toThrow(/authentication failed/i);
  });

  it("does not store the device secret in the clear", async () => {
    const store = makeStore();
    const deviceSecret = randomBytes(48);
    await store.set("device", deviceSecret);
    const fileText = readFileSync(filePath, "utf8");
    // The raw secret must not appear in any encoding we control.
    expect(fileText).not.toContain(Buffer.from(deviceSecret).toString("base64"));
    expect(fileText).not.toContain(Buffer.from(deviceSecret).toString("hex"));
    // The salt IS stored (non-secret, F8) and params are pinned in the file.
    const doc = JSON.parse(fileText) as { kdf: { salt: string; params: Argon2idParams } };
    expect(doc.kdf.salt).toBeTruthy();
    expect(doc.kdf.params.memoryKiB).toBe(TEST_ARGON.memoryKiB);
  });

  it("writes the key file with 0600 permissions", async () => {
    const store = makeStore();
    await store.set("device", randomBytes(32));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rekey re-wraps under a new recovery secret; the old one stops working", async () => {
    const deviceSecret = randomBytes(40);
    const store = makeStore(secret1);
    await store.set("device", deviceSecret);

    const secret2 = normalizeRecoverySecret(generateRecoveryKey().key);
    await store.rekey(secret2);

    // The same store instance (now holding secret2) still reads it.
    expect(await store.get("device")).toEqual(deviceSecret);
    // A fresh store with the NEW secret reads it.
    expect(await makeStore(secret2).get("device")).toEqual(deviceSecret);
    // A fresh store with the OLD secret no longer can.
    await expect(makeStore(secret1).get("device")).rejects.toThrow();
  });

  it("destroy removes the key file", async () => {
    const store = makeStore();
    await store.set("device", randomBytes(32));
    expect(existsSync(filePath)).toBe(true);
    await store.destroy();
    expect(existsSync(filePath)).toBe(false);
    expect(await store.get("device")).toBeNull();
  });

  it("exposes the setup-time security downgrade warning (F6)", () => {
    const store = makeStore();
    expect(FILE_KEYSTORE_SECURITY_WARNING).toMatch(/less secure/i);
    expect(store.securityLevel).toBe("file-fallback");
    expect(store.securityWarning).toBe(FILE_KEYSTORE_SECURITY_WARNING);
  });
});
