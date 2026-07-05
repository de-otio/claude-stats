/**
 * VS Code `SecretStorage` implementation of the core `KeyStore` seam.
 *
 * `SecretStorage` persists into the OS keychain (Keychain / libsecret / DPAPI),
 * which provides at-rest protection — so, unlike the CLI `0600` fallback, the
 * device secret needs no additional application-level wrap here. We only bridge
 * bytes <-> base64 (SecretStorage stores strings) and namespace the keys.
 *
 * `vscode` is imported type-only so this module carries no runtime dependency on
 * the VS Code host and can be unit-tested against a fake `SecretStorage`. This is
 * the ONLY keystore impl allowed to touch `vscode`; core stays dependency-free
 * (review S5).
 */

import type * as vscode from "vscode";
import type { KeyStore } from "@claude-stats/core/crypto/types";

/** Keychain key namespace so claude-stats secrets don't collide with others. */
const KEY_PREFIX = "claude-stats.deviceKey.";

export class SecretStorageKeyStore implements KeyStore {
  readonly #secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this.#secrets = secrets;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const stored = await this.#secrets.get(KEY_PREFIX + key);
    if (stored === undefined) return null;
    return new Uint8Array(Buffer.from(stored, "base64"));
  }

  async set(key: string, secret: Uint8Array): Promise<void> {
    await this.#secrets.store(KEY_PREFIX + key, Buffer.from(secret).toString("base64"));
  }

  async delete(key: string): Promise<void> {
    await this.#secrets.delete(KEY_PREFIX + key);
  }
}

/** Build a keystore from an extension context (`context.secrets`). */
export function createSecretStorageKeyStore(
  context: Pick<vscode.ExtensionContext, "secrets">,
): SecretStorageKeyStore {
  return new SecretStorageKeyStore(context.secrets);
}
