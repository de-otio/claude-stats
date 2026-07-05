/**
 * Phase E — onboarding fork + second-device enrollment (functional core).
 *
 * Two pure state machines that the extension's imperative shell (VS Code
 * notifications/quickpicks — NEVER a build-time stdin prompt) drives forward.
 * Keeping the flow logic here means the "effortless onboarding, end to end"
 * sequence (doc 02 §9: prompt → detect → target → encryption fork → recovery
 * key save/confirm → done) is unit-testable without a VS Code host, and the
 * "second device = one paste" flow (doc 02 §2) is a single well-defined
 * transition rather than nested `if`s in a command handler.
 *
 * Neither machine performs IO. The extension layer calls `detectCloudRoots`,
 * generates the recovery key via `@claude-stats/core/crypto/keys`, writes
 * config, etc., and feeds the *results* into these transitions.
 */

import type { CloudRootCandidate } from "./cloud-detect.js";

// ─── First-device (or first-enable) onboarding fork ────────────────────────

export type EncryptionChoice = "encrypted" | "plaintext";

export type OnboardingStep =
  | "prompt"
  | "detecting"
  | "chooseTarget"
  | "chooseEncryption"
  | "showRecoveryKey"
  | "awaitingConfirmation"
  | "done"
  | "declined";

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly detected: readonly CloudRootCandidate[];
  readonly target: string | null;
  readonly encryption: EncryptionChoice | null;
  readonly recoveryKey: string | null;
  /** True once the user has clicked "I've saved it" — never auto-set. */
  readonly recoveryKeyConfirmed: boolean;
}

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  step: "prompt",
  detected: [],
  target: null,
  encryption: null,
  recoveryKey: null,
  recoveryKeyConfirmed: false,
};

/** User dismissed/declined the gentle one-time nudge — never re-prompt aggressively. */
export function declineOnboarding(state: OnboardingState): OnboardingState {
  return { ...state, step: "declined" };
}

/** User clicked "Set up backup" — move to detection. */
export function startOnboarding(state: OnboardingState): OnboardingState {
  return { ...state, step: "detecting" };
}

/** Detection finished (possibly empty — the UI falls back to "Choose a folder…"). */
export function onDetected(
  state: OnboardingState,
  detected: readonly CloudRootCandidate[],
): OnboardingState {
  return { ...state, step: "chooseTarget", detected };
}

/** The user picked (or manually chose) a storage target directory. */
export function onTargetChosen(state: OnboardingState, target: string): OnboardingState {
  if (state.step !== "chooseTarget") {
    throw new Error(`onTargetChosen: invalid step "${state.step}", expected "chooseTarget"`);
  }
  return { ...state, step: "chooseEncryption", target };
}

/**
 * The encryption fork (doc 02 §4 / plan F3): encrypted is default/recommended;
 * plaintext is a legitimate, informed opt-out — never a dead end, never forced.
 * Encrypted moves on to the recovery-key screen; plaintext has nothing to save
 * and goes straight to done.
 */
export function onEncryptionChosen(
  state: OnboardingState,
  choice: EncryptionChoice,
  recoveryKey?: string,
): OnboardingState {
  if (state.step !== "chooseEncryption") {
    throw new Error(`onEncryptionChosen: invalid step "${state.step}", expected "chooseEncryption"`);
  }
  if (choice === "plaintext") {
    return { ...state, step: "done", encryption: choice, recoveryKey: null };
  }
  if (!recoveryKey) {
    throw new Error("onEncryptionChosen: encrypted choice requires a generated recoveryKey");
  }
  return { ...state, step: "showRecoveryKey", encryption: choice, recoveryKey };
}

/** The recovery key has been shown (Copy/Download/QR/password-manager nudge, doc 02 §2). */
export function onRecoveryKeyShown(state: OnboardingState): OnboardingState {
  if (state.step !== "showRecoveryKey") {
    throw new Error(`onRecoveryKeyShown: invalid step "${state.step}", expected "showRecoveryKey"`);
  }
  return { ...state, step: "awaitingConfirmation" };
}

/**
 * "I've saved my recovery key" — the one confirmation the design asks for
 * (doc 02 §3). Never a hard block: the extension layer may still finish setup
 * without this and instead leave a standing, dismissible reminder (doc 02 §8),
 * but the state machine records whether it happened.
 */
export function confirmRecoveryKeySaved(state: OnboardingState): OnboardingState {
  if (state.step !== "awaitingConfirmation") {
    throw new Error(
      `confirmRecoveryKeySaved: invalid step "${state.step}", expected "awaitingConfirmation"`,
    );
  }
  return { ...state, step: "done", recoveryKeyConfirmed: true };
}

/** Finish onboarding without the explicit confirm click (dismissed the dialog). */
export function finishWithoutConfirmation(state: OnboardingState): OnboardingState {
  return { ...state, step: "done" };
}

export function isOnboardingComplete(state: OnboardingState): boolean {
  return state.step === "done" || state.step === "declined";
}

// ─── Second-device enrollment ("one paste", doc 02 §2 / §9 step 7) ─────────

export type EnrollmentStep =
  | "idle"
  | "foundBackup"
  | "awaitingRecoveryKey"
  | "enrolling"
  | "enrolled"
  | "failed";

export interface EnrollmentState {
  readonly step: EnrollmentStep;
  /** Set once a manifest is found in the configured/detected target. */
  readonly manifestTarget: string | null;
  readonly error: string | null;
}

export const INITIAL_ENROLLMENT_STATE: EnrollmentState = {
  step: "idle",
  manifestTarget: null,
  error: null,
};

/** A second device saw an existing bundle at `target` — surface the notification. */
export function onBackupFound(state: EnrollmentState, target: string): EnrollmentState {
  return { ...state, step: "foundBackup", manifestTarget: target, error: null };
}

/** User clicked the notification's action to enter their recovery key. */
export function beginRecoveryKeyEntry(state: EnrollmentState): EnrollmentState {
  if (state.step !== "foundBackup") {
    throw new Error(`beginRecoveryKeyEntry: invalid step "${state.step}", expected "foundBackup"`);
  }
  return { ...state, step: "awaitingRecoveryKey" };
}

/** The user pasted (or QR-scanned) a key; the shell now attempts to unwrap the DEK. */
export function submitRecoveryKey(state: EnrollmentState): EnrollmentState {
  if (state.step !== "awaitingRecoveryKey") {
    throw new Error(
      `submitRecoveryKey: invalid step "${state.step}", expected "awaitingRecoveryKey"`,
    );
  }
  return { ...state, step: "enrolling" };
}

/** Unwrap succeeded — this device is enrolled (its keypair is now a manifest recipient). */
export function enrollmentSucceeded(state: EnrollmentState): EnrollmentState {
  if (state.step !== "enrolling") {
    throw new Error(`enrollmentSucceeded: invalid step "${state.step}", expected "enrolling"`);
  }
  return { ...state, step: "enrolled", error: null };
}

/**
 * Unwrap failed — wrong/mistyped key. The UX must say "Enter your recovery
 * key to unlock this backup," never `AEAD: decryption failed` (doc 02 §8).
 * `message` is a caller-supplied friendly string, not the raw crypto error.
 */
export function enrollmentFailed(state: EnrollmentState, message: string): EnrollmentState {
  if (state.step !== "enrolling") {
    throw new Error(`enrollmentFailed: invalid step "${state.step}", expected "enrolling"`);
  }
  return { ...state, step: "failed", error: message };
}

/** Retry after a failure — back to awaiting a (re-)pasted key. */
export function retryRecoveryKeyEntry(state: EnrollmentState): EnrollmentState {
  if (state.step !== "failed") {
    throw new Error(`retryRecoveryKeyEntry: invalid step "${state.step}", expected "failed"`);
  }
  return { ...state, step: "awaitingRecoveryKey", error: null };
}
