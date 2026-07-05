/**
 * Phase C — signed + encrypted shard bundle + backup push.
 *
 * Covers the four load-bearing properties:
 *   1. SIGN + VERIFY round-trip — shards and the manifest body authenticate the
 *      writing device; tampering / a wrong key is rejected (F1).
 *   2. ONLY locally-originated rows are exported (S3).
 *   3. The manifest device/file INDEX is ENCRYPTED at rest — project/session
 *      names never appear in the on-store bytes (F4).
 *   4. Mode-switch (plaintext↔encrypted) is RESUMABLE/IDEMPOTENT and leaves ZERO
 *      plaintext leftovers, writing to NEW filenames (F3/F12).
 *
 * All fixtures are synthetic: fake hex device ids, IETF-reserved example paths,
 * fake session/source ids. No real MCP output, no customer data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateDek,
  generateSignKeyPair,
  generateWrapKeyPair,
  deriveMaster,
  wrapDek,
} from "@claude-stats/core/crypto/keys";
import { generateKdfSalt } from "@claude-stats/core/crypto/random";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";
import {
  assertDeviceId,
  type DeviceId,
  type Shard,
} from "@claude-stats/core/types/shard";
import {
  decodeManifest,
  decodeShardFile,
  encodeManifest,
  encryptPathComponents,
  decryptPathComponents,
  openManifest,
  openShard,
  sealManifest,
  sealShard,
  emptyManifestBody,
  upsertFileIndex,
  utf8Encode,
} from "@claude-stats/core/bundle";

import {
  DirectoryStorageTransport,
  buildSessionRecords,
  pushShard,
  switchMode,
  compact,
  loadOrSeedBody,
  type BackupCrypto,
  type DeviceIdentity,
  type SessionExportPayload,
} from "../../backup/index.js";
import type { MessageRow, SessionRow } from "../../store/index.js";

// ── deterministic, fast crypto material ───────────────────────────────────────

const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };
const DEVICE_ID = "deadbeefcafe0001";
const OTHER_DEVICE = "deadbeefcafe0002";

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
  const passphraseWrappedDek = wrapDek(dek, [{ kind: "passphrase", masterKey: master }]);
  return { dek, passphraseWrappedDek, kdfSalt, kdfParams: TEST_ARGON };
}

// ── synthetic rows ────────────────────────────────────────────────────────────

function sessionRow(id: string, sourceFile: string): SessionRow {
  return {
    session_id: id,
    project_path: "/home/example/proj",
    source_file: sourceFile,
    first_timestamp: 1_700_000_000_000,
    last_timestamp: 1_700_000_100_000,
    claude_version: "1.0.0",
    entrypoint: "cli",
    git_branch: null,
    is_interactive: 1,
    prompt_count: 2,
    assistant_message_count: 2,
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    web_search_requests: 0,
    web_fetch_requests: 0,
    tool_use_counts: "[]",
    models: '["claude-x"]',
    repo_url: null,
    account_uuid: null,
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: null,
    median_response_time_ms: null,
  } as SessionRow;
}

function messageRow(uuid: string, sessionId: string, prompt: string): MessageRow {
  return {
    uuid,
    session_id: sessionId,
    timestamp: 1_700_000_000_000,
    claude_version: "1.0.0",
    model: "claude-x",
    stop_reason: "end_turn",
    input_tokens: 5,
    output_tokens: 10,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tools: "[]",
    file_paths: "[]",
    thinking_blocks: 0,
    service_tier: null,
    inference_geo: null,
    ephemeral_5m_cache_tokens: 0,
    ephemeral_1h_cache_tokens: 0,
    prompt_text: prompt,
  } as MessageRow;
}

// ── temp transport ────────────────────────────────────────────────────────────

let root: string;
let transport: DirectoryStorageTransport;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-bundle-"));
  transport = new DirectoryStorageTransport(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("shard sign + verify round-trip (F1)", () => {
  it("seals, signs, and re-opens a shard's records", () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const shard: Shard<SessionExportPayload> = {
      header: { schemaVersion: 1, originDevice: id.deviceId, seq: 0 },
      records: [
        {
          clock: { wallMs: 1, counter: 0, originDevice: id.deviceId },
          value: { session: sessionRow("s1", "f1"), messages: [messageRow("m1", "s1", "hi")] },
        },
      ],
    };
    const file = sealShard(shard, { encryption: "encrypted", signingSecretKey: id.signingSecretKey, dek: crypto.dek });
    const reopened = openShard<SessionExportPayload>(file, { signPublicKey: id.signPublicKey, dek: crypto.dek });
    expect(reopened.records[0]!.value.messages[0]!.prompt_text).toBe("hi");
  });

  it("rejects a tampered shard body", () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const shard: Shard<SessionExportPayload> = {
      header: { schemaVersion: 1, originDevice: id.deviceId, seq: 0 },
      records: [],
    };
    const file = sealShard(shard, { encryption: "plaintext", signingSecretKey: id.signingSecretKey });
    const tampered = { ...file, body: Uint8Array.from(file.body).map((b, i) => (i === 0 ? b ^ 0xff : b)) };
    expect(() => openShard(tampered, { signPublicKey: id.signPublicKey })).toThrowError(/signature/i);
  });

  it("rejects a shard signed by a different (rogue) device key", () => {
    const id = makeIdentity(DEVICE_ID);
    const rogue = makeIdentity(OTHER_DEVICE);
    const crypto = makeCrypto();
    const shard: Shard<SessionExportPayload> = {
      header: { schemaVersion: 1, originDevice: id.deviceId, seq: 0 },
      records: [],
    };
    // Rogue signs bytes claiming to be `id`'s shard; verifying against id's key fails.
    const file = sealShard(shard, { encryption: "encrypted", signingSecretKey: rogue.signingSecretKey, dek: crypto.dek });
    expect(() => openShard(file, { signPublicKey: id.signPublicKey, dek: crypto.dek })).toThrowError(/signature/i);
  });

  it("signs + verifies the manifest body and rejects tampering", () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    let body = emptyManifestBody(crypto);
    body = upsertFileIndex(body, { path: `${id.deviceId}/sessions-0.json`, state: "plaintext", originDevice: id.deviceId, seq: 0 });
    body = { ...body, devices: [{ deviceId: id.deviceId, wrapPublicKey: id.wrapPublicKey, signPublicKey: id.signPublicKey, wrappedDek: crypto.passphraseWrappedDek, enrolledAt: 1 }] };
    const manifest = sealManifest(body, { dek: crypto.dek, signingSecretKey: id.signingSecretKey, signedBy: id.deviceId });
    // Round-trips through the store wire form (encode → decode → verify+open).
    const reopened = openManifest(decodeManifest(encodeManifest(manifest)), { dek: crypto.dek, signPublicKey: id.signPublicKey });
    expect(reopened.files[0]!.path).toBe(`${id.deviceId}/sessions-0.json`);
    // Self-authenticating open (no external key) also verifies via the embedded key.
    expect(openManifest(manifest, { dek: crypto.dek }).files[0]!.path).toBe(`${id.deviceId}/sessions-0.json`);
    // A tampered sealed body fails signature verification.
    const tampered = { ...manifest, sealedBody: Uint8Array.from(manifest.sealedBody).map((b, i) => (i === 0 ? b ^ 0xff : b)) };
    expect(() => openManifest(tampered, { dek: crypto.dek, signPublicKey: id.signPublicKey })).toThrowError(/verify/i);
  });
});

describe("export selector — only locally-originated rows (S3)", () => {
  it("exports rows this device collected and drops merged-in rows", () => {
    const id = makeIdentity(DEVICE_ID);
    const sessions = [
      sessionRow("local-a", "/home/example/.claude/projects/p/a.jsonl"),
      sessionRow("local-b", "/home/example/.claude/projects/p/b.jsonl"),
      sessionRow("merged-c", "/other-device/collected/c.jsonl"), // not in our collection_state
    ];
    const localSourceFiles = new Set<string>([
      "/home/example/.claude/projects/p/a.jsonl",
      "/home/example/.claude/projects/p/b.jsonl",
    ]);
    const records = buildSessionRecords(sessions, () => [], {
      originDevice: id.deviceId,
      localSourceFiles,
      wallMs: 42,
      startCounter: 0,
    });
    const ids = records.map((r) => r.value.session.session_id);
    expect(ids).toEqual(["local-a", "local-b"]); // sorted, merged-c excluded
    // Counters are strictly increasing and stamped to this device.
    expect(records.map((r) => r.clock.counter)).toEqual([0, 1]);
    expect(records.every((r) => r.clock.originDevice === id.deviceId)).toBe(true);
  });
});

describe("manifest index is encrypted at rest (F4)", () => {
  it("does not leak project/session names in the on-store manifest bytes", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const SECRET = "top-secret-project-name";
    let body = emptyManifestBody(crypto);
    // An archive file whose sensitive components are encrypted for the store key.
    const encryptedPath = `${id.deviceId}/archive/${encryptPathComponents(`${SECRET}/session-xyz.jsonl`, crypto.dek)}`;
    body = upsertFileIndex(body, { path: encryptedPath, state: "encrypted", originDevice: id.deviceId, seq: 0 });
    body = { ...body, devices: [{ deviceId: id.deviceId, wrapPublicKey: id.wrapPublicKey, signPublicKey: id.signPublicKey, wrappedDek: crypto.passphraseWrappedDek, enrolledAt: 1 }] };
    const manifest = sealManifest(body, { dek: crypto.dek, signingSecretKey: id.signingSecretKey, signedBy: id.deviceId });

    const wireBytes = encodeManifest(manifest);
    const asText = Buffer.from(wireBytes).toString("latin1");
    // The plaintext project/session names never appear in the sealed manifest.
    expect(asText).not.toContain(SECRET);
    expect(asText).not.toContain("session-xyz");

    // The holder of the DEK recovers the index and the plaintext path.
    const reopened = openManifest(manifest, { dek: crypto.dek });
    const storedPath = reopened.files[0]!.path.replace(`${id.deviceId}/archive/`, "");
    expect(decryptPathComponents(storedPath, crypto.dek)).toBe(`${SECRET}/session-xyz.jsonl`);
  });

  it("encryptPathComponents hides names and round-trips", () => {
    const dek = generateDek();
    const enc = encryptPathComponents("customer-x/secret-session.jsonl", dek);
    expect(enc).not.toContain("customer-x");
    expect(enc).not.toContain("secret-session");
    expect(decryptPathComponents(enc, dek)).toBe("customer-x/secret-session.jsonl");
  });
});

describe("backup push writes a signed shard + encrypted manifest", () => {
  it("pushes an encrypted shard and records it in the manifest index", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const records = buildSessionRecords(
      [sessionRow("s1", "f1")],
      () => [messageRow("m1", "s1", "hello")],
      { originDevice: id.deviceId, localSourceFiles: new Set(["f1"]), wallMs: 1, startCounter: 0 },
    );
    const res = await pushShard({ transport, identity: id, crypto, encryptSyncData: true, records, seq: 0, enrolledAt: 1 });
    expect(res.shardKey).toBe(`${id.deviceId}/sessions-0.json.age`);
    expect(res.encryption).toBe("encrypted");

    // Manifest indexes the shard and re-opens with the DEK.
    const body = await loadOrSeedBody(transport, crypto);
    expect(body.files.map((f) => f.path)).toContain(res.shardKey);
    expect(body.devices.map((d) => d.deviceId)).toContain(id.deviceId);

    // The shard bytes verify + decrypt to the original prompt.
    const raw = await transport.get(res.shardKey);
    const shard = openShard<SessionExportPayload>(decodeShardFile(raw!), { signPublicKey: id.signPublicKey, dek: crypto.dek });
    expect(shard.records[0]!.value.messages[0]!.prompt_text).toBe("hello");
  });
});

describe("mode-switch is idempotent + leaves zero plaintext leftovers (F3/F12)", () => {
  async function pushPlaintext(id: DeviceIdentity, crypto: BackupCrypto): Promise<void> {
    const records = buildSessionRecords(
      [sessionRow("s1", "f1")],
      () => [messageRow("m1", "s1", "leak-me-if-you-can")],
      { originDevice: id.deviceId, localSourceFiles: new Set(["f1"]), wallMs: 1, startCounter: 0 },
    );
    await pushShard({ transport, identity: id, crypto, encryptSyncData: false, records, seq: 0, enrolledAt: 1 });
  }

  it("plaintext→encrypted: new filename, old deleted, no plaintext body left", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    await pushPlaintext(id, crypto);

    const plainKey = `${id.deviceId}/sessions-0.json`;
    const encKey = `${id.deviceId}/sessions-0.json.age`;
    // Before: plaintext shard present; its (unsealed) body carries the prompt in
    // the clear — the very leak the switch removes.
    expect(await transport.has(plainKey)).toBe(true);
    const before = decodeShardFile((await transport.get(plainKey))!);
    expect(before.encryption).toBe("plaintext");
    expect(Buffer.from(before.body).toString("latin1")).toContain("leak-me-if-you-can");

    const res = await switchMode({ transport, identity: id, crypto, target: "encrypted" });
    expect(res.converted).toContain(encKey);

    // After: plaintext file gone (new filename used — no version-history link, F3).
    expect(await transport.has(plainKey)).toBe(false);
    expect(await transport.has(encKey)).toBe(true);

    // ZERO plaintext leftovers anywhere in the device subtree.
    const keys = await transport.list(id.deviceId);
    expect(keys.some((k) => /sessions-\d+\.json$/.test(k))).toBe(false);
    // And the ciphertext body does not reveal the prompt (sealed, requires the DEK).
    const after = decodeShardFile((await transport.get(encKey))!);
    expect(after.encryption).toBe("encrypted");
    expect(Buffer.from(after.body).toString("latin1")).not.toContain("leak-me-if-you-can");

    // Manifest index now says encrypted.
    const body = await loadOrSeedBody(transport, crypto);
    expect(body.files.find((f) => f.path === encKey)?.state).toBe("encrypted");
  });

  it("is idempotent — a second switch converts nothing and re-encrypts nothing", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    await pushPlaintext(id, crypto);
    await switchMode({ transport, identity: id, crypto, target: "encrypted" });
    const second = await switchMode({ transport, identity: id, crypto, target: "encrypted" });
    expect(second.converted).toEqual([]);
    expect(second.skipped).toContain(`${id.deviceId}/sessions-0.json.age`);
  });

  it("resumable: a leftover orphan plaintext from an interrupted run is swept", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    await pushPlaintext(id, crypto);
    await switchMode({ transport, identity: id, crypto, target: "encrypted" });

    // Simulate an interrupted earlier run that left a stale plaintext shard the
    // manifest no longer references.
    const orphan = `${id.deviceId}/sessions-9.json`;
    await transport.put(orphan, utf8Encode("stale plaintext leak-me-if-you-can"));
    expect(await transport.has(orphan)).toBe(true);

    const res = await switchMode({ transport, identity: id, crypto, target: "encrypted" });
    expect(res.swept).toContain(orphan);
    expect(await transport.has(orphan)).toBe(false);
  });

  it("encrypted→plaintext also round-trips the records", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const records = buildSessionRecords(
      [sessionRow("s1", "f1")],
      () => [messageRow("m1", "s1", "roundtrip")],
      { originDevice: id.deviceId, localSourceFiles: new Set(["f1"]), wallMs: 1, startCounter: 0 },
    );
    await pushShard({ transport, identity: id, crypto, encryptSyncData: true, records, seq: 0, enrolledAt: 1 });
    await switchMode({ transport, identity: id, crypto, target: "plaintext" });
    const plainKey = `${id.deviceId}/sessions-0.json`;
    const raw = await transport.get(plainKey);
    const shard = openShard<SessionExportPayload>(decodeShardFile(raw!), { signPublicKey: id.signPublicKey });
    expect(shard.records[0]!.value.messages[0]!.prompt_text).toBe("roundtrip");
  });
});

describe("compaction — owning device only", () => {
  it("folds multiple shards into one and deletes the old ones", async () => {
    const id = makeIdentity(DEVICE_ID);
    const crypto = makeCrypto();
    const mk = (sid: string, seq: number) =>
      buildSessionRecords([sessionRow(sid, sid)], () => [messageRow(`m-${sid}`, sid, sid)], {
        originDevice: id.deviceId,
        localSourceFiles: new Set([sid]),
        wallMs: 1,
        startCounter: seq,
      });
    await pushShard({ transport, identity: id, crypto, encryptSyncData: true, records: mk("s1", 0), seq: 0, enrolledAt: 1 });
    await pushShard({ transport, identity: id, crypto, encryptSyncData: true, records: mk("s2", 1), seq: 1, enrolledAt: 1 });

    const res = await compact({ transport, identity: id, crypto, encryptSyncData: true, enrolledAt: 1 });
    expect(res.compacted).toBe(true);
    expect(res.recordCount).toBe(2);
    expect(await transport.has(`${id.deviceId}/sessions-0.json.age`)).toBe(false);
    expect(await transport.has(`${id.deviceId}/sessions-1.json.age`)).toBe(false);
    expect(await transport.has(res.mergedShardKey!)).toBe(true);

    // Merged shard verifies + decrypts and carries both sessions.
    const raw = await transport.get(res.mergedShardKey!);
    const shard = openShard<SessionExportPayload>(decodeShardFile(raw!), { signPublicKey: id.signPublicKey, dek: crypto.dek });
    expect(shard.records.map((r) => r.value.session.session_id).sort()).toEqual(["s1", "s2"]);
  });

  it("refuses to compact another device's subtree", async () => {
    const id = makeIdentity(DEVICE_ID);
    const { assertOwningDevice } = await import("../../backup/index.js");
    expect(() => assertOwningDevice(assertDeviceId(OTHER_DEVICE), id)).toThrowError(/owning device/i);
  });
});
