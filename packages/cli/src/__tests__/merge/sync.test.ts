/**
 * Phase D — SYNC orchestrator: apply-into-SQLite, F13 new-device alert, ambient
 * wiring, glanceable status. End-to-end over a real Store (temp DB), real crypto,
 * and a real directory transport. Synthetic ids/paths only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveMaster,
  generateDek,
  generateSignKeyPair,
  generateWrapKeyPair,
  wrapDek,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";
import { assertDeviceId, type DeviceId } from "@claude-stats/core/types/shard";
import { utf8Encode } from "@claude-stats/core/bundle";
import type { StorageTransport } from "@claude-stats/core/crypto/types";

import {
  DirectoryStorageTransport,
  buildSessionRecords,
  pushShard,
  type BackupCrypto,
  type DeviceIdentity,
} from "../../backup/index.js";
import { Store, type MessageRow, type SessionRow } from "../../store/index.js";
import {
  MemoryKnownDeviceRegistry,
  attachAmbientSync,
  detectNewDevices,
  formatSyncStatus,
  originDevicesOf,
  rowToSessionRecord,
  syncOnce,
  type CollectSignal,
  type NewDeviceEvent,
  type SyncStatus,
} from "../../sync-merge/index.js";

const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };
const SELF = "deadbeefcafe5e1f";
const OTHER = "deadbeefcafe0002";

function makeIdentity(hexId: string): DeviceIdentity {
  const wrap = generateWrapKeyPair();
  const sig = generateSignKeyPair();
  return { deviceId: assertDeviceId(hexId), wrapPublicKey: wrap.publicKey, signPublicKey: sig.publicKey, signingSecretKey: sig.secretKey };
}
function makeCrypto(): BackupCrypto {
  const dek = generateDek();
  const kdfSalt = generateKdfSalt();
  const master = deriveMaster(utf8Encode("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23"), kdfSalt, TEST_ARGON);
  return { dek, passphraseWrappedDek: wrapDek(dek, [{ kind: "passphrase", masterKey: master }]), kdfSalt, kdfParams: TEST_ARGON };
}
function sessionRow(id: string): SessionRow {
  return {
    session_id: id, project_path: "/home/example/p", source_file: `/home/example/${id}.jsonl`,
    first_timestamp: 100, last_timestamp: 200, claude_version: "1", entrypoint: "cli", git_branch: null,
    is_interactive: 1, prompt_count: 3, assistant_message_count: 3, input_tokens: 30, output_tokens: 60,
    cache_creation_tokens: 0, cache_read_tokens: 0, web_search_requests: 0, web_fetch_requests: 0,
    tool_use_counts: "[]", models: '["claude-x"]', repo_url: null, account_uuid: null, organization_uuid: null,
    subscription_type: null, thinking_blocks: 0, parent_session_id: null, is_subagent: 0,
    source_deleted: 0, throttle_events: 0, active_duration_ms: null, median_response_time_ms: null,
  } as SessionRow;
}
function messageRow(uuid: string, sid: string): MessageRow {
  return {
    uuid, session_id: sid, timestamp: 150, claude_version: "1", model: "claude-x", stop_reason: "end_turn",
    input_tokens: 5, output_tokens: 10, cache_creation_tokens: 0, cache_read_tokens: 0, tools: "[]",
    file_paths: "[]", thinking_blocks: 0, service_tier: null, inference_geo: null,
    ephemeral_5m_cache_tokens: 0, ephemeral_1h_cache_tokens: 0, prompt_text: "hi",
  } as MessageRow;
}
function recordsFor(id: DeviceId, sid: string) {
  return buildSessionRecords([sessionRow(sid)], () => [messageRow(`${sid}-m`, sid)], {
    originDevice: id, localSourceFiles: new Set([`/home/example/${sid}.jsonl`]), wallMs: 1, startCounter: 0,
  });
}

let root: string;
let transport: DirectoryStorageTransport;
let dbPath: string;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-sync-"));
  transport = new DirectoryStorageTransport(root);
  dbPath = join(root, "stats.db");
  store = new Store(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("syncOnce merges another device's shards into SQLite", () => {
  it("pulls, merges, and upserts a remote session into the local store", async () => {
    const crypto = makeCrypto();
    const other = makeIdentity(OTHER);
    await pushShard({ transport, identity: other, crypto, encryptSyncData: true, records: recordsFor(other.deviceId, "remote1"), seq: 0, enrolledAt: 1 });

    const status = await syncOnce({
      transport, dek: crypto.dek, store, self: assertDeviceId(SELF),
      registry: new MemoryKnownDeviceRegistry([assertDeviceId(OTHER)]), // already known → no alert
      now: () => 1234,
    });

    expect(status.ok).toBe(true);
    expect(status.at).toBe(1234);
    expect(status.sessionsApplied).toBe(1);
    expect(status.messagesApplied).toBe(1);

    const rows = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(rows.map((r) => r.session_id)).toContain("remote1");
    expect(store.getSessionMessages("remote1").map((m) => m.uuid)).toEqual(["remote1-m"]);
  });

  it("does NOT re-apply this device's own sessions (own rows stay local-authoritative)", async () => {
    const crypto = makeCrypto();
    const self = makeIdentity(SELF);
    await pushShard({ transport, identity: self, crypto, encryptSyncData: true, records: recordsFor(self.deviceId, "mine"), seq: 0, enrolledAt: 1 });

    const status = await syncOnce({
      transport, dek: crypto.dek, store, self: self.deviceId,
      registry: new MemoryKnownDeviceRegistry([self.deviceId]),
      now: () => 1,
    });
    // The one merged session is this device's own → skipped, not written.
    expect(status.sessionsMerged).toBe(1);
    expect(status.sessionsApplied).toBe(0);
    expect(store.getSessions({ includeCI: true, includeDeleted: true })).toEqual([]);
  });
});

describe("F13 — new-device notification fires once", () => {
  it("alerts on a never-before-seen device, then never again", async () => {
    const crypto = makeCrypto();
    const other = makeIdentity(OTHER);
    await pushShard({ transport, identity: other, crypto, encryptSyncData: false, records: recordsFor(other.deviceId, "r1"), seq: 0, enrolledAt: 1 });

    const events: NewDeviceEvent[] = [];
    const registry = new MemoryKnownDeviceRegistry(); // nothing known yet
    const deps = {
      transport, dek: crypto.dek, store, self: assertDeviceId(SELF), registry,
      notifier: (e: NewDeviceEvent) => { events.push(e); },
      now: () => 1,
    };

    const first = await syncOnce(deps);
    expect(first.newDevices).toEqual([assertDeviceId(OTHER)]);
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toMatch(/rotate your recovery key/i);
    expect(events[0]!.message).toContain(OTHER);

    // Second sync: the device is now acknowledged → no repeat alert.
    const second = await syncOnce(deps);
    expect(second.newDevices).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("detectNewDevices excludes self and already-known devices", () => {
    const seen = new Set<DeviceId>([assertDeviceId(SELF), assertDeviceId(OTHER)]);
    const known = new Set<DeviceId>([assertDeviceId(OTHER)]);
    expect(detectNewDevices(seen, known, assertDeviceId(SELF))).toEqual([]);
    expect(detectNewDevices(seen, new Set(), assertDeviceId(SELF))).toEqual([assertDeviceId(OTHER)]);
  });
});

describe("glanceable status", () => {
  it("formats a healthy sync and flags new devices", () => {
    expect(formatSyncStatus({
      at: 1, ok: true, devicesSeen: 2, shardsAccepted: 3, shardsRejected: 0, shardsDeferred: 0,
      sessionsMerged: 3, sessionsApplied: 2, messagesApplied: 5, newDevices: [],
    })).toMatch(/2 device\(s\).*3 accepted.*2 session/);
    expect(formatSyncStatus({
      at: 1, ok: true, devicesSeen: 1, shardsAccepted: 1, shardsRejected: 1, shardsDeferred: 1,
      sessionsMerged: 1, sessionsApplied: 1, messagesApplied: 1, newDevices: [assertDeviceId(OTHER)],
    })).toMatch(/new device/);
    expect(formatSyncStatus({
      at: 1, ok: false, error: "boom", devicesSeen: 0, shardsAccepted: 0, shardsRejected: 0,
      shardsDeferred: 0, sessionsMerged: 0, sessionsApplied: 0, messagesApplied: 0, newDevices: [],
    })).toMatch(/failed \(boom\)/);
  });
});

describe("ambient wiring off the collector", () => {
  it("debounces a burst of collects into a single sync and exposes last status", async () => {
    vi.useFakeTimers();
    try {
      const cbs: Array<() => void> = [];
      const signal: CollectSignal = { onDidCollect: (cb) => { cbs.push(cb); return { dispose: () => {} }; } };
      let runs = 0;
      const status = { at: 1, ok: true, devicesSeen: 0, shardsAccepted: 0, shardsRejected: 0, shardsDeferred: 0, sessionsMerged: 0, sessionsApplied: 0, messagesApplied: 0, newDevices: [] };
      const handle = attachAmbientSync(signal, async () => { runs++; return status; }, { debounceMs: 100 });

      // Three rapid collects → one debounced run.
      cbs[0]!(); cbs[0]!(); cbs[0]!();
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(runs).toBe(1);
      expect(handle.lastStatus()).toBe(status);
      handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncNow runs immediately and dispose unsubscribes", async () => {
    let disposed = false;
    const signal: CollectSignal = { onDidCollect: () => ({ dispose: () => { disposed = true; } }) };
    let runs = 0;
    const status = { at: 1, ok: true, devicesSeen: 0, shardsAccepted: 0, shardsRejected: 0, shardsDeferred: 0, sessionsMerged: 0, sessionsApplied: 0, messagesApplied: 0, newDevices: [] };
    const handle = attachAmbientSync(signal, async () => { runs++; return status; });
    await handle.syncNow();
    expect(runs).toBe(1);
    handle.dispose();
    expect(disposed).toBe(true);
  });

  it("single-flight: a collect during an in-flight sync RE-schedules exactly one rerun", async () => {
    const STATUS: SyncStatus = {
      at: 1, ok: true, devicesSeen: 0, shardsAccepted: 0, shardsRejected: 0, shardsDeferred: 0,
      sessionsMerged: 0, sessionsApplied: 0, messagesApplied: 0, newDevices: [],
    };
    // Manually-driven timer queue + deferred syncs → full control over interleaving.
    let timers: Array<{ fn: () => void }> = [];
    const setTimer = (fn: () => void) => { const h = { fn }; timers.push(h); return h as unknown as ReturnType<typeof setTimeout>; };
    const clearTimer = (h: ReturnType<typeof setTimeout>) => { timers = timers.filter((t) => (t as unknown) !== h); };
    const flush = () => { const t = timers.shift(); t?.fn(); };
    const micro = () => new Promise<void>((r) => setImmediate(r));

    let runs = 0;
    const resolvers: Array<() => void> = [];
    const runSync = () => { runs++; return new Promise<SyncStatus>((res) => { resolvers.push(() => res(STATUS)); }); };

    const cbs: Array<() => void> = [];
    const signal: CollectSignal = { onDidCollect: (cb) => { cbs.push(cb); return { dispose: () => {} }; } };
    const handle = attachAmbientSync(signal, runSync, { setTimer, clearTimer, debounceMs: 100 });

    cbs[0]!();            // schedule run #1
    flush();              // timer fires → run #1 starts, awaits its deferred
    expect(runs).toBe(1);

    cbs[0]!();            // a collect DURING the in-flight run → schedule
    flush();              // timer fires → run() sees syncing → pendingRerun, no new run
    expect(runs).toBe(1);

    resolvers[0]!();      // run #1 settles → finally sees pendingRerun → reschedules
    await micro();
    flush();              // that rescheduled timer fires → run #2
    expect(runs).toBe(2);

    resolvers[1]!();
    await micro();
    expect(handle.lastStatus()).toBe(STATUS);
    handle.dispose();
  });

  it("dispose() cancels a still-pending debounce timer (no sync runs)", () => {
    let timers: Array<{ fn: () => void }> = [];
    const setTimer = (fn: () => void) => { const h = { fn }; timers.push(h); return h as unknown as ReturnType<typeof setTimeout>; };
    const clearTimer = (h: ReturnType<typeof setTimeout>) => { timers = timers.filter((t) => (t as unknown) !== h); };

    let runs = 0;
    let disposed = false;
    let cb: (() => void) | undefined;
    const signal: CollectSignal = { onDidCollect: (c) => { cb = c; return { dispose: () => { disposed = true; } }; } };
    const handle = attachAmbientSync(signal, async () => { runs++; return {} as SyncStatus; }, { setTimer, clearTimer, debounceMs: 100 });

    cb!();                     // schedules a timer that has NOT fired yet
    expect(timers.length).toBe(1);
    handle.dispose();          // must clear that pending timer AND unsubscribe
    expect(timers.length).toBe(0);
    expect(disposed).toBe(true);
    expect(runs).toBe(0);
  });
});

describe("syncOnce is fail-safe on an unexpected error (non-ok status, never throws)", () => {
  it("returns ok:false with the error and the injected timestamp when the transport blows up", async () => {
    const boom: StorageTransport = {
      list: async () => [],
      get: async () => { throw new Error("kaboom opening manifest"); },
      put: async () => {},
      delete: async () => {},
    };
    const status = await syncOnce({
      transport: boom, dek: new Uint8Array(32), store, self: assertDeviceId(SELF),
      registry: new MemoryKnownDeviceRegistry(), now: () => 77,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/kaboom/);
    expect(status.at).toBe(77);
    expect(status.sessionsApplied).toBe(0);
  });
});

describe("originDevicesOf collects distinct authoring devices (diagnostics/F13)", () => {
  it("returns the set of origin devices across a mixed record batch", () => {
    const recs = [
      ...recordsFor(assertDeviceId(OTHER), "x"),
      ...recordsFor(assertDeviceId(SELF), "y"),
      ...recordsFor(assertDeviceId(OTHER), "z"),
    ];
    expect([...originDevicesOf(recs)].sort()).toEqual([OTHER, SELF].sort());
  });
});

describe("rowToSessionRecord tolerates malformed JSON-array columns (apply defensive parse)", () => {
  it("degrades a corrupt models / tool_use_counts column to [] instead of throwing", () => {
    const row = { ...sessionRow("s1"), models: "not-json", tool_use_counts: "{oops" } as SessionRow;
    const rec = rowToSessionRecord(row);
    expect(rec.models).toEqual([]);
    expect(rec.toolUseCounts).toEqual([]);
    expect(rec.sessionId).toBe("s1");
  });
});
