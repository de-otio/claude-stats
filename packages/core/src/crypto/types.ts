/**
 * Personal-plane crypto CONTRACTS (Phase 0b keystone).
 *
 * Interfaces + pinned parameter constants ONLY. There is deliberately NO
 * cryptographic implementation in this file — impls land in Phase B
 * (`packages/core/src/crypto/{keys,aead,sign}.ts`), keystore impls land in the
 * extension (VS Code `SecretStorage`) and the CLI (`0600` file fallback).
 *
 * HARD RULES (enforced by review + package boundaries):
 *  - `packages/core` has NO `vscode` and NO `aws` imports. The `KeyStore` seam
 *    lives here as an interface; platform impls live outside core (review S5).
 *  - Key material is raw `Uint8Array`; NEVER log it, never put it in an error
 *    message, never serialize it into the plaintext manifest header.
 *  - The AEAD, KDF, and entropy parameters below are PINNED. Do not weaken them
 *    (no AES-GCM / 96-bit-nonce AEADs — review F7). A reader that finds a bundle
 *    stamped with different params must fail loudly, not silently reinterpret.
 */

// ─── Pinned parameters (non-negotiable) ──────────────────────────────────────

/**
 * Content AEAD. Delivered via `age-encryption` (XChaCha20-Poly1305, 192-bit
 * nonce) so random nonces are safe with a long-lived DEK. AES-GCM and any
 * 96-bit-nonce AEAD with random nonces are FORBIDDEN (review F7).
 */
export const AEAD_ALGORITHM = "XChaCha20-Poly1305" as const;
export type AeadAlgorithm = typeof AEAD_ALGORITHM;

/** Argon2id parameters for deriving the master key from the recovery secret. */
export interface Argon2idParams {
  /** Memory cost in KiB. */
  readonly memoryKiB: number;
  /** Time cost (iterations). */
  readonly iterations: number;
  /** Lanes / parallelism. */
  readonly parallelism: number;
  /** Derived key length in bytes. */
  readonly keyLengthBytes: number;
}

/**
 * Pinned Argon2id params (memory-hard KDF for the passphrase/recovery recipient).
 * 64 MiB × 3 iterations is a conservative interactive-login-grade cost. The salt
 * is a random 128-bit value stored (non-secret) in the manifest body (review F8).
 */
export const ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 65536, // 64 MiB
  iterations: 3,
  parallelism: 1,
  keyLengthBytes: 32,
} as const;

/** KDF salt length in bytes = 128-bit (review F8). */
export const KDF_SALT_BYTES = 16;

/** Minimum recovery-key entropy in bits (review F10). */
export const RECOVERY_ENTROPY_BITS = 128;

/** Symmetric data-encryption-key length in bytes (256-bit). */
export const DEK_BYTES = 32;

// ─── Key material types (opaque byte holders) ────────────────────────────────

/** Random 256-bit symmetric data-encryption key. Encrypts content per-file. */
export type Dek = Uint8Array;

/** Master key derived from the recovery secret via Argon2id; wraps the DEK. */
export type MasterKey = Uint8Array;

/** An X25519 keypair used to WRAP/unwrap the DEK to a device. */
export interface WrapKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** An Ed25519 keypair used to SIGN/verify shards + the manifest body. */
export interface SignKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/**
 * A recipient the DEK is wrapped TO. Either an enrolled device's X25519 wrap
 * public key, or the passphrase recipient derived (Argon2id) from the recovery
 * secret. Wrapping to multiple recipients is what makes new-device enrollment
 * and recovery possible without re-encrypting content (reviews F2/B3).
 */
export type WrapRecipient =
  | { readonly kind: "device"; readonly wrapPublicKey: Uint8Array }
  | { readonly kind: "passphrase"; readonly masterKey: MasterKey };

/**
 * The IDENTITY used to UNWRAP a DEK: either a device's X25519 secret key, or the
 * master key derived from the recovery secret (the passphrase recipient).
 */
export type WrapIdentity =
  | { readonly kind: "device"; readonly wrapSecretKey: Uint8Array }
  | { readonly kind: "passphrase"; readonly masterKey: MasterKey };

/** Opaque bytes carrying a DEK wrapped to one or more recipients (age header). */
export type WrappedDek = Uint8Array;

// ─── The swappable-storage seam ──────────────────────────────────────────────

/**
 * Storage transport: list/put/get/delete over a directory-shaped target. THE
 * swappable-transport seam — a consumer-cloud folder (Dropbox/iCloud/Drive) today
 * and a blind zero-knowledge service later store the EXACT same opaque shards, so
 * the whole personal plane is written once against this interface. Paths are
 * bundle-relative, `/`-separated logical keys; the impl maps them onto its target.
 *
 * Impls hold NO plaintext knowledge — they move opaque bytes. Encryption happens
 * above this seam (via `CryptoProvider`), never inside a transport.
 */
export interface StorageTransport {
  /** Logical keys under `prefix` (bundle-relative). Omit `prefix` for the root. */
  list(prefix?: string): Promise<readonly string[]>;
  /** Read a blob; `null` when absent. */
  get(path: string): Promise<Uint8Array | null>;
  /** Write (create/overwrite) a blob. */
  put(path: string, data: Uint8Array): Promise<void>;
  /** Delete a blob; no-op when absent. */
  delete(path: string): Promise<void>;
}

// ─── The device-secret keystore seam ─────────────────────────────────────────

/**
 * Stores a device secret (the device's wrap/sign secret keys, serialized) at
 * rest. Interface ONLY — no VS Code / no AWS here (review S5).
 *
 * Impls:
 *  - extension: VS Code `SecretStorage` (OS keychain).
 *  - cli: `0600` file fallback, where the stored secret is itself wrapped by an
 *    Argon2id-derived key from the recovery secret (never at rest raw), with a
 *    setup-time downgrade warning (review F6). The file impl re-wraps on
 *    recovery-secret change.
 *
 * `get` returns `null` when nothing is stored under `key`.
 */
export interface KeyStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, secret: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── The crypto provider seam (impl deferred to Phase B) ─────────────────────

/**
 * The whole personal-plane crypto surface behind one interface. Impl deferred to
 * Phase B — this file pins the SHAPE so Phases C/D/F can compile against it now.
 * All methods are async: `age-encryption` and Argon2id are async, and a hardware/
 * keychain-backed impl may be too.
 */
export interface CryptoProvider {
  /** Generate a device's X25519 wrap keypair. */
  generateWrapKeyPair(): Promise<WrapKeyPair>;
  /** Generate a device's Ed25519 signing keypair. */
  generateSignKeyPair(): Promise<SignKeyPair>;
  /** Generate a fresh random 256-bit DEK. */
  generateDek(): Dek;

  /**
   * Derive the master key from the recovery secret + salt (Argon2id). `params`
   * defaults to `ARGON2ID_PARAMS`; a bundle carrying different params passes its
   * own so old bundles stay readable.
   */
  deriveMaster(recoverySecret: Uint8Array, salt: Uint8Array, params?: Argon2idParams): Promise<MasterKey>;

  /** Wrap a DEK to the given recipients (device pubkeys + passphrase recipient). */
  wrapDek(dek: Dek, recipients: readonly WrapRecipient[]): Promise<WrappedDek>;
  /** Unwrap a DEK using a device secret key or the passphrase master key. */
  unwrapDek(wrapped: WrappedDek, identity: WrapIdentity): Promise<Dek>;

  /** AEAD-seal content with the DEK. */
  seal(plaintext: Uint8Array, dek: Dek): Promise<Uint8Array>;
  /** AEAD-open content with the DEK; rejects on auth failure (never returns garbage). */
  open(ciphertext: Uint8Array, dek: Dek): Promise<Uint8Array>;

  /** Ed25519-sign a message with a device signing secret key. */
  sign(message: Uint8Array, signingSecretKey: Uint8Array): Promise<Uint8Array>;
  /** Verify an Ed25519 signature against a device signing public key. */
  verify(message: Uint8Array, signature: Uint8Array, signPublicKey: Uint8Array): Promise<boolean>;
}
