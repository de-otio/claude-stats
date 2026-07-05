/**
 * Phase D — SYNC orchestrator (imperative shell): pull → merge → apply, plus the
 * F13 new-device notification and a glanceable status. Backup (Phase C) was push;
 * sync is push's counterpart — pull everyone else's shards and converge them into
 * the local DB.
 *
 * Sequence, and why:
 *   1. loadTrustedDevices — open the signed+sealed manifest; it is the trust root
 *      for who may author a shard (F1).
 *   2. pullShards — verify + decrypt every shard against that root; hostile or
 *      half-synced shards are categorized out, never merged (F1/S8).
 *   3. mergeRecords — fold accepted records into the convergent per-session view
 *      off the origin logical clock, NOT `updated_at` (B2).
 *   4. applyMerged — idempotently upsert the winners (skipping this device's own).
 *   5. new-device detection — diff seen devices against the local known set; on a
 *      never-before-seen device, fire the notification, THEN persist the set so
 *      the alert fires exactly once (F13).
 *
 * Everything nondeterministic is injected: the transport, the DEK, the clock. No
 * bare `Date.now()` — `deps.now` supplies the status timestamp so tests pin it.
 */

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import type { DeviceId } from "@claude-stats/core/types/shard";
import type { Store } from "../store/index.js";
import { applyMerged, type ApplyResult } from "./apply.js";
import { detectNewDevices, type KnownDeviceRegistry } from "./device-registry.js";
import { mergeRecords, type MergedSession } from "./merge.js";
import { loadTrustedDevices, pullShards, type PullResult } from "./pull.js";

/**
 * Fired when a pull surfaces a device id this machine has never acknowledged.
 * The UX layer (Phase E) wires this to a VS Code notification / CLI warning. Kept
 * as a plain callback so core sync has no VS Code dependency.
 */
export type NewDeviceNotifier = (event: NewDeviceEvent) => void | Promise<void>;

export interface NewDeviceEvent {
  readonly devices: readonly DeviceId[];
  /** The actionable framing — surfaced verbatim by the UX layer. */
  readonly message: string;
}

/** The user-facing copy for F13. `%s` is replaced with the joined device list. */
export function newDeviceMessage(devices: readonly DeviceId[]): string {
  const list = devices.join(", ");
  return `New device added to your sync (${list}) — rotate your recovery key if this wasn't you.`;
}

export interface SyncDeps {
  readonly transport: StorageTransport;
  /** DEK for this device (opens the manifest; decrypts encrypted shards). */
  readonly dek: Uint8Array;
  readonly store: Store;
  /** This device's id — its own merged rows are left to local collection. */
  readonly self: DeviceId;
  /** Local known-device registry backing the once-only F13 alert. */
  readonly registry: KnownDeviceRegistry;
  /** Optional F13 hook; omitted in headless/no-UI contexts. */
  readonly notifier?: NewDeviceNotifier;
  /** Injected clock for the status timestamp (no bare Date.now()). */
  readonly now?: () => number;
}

/** Glanceable outcome of one sync — the shape the status surface renders. */
export interface SyncStatus {
  readonly at: number;
  readonly ok: boolean;
  /** Present only when `ok` is false. */
  readonly error?: string;
  readonly devicesSeen: number;
  readonly shardsAccepted: number;
  readonly shardsRejected: number;
  readonly shardsDeferred: number;
  readonly sessionsMerged: number;
  readonly sessionsApplied: number;
  readonly messagesApplied: number;
  readonly newDevices: readonly DeviceId[];
}

/**
 * Run one full sync cycle. Never throws for an expected failure (no manifest,
 * hostile/half-synced shard) — those are represented in the returned status. A
 * genuinely unexpected error (e.g. a store failure) is caught and returned as a
 * non-ok status so the ambient loop keeps running.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncStatus> {
  const now = deps.now ?? Date.now;
  try {
    const trustedDevices = await loadTrustedDevices(deps.transport, deps.dek);
    const pull: PullResult = await pullShards({
      transport: deps.transport,
      trustedDevices,
      dek: deps.dek,
    });

    const merged: readonly MergedSession[] = mergeRecords(pull.records);
    const applied: ApplyResult = applyMerged(deps.store, merged, { selfDeviceId: deps.self });

    const newDevices = await reconcileKnownDevices(deps, pull.devicesSeen);

    const shardsRejected = pull.rejectedUnknownDevice.length + pull.rejectedBadSignature.length;
    return {
      at: now(),
      ok: true,
      devicesSeen: pull.devicesSeen.size,
      shardsAccepted: pull.accepted.length,
      shardsRejected,
      shardsDeferred: pull.deferredTruncated.length,
      sessionsMerged: merged.length,
      sessionsApplied: applied.sessionsApplied,
      messagesApplied: applied.messagesApplied,
      newDevices,
    };
  } catch (err) {
    return {
      at: now(),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      devicesSeen: 0,
      shardsAccepted: 0,
      shardsRejected: 0,
      shardsDeferred: 0,
      sessionsMerged: 0,
      sessionsApplied: 0,
      messagesApplied: 0,
      newDevices: [],
    };
  }
}

/**
 * Diff the devices this pull saw against the locally-acknowledged set; notify on
 * any new one, THEN persist the union so the alert never re-fires. Notification
 * happens BEFORE the save so a crash between the two re-alerts (safe direction)
 * rather than silently swallowing the event.
 */
async function reconcileKnownDevices(
  deps: SyncDeps,
  seen: ReadonlySet<DeviceId>,
): Promise<readonly DeviceId[]> {
  const known = await deps.registry.load();
  const newDevices = detectNewDevices(seen, known, deps.self);
  if (newDevices.length > 0 && deps.notifier) {
    await deps.notifier({ devices: newDevices, message: newDeviceMessage(newDevices) });
  }
  if (newDevices.length > 0) {
    const union = new Set<DeviceId>(known);
    for (const id of seen) union.add(id);
    await deps.registry.save(union);
  }
  return newDevices;
}

/** One-line, human-glanceable rendering of a {@link SyncStatus}. */
export function formatSyncStatus(status: SyncStatus): string {
  if (!status.ok) return `sync: failed (${status.error ?? "unknown error"})`;
  const parts = [
    `${status.devicesSeen} device(s)`,
    `${status.shardsAccepted} accepted`,
  ];
  if (status.shardsRejected > 0) parts.push(`${status.shardsRejected} rejected`);
  if (status.shardsDeferred > 0) parts.push(`${status.shardsDeferred} deferred`);
  parts.push(`${status.sessionsApplied} session(s) merged in`);
  if (status.newDevices.length > 0) parts.push(`⚠ ${status.newDevices.length} new device(s)`);
  return `sync: ${parts.join(", ")}`;
}
