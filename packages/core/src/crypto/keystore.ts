/**
 * The device-secret keystore SEAM (interface only — impls live outside core).
 *
 * The `KeyStore` interface is defined in `./types.ts` alongside the other crypto
 * contracts; this module re-exports it so the Phase-B file layout matches the
 * plan (`packages/core/src/crypto/keystore.ts`, interface-only — review S5).
 * There is intentionally NO implementation here: `packages/core` must carry no
 * `vscode` / `aws` dependency. The impls are:
 *  - extension: VS Code `SecretStorage` (OS keychain) —
 *    `packages/cli/src/extension/keystore-secretstorage.ts`.
 *  - CLI headless: a `0600` file whose device secret is wrapped by an
 *    Argon2id-derived key from the recovery secret —
 *    `packages/cli/src/crypto/keystore-file.ts` (F6).
 */

export type { KeyStore } from "./types.js";
