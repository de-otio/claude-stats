/**
 * Per-device append-only shard: seal + SIGN on write, verify + open on read.
 *
 * A shard is a batch of {@link StampedRecord}s authored by exactly ONE device
 * (`header.originDevice`). Writers are partitioned by device, so two writers
 * never touch the same file ⇒ conflict-free by construction (see
 * `doc/analysis/data-planes/01-personal-plane.md` §2).
 *
 * On-store wire form is {@link ShardFile}: a small envelope carrying the
 * signature and the (optionally sealed) body. The `body` bytes are what the
 * Ed25519 signature covers — encrypt-THEN-sign, matching the manifest (F1):
 *   - encrypted: `body = seal(serializeShard(shard), DEK)`   (nonce||ct||tag)
 *   - plaintext: `body = serializeShard(shard)`
 * so a reader ALWAYS verifies the signature over the exact stored bytes BEFORE
 * spending a decrypt, and an attacker with cloud-folder write access cannot
 * forge a shard for a device whose Ed25519 key they don't hold.
 *
 * Pure functional core: crypto is the vetted `../crypto` primitives; no IO here.
 */

import type { DeviceId, FileEncryptionState, Shard } from "../types/shard.js";
import { open, seal } from "../crypto/aead.js";
import { sign, verify } from "../crypto/sign.js";
import {
  deserializeJson,
  fromBase64,
  serializeJson,
  toBase64,
} from "./serialize.js";

/** Shard-format schema version (bump on a breaking layout change). */
export const SHARD_SCHEMA_VERSION = 1;

/**
 * On-store shard envelope. `body` is the signed representation (sealed when
 * `encryption === "encrypted"`, canonical-JSON otherwise); `signature` is the
 * Ed25519 signature over `body` by `signedBy`.
 */
export interface ShardFile {
  readonly schemaVersion: number;
  readonly encryption: FileEncryptionState;
  /** The device that authored AND signed this shard. */
  readonly signedBy: DeviceId;
  /** Ed25519 signature over `body`. */
  readonly signature: Uint8Array;
  /** Sealed-or-plaintext canonical serialization of the {@link Shard}. */
  readonly body: Uint8Array;
}

/** Canonical serialization of a {@link Shard} (the plaintext SIGNED-or-SEALED payload). */
export function serializeShard<T>(shard: Shard<T>): Uint8Array {
  return serializeJson(shard);
}

/** Parse a canonical shard serialization back to a {@link Shard}. */
export function deserializeShard<T>(bytes: Uint8Array): Shard<T> {
  return deserializeJson<Shard<T>>(bytes);
}

export interface SealShardOptions {
  readonly encryption: FileEncryptionState;
  /** Ed25519 signing secret key of `shard.header.originDevice`. */
  readonly signingSecretKey: Uint8Array;
  /** The DEK — REQUIRED when `encryption === "encrypted"`. */
  readonly dek?: Uint8Array;
}

/**
 * Build a signed (and, when requested, sealed) {@link ShardFile} from a shard.
 * The signer MUST be `shard.header.originDevice` — `signedBy` is stamped from it
 * so a reader can look up the right verification key.
 */
export function sealShard<T>(shard: Shard<T>, options: SealShardOptions): ShardFile {
  const plaintext = serializeShard(shard);
  let body: Uint8Array;
  if (options.encryption === "encrypted") {
    if (!options.dek) {
      throw new Error("sealShard: a DEK is required to encrypt a shard");
    }
    body = seal(plaintext, options.dek);
  } else {
    body = plaintext;
  }
  const signature = sign(body, options.signingSecretKey);
  return {
    schemaVersion: SHARD_SCHEMA_VERSION,
    encryption: options.encryption,
    signedBy: shard.header.originDevice,
    signature,
    body,
  };
}

export interface OpenShardOptions {
  /**
   * Ed25519 PUBLIC key that must have signed the shard — the trust anchor. In
   * Phase D this is the key from the device's already-trusted manifest entry;
   * merge REJECTS a shard whose signature does not verify against a known device
   * (F1). Verification happens BEFORE any decrypt.
   */
  readonly signPublicKey: Uint8Array;
  /** The DEK — REQUIRED when the shard is encrypted. */
  readonly dek?: Uint8Array;
}

/**
 * Verify a {@link ShardFile}'s signature over its `body` against
 * `signPublicKey`, then (if encrypted) decrypt and parse it. Throws a clean
 * error on a bad/absent signature or a decrypt failure — NEVER returns
 * unverified or unauthenticated records.
 */
export function openShard<T>(file: ShardFile, options: OpenShardOptions): Shard<T> {
  if (!verify(file.body, file.signature, options.signPublicKey)) {
    throw new Error("openShard: shard signature did not verify (untrusted or tampered)");
  }
  let plaintext: Uint8Array;
  if (file.encryption === "encrypted") {
    if (!options.dek) {
      throw new Error("openShard: a DEK is required to decrypt an encrypted shard");
    }
    plaintext = open(file.body, options.dek);
  } else {
    plaintext = file.body;
  }
  return deserializeShard<T>(plaintext);
}

// ─── ShardFile ⇄ bytes (JSON envelope; base64 for the two byte fields) ────────

interface ShardFileWire {
  readonly schemaVersion: number;
  readonly encryption: FileEncryptionState;
  readonly signedBy: string;
  readonly signature: string;
  readonly body: string;
}

/** Serialize a {@link ShardFile} to the bytes written to the store. */
export function encodeShardFile(file: ShardFile): Uint8Array {
  const wire: ShardFileWire = {
    schemaVersion: file.schemaVersion,
    encryption: file.encryption,
    signedBy: file.signedBy,
    signature: toBase64(file.signature),
    body: toBase64(file.body),
  };
  return serializeJson(wire);
}

/** Parse store bytes back into a {@link ShardFile}. Throws on malformed input. */
export function decodeShardFile(bytes: Uint8Array): ShardFile {
  const wire = deserializeJson<ShardFileWire>(bytes);
  if (wire.encryption !== "encrypted" && wire.encryption !== "plaintext") {
    throw new Error("decodeShardFile: unknown encryption state");
  }
  return {
    schemaVersion: wire.schemaVersion,
    encryption: wire.encryption,
    signedBy: wire.signedBy as DeviceId,
    signature: fromBase64(wire.signature),
    body: fromBase64(wire.body),
  };
}
