/**
 * Phase D — PULL authentication + resilience (F1, S8).
 *
 *   F1 — a shard is merged ONLY if its `<device-id>/` directory names a known,
 *   non-revoked device AND its signature verifies. An attacker who drops a shard
 *   under an unknown device dir, or forges a body, is rejected.
 *   S8 — a truncated/half-synced shard is skipped (deferred) and the good shards
 *   still pull; no throw.
 *
 * Real crypto + a real directory transport. Synthetic ids/paths only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { decodeShardFile, encodeShardFile, utf8Encode } from "@claude-stats/core/bundle";

import {
  DirectoryStorageTransport,
  buildSessionRecords,
  pushShard,
  type BackupCrypto,
  type DeviceIdentity,
} from "../../backup/index.js";
import type { MessageRow, SessionRow } from "../../store/index.js";
import { loadTrustedDevices, pullShards } from "../../sync-merge/pull.js";

const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };
const DEV_A = "deadbeefcafe0a01";
const DEV_B = "deadbeefcafe0b02";
const DEV_ROGUE = "deadbeefcafe0c03";

function makeIdentity(hexId: string): DeviceIdentity {
  const wrap = generateWrapKeyPair();
  const sig = generateSignKeyPair();
  return {
    deviceId: assertDeviceId(hexId),
    wrapPublicKey: wrap.publicKey,
    signPublicKey: sig.publicKey,
    signingSecretKey: sig.secretKey,
  };
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
    first_timestamp: 1, last_timestamp: 2, claude_version: "1", entrypoint: "cli", git_branch: null,
    is_interactive: 1, prompt_count: 1, assistant_message_count: 1, input_tokens: 1, output_tokens: 1,
    cache_creation_tokens: 0, cache_read_tokens: 0, web_search_requests: 0, web_fetch_requests: 0,
    tool_use_counts: "[]", models: "[]", repo_url: null, account_uuid: null, organization_uuid: null,
    subscription_type: null, thinking_blocks: 0, parent_session_id: null, is_subagent: 0,
    source_deleted: 0, throttle_events: 0, active_duration_ms: null, median_response_time_ms: null,
  } as SessionRow;
}

function records(id: DeviceId, sid: string) {
  return buildSessionRecords([sessionRow(sid)], () => [] as MessageRow[], {
    originDevice: id, localSourceFiles: new Set([`/home/example/${sid}.jsonl`]), wallMs: 1, startCounter: 0,
  });
}

let root: string;
let transport: DirectoryStorageTransport;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-pull-"));
  transport = new DirectoryStorageTransport(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pull accepts verified shards from known devices", () => {
  it("pulls records from two enrolled devices sharing one bundle", async () => {
    const crypto = makeCrypto();
    const a = makeIdentity(DEV_A);
    const b = makeIdentity(DEV_B);
    await pushShard({ transport, identity: a, crypto, encryptSyncData: true, records: records(a.deviceId, "sa"), seq: 0, enrolledAt: 1 });
    await pushShard({ transport, identity: b, crypto, encryptSyncData: true, records: records(b.deviceId, "sb"), seq: 0, enrolledAt: 1 });

    const trusted = await loadTrustedDevices(transport, crypto.dek);
    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });

    expect(res.accepted.length).toBe(2);
    expect(res.rejectedUnknownDevice).toEqual([]);
    expect(res.rejectedBadSignature).toEqual([]);
    expect(res.deferredTruncated).toEqual([]);
    expect(res.records.map((r) => r.value.session.session_id).sort()).toEqual(["sa", "sb"]);
  });
});

describe("F1 — rejects unknown / rogue / revoked devices", () => {
  it("rejects a shard dropped under an UNKNOWN device directory", async () => {
    const crypto = makeCrypto();
    const a = makeIdentity(DEV_A);
    await pushShard({ transport, identity: a, crypto, encryptSyncData: false, records: records(a.deviceId, "sa"), seq: 0, enrolledAt: 1 });

    // Attacker with folder-write access forges a plausibly-named shard under a
    // device that is NOT in the manifest device list.
    const rogue = makeIdentity(DEV_ROGUE);
    const rogueRecords = records(rogue.deviceId, "evil");
    const { sealShard } = await import("@claude-stats/core/bundle");
    const file = sealShard({ header: { schemaVersion: 1, originDevice: rogue.deviceId, seq: 0 }, records: rogueRecords }, { encryption: "plaintext", signingSecretKey: rogue.signingSecretKey });
    await transport.put(`${DEV_ROGUE}/sessions-0.json`, encodeShardFile(file));

    const trusted = await loadTrustedDevices(transport, crypto.dek);
    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });

    expect(res.rejectedUnknownDevice).toContain(`${DEV_ROGUE}/sessions-0.json`);
    // The rogue's records never enter the merge input.
    expect(res.records.some((r) => r.value.session.session_id === "evil")).toBe(false);
    expect(res.accepted).toEqual([`${DEV_A}/sessions-0.json`]);
  });

  it("rejects a shard whose signature does not verify against the claimed device", async () => {
    const crypto = makeCrypto();
    const a = makeIdentity(DEV_A);
    await pushShard({ transport, identity: a, crypto, encryptSyncData: false, records: records(a.deviceId, "sa"), seq: 0, enrolledAt: 1 });

    // Flip a byte in the (plaintext) body — signature no longer matches.
    const key = `${DEV_A}/sessions-0.json`;
    const file = decodeShardFile((await transport.get(key))!);
    const tampered = { ...file, body: Uint8Array.from(file.body).map((byte, i) => (i === 0 ? byte ^ 0xff : byte)) };
    await transport.put(key, encodeShardFile(tampered));

    const trusted = await loadTrustedDevices(transport, crypto.dek);
    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });

    expect(res.rejectedBadSignature).toContain(key);
    expect(res.accepted).toEqual([]);
    expect(res.records).toEqual([]);
  });

  it("rejects shards from a REVOKED device", async () => {
    const crypto = makeCrypto();
    const a = makeIdentity(DEV_A);
    await pushShard({ transport, identity: a, crypto, encryptSyncData: false, records: records(a.deviceId, "sa"), seq: 0, enrolledAt: 1 });

    const trusted = await loadTrustedDevices(transport, crypto.dek);
    // Simulate the device having been revoked (DEK rotated, recipient dropped).
    const entry = trusted.get(a.deviceId)!;
    trusted.set(a.deviceId, { ...entry, revoked: true });

    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });
    expect(res.rejectedUnknownDevice).toContain(`${DEV_A}/sessions-0.json`);
    expect(res.accepted).toEqual([]);
  });
});

describe("S8 — tolerates a truncated / half-synced shard", () => {
  it("skips a byte-truncated shard and still pulls the good one; no throw", async () => {
    const crypto = makeCrypto();
    const a = makeIdentity(DEV_A);
    await pushShard({ transport, identity: a, crypto, encryptSyncData: true, records: records(a.deviceId, "good"), seq: 0, enrolledAt: 1 });
    await pushShard({ transport, identity: a, crypto, encryptSyncData: true, records: records(a.deviceId, "half"), seq: 1, enrolledAt: 1 });

    // A paused cloud client exposes seq-1 half-written: truncate its bytes.
    const halfKey = `${DEV_A}/sessions-1.json.age`;
    const full = (await transport.get(halfKey))!;
    await transport.put(halfKey, full.slice(0, Math.floor(full.length / 2)));

    const trusted = await loadTrustedDevices(transport, crypto.dek);
    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });

    expect(res.deferredTruncated).toContain(halfKey);
    expect(res.accepted).toContain(`${DEV_A}/sessions-0.json.age`);
    // The good shard's records are present; the truncated one contributes nothing
    // this pull and is retried next time.
    expect(res.records.map((r) => r.value.session.session_id)).toEqual(["good"]);
  });

  it("returns an empty pull (no throw) when there is no manifest yet", async () => {
    const crypto = makeCrypto();
    const trusted = await loadTrustedDevices(transport, crypto.dek);
    expect(trusted.size).toBe(0);
    const res = await pullShards({ transport, trustedDevices: trusted, dek: crypto.dek });
    expect(res.records).toEqual([]);
    expect(res.accepted).toEqual([]);
  });
});
