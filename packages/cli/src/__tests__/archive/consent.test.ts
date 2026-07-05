/**
 * Consent gating — the archive is OFF unless explicitly opted in, and collect
 * is a no-op for the archive when disabled.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isArchiveEnabled,
  archiveRetentionDays,
  validateArchiveConfig,
  mergeConfig,
  type Config,
} from "../../config.js";
import { archiveDuringCollect, pruneDuringCollect } from "../../archive/index.js";
import { mirrorFilePath } from "../../archive/paths.js";

let tmp: string;
let archiveRoot: string;
let sourcePath: string;

const PROJECT_DIR = "-Users-alice-repos-example";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-consent-"));
  archiveRoot = path.join(tmp, "archive");
  sourcePath = path.join(tmp, "source.jsonl");
  fs.writeFileSync(
    sourcePath,
    JSON.stringify({ sessionId: SESSION_ID, timestamp: new Date().toISOString() }) + "\n",
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function input() {
  return {
    sourceFilePath: sourcePath,
    projectDirName: PROJECT_DIR,
    sessionId: SESSION_ID,
    mode: "new" as const,
    lastGoodOffset: fs.statSync(sourcePath).size,
  };
}

describe("isArchiveEnabled", () => {
  it("defaults OFF for empty / absent config", () => {
    expect(isArchiveEnabled({})).toBe(false);
    expect(isArchiveEnabled({ archive: {} })).toBe(false);
    expect(isArchiveEnabled({ archive: { enabled: false } })).toBe(false);
  });
  it("is ON only for enable === true", () => {
    expect(isArchiveEnabled({ archive: { enabled: true } })).toBe(true);
  });
});

describe("archiveDuringCollect — consent gate", () => {
  it("no-ops (returns null) and writes nothing when disabled", () => {
    const res = archiveDuringCollect({}, input(), archiveRoot);
    expect(res).toBeNull();
    expect(fs.existsSync(mirrorFilePath(archiveRoot, PROJECT_DIR, SESSION_ID))).toBe(false);
  });

  it("mirrors when enabled", () => {
    const cfg: Config = { archive: { enabled: true } };
    const res = archiveDuringCollect(cfg, input(), archiveRoot);
    expect(res).not.toBeNull();
    expect(res!.bytesWritten).toBeGreaterThan(0);
    expect(fs.existsSync(mirrorFilePath(archiveRoot, PROJECT_DIR, SESSION_ID))).toBe(true);
  });

  it("pruneDuringCollect no-ops when disabled", () => {
    expect(pruneDuringCollect({}, archiveRoot, () => Date.now())).toBeNull();
  });
});

describe("archiveRetentionDays", () => {
  it("applies default and clamps", () => {
    expect(archiveRetentionDays({})).toBe(90);
    expect(archiveRetentionDays({ archive: { enabled: true, retentionDays: 0 } })).toBe(1);
    expect(archiveRetentionDays({ archive: { enabled: true, retentionDays: 10_000 } })).toBe(3650);
    expect(archiveRetentionDays({ archive: { enabled: true, retentionDays: 30 } })).toBe(30);
  });
});

describe("validateArchiveConfig + mergeConfig", () => {
  it("keeps only a boolean `enabled`; non-boolean is dropped (never opts in)", () => {
    expect(validateArchiveConfig({ enabled: "yes" })).toEqual({});
    expect(validateArchiveConfig({ enabled: 1 })).toEqual({});
    expect(validateArchiveConfig({ enabled: true })).toEqual({ enabled: true });
    expect(validateArchiveConfig({ enabled: false })).toEqual({ enabled: false });
  });
  it("keeps only in-range retentionDays; out-of-range and empty are dropped", () => {
    expect(validateArchiveConfig({ retentionDays: 45 })).toEqual({ retentionDays: 45 });
    expect(validateArchiveConfig({ retentionDays: 999999 })).toEqual({});
    expect(validateArchiveConfig({ retentionDays: -5 })).toEqual({});
    expect(validateArchiveConfig({})).toEqual({});
    expect(validateArchiveConfig("nope")).toEqual({});
  });
  it("mergeConfig only accepts the validated archive block", () => {
    const merged = mergeConfig({}, { archive: { enabled: true, retentionDays: 45 } });
    expect(merged.archive).toEqual({ enabled: true, retentionDays: 45 });
    // A hostile enabled value is dropped by validation, never opting in.
    const merged2 = mergeConfig({}, { archive: { enabled: "true" } });
    expect(merged2.archive).toEqual({});
  });
});
