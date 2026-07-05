/**
 * Personal-plane + org-plane data CONTRACTS (Phase 0b keystone).
 *
 * Type-only contracts plus the strict `DeviceId` validator and the shared
 * path-safety guard. NO crypto/merge/export implementation here (deferred to
 * Phases B/C/D). Everything trust- or convergence-critical is pinned as a type
 * so the Phase-1 fan-out has no sibling edges.
 */

import type {
  AeadAlgorithm,
  Argon2idParams,
  WrappedDek,
} from "../crypto/types.js";

// ─── Path safety (shared guard — device ids AND archive component names) ──────

/**
 * True when `value` is safe to use as a SINGLE filesystem path component: no
 * path separators, no parent/self refs, no NUL, no control chars, non-empty and
 * bounded. This is THE shared guard — the archive uses it for session/project
 * component names and `DeviceId` validation composes it (review F5). Blocking
 * separators + `.`/`..` is what stops path traversal via a hostile component.
 */
export function isPathSafeComponent(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // Reject NUL + C0 controls (0x00–0x1f) and DEL (0x7f).
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Throwing form of {@link isPathSafeComponent}. Message never echoes the value. */
export function assertPathSafeComponent(value: string, kind = "path component"): void {
  if (!isPathSafeComponent(value)) {
    throw new Error(`Unsafe ${kind}: rejected by path-safety guard`);
  }
}

// ─── DeviceId (branded) ───────────────────────────────────────────────────────

/**
 * A device identifier. Branded so a raw string can't be passed where a validated
 * DeviceId is required. Format is STRICT: a canonical lowercase UUID, or a
 * lowercase hex string (8–64 chars). The strict format already excludes path
 * separators; we ALSO run the shared path-safety guard as defence-in-depth, and
 * validate on WRITE and on READ (review F5) so a hostile shard directory name can
 * never traverse out of the bundle.
 */
export type DeviceId = string & { readonly __brand: "DeviceId" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOWER_HEX_RE = /^[0-9a-f]{8,64}$/;

/** Type guard: does `value` meet the strict DeviceId format AND path-safety? */
export function isValidDeviceId(value: string): value is DeviceId {
  if (!isPathSafeComponent(value)) return false;
  return UUID_RE.test(value) || LOWER_HEX_RE.test(value);
}

/**
 * Validate + brand. Throws on any non-conforming id. Call this on BOTH the write
 * path (before creating `<device-id>/`) and the read path (before trusting a
 * directory/shard name pulled from the store). Message never echoes the value.
 */
export function assertDeviceId(value: string): DeviceId {
  if (!isValidDeviceId(value)) {
    throw new Error("Invalid DeviceId: must be a lowercase UUID or 8–64-char lowercase hex, with no path separators");
  }
  return value;
}

// ─── Origin logical clock (THE cross-device merge key) ───────────────────────

/**
 * Origin logical clock stamped by the WRITING device at write time — a hybrid
 * logical clock: a wall-clock hint plus a monotonic counter, tie-broken by the
 * origin device.
 *
 * ‼️  THIS — not the SQLite `updated_at` column — is the cross-device merge key.
 *     `updated_at` is stamped `Date.now()` at LOCAL MERGE time (see
 *     `packages/cli/src/store`), so it is NON-CONVERGENT across devices,
 *     unpinnable in tests, and has no tiebreak. NEVER use `updated_at` as the
 *     cross-device clock (review B2). Merge takes `max()` over `(counter, then
 *     originDevice)`; equal clocks resolve deterministically on `originDevice`.
 */
export interface OriginClock {
  /** Wall-clock millis at the origin device. A readability/ordering HINT only —
   *  skew and ties are resolved by `counter` then `originDevice`, never by this. */
  readonly wallMs: number;
  /** Strictly-increasing monotonic counter, per origin device. */
  readonly counter: number;
  /** The device that authored this version — the deterministic tiebreak. */
  readonly originDevice: DeviceId;
}

/** A payload value carrying its cross-device merge key. */
export interface StampedRecord<T> {
  readonly clock: OriginClock;
  readonly value: T;
}

/** Header of an append-only shard file (`<device-id>/sessions-<seq>.jsonl[.age]`). */
export interface ShardHeader {
  /** Shard-format schema version (bump on breaking layout changes). */
  readonly schemaVersion: number;
  /** The owning/writing device. Only this device ever writes this shard. */
  readonly originDevice: DeviceId;
  /** Monotonic per-device shard sequence — the `<seq>` in the filename. */
  readonly seq: number;
}

/**
 * A per-device append-only shard: a batch of stamped records written by exactly
 * one device. Writers are partitioned by device so two writers never touch the
 * same file ⇒ conflict-free by construction. The whole shard is signed by the
 * origin device (Ed25519); merge REJECTS shards from unknown/unverified devices
 * (reviews F1/D).
 */
export interface Shard<T = unknown> {
  readonly header: ShardHeader;
  readonly records: readonly StampedRecord<T>[];
}

// ─── Manifest (plaintext header + encrypted, signed body) ────────────────────

/** Whether a bundle file is stored sealed or in the clear. */
export type FileEncryptionState = "plaintext" | "encrypted";

/**
 * The SMALL plaintext, UNAUTHENTICATED manifest header. Carries ONLY what a
 * reader needs to dispatch/parse — never anything trust-bearing. Everything that
 * matters (device list, wrapped DEKs, salt, file index) lives in the signed +
 * encrypted body (reviews B3/F4).
 */
export interface ManifestHeader {
  /** Manifest wire-format version. */
  readonly formatVersion: number;
  /** AEAD pinning so an incompatible reader fails loudly, not silently. */
  readonly aead: AeadAlgorithm;
}

/** One enrolled device, as recorded in the (encrypted) manifest body. */
export interface DeviceEntry {
  readonly deviceId: DeviceId;
  /** X25519 public key the DEK is wrapped to for this device. */
  readonly wrapPublicKey: Uint8Array;
  /** Ed25519 public key that verifies this device's shard/manifest signatures. */
  readonly signPublicKey: Uint8Array;
  /** The DEK wrapped to this device's `wrapPublicKey`. */
  readonly wrappedDek: WrappedDek;
  /** When the device was enrolled (origin wall-clock millis). */
  readonly enrolledAt: number;
  /** Set when the device has been revoked; readers reject its shards after DEK rotation. */
  readonly revoked?: boolean;
}

/** Per-file encryption-state index — drives resumable/idempotent mode-switch (F12). */
export interface FileIndexEntry {
  /** Bundle-relative logical path. When encrypted, the path COMPONENTS are
   *  themselves encrypted so project/session names don't leak (review F4). */
  readonly path: string;
  readonly state: FileEncryptionState;
  readonly originDevice: DeviceId;
  readonly seq: number;
}

/**
 * The manifest BODY: encrypted with the DEK and signed by the writing device.
 * Readers MUST verify the signature (against an already-trusted device
 * `signPublicKey`) and decrypt BEFORE trusting any field here.
 */
export interface ManifestBody {
  readonly devices: readonly DeviceEntry[];
  /** DEK wrapped to the passphrase (recovery) recipient — enables recovery +
   *  new-device enrollment by unwrapping the DEK from the manifest (review B3). */
  readonly passphraseWrappedDek: WrappedDek;
  /** Random 128-bit KDF salt (non-secret). */
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: Argon2idParams;
  /** Per-file encryption-state index. */
  readonly files: readonly FileIndexEntry[];
}

/**
 * The on-store manifest wire form: a small plaintext header + a SEALED body +
 * the body's signature + which device signed it. `sealedBody` is
 * `serialize(ManifestBody)` → `seal(DEK)`; `bodySignature` is that sealed blob
 * signed by `signedBy`'s Ed25519 key. Never trust `sealedBody` until its
 * signature verifies against a device already known/trusted (reviews F1/F4).
 */
export interface Manifest {
  readonly header: ManifestHeader;
  readonly sealedBody: Uint8Array;
  readonly bodySignature: Uint8Array;
  readonly signedBy: DeviceId;
}

// ─── Export selector (impl in Phase C) ───────────────────────────────────────

/** Minimal projection of a `sessions` row needed by the export selector. */
export interface ExportCandidateRow {
  readonly sessionId: string;
  /** The row's `source_file` — the JSONL this device parsed it from. */
  readonly sourceFile: string;
}

/**
 * EXPORT SELECTOR (signature only — impl in Phase C).
 *
 * "Locally-originated" = a `sessions` row whose `source_file` matches a row in
 * this device's `collection_state.source_file`. Meaning: this device actually
 * COLLECTED that file, as opposed to a row that arrived by merging another
 * device's shard. ONLY locally-originated rows are exported to THIS device's
 * shards — so merged-in rows are never re-exported and every device doesn't end
 * up re-exporting everyone else's data (review S3).
 *
 * @param row               a candidate `sessions` row
 * @param localSourceFiles  the set of `collection_state.source_file` values on THIS device
 * @returns                 true iff the row should be exported to this device's shards
 */
export type IsLocallyOriginated = (
  row: ExportCandidateRow,
  localSourceFiles: ReadonlySet<string>,
) => boolean;

// ─── Org-plane aggregate projection (the plane-separation invariant) ─────────

/**
 * Org-plane AGGREGATE PROJECTION — the ONLY shape the client ever sends to the
 * org backend. Deliberately a DIFFERENT shape from `SessionRecord` /
 * `SyncSessionInput`: it carries only counts/totals the client computed and
 * MINIMIZED locally (k-anonymity, if any, is a cohort property enforced org-side
 * — review N3), and is STRUCTURALLY INCAPABLE of carrying transcript content,
 * `prompt_text`, `file_paths`, session/source ids/paths, or any key material.
 *
 * This is the security-critical plane-separation invariant enforced BY TYPE, not
 * by a runtime filter. There is no code path by which the org plane obtains
 * personal-plane plaintext or ciphertext. See the compile-time assertion below;
 * Phase G ships the runtime structural test too (review F9/S6).
 */
export interface AggregateProjection {
  /** Coarse bucket start (ISO date), NOT a session/message id. */
  readonly periodStart: string;
  readonly periodKind: "day" | "week" | "month";
  /** Opaque cohort/account handle (client-minimized / HMAC-derived) — never a raw
   *  account uuid, never a path. */
  readonly cohortId: string;
  readonly sessionCount: number;
  readonly promptCount: number;
  readonly assistantMessageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly estimatedCostUsd: number;
  /** Model identifiers used in the bucket (non-sensitive labels). */
  readonly models: readonly string[];
  /** Aggregate-payload schema version. */
  readonly _schema: number;
}

/**
 * Field names that must NEVER appear on an org-plane payload. Used by the
 * compile-time invariant below and reused by the Phase-G structural test.
 */
export type ForbiddenPersonalField =
  | "promptText"
  | "prompt_text"
  | "filePaths"
  | "file_paths"
  | "transcript"
  | "content"
  | "sourceFile"
  | "source_file"
  | "sessionId"
  | "session_id"
  | "sealedBody"
  | "wrappedDek"
  | "secretKey"
  | "wrapSecretKey"
  | "signingSecretKey"
  | "dek";

/** True iff `T` names no forbidden personal-plane field. */
export type HasNoPersonalFields<T> =
  Extract<keyof T, ForbiddenPersonalField> extends never ? true : false;

/** @internal compile-time assertion; zero runtime effect. */
type Assert<T extends true> = T;
/** If `AggregateProjection` ever grows a forbidden field, THIS line fails to compile. */
type _PlaneSeparationInvariant = Assert<HasNoPersonalFields<AggregateProjection>>;
export type { _PlaneSeparationInvariant };
