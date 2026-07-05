/**
 * Phase D — FILE-backed known-device registry (F13 once-only alert state).
 *
 * The pure detection (`detectNewDevices`) and the in-memory registry are covered
 * in sync.test.ts; this file exercises the on-disk `FileKnownDeviceRegistry`: its
 * `0600`/`0700` perms, its round-trip, and — the security-relevant part — its
 * fail-SAFE decode (a corrupt/absent/hostile file loads as EMPTY, which at worst
 * fires one extra "new device" prompt rather than silently trusting a rogue id).
 *
 * Real filesystem under a deterministic temp dir; synthetic hex device ids only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertDeviceId, type DeviceId } from "@claude-stats/core/types/shard";
import { FileKnownDeviceRegistry } from "../../sync-merge/device-registry.js";

const A = "deadbeefcafe0a01";
const B = "deadbeefcafe0b02";

let root: string;
let filePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-known-"));
  filePath = join(root, "nested", "known-devices.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("FileKnownDeviceRegistry", () => {
  it("loads an EMPTY set when the file does not exist (no crash on first run)", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    expect([...(await reg.load())]).toEqual([]);
  });

  it("save() creates the parent dir 0700 and writes the file 0600, sorted", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    await reg.save(new Set<DeviceId>([assertDeviceId(B), assertDeviceId(A)]));

    // Perms: 0600 on the file, 0700 on the created parent dir (mask off type bits).
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);

    // Persisted shape is versioned and the device list is sorted (deterministic).
    const wire = JSON.parse(readFileSync(filePath, "utf8"));
    expect(wire.version).toBe(1);
    expect(wire.devices).toEqual([A, B]);
  });

  it("round-trips a saved set back through load()", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    const ids = new Set<DeviceId>([assertDeviceId(A), assertDeviceId(B)]);
    await reg.save(ids);
    expect([...(await reg.load())].sort()).toEqual([A, B]);
  });

  it("fail-safe: a MALFORMED file loads as empty rather than throwing", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    await reg.save(new Set<DeviceId>([assertDeviceId(A)]));
    writeFileSync(filePath, "{ this is not json");
    expect([...(await reg.load())]).toEqual([]);
  });

  it("drops non-string and INVALID device ids on load (never trusts a path-y id)", async () => {
    // A hand-crafted file mixing a valid id with hostile / malformed entries.
    const reg = new FileKnownDeviceRegistry(filePath);
    await reg.save(new Set());
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, devices: [A, 42, "../escape", "UPPERCASE", "", "x"] }),
    );
    // Only the well-formed lowercase-hex id survives the validator.
    expect([...(await reg.load())]).toEqual([A]);
  });

  it("tolerates a valid-JSON file whose `devices` is missing/not an array", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1 }));
    expect([...(await reg.load())]).toEqual([]);
    writeFileSync(filePath, JSON.stringify({ version: 1, devices: "nope" }));
    expect([...(await reg.load())]).toEqual([]);
  });

  it("save(empty) still writes a well-formed file", async () => {
    const reg = new FileKnownDeviceRegistry(filePath);
    await reg.save(new Set());
    expect(existsSync(filePath)).toBe(true);
    expect([...(await reg.load())]).toEqual([]);
  });
});
