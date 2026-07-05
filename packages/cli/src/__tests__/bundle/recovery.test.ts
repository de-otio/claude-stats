/**
 * B3 regression: second-device / disaster recovery from the recovery key ALONE.
 *
 * Before manifest format v2 this was architecturally impossible — the KDF
 * salt/params and passphrase-wrapped DEK lived inside the DEK-sealed body, so a
 * fresh device holding only the recovery key could not bootstrap the DEK to open
 * the very body that held the material it needed (chicken-and-egg). v2 moves that
 * bootstrap material into the manifest's PLAINTEXT, signature-covered key
 * envelope. These tests pin the property end-to-end:
 *
 *   1. a device with ONLY the recovery key + the on-store manifest bytes recovers
 *      the exact DEK and reads the sealed index,
 *   2. it then enrolls itself as a trusted device,
 *   3. a wrong recovery key fails cleanly (never a silent wrong DEK), and
 *   4. tampering the plaintext key envelope is caught by the signature.
 *
 * Fixtures are synthetic (fake hex device ids, IETF-reserved example paths).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateRecoveryKey, generateSignKeyPair, generateWrapKeyPair, normalizeRecoverySecret } from "@claude-stats/core/crypto/keys";
import type { Argon2idParams } from "@claude-stats/core/crypto/types";
import { assertDeviceId, type DeviceId } from "@claude-stats/core/types/shard";
import { decodeManifest, encodeManifest, MANIFEST_FORMAT_VERSION, openManifest } from "@claude-stats/core/bundle";

import {
  DirectoryStorageTransport,
  bootstrapBackupCrypto,
  buildSessionRecords,
  ensureDevice,
  loadOrSeedBody,
  pushShard,
  recoverBackupCrypto,
  writeManifest,
  MANIFEST_KEY,
  type DeviceIdentity,
} from "../../backup/index.js";
import type { MessageRow, SessionRow } from "../../store/index.js";

// Fast, memory-light Argon2id so the memory-hard derivation doesn't dominate.
const TEST_ARGON: Argon2idParams = { memoryKiB: 256, iterations: 1, parallelism: 1, keyLengthBytes: 32 };
const DEVICE_A = "deadbeefcafe0001";
const DEVICE_B = "deadbeefcafe0002";

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

function sessionRow(id: string): SessionRow {
  return {
    session_id: id,
    project_path: "/home/example/proj",
    source_file: id,
    first_timestamp: 1_700_000_000_000,
    last_timestamp: 1_700_000_100_000,
    claude_version: "1.0.0",
    entrypoint: "cli",
    git_branch: null,
    is_interactive: 1,
    prompt_count: 1,
    assistant_message_count: 1,
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

function messageRow(uuid: string, sessionId: string): MessageRow {
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
    prompt_text: "hi",
  } as MessageRow;
}

let root: string;
let transport: DirectoryStorageTransport;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-recovery-"));
  transport = new DirectoryStorageTransport(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Device A creates a bundle (fresh DEK wrapped to `recoveryKey`) and pushes one shard. */
async function seedBundle(recoverySecret: Uint8Array): Promise<{ deviceA: DeviceIdentity; dekA: Uint8Array }> {
  const deviceA = makeIdentity(DEVICE_A);
  const crypto = bootstrapBackupCrypto(recoverySecret, TEST_ARGON);
  const records = buildSessionRecords([sessionRow("s1")], () => [messageRow("m1", "s1")], {
    originDevice: deviceA.deviceId,
    localSourceFiles: new Set(["s1"]),
    wallMs: 1,
    startCounter: 0,
  });
  await pushShard({ transport, identity: deviceA, crypto, encryptSyncData: true, records, seq: 0, enrolledAt: 1 });
  return { deviceA, dekA: crypto.dek };
}

describe("manifest v2 — recovery from the recovery key alone (B3)", () => {
  it("pins the wire-format version at 2 (bootstrap material moved to the plaintext envelope)", () => {
    expect(MANIFEST_FORMAT_VERSION).toBe(2);
  });

  it("a fresh device with ONLY the recovery key recovers the DEK and reads the sealed index", async () => {
    const recoveryKey = generateRecoveryKey();
    const secret = normalizeRecoverySecret(recoveryKey.key);
    const { deviceA, dekA } = await seedBundle(secret);

    // ── Device B: holds the recovery key and can read the manifest BYTES only. ──
    const raw = await transport.get(MANIFEST_KEY);
    expect(raw).not.toBeNull();
    const manifest = decodeManifest(raw!);
    expect(manifest.header.formatVersion).toBe(2);

    // The recovery key alone bootstraps the exact same DEK — no prior device access.
    const cryptoB = recoverBackupCrypto(manifest, secret);
    expect(cryptoB.dek).toEqual(dekA);

    // With the recovered DEK, device B opens the sealed body and sees the index.
    const body = openManifest(manifest, { dek: cryptoB.dek });
    expect(body.files.map((f) => f.path)).toContain(`${deviceA.deviceId}/sessions-0.json.age`);
    expect(body.devices.map((d) => d.deviceId)).toContain(deviceA.deviceId);
  }, 30_000);

  it("device B enrolls itself so both devices are trusted going forward", async () => {
    const secret = normalizeRecoverySecret(generateRecoveryKey().key);
    const { deviceA } = await seedBundle(secret);

    const cryptoB = recoverBackupCrypto(decodeManifest((await transport.get(MANIFEST_KEY))!), secret);
    const deviceB = makeIdentity(DEVICE_B);
    let body = await loadOrSeedBody(transport, cryptoB);
    body = ensureDevice(body, deviceB, cryptoB, 2);
    await writeManifest(transport, body, deviceB, cryptoB);

    // Re-open: both devices are enrolled; the envelope still recovers the DEK.
    const reopened = decodeManifest((await transport.get(MANIFEST_KEY))!);
    const cryptoB2 = recoverBackupCrypto(reopened, secret);
    const finalBody = openManifest(reopened, { dek: cryptoB2.dek });
    expect(finalBody.devices.map((d) => d.deviceId).sort()).toEqual(
      [deviceA.deviceId, deviceB.deviceId].sort(),
    );
  }, 30_000);

  it("a WRONG recovery key fails cleanly and never returns a wrong DEK", async () => {
    const secret = normalizeRecoverySecret(generateRecoveryKey().key);
    await seedBundle(secret);
    const wrong = normalizeRecoverySecret(generateRecoveryKey().key);
    const manifest = decodeManifest((await transport.get(MANIFEST_KEY))!);
    expect(() => recoverBackupCrypto(manifest, wrong)).toThrow();
  }, 30_000);

  it("tampering the plaintext key envelope is caught by the manifest signature", async () => {
    const secret = normalizeRecoverySecret(generateRecoveryKey().key);
    const { deviceA, dekA } = await seedBundle(secret);
    const manifest = decodeManifest((await transport.get(MANIFEST_KEY))!);

    // Flip a byte of the (plaintext) passphrase-wrapped DEK: the signature covers
    // the key envelope, so an external-key open must reject it.
    const tamperedWrap = Uint8Array.from(manifest.keyEnvelope.passphraseWrappedDek);
    tamperedWrap[0] = tamperedWrap[0]! ^ 0xff;
    const tampered = {
      ...manifest,
      keyEnvelope: { ...manifest.keyEnvelope, passphraseWrappedDek: tamperedWrap },
    };
    // Re-encode/decode to prove the tamper survives the wire, not just in-memory.
    const roundTripped = decodeManifest(encodeManifest(tampered));
    expect(() => openManifest(roundTripped, { dek: dekA, signPublicKey: deviceA.signPublicKey })).toThrowError(
      /verify/i,
    );
  }, 30_000);
});
