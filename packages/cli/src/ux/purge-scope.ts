/**
 * Phase E — data-removal scope: "this machine only" vs "also delete the cloud
 * copy" (doc 02 §10 / plan Phase E).
 *
 * The existing `purge` CLI command (and the VS Code "Delete All Stored Data"
 * command it backs) already deletes local state honestly and idempotently
 * (`archive/purge.ts`). This module adds the personal-plane BACKUP dimension:
 * a scope picker that is explicit about what "also delete the cloud copy"
 * really means — this device's shards in the shared bundle — and states
 * plainly that other devices still hold their own copies until they too are
 * purged, because that is how a distributed, conflict-free backup works. It
 * is NOT a claim to erase the org plane, which the org owns (doc 02 §10) and
 * a local button can never unilaterally delete.
 *
 * `describePurgeScope` is pure (no IO) so the scope copy is unit-testable;
 * `purgeDeviceCloudCopy` is the imperative-shell counterpart that actually
 * removes this device's subtree from a {@link StorageTransport} and drops its
 * entries from the signed manifest index — built from the same primitives
 * Phase C's mode-switch reconcile sweep uses, so a run interrupted mid-way
 * self-heals: files gone from storage but still indexed are dropped from the
 * index on the next run, and index entries with no backing file are ignored.
 */

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import { removeFileIndex } from "@claude-stats/core/bundle";
import {
  loadOrSeedBody,
  writeManifest,
  type BackupCrypto,
  type DeviceIdentity,
} from "../backup/index.js";

export type PurgeScope = "this-machine" | "also-cloud";

export interface PurgeScopeDescription {
  readonly scope: PurgeScope;
  /** Human-readable list of what this scope deletes (order matters for display). */
  readonly deletes: readonly string[];
  /**
   * Present (non-null) only for "also-cloud": the plain-language caveat that
   * other devices are unaffected until they too are purged. Never omit this
   * when describing the also-cloud scope — hiding it would let a user believe
   * one button erases every copy everywhere.
   */
  readonly otherDevicesNote: string | null;
}

/**
 * Describe what each purge scope deletes, in plain language, for the VS Code
 * quickpick / confirmation dialog. Pure — no filesystem or transport access.
 */
export function describePurgeScope(scope: PurgeScope): PurgeScopeDescription {
  const local = [
    "The local transcript archive",
    "The local export bundle cache",
  ];
  if (scope === "this-machine") {
    return { scope, deletes: local, otherDevicesNote: null };
  }
  return {
    scope,
    deletes: [
      ...local,
      "This device's encrypted/plaintext shards in your configured backup location (Dropbox/iCloud/Drive/OneDrive/local folder)",
    ],
    otherDevicesNote:
      "Other devices you've enrolled still hold their own copies until they, too, run " +
      "\"Delete all stored data\" with the cloud scope. This is how a distributed backup " +
      "works: no single device can erase what another device independently wrote.",
  };
}

export interface PurgeCloudCopyResult {
  /** Shard/manifest-index keys removed from this device's subtree. */
  readonly deleted: readonly string[];
}

/**
 * Remove every file this device owns from the shared bundle transport, and
 * drop those entries from the signed manifest index. Only this device's OWN
 * subtree is touched (`${deviceId}/...`) — exactly like `mode-switch.ts`, a
 * device can only produce a validly-signed manifest update for its own
 * writes; it never touches another device's shards or entry.
 *
 * Idempotent: safe to re-run (nothing left to delete → empty result).
 */
export async function purgeDeviceCloudCopy(
  transport: StorageTransport,
  identity: DeviceIdentity,
  crypto: BackupCrypto,
): Promise<PurgeCloudCopyResult> {
  const deviceId = identity.deviceId;

  let body = await loadOrSeedBody(transport, crypto);
  const ownEntries = body.files.filter((f) => f.originDevice === deviceId);
  for (const entry of ownEntries) {
    body = removeFileIndex(body, entry.path);
  }
  // Persist the pruned index BEFORE deleting bytes, so a crash mid-delete
  // leaves an orphan file (harmless, cleaned up by a later sweep) rather than
  // a dangling index entry pointing at nothing.
  if (ownEntries.length > 0) {
    await writeManifest(transport, body, identity, crypto);
  }

  const present = await transport.list(deviceId);
  const deleted: string[] = [];
  for (const key of present) {
    await transport.delete(key);
    deleted.push(key);
  }
  return { deleted };
}
