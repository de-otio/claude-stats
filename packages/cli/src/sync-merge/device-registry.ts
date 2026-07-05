/**
 * Phase D — known-device registry + new-device detection (F13).
 *
 * A device the merge has never seen before, appearing in the shared bundle, is a
 * security-relevant event: either the user legitimately enrolled a new device, or
 * an attacker who obtained the DEK enrolled a rogue one. Either way the user
 * should be told, with the actionable framing "if this wasn't you, rotate your
 * recovery key". To fire that exactly ONCE per device we persist the set of
 * device ids we've already acknowledged locally and diff each pull against it.
 *
 * The registry is LOCAL per-device trust state — it lives next to the DB, NOT in
 * the shared bundle (an attacker with bundle write access must not be able to
 * pre-seed their own id as "already known"). Pure detection ({@link detectNewDevices})
 * is separated from the file IO so the notification logic is trivially testable.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DeviceId } from "@claude-stats/core/types/shard";
import { isValidDeviceId } from "@claude-stats/core/types/shard";

/**
 * Pure diff: device ids present in `seen` but not in `known`, excluding `self`
 * (this device is never "new" to itself). Sorted for deterministic notification
 * order. This is the whole F13 decision — the IO around it just persists `known`.
 */
export function detectNewDevices(
  seen: ReadonlySet<DeviceId>,
  known: ReadonlySet<DeviceId>,
  self?: DeviceId,
): DeviceId[] {
  const out: DeviceId[] = [];
  for (const id of seen) {
    if (id === self) continue;
    if (!known.has(id)) out.push(id);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Persists the set of device ids this device has already acknowledged. */
export interface KnownDeviceRegistry {
  load(): Promise<Set<DeviceId>>;
  /** Persist the acknowledged set (replaces the stored set). */
  save(ids: ReadonlySet<DeviceId>): Promise<void>;
}

/** In-memory registry — for tests and for a caller that manages its own state. */
export class MemoryKnownDeviceRegistry implements KnownDeviceRegistry {
  private ids: Set<DeviceId>;
  constructor(initial: Iterable<DeviceId> = []) {
    this.ids = new Set(initial);
  }
  async load(): Promise<Set<DeviceId>> {
    return new Set(this.ids);
  }
  async save(ids: ReadonlySet<DeviceId>): Promise<void> {
    this.ids = new Set(ids);
  }
}

interface KnownDevicesWire {
  readonly version: number;
  readonly devices: readonly string[];
}

const KNOWN_DEVICES_VERSION = 1;

/**
 * File-backed registry (`0600`, JSON). Malformed/absent state loads as empty —
 * a corrupt file must not crash sync; the worst case is one extra "new device"
 * notification, which is the safe direction for a security prompt.
 */
export class FileKnownDeviceRegistry implements KnownDeviceRegistry {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Set<DeviceId>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return new Set();
    }
    try {
      const parsed = JSON.parse(raw) as KnownDevicesWire;
      const ids = Array.isArray(parsed?.devices) ? parsed.devices : [];
      const out = new Set<DeviceId>();
      for (const id of ids) if (typeof id === "string" && isValidDeviceId(id)) out.add(id);
      return out;
    } catch {
      return new Set();
    }
  }

  async save(ids: ReadonlySet<DeviceId>): Promise<void> {
    const wire: KnownDevicesWire = {
      version: KNOWN_DEVICES_VERSION,
      devices: [...ids].sort(),
    };
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, JSON.stringify(wire), { mode: 0o600 });
  }
}
