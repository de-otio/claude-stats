/**
 * Host-agnostic backup/sync settings actions — the shared brain behind the
 * dashboard Settings tab's "Backup & Sync" section in BOTH hosts:
 *
 *  - the served dashboard's `/api/backup/*` routes (`server/index.ts`), which
 *    use the headless `FileKeyStore`, and
 *  - the VS Code panel's `backupAction` webview messages (`extension/panel.ts`),
 *    which use the `SecretStorage` keystore.
 *
 * The host supplies its keystore via `makeKeyStore(recoverySecret)` — the file
 * fallback needs the recovery secret to seal the device identity, the OS
 * keychain ignores it — so no `vscode` (or fs-keystore) dependency leaks in
 * here. Everything else composes the SAME vetted primitives the extension
 * wizard uses (`backup/identity.ts`, `backup/backup.ts`, `config.ts`): no new
 * cryptography, no second config schema.
 *
 * Unlike the wizard (a linear VS Code quickpick flow), these are stateless
 * request/response actions: the client renders `getBackupStatus()` and calls
 * one action per user decision, so the HTTP path needs no server-side session.
 */

import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Argon2idParams, KeyStore } from "@claude-stats/core/crypto/types";
import { generateRecoveryKey, normalizeRecoverySecret } from "@claude-stats/core/crypto/keys";
import { decodeManifest } from "@claude-stats/core/bundle";

import {
  bootstrapBackupCrypto,
  recoverBackupCrypto,
  DirectoryStorageTransport,
  generateDeviceId,
  loadOrCreateDeviceIdentity,
  MANIFEST_KEY,
  writeManifest,
  ensureDevice,
  loadOrSeedBody,
} from "../backup/index.js";
import { detectCloudRoots, type CloudProvider, type DetectCloudRootsOptions } from "./cloud-detect.js";
import { loadConfig, mergeConfig, saveConfig, type Config } from "../config.js";

/** Host-provided keystore seam. The recovery secret is only meaningful to the
 *  headless file keystore (which seals under it); keychain impls ignore it. */
export type MakeKeyStore = (recoverySecret: Uint8Array) => KeyStore;

export type BackupActionErrorCode =
  | "invalid-target"
  | "existing-backup"
  | "no-backup-found"
  | "wrong-key";

/** A user-recoverable action failure. The `code` (not the message) is the API
 *  contract — clients map it to localized copy; messages are for logs only. */
export class BackupActionError extends Error {
  readonly code: BackupActionErrorCode;
  constructor(code: BackupActionErrorCode, message: string) {
    super(message);
    this.name = "BackupActionError";
    this.code = code;
  }
}

export interface DetectedRootStatus {
  readonly provider: CloudProvider;
  readonly path: string;
  /** An existing claude-stats bundle lives here — offer enrollment, not setup. */
  readonly hasManifest: boolean;
}

export interface BackupStatus {
  /** True once a target is persisted on this device. */
  readonly configured: boolean;
  readonly target: string | null;
  /** Which data classes are E2E-sealed (null until configured). */
  readonly encryption: { readonly syncData: boolean; readonly archive: boolean } | null;
  readonly recoveryKeyConfirmed: boolean;
  /** Manifest presence + last write at the CONFIGURED target (null until configured). */
  readonly manifest: { readonly exists: boolean; readonly lastModifiedMs: number | null } | null;
  /** Consumer-cloud roots detected on this machine right now. */
  readonly detected: readonly DetectedRootStatus[];
}

export interface BackupSettingsOptions {
  /** Config file override (tests). Defaults to the real `~/.claude-stats/config.json`. */
  readonly configPath?: string;
  /** Injected for tests; defaults to the real detector. */
  readonly detect?: (options?: DetectCloudRootsOptions) => ReturnType<typeof detectCloudRoots>;
  /** Clock seam (tests). */
  readonly now?: () => number;
  /** KDF params for a NEW bundle (tests use cheap ones). Recovery/enroll always
   *  uses the params stored in the manifest, never this. */
  readonly argon2Params?: Argon2idParams;
}

/** mtime of the manifest file at `target`, or null when absent/unreadable. */
function manifestMtimeMs(target: string): number | null {
  try {
    return statSync(join(target, MANIFEST_KEY)).mtimeMs;
  } catch {
    return null;
  }
}

function hasManifestAt(target: string): boolean {
  return manifestMtimeMs(target) !== null;
}

/**
 * Snapshot everything the Settings-tab section needs to render: this device's
 * backup config plus which cloud roots exist (and which already hold a bundle,
 * so the UI offers "connect this device" instead of a fresh setup).
 */
export function getBackupStatus(options: BackupSettingsOptions = {}): BackupStatus {
  const config = loadConfig(options.configPath);
  const detect = options.detect ?? detectCloudRoots;
  const detected: DetectedRootStatus[] = detect().map((c) => ({
    provider: c.provider,
    path: c.path,
    hasManifest: hasManifestAt(c.path),
  }));

  const target = config.backup?.target ?? null;
  const encryption = config.backup?.encryption ?? null;
  return {
    configured: target !== null,
    target,
    encryption: encryption
      ? { syncData: encryption.syncData === true, archive: encryption.archive === true }
      : null,
    recoveryKeyConfirmed: config.backup?.recoveryKeyConfirmed === true,
    manifest:
      target !== null
        ? (() => {
            const mtime = manifestMtimeMs(target);
            return { exists: mtime !== null, lastModifiedMs: mtime };
          })()
        : null,
    detected,
  };
}

/** Same target sanity bounds `validateBackupConfig` enforces on the write. */
function assertValidTarget(target: unknown): asserts target is string {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    target.includes("\0")
  ) {
    throw new BackupActionError("invalid-target", "backup target must be a non-empty path");
  }
}

function persistBackup(configPath: string | undefined, patch: NonNullable<Config["backup"]>): void {
  saveConfig(mergeConfig(loadConfig(configPath), { backup: patch }), configPath);
}

export interface SetupBackupInput {
  readonly target: string;
  readonly mode: "encrypted" | "plaintext";
  readonly makeKeyStore: MakeKeyStore;
}

export interface SetupBackupResult {
  /** Present only for `mode: "encrypted"` — shown ONCE, never persisted. */
  readonly recoveryKey?: string;
}

/**
 * First-time setup on this device (mirrors the extension wizard's two forks):
 *
 *  - `plaintext`: an informed opt-out — persists the target with both data
 *    classes unencrypted; no keys, no manifest.
 *  - `encrypted`: mints a recovery key + this device's identity, bootstraps the
 *    bundle crypto, and writes the first manifest so a second device can enroll
 *    immediately. Returns the recovery key for the caller to display ONCE;
 *    `recoveryKeyConfirmed` stays false until {@link confirmRecoveryKeySaved}.
 *
 * Refuses (`existing-backup`) when the target already holds a manifest —
 * bootstrapping would abandon the existing bundle; the right action there is
 * {@link enrollExistingBackup}.
 */
export async function setupBackup(
  input: SetupBackupInput,
  options: BackupSettingsOptions = {},
): Promise<SetupBackupResult> {
  assertValidTarget(input.target);
  const now = options.now ?? Date.now;

  if (input.mode === "plaintext") {
    persistBackup(options.configPath, {
      target: input.target,
      encryption: { syncData: false, archive: false },
      onboardingDismissedAt: now(),
    });
    return {};
  }

  if (hasManifestAt(input.target)) {
    throw new BackupActionError(
      "existing-backup",
      "target already holds a backup — enroll this device instead",
    );
  }

  await mkdir(input.target, { recursive: true });

  const recoveryKey = generateRecoveryKey();
  const secret = normalizeRecoverySecret(recoveryKey.key);
  const keystore = input.makeKeyStore(secret);
  const identity = await loadOrCreateDeviceIdentity(keystore, generateDeviceId());
  const crypto = options.argon2Params
    ? bootstrapBackupCrypto(secret, options.argon2Params)
    : bootstrapBackupCrypto(secret);
  const transport = new DirectoryStorageTransport(input.target);
  let body = await loadOrSeedBody(transport, crypto);
  body = ensureDevice(body, identity.identity, crypto, now());
  await writeManifest(transport, body, identity.identity, crypto);

  persistBackup(options.configPath, {
    target: input.target,
    encryption: { syncData: true, archive: true },
    // Explicitly reset: a confirmation for a PREVIOUS bundle's key must not
    // carry over to this fresh one (the reminder would never show).
    recoveryKeyConfirmed: false,
    onboardingDismissedAt: now(),
  });
  return { recoveryKey: recoveryKey.key };
}

export interface EnrollBackupInput {
  readonly target: string;
  readonly recoveryKey: string;
  readonly makeKeyStore: MakeKeyStore;
}

/**
 * One-paste second-device enrollment onto an EXISTING bundle (review B3):
 * recover the DEK from the manifest's plaintext key envelope + the pasted
 * recovery key, enroll THIS device into the body, and persist the config.
 * A wrong/mistyped key fails cleanly as `wrong-key` — never fake success,
 * never key material in the error.
 */
export async function enrollExistingBackup(
  input: EnrollBackupInput,
  options: BackupSettingsOptions = {},
): Promise<void> {
  assertValidTarget(input.target);
  const now = options.now ?? Date.now;

  const transport = new DirectoryStorageTransport(input.target);
  const raw = await transport.get(MANIFEST_KEY).catch(() => null);
  if (!raw) {
    throw new BackupActionError("no-backup-found", "no backup manifest at target");
  }

  let secret: Uint8Array;
  let crypto: ReturnType<typeof recoverBackupCrypto>;
  try {
    secret = normalizeRecoverySecret(input.recoveryKey);
    crypto = recoverBackupCrypto(decodeManifest(raw), secret);
  } catch {
    throw new BackupActionError("wrong-key", "recovery key did not unlock the backup");
  }

  const keystore = input.makeKeyStore(secret);
  const identity = await loadOrCreateDeviceIdentity(keystore, generateDeviceId());
  let body = await loadOrSeedBody(transport, crypto);
  body = ensureDevice(body, identity.identity, crypto, now());
  await writeManifest(transport, body, identity.identity, crypto);

  persistBackup(options.configPath, {
    target: input.target,
    encryption: { syncData: true, archive: true },
    recoveryKeyConfirmed: true,
    onboardingDismissedAt: now(),
  });
}

/** The user clicked "I've saved my recovery key" (doc 02 §3) — never set automatically. */
export function confirmRecoveryKeySaved(options: BackupSettingsOptions = {}): void {
  persistBackup(options.configPath, { recoveryKeyConfirmed: true });
}

/**
 * Turn backup off on THIS device: drop the target (and encryption selection)
 * from config. Deliberately does NOT touch the backup folder — files there
 * (and other devices) are unaffected; `purge --backup-cloud` is the deletion
 * path. Keeps `onboardingDismissedAt` so the one-time nudge never returns.
 */
export function disableBackup(options: BackupSettingsOptions = {}): void {
  const now = options.now ?? Date.now;
  const config = loadConfig(options.configPath);
  if (!config.backup?.target) return;
  // Also drop the key confirmation — it belongs to the bundle being detached,
  // not to whatever a future re-setup mints.
  const { target: _target, encryption: _encryption, recoveryKeyConfirmed: _rkc, ...rest } = config.backup;
  saveConfig(
    { ...config, backup: { ...rest, onboardingDismissedAt: rest.onboardingDismissedAt ?? now() } },
    options.configPath,
  );
}
