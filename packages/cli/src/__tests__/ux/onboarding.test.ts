/**
 * Phase E — onboarding fork + second-device enrollment state machines.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_ENROLLMENT_STATE,
  INITIAL_ONBOARDING_STATE,
  beginRecoveryKeyEntry,
  confirmRecoveryKeySaved,
  declineOnboarding,
  enrollmentFailed,
  enrollmentSucceeded,
  finishWithoutConfirmation,
  isOnboardingComplete,
  onBackupFound,
  onDetected,
  onEncryptionChosen,
  onRecoveryKeyShown,
  onTargetChosen,
  retryRecoveryKeyEntry,
  startOnboarding,
  submitRecoveryKey,
} from "../../ux/onboarding.js";

describe("onboarding fork", () => {
  it("declining the gentle nudge ends the flow without touching any other field", () => {
    const state = declineOnboarding(INITIAL_ONBOARDING_STATE);
    expect(state.step).toBe("declined");
    expect(isOnboardingComplete(state)).toBe(true);
  });

  it("walks the encrypted happy path: prompt -> detect -> target -> encrypt -> key -> confirm -> done", () => {
    let state = startOnboarding(INITIAL_ONBOARDING_STATE);
    expect(state.step).toBe("detecting");

    state = onDetected(state, [{ provider: "dropbox", path: "/home/example/Dropbox" }]);
    expect(state.step).toBe("chooseTarget");
    expect(state.detected).toHaveLength(1);

    state = onTargetChosen(state, "/home/example/Dropbox");
    expect(state.step).toBe("chooseEncryption");
    expect(state.target).toBe("/home/example/Dropbox");

    state = onEncryptionChosen(state, "encrypted", "ABCD-EFGH-IJKL-MNOP");
    expect(state.step).toBe("showRecoveryKey");
    expect(state.recoveryKey).toBe("ABCD-EFGH-IJKL-MNOP");

    state = onRecoveryKeyShown(state);
    expect(state.step).toBe("awaitingConfirmation");

    state = confirmRecoveryKeySaved(state);
    expect(state.step).toBe("done");
    expect(state.recoveryKeyConfirmed).toBe(true);
    expect(isOnboardingComplete(state)).toBe(true);
  });

  it("the plaintext fork skips the recovery-key screens entirely", () => {
    let state = startOnboarding(INITIAL_ONBOARDING_STATE);
    state = onDetected(state, []);
    state = onTargetChosen(state, "/home/example/backups");
    state = onEncryptionChosen(state, "plaintext");
    expect(state.step).toBe("done");
    expect(state.recoveryKey).toBeNull();
    expect(state.recoveryKeyConfirmed).toBe(false);
  });

  it("choosing encrypted without a recovery key is a programming error, not a silent no-op", () => {
    let state = startOnboarding(INITIAL_ONBOARDING_STATE);
    state = onDetected(state, []);
    state = onTargetChosen(state, "/x");
    expect(() => onEncryptionChosen(state, "encrypted")).toThrow(/requires a generated recoveryKey/);
  });

  it("dismissing the recovery-key confirmation dialog still finishes onboarding (never a hard block)", () => {
    let state = startOnboarding(INITIAL_ONBOARDING_STATE);
    state = onDetected(state, []);
    state = onTargetChosen(state, "/x");
    state = onEncryptionChosen(state, "encrypted", "KEY");
    state = onRecoveryKeyShown(state);
    state = finishWithoutConfirmation(state);
    expect(state.step).toBe("done");
    expect(state.recoveryKeyConfirmed).toBe(false);
  });

  it("rejects out-of-order transitions (e.g. choosing a target before detection ran)", () => {
    expect(() => onTargetChosen(INITIAL_ONBOARDING_STATE, "/x")).toThrow(/invalid step "prompt"/);
  });
});

describe("second-device enrollment (one paste)", () => {
  it("walks found-backup -> enter key -> submit -> success", () => {
    let state = onBackupFound(INITIAL_ENROLLMENT_STATE, "/home/example/Dropbox");
    expect(state.step).toBe("foundBackup");
    expect(state.manifestTarget).toBe("/home/example/Dropbox");

    state = beginRecoveryKeyEntry(state);
    expect(state.step).toBe("awaitingRecoveryKey");

    state = submitRecoveryKey(state);
    expect(state.step).toBe("enrolling");

    state = enrollmentSucceeded(state);
    expect(state.step).toBe("enrolled");
    expect(state.error).toBeNull();
  });

  it("a wrong recovery key fails with a friendly message, never the raw crypto error, and can be retried", () => {
    let state = onBackupFound(INITIAL_ENROLLMENT_STATE, "/home/example/Dropbox");
    state = beginRecoveryKeyEntry(state);
    state = submitRecoveryKey(state);
    state = enrollmentFailed(state, "Enter your recovery key to unlock this backup.");
    expect(state.step).toBe("failed");
    expect(state.error).toBe("Enter your recovery key to unlock this backup.");

    state = retryRecoveryKeyEntry(state);
    expect(state.step).toBe("awaitingRecoveryKey");
    expect(state.error).toBeNull();
  });

  it("rejects submitting a key before one was ever requested", () => {
    expect(() => submitRecoveryKey(INITIAL_ENROLLMENT_STATE)).toThrow(/invalid step "idle"/);
  });
});
