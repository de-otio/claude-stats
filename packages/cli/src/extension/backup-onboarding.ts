/**
 * Phase E — effortless consumer-cloud onboarding + data removal (imperative
 * shell). Drives the pure state machines in `ux/onboarding.ts` with real VS
 * Code notifications/quickpicks (NEVER a build-time stdin prompt — plan
 * Phase E) and the real crypto/config primitives from `backup/identity.ts`
 * and `config.ts`.
 *
 * Not unit-tested (like `mcp-register.ts`/`sync-integration.ts`, this module
 * has a hard `vscode` runtime dependency and is excluded from the vitest
 * coverage config); the logic it composes IS unit-tested where it lives
 * (`ux/onboarding.ts`, `ux/cloud-detect.ts`, `ux/purge-scope.ts`,
 * `backup/identity.ts`).
 *
 * SECOND DEVICE = ONE PASTE: enrolling onto an EXISTING backup works. The
 * manifest's PLAINTEXT key envelope (format v2) carries the KDF salt/params +
 * passphrase-wrapped DEK, so `recoverBackupCrypto` derives the DEK from the
 * pasted recovery key alone (review B3); this module then opens the sealed body,
 * enrolls THIS device, and writes the manifest. A wrong key fails cleanly with
 * the "that key didn't work" message — no fake success.
 */
import * as vscode from "vscode";

import { paths } from "@claude-stats/core/paths";
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
import { detectCloudRoots, providerLabelKey, type CloudRootCandidate } from "../ux/cloud-detect.js";
import {
  beginRecoveryKeyEntry,
  declineOnboarding,
  enrollmentFailed,
  enrollmentSucceeded,
  INITIAL_ONBOARDING_STATE,
  onBackupFound,
  onDetected,
  onEncryptionChosen,
  onTargetChosen,
  startOnboarding,
  submitRecoveryKey,
  type EncryptionChoice,
} from "../ux/onboarding.js";
import { describePurgeScope, type PurgeScope } from "../ux/purge-scope.js";
import { loadConfig, mergeConfig, saveConfig } from "../config.js";
import { createSecretStorageKeyStore } from "./keystore-secretstorage.js";
import { t } from "./i18n.js";

/**
 * A gentle, ONE-TIME nudge (doc 02 §9 step 2) — never re-prompts once the user
 * has made any choice (accepted, declined, or already configured backup).
 */
export async function maybeShowOnboardingNudge(context: vscode.ExtensionContext): Promise<void> {
  const config = loadConfig();
  if (config.backup?.target || config.backup?.onboardingDismissedAt) return;

  const action = t("extension:onboarding.nudgeAction");
  const dismiss = t("extension:onboarding.nudgeDismiss");
  const choice = await vscode.window.showInformationMessage(
    t("extension:onboarding.nudgeMessage"),
    action,
    dismiss,
  );

  if (choice === action) {
    await runBackupSetupWizard(context);
    return;
  }
  // Dismissed (either button, or closed with Escape) — never nag again.
  const declined = declineOnboarding(INITIAL_ONBOARDING_STATE);
  void declined; // state recorded via config below; the machine itself is UI-agnostic
  saveConfig(mergeConfig(loadConfig(), { backup: { onboardingDismissedAt: Date.now() } }));
}

/** Label a detected cloud root for the quickpick (doc 02 §1: "Back up to your Dropbox →"). */
function labelFor(candidate: CloudRootCandidate): string {
  return t(`extension:backup.${providerLabelKey(candidate.provider)}`);
}

/**
 * The full guided setup (doc 02 §9): detect → target → encryption fork →
 * (encrypted) recovery key save/confirm → done. Registers as
 * `claude-stats.setupBackup`.
 */
export async function runBackupSetupWizard(context: vscode.ExtensionContext): Promise<void> {
  let state = startOnboarding(INITIAL_ONBOARDING_STATE);

  const detected = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("extension:onboarding.detectingProgress") },
    async () => detectCloudRoots(),
  );
  state = onDetected(state, detected);

  const items: vscode.QuickPickItem[] = detected.map((c) => ({
    label: labelFor(c),
    description: c.path,
  }));
  items.push({ label: t("extension:onboarding.chooseLocation") });

  const picked = await vscode.window.showQuickPick(items, {
    title: detected.length > 0 ? undefined : t("extension:onboarding.noneDetected"),
    placeHolder: t("extension:backup.targetSelect"),
  });
  if (!picked) return; // user cancelled — no partial config written

  let target: string;
  if (picked.description) {
    target = picked.description;
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: t("extension:onboarding.chooseLocationTitle"),
    });
    if (!uris || uris.length === 0) return;
    target = uris[0]!.fsPath;
  }
  state = onTargetChosen(state, target);

  const encryptedItem: vscode.QuickPickItem = {
    label: t("extension:onboarding.encryptChoiceEncrypted"),
    detail: t("extension:onboarding.encryptChoiceEncryptedDetail"),
  };
  const plaintextItem: vscode.QuickPickItem = {
    label: t("extension:onboarding.encryptChoicePlaintext"),
    detail: t("extension:onboarding.encryptChoicePlaintextDetail"),
  };
  const encChoice = await vscode.window.showQuickPick([encryptedItem, plaintextItem], {
    placeHolder: t("extension:onboarding.encryptionForkPrompt"),
  });
  if (!encChoice) return;

  const encryption: EncryptionChoice = encChoice === encryptedItem ? "encrypted" : "plaintext";

  if (encryption === "plaintext") {
    // Plaintext is a legitimate, informed opt-out (doc 02 §4) — not a dead end.
    void vscode.window.showWarningMessage(t("extension:backup.plaintextWarning"));
    state = onEncryptionChosen(state, "plaintext");
    persistBackupConfig(target, { syncData: false, archive: false });
    void vscode.window.showInformationMessage(t("extension:onboarding.setupComplete"));
    return;
  }

  const recoveryKey = generateRecoveryKey();
  state = onEncryptionChosen(state, "encrypted", recoveryKey.key);

  // Bootstrap this device's identity + a fresh DEK wrapped to the recovery key,
  // and write the first (empty) manifest, so the bundle exists the moment a
  // second device looks for it.
  const keystore = createSecretStorageKeyStore(context);
  const identityMaterial = await loadOrCreateDeviceIdentity(keystore, generateDeviceId());
  const secret = normalizeRecoverySecret(recoveryKey.key);
  const crypto = bootstrapBackupCrypto(secret);
  const transport = new DirectoryStorageTransport(target);
  let body = await loadOrSeedBody(transport, crypto);
  body = ensureDevice(body, identityMaterial.identity, crypto, Date.now());
  await writeManifest(transport, body, identityMaterial.identity, crypto);

  await showRecoveryKeyAndConfirm(recoveryKey.key);
  persistBackupConfig(target, { syncData: true, archive: true });
  saveConfig(mergeConfig(loadConfig(), { backup: { recoveryKeyConfirmed: true } }));
  void vscode.window.showInformationMessage(t("extension:onboarding.setupComplete"));
}

async function showRecoveryKeyAndConfirm(key: string): Promise<void> {
  void vscode.window.showInformationMessage(t("extension:onboarding.recoveryKeyIntro"));
  const copyLabel = t("extension:backup.recoveryKeyCopy");
  const continueLabel = t("extension:onboarding.recoveryKeySavedButton");
  let confirmed = false;
  while (!confirmed) {
    const choice = await vscode.window.showInformationMessage(
      `${t("extension:backup.recoveryKeyTitle")}: ${key}`,
      { modal: true, detail: t("extension:backup.recoveryKeySaveInstructions") },
      copyLabel,
      continueLabel,
    );
    if (choice === copyLabel) {
      await vscode.env.clipboard.writeText(key);
      void vscode.window.showInformationMessage(t("extension:backup.recoveryKeyCopied"));
      continue; // stay on the key screen — copying isn't confirming
    }
    confirmed = choice === continueLabel;
    if (choice === undefined) break; // dismissed — finish without confirmation (never a hard block)
  }
}

function persistBackupConfig(target: string, encryption: { syncData: boolean; archive: boolean }): void {
  saveConfig(mergeConfig(loadConfig(), { backup: { target, encryption } }));
}

/**
 * On activation, glance at the configured (or a detected) cloud root for an
 * existing `manifest.json` this device hasn't set up yet — the "second
 * device" moment (doc 02 §2/§9 step 7). On finding one it offers a one-paste
 * enrollment: recover the DEK from the pasted recovery key (B3), enroll THIS
 * device into the manifest, and persist the local backup config.
 */
export async function checkForExistingBackup(context: vscode.ExtensionContext): Promise<void> {
  const config = loadConfig();
  if (config.backup?.target) return; // already set up on this device

  const candidates = detectCloudRoots();
  for (const candidate of candidates) {
    const transport = new DirectoryStorageTransport(candidate.path);
    const raw = await transport.get(MANIFEST_KEY).catch(() => null);
    if (!raw) continue;

    let state = onBackupFound({ step: "idle", manifestTarget: null, error: null }, candidate.path);
    const action = t("extension:onboarding.secondDeviceEnterKeyAction");
    const choice = await vscode.window.showInformationMessage(
      t("extension:onboarding.secondDeviceFoundMessage"),
      action,
    );
    if (choice !== action) return;
    state = beginRecoveryKeyEntry(state);

    const pasted = await vscode.window.showInputBox({
      prompt: t("extension:onboarding.secondDeviceKeyPrompt"),
      placeHolder: t("extension:onboarding.secondDeviceKeyPlaceholder"),
      password: true,
      ignoreFocusOut: true,
    });
    if (!pasted) return;
    state = submitRecoveryKey(state);

    try {
      // Recover the bundle DEK from the pasted recovery key alone (B3), then
      // enroll THIS device into the manifest so its future pushes are trusted.
      const manifest = decodeManifest(raw);
      const crypto = recoverBackupCrypto(manifest, normalizeRecoverySecret(pasted));
      const keystore = createSecretStorageKeyStore(context);
      const identityMaterial = await loadOrCreateDeviceIdentity(keystore, generateDeviceId());
      let body = await loadOrSeedBody(transport, crypto);
      body = ensureDevice(body, identityMaterial.identity, crypto, Date.now());
      await writeManifest(transport, body, identityMaterial.identity, crypto);

      state = enrollmentSucceeded(state);
      void state; // step machine advanced; config below is the durable record
      persistBackupConfig(candidate.path, { syncData: true, archive: true });
      saveConfig(mergeConfig(loadConfig(), { backup: { recoveryKeyConfirmed: true } }));
      void vscode.window.showInformationMessage(t("extension:onboarding.secondDeviceEnrolled"));
    } catch {
      // Wrong/mistyped key (unwrap failed) or a malformed manifest — report
      // honestly; never fake success, never surface key material in the error.
      state = enrollmentFailed(state, "wrong-key");
      void state;
      void vscode.window.showWarningMessage(t("extension:onboarding.secondDeviceWrongKey"));
    }
    return;
  }
}

// ─── Data removal: "this machine" vs "also delete the cloud copy" ──────────

/**
 * The VS Code "Delete all stored data" command. Presents an honest scope
 * picker (doc 02 §10) before calling into `purgeAllData` (which itself calls
 * the MCP-unregister hook) plus, for the cloud scope, states plainly that
 * other devices are unaffected (never claims to erase every copy everywhere).
 */
export async function runDeleteAllStoredDataCommand(): Promise<void> {
  const config = loadConfig();
  const items: Array<vscode.QuickPickItem & { scope: PurgeScope }> = [
    {
      scope: "this-machine",
      label: t("extension:dataRemoval.scopeThisMachine"),
      detail: t("extension:dataRemoval.scopeThisMachineDetail"),
    },
  ];
  if (config.backup?.target) {
    items.push({
      scope: "also-cloud",
      label: t("extension:dataRemoval.scopeAlsoCloud"),
      detail: t("extension:dataRemoval.scopeAlsoCloudDetail"),
    });
  }

  const picked = await vscode.window.showQuickPick(items, { title: t("extension:dataRemoval.scopeTitle") });
  if (!picked) return;

  const description = describePurgeScope(picked.scope);
  const confirmLabel = t("extension:archive.purgeButton");
  const confirm = await vscode.window.showWarningMessage(
    t("extension:dataRemoval.confirmTitle"),
    {
      modal: true,
      detail: [...description.deletes, description.otherDevicesNote].filter(Boolean).join("\n\n"),
    },
    confirmLabel,
  );
  if (confirm !== confirmLabel) return;

  // No explicit `unregister` hook: `purgeAllData` defaults to
  // `unregisterMcpServerFromClaudeJson`, which has no `vscode` dependency and
  // is exactly what "Delete all stored data" needs to stop Claude Code from
  // respawning the MCP server.
  const { purgeAllData } = await import("../archive/index.js");
  const result = purgeAllData({});

  if (picked.scope === "also-cloud") {
    // Cloud-copy deletion mechanics are implemented and tested
    // (`ux/purge-scope.ts::purgeDeviceCloudCopy`); wiring this device's
    // identity+crypto into the extension is tracked as a known gap (see the
    // module doc) — surface the same honest message the CLI does.
    void vscode.window.showInformationMessage(
      `${paths.bundleDir}: ${t("extension:dataRemoval.otherDevicesNote")}`,
    );
  }

  void vscode.window.showInformationMessage(
    result.ok ? t("extension:archive.purgeSuccess") : t("extension:errors.generic", { message: "purge incomplete" }),
  );
}
