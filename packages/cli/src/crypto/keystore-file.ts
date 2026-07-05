/**
 * Headless CLI `KeyStore` fallback: a `0600` file for machines with no OS
 * keychain (review F6/S4). The stored device secret is NEVER at rest in the
 * clear — it is sealed under a key derived from the user's **recovery secret**
 * via Argon2id (memory-hard, pinned params, random 128-bit salt stored non-
 * secret alongside — F8), using the same core AEAD as the rest of the plane.
 *
 * This is strictly less secure than an OS keychain (the ciphertext + salt sit in
 * a file readable by anything running as the user; only the recovery secret,
 * which is not on disk, protects it). That downgrade MUST be surfaced at setup —
 * {@link FILE_KEYSTORE_SECURITY_WARNING} + {@link FileKeyStore.securityWarning}
 * are exposed for the UX phase (F6).
 *
 * Imperative shell: this file does the fs + path work and reuses core's pure
 * crypto (`deriveMaster`, `seal`, `open`) — no crypto is re-implemented here.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  ARGON2ID_PARAMS,
  type Argon2idParams,
  type KeyStore,
} from "@claude-stats/core/crypto/types";
import { deriveMaster } from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import { open, seal } from "@claude-stats/core/crypto/aead";

/** Setup-time warning copy (English seed; the UX phase i18n-izes it — F6). */
export const FILE_KEYSTORE_SECURITY_WARNING =
  "This machine has no OS keychain, so your device key is stored in a 0600 " +
  "file encrypted with your recovery key. This is less secure than a system " +
  "keychain: keep your recovery key safe and prefer a device with a keychain " +
  "for sensitive data.";

/** Default location for the headless key file, under `~/.claude-stats/keys/`. */
export function defaultKeyFilePath(): string {
  return join(homedir(), ".claude-stats", "keys", "device-keys.json");
}

interface KeyFileDoc {
  readonly version: 1;
  readonly kdf: { readonly salt: string; readonly params: Argon2idParams };
  readonly entries: Record<string, string>;
}

export interface FileKeyStoreOptions {
  /** Path to the 0600 key file. Defaults to {@link defaultKeyFilePath}. */
  readonly filePath?: string;
  /**
   * The recovery secret (canonicalized recovery-key bytes) used to derive the
   * wrap key. NOT persisted anywhere; held in memory for the store's lifetime.
   */
  readonly recoverySecret: Uint8Array;
  /** Argon2id params for NEW files. Existing files keep the params they stored. */
  readonly argon2Params?: Argon2idParams;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * A `KeyStore` backed by a `0600` file. Each secret is sealed under an Argon2id-
 * derived wrap key; a wrong recovery secret makes {@link get} fail cleanly (AEAD
 * auth failure), never returning garbage.
 */
export class FileKeyStore implements KeyStore {
  readonly filePath: string;
  /** Signals the security downgrade so the UX phase can warn at setup (F6). */
  readonly securityLevel = "file-fallback" as const;
  readonly securityWarning = FILE_KEYSTORE_SECURITY_WARNING;

  #recoverySecret: Uint8Array;
  readonly #argon2Params: Argon2idParams;

  constructor(options: FileKeyStoreOptions) {
    this.filePath = options.filePath ?? defaultKeyFilePath();
    this.#recoverySecret = options.recoverySecret;
    this.#argon2Params = options.argon2Params ?? ARGON2ID_PARAMS;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const doc = await this.#load();
    if (!doc) return null;
    const sealed = doc.entries[key];
    if (sealed === undefined) return null;
    const wrapKey = deriveMaster(this.#recoverySecret, fromB64(doc.kdf.salt), doc.kdf.params);
    // `open` throws a clean error on a wrong recovery secret or tampering.
    return open(fromB64(sealed), wrapKey);
  }

  async set(key: string, secret: Uint8Array): Promise<void> {
    const existing = await this.#load();
    const doc: KeyFileDoc = existing ?? {
      version: 1,
      kdf: { salt: toB64(generateKdfSalt()), params: this.#argon2Params },
      entries: {},
    };
    const wrapKey = deriveMaster(this.#recoverySecret, fromB64(doc.kdf.salt), doc.kdf.params);
    const entries = { ...doc.entries, [key]: toB64(seal(secret, wrapKey)) };
    await this.#persist({ ...doc, entries });
  }

  async delete(key: string): Promise<void> {
    const doc = await this.#load();
    if (!doc) return;
    if (!(key in doc.entries)) return;
    const entries = { ...doc.entries };
    delete entries[key];
    await this.#persist({ ...doc, entries });
  }

  /**
   * Re-wrap every stored secret under a NEW recovery secret + fresh salt (F6:
   * "re-wrap on recovery-secret change"). After this resolves, the old recovery
   * secret no longer opens the file. Uses the CURRENT (old) secret to decrypt,
   * then adopts the new one.
   */
  async rekey(newRecoverySecret: Uint8Array): Promise<void> {
    const doc = await this.#load();
    if (!doc) {
      this.#recoverySecret = newRecoverySecret;
      return;
    }
    const oldWrapKey = deriveMaster(this.#recoverySecret, fromB64(doc.kdf.salt), doc.kdf.params);
    const plaintexts: Record<string, Uint8Array> = {};
    for (const [k, sealed] of Object.entries(doc.entries)) {
      plaintexts[k] = open(fromB64(sealed), oldWrapKey);
    }
    const newSalt = generateKdfSalt();
    const newWrapKey = deriveMaster(newRecoverySecret, newSalt, this.#argon2Params);
    const entries: Record<string, string> = {};
    for (const [k, plain] of Object.entries(plaintexts)) {
      entries[k] = toB64(seal(plain, newWrapKey));
    }
    await this.#persist({
      version: 1,
      kdf: { salt: toB64(newSalt), params: this.#argon2Params },
      entries,
    });
    this.#recoverySecret = newRecoverySecret;
  }

  /** Remove the whole key file (used by `purge` / data removal). */
  async destroy(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  async #load(): Promise<KeyFileDoc | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(raw) as KeyFileDoc;
  }

  async #persist(doc: KeyFileDoc): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {
      /* best-effort: dir may be shared/owned differently */
    });
    // Write then chmod: the file mode on create is subject to umask, so the
    // explicit chmod is what guarantees 0600.
    await writeFile(this.filePath, JSON.stringify(doc, null, 2), { mode: FILE_MODE });
    await chmod(this.filePath, FILE_MODE);
  }
}

/** Convenience factory mirroring the extension keystore's shape. */
export function createFileKeyStore(options: FileKeyStoreOptions): FileKeyStore {
  return new FileKeyStore(options);
}
