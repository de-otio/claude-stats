/**
 * Host-agnostic Backup & Sync settings actions (`ux/backup-settings.ts`) — the
 * shared brain behind the dashboard Settings tab in both hosts (served HTTP
 * routes + VS Code webview messages). Pins the action contract end-to-end
 * against real crypto and a real temp-dir transport:
 *
 *  - status: config echo + detected roots + manifest presence,
 *  - setup (plaintext): config only, no keys, no manifest,
 *  - setup (encrypted): recovery key out, manifest written, device enrolled,
 *    and the bundle recoverable from the returned key ALONE (B3),
 *  - setup refuses a target that already holds a bundle (`existing-backup`),
 *  - enroll: one-paste second device; wrong key fails cleanly without
 *    persisting config,
 *  - confirm-key / disable: config flag transitions (disable keeps the folder).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeRecoverySecret } from "@claude-stats/core/crypto/keys";
import type { Argon2idParams, KeyStore } from "@claude-stats/core/crypto/types";
import { decodeManifest } from "@claude-stats/core/bundle";

import {
  DirectoryStorageTransport,
  loadOrSeedBody,
  recoverBackupCrypto,
  MANIFEST_KEY,
} from "../../backup/index.js";
import {
  BackupActionError,
  confirmRecoveryKeySaved,
  disableBackup,
  enrollExistingBackup,
  getBackupStatus,
  setupBackup,
} from "../../ux/backup-settings.js";
import { loadConfig } from "../../config.js";

/** Cheap KDF for tests (mirrors bundle/recovery.test.ts) — NEVER production. */
const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };

function memKeyStore(): KeyStore {
  const m = new Map<string, Uint8Array>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

let workDir: string;
let configPath: string;
let target: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cs-backup-settings-"));
  configPath = join(workDir, "config.json");
  target = join(workDir, "cloud");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const opts = () => ({ configPath, now: () => NOW, argon2Params: TEST_ARGON });

describe("getBackupStatus", () => {
  it("reports unconfigured with detected roots and their manifest presence", () => {
    const withManifest = mkdtempSync(join(workDir, "root-a-"));
    const withoutManifest = mkdtempSync(join(workDir, "root-b-"));
    writeFileSync(join(withManifest, MANIFEST_KEY), "{}");

    const status = getBackupStatus({
      configPath,
      detect: () => [
        { provider: "dropbox", path: withManifest },
        { provider: "icloud", path: withoutManifest },
      ],
    });

    expect(status.configured).toBe(false);
    expect(status.target).toBeNull();
    expect(status.encryption).toBeNull();
    expect(status.manifest).toBeNull();
    expect(status.detected).toEqual([
      { provider: "dropbox", path: withManifest, hasManifest: true },
      { provider: "icloud", path: withoutManifest, hasManifest: false },
    ]);
  });
});

describe("setupBackup — plaintext", () => {
  it("persists the target with both classes unencrypted; no keys, no manifest", async () => {
    const result = await setupBackup(
      { target, mode: "plaintext", makeKeyStore: memKeyStore },
      opts(),
    );

    expect(result.recoveryKey).toBeUndefined();
    expect(existsSync(join(target, MANIFEST_KEY))).toBe(false);

    const config = loadConfig(configPath);
    expect(config.backup?.target).toBe(target);
    expect(config.backup?.encryption).toEqual({ syncData: false, archive: false });
    // The one-time nudge must never return after an explicit choice.
    expect(config.backup?.onboardingDismissedAt).toBe(NOW);

    const status = getBackupStatus({ configPath, detect: () => [] });
    expect(status.configured).toBe(true);
    expect(status.manifest).toEqual({ exists: false, lastModifiedMs: null });
  });
});

describe("setupBackup — encrypted", () => {
  it("returns a recovery key, writes a manifest with THIS device enrolled, and stays key-unconfirmed", async () => {
    const { recoveryKey } = await setupBackup(
      { target, mode: "encrypted", makeKeyStore: memKeyStore },
      opts(),
    );

    expect(recoveryKey).toBeTruthy();

    const config = loadConfig(configPath);
    expect(config.backup?.target).toBe(target);
    expect(config.backup?.encryption).toEqual({ syncData: true, archive: true });
    // Never set automatically — only the explicit confirm action.
    expect(config.backup?.recoveryKeyConfirmed).toBe(false);

    // B3 property: the returned key ALONE opens the bundle.
    const raw = readFileSync(join(target, MANIFEST_KEY));
    const crypto = recoverBackupCrypto(
      decodeManifest(new Uint8Array(raw)),
      normalizeRecoverySecret(recoveryKey!),
    );
    const body = await loadOrSeedBody(new DirectoryStorageTransport(target), crypto);
    expect(body.devices).toHaveLength(1);

    const status = getBackupStatus({ configPath, detect: () => [] });
    expect(status.configured).toBe(true);
    expect(status.encryption).toEqual({ syncData: true, archive: true });
    expect(status.recoveryKeyConfirmed).toBe(false);
    expect(status.manifest?.exists).toBe(true);
    expect(status.manifest?.lastModifiedMs).toBeGreaterThan(0);
  });

  it("refuses a target that already holds a bundle (existing-backup)", async () => {
    await setupBackup({ target, mode: "encrypted", makeKeyStore: memKeyStore }, opts());
    await expect(
      setupBackup({ target, mode: "encrypted", makeKeyStore: memKeyStore }, opts()),
    ).rejects.toMatchObject({ code: "existing-backup" });
  });

  it("rejects an invalid target without touching config", async () => {
    await expect(
      setupBackup({ target: "", mode: "encrypted", makeKeyStore: memKeyStore }, opts()),
    ).rejects.toBeInstanceOf(BackupActionError);
    expect(loadConfig(configPath).backup).toBeUndefined();
  });
});

describe("enrollExistingBackup", () => {
  it("one-paste second device: enrolls into the existing bundle and confirms the key", async () => {
    const { recoveryKey } = await setupBackup(
      { target, mode: "encrypted", makeKeyStore: memKeyStore },
      opts(),
    );

    // Second device: fresh keystore + its own config file.
    const secondConfig = join(workDir, "config-device2.json");
    await enrollExistingBackup(
      { target, recoveryKey: recoveryKey!, makeKeyStore: memKeyStore },
      { configPath: secondConfig, now: () => NOW + 1 },
    );

    const config = loadConfig(secondConfig);
    expect(config.backup?.target).toBe(target);
    expect(config.backup?.encryption).toEqual({ syncData: true, archive: true });
    // Pasting the key IS proof of possession — confirmed immediately.
    expect(config.backup?.recoveryKeyConfirmed).toBe(true);

    const raw = readFileSync(join(target, MANIFEST_KEY));
    const crypto = recoverBackupCrypto(
      decodeManifest(new Uint8Array(raw)),
      normalizeRecoverySecret(recoveryKey!),
    );
    const body = await loadOrSeedBody(new DirectoryStorageTransport(target), crypto);
    expect(body.devices).toHaveLength(2);
  });

  it("fails cleanly on a wrong key (wrong-key) and persists nothing", async () => {
    const { recoveryKey } = await setupBackup(
      { target, mode: "encrypted", makeKeyStore: memKeyStore },
      opts(),
    );
    const wrong = recoveryKey!.replace(/[A-Z2-7]/, (c) => (c === "A" ? "B" : "A"));

    const secondConfig = join(workDir, "config-device2.json");
    await expect(
      enrollExistingBackup(
        { target, recoveryKey: wrong, makeKeyStore: memKeyStore },
        { configPath: secondConfig },
      ),
    ).rejects.toMatchObject({ code: "wrong-key" });
    expect(loadConfig(secondConfig).backup).toBeUndefined();
  });

  it("reports no-backup-found for a folder without a manifest", async () => {
    await expect(
      enrollExistingBackup(
        { target: workDir, recoveryKey: "whatever", makeKeyStore: memKeyStore },
        { configPath },
      ),
    ).rejects.toMatchObject({ code: "no-backup-found" });
  });
});

describe("confirmRecoveryKeySaved / disableBackup", () => {
  it("confirm flips the flag; disable drops target+encryption but keeps the folder and the dismissal", async () => {
    await setupBackup({ target, mode: "encrypted", makeKeyStore: memKeyStore }, opts());

    confirmRecoveryKeySaved({ configPath });
    expect(loadConfig(configPath).backup?.recoveryKeyConfirmed).toBe(true);

    disableBackup({ configPath });
    const config = loadConfig(configPath);
    expect(config.backup?.target).toBeUndefined();
    expect(config.backup?.encryption).toBeUndefined();
    // The confirmation belonged to the detached bundle — must not survive.
    expect(config.backup?.recoveryKeyConfirmed).toBeUndefined();
    expect(config.backup?.onboardingDismissedAt).toBe(NOW);
    // Deliberately non-destructive: the bundle stays on disk.
    expect(existsSync(join(target, MANIFEST_KEY))).toBe(true);

    expect(getBackupStatus({ configPath, detect: () => [] }).configured).toBe(false);
  });

  it("disable is a no-op when backup was never configured", () => {
    disableBackup({ configPath });
    expect(loadConfig(configPath).backup).toBeUndefined();
  });
});
