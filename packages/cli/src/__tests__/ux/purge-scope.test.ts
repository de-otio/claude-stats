/**
 * Phase E — purge-scope: description copy + the cloud-copy deletion mechanics.
 * Real crypto + a real directory transport (temp dir); synthetic ids only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveMaster,
  generateDek,
  generateSignKeyPair,
  generateWrapKeyPair,
  wrapDek,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";
import { assertDeviceId } from "@claude-stats/core/types/shard";
import { utf8Encode } from "@claude-stats/core/bundle";

import {
  DirectoryStorageTransport,
  buildSessionRecords,
  pushShard,
  type BackupCrypto,
  type DeviceIdentity,
} from "../../backup/index.js";
import { describePurgeScope, purgeDeviceCloudCopy } from "../../ux/purge-scope.js";

const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };

function makeIdentity(hexId: string): DeviceIdentity {
  const wrap = generateWrapKeyPair();
  const sig = generateSignKeyPair();
  return { deviceId: assertDeviceId(hexId), wrapPublicKey: wrap.publicKey, signPublicKey: sig.publicKey, signingSecretKey: sig.secretKey };
}
function makeCrypto(): BackupCrypto {
  const dek = generateDek();
  const kdfSalt = generateKdfSalt();
  const master = deriveMaster(utf8Encode("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23"), kdfSalt, TEST_ARGON);
  return { dek, passphraseWrappedDek: wrapDek(dek, [{ kind: "passphrase", masterKey: master }]), kdfSalt, kdfParams: TEST_ARGON };
}

describe("describePurgeScope", () => {
  it("this-machine deletes only local state and carries no cloud caveat", () => {
    const d = describePurgeScope("this-machine");
    expect(d.deletes.length).toBeGreaterThan(0);
    expect(d.deletes.every((s) => !/cloud|dropbox|icloud/i.test(s))).toBe(true);
    expect(d.otherDevicesNote).toBeNull();
  });

  it("also-cloud adds the shard deletion AND always states other devices are unaffected", () => {
    const d = describePurgeScope("also-cloud");
    expect(d.deletes.some((s) => /shard/i.test(s))).toBe(true);
    expect(d.otherDevicesNote).not.toBeNull();
    expect(d.otherDevicesNote).toMatch(/other devices/i);
    expect(d.otherDevicesNote).toMatch(/still hold/i);
  });
});

describe("purgeDeviceCloudCopy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-stats-purge-scope-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes this device's shards + manifest index entries, leaving another device's untouched", async () => {
    const transport = new DirectoryStorageTransport(dir);
    const self = makeIdentity("deadbeefcafe5e1f");
    const other = makeIdentity("deadbeefcafe0002");
    const crypto = makeCrypto();

    const selfRecords = buildSessionRecords(
      [],
      () => [],
      { originDevice: self.deviceId, localSourceFiles: new Set(), wallMs: 1, startCounter: 0 },
    );
    const otherRecords = buildSessionRecords(
      [],
      () => [],
      { originDevice: other.deviceId, localSourceFiles: new Set(), wallMs: 1, startCounter: 0 },
    );

    await pushShard({
      transport, identity: self, crypto, encryptSyncData: true,
      records: selfRecords, seq: 0, enrolledAt: 1,
    });
    await pushShard({
      transport, identity: other, crypto, encryptSyncData: true,
      records: otherRecords, seq: 0, enrolledAt: 1,
    });

    const before = await transport.list();
    expect(before.some((k) => k.startsWith(`${self.deviceId}/`))).toBe(true);
    expect(before.some((k) => k.startsWith(`${other.deviceId}/`))).toBe(true);

    const result = await purgeDeviceCloudCopy(transport, self, crypto);
    expect(result.deleted.length).toBeGreaterThan(0);

    const after = await transport.list();
    expect(after.some((k) => k.startsWith(`${self.deviceId}/`))).toBe(false);
    expect(after.some((k) => k.startsWith(`${other.deviceId}/`))).toBe(true);

    // Manifest index no longer references self's files (only other's remain).
    const { loadOrSeedBody } = await import("../../backup/index.js");
    const body = await loadOrSeedBody(transport, crypto);
    expect(body.files.some((f) => f.originDevice === self.deviceId)).toBe(false);
    expect(body.files.some((f) => f.originDevice === other.deviceId)).toBe(true);
  });

  it("is idempotent: a second run with nothing left to delete returns an empty result", async () => {
    const transport = new DirectoryStorageTransport(dir);
    const self = makeIdentity("deadbeefcafe5e1f");
    const crypto = makeCrypto();
    const records = buildSessionRecords(
      [],
      () => [],
      { originDevice: self.deviceId, localSourceFiles: new Set(), wallMs: 1, startCounter: 0 },
    );
    await pushShard({
      transport, identity: self, crypto, encryptSyncData: true,
      records, seq: 0, enrolledAt: 1,
    });

    const first = await purgeDeviceCloudCopy(transport, self, crypto);
    expect(first.deleted.length).toBeGreaterThan(0);

    const second = await purgeDeviceCloudCopy(transport, self, crypto);
    expect(second.deleted).toEqual([]);
  });
});
