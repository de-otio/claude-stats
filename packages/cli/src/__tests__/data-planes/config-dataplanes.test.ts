import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  mergeConfig,
  validateArchiveConfig,
  validateBackupConfig,
  loadConfig,
  saveConfig,
  type Config,
} from "../../config.js";

describe("validateArchiveConfig", () => {
  it("keeps a well-formed enabled + retentionDays", () => {
    expect(validateArchiveConfig({ enabled: true, retentionDays: 90 })).toEqual({
      enabled: true,
      retentionDays: 90,
    });
  });

  it("drops non-boolean enabled and out-of-range / non-finite retentionDays", () => {
    expect(validateArchiveConfig({ enabled: "yes", retentionDays: 0 })).toEqual({});
    expect(validateArchiveConfig({ retentionDays: -5 })).toEqual({});
    expect(validateArchiveConfig({ retentionDays: Number.NaN })).toEqual({});
    expect(validateArchiveConfig({ retentionDays: 999_999 })).toEqual({});
  });

  it("floors a fractional retentionDays", () => {
    expect(validateArchiveConfig({ retentionDays: 30.9 }).retentionDays).toBe(30);
  });

  it("ignores non-object input", () => {
    expect(validateArchiveConfig(null)).toEqual({});
    expect(validateArchiveConfig("nope")).toEqual({});
  });
});

describe("validateBackupConfig", () => {
  it("keeps a bounded, NUL-free target and present encryption booleans", () => {
    expect(
      validateBackupConfig({ target: "/tmp/backup", encryption: { syncData: true, archive: false } }),
    ).toEqual({ target: "/tmp/backup", encryption: { syncData: true, archive: false } });
  });

  it("drops an empty, over-long, or NUL-bearing target", () => {
    expect(validateBackupConfig({ target: "" }).target).toBeUndefined();
    expect(validateBackupConfig({ target: "x".repeat(5000) }).target).toBeUndefined();
    expect(validateBackupConfig({ target: "/tmp/a\0b" }).target).toBeUndefined();
  });

  it("carries only the encryption booleans actually present (partial update)", () => {
    expect(validateBackupConfig({ encryption: { syncData: true } })).toEqual({
      encryption: { syncData: true },
    });
    expect(validateBackupConfig({ encryption: { archive: "yes" } })).toEqual({ encryption: {} });
  });

  it("ignores non-object input", () => {
    expect(validateBackupConfig(null)).toEqual({});
    expect(validateBackupConfig(42)).toEqual({});
  });
});

describe("mergeConfig — archive/backup", () => {
  it("allow-lists archive + backup and validates during merge", () => {
    const merged = mergeConfig(
      {},
      { archive: { enabled: true, retentionDays: 60 }, backup: { target: "/tmp/b" } },
    );
    expect(merged.archive).toEqual({ enabled: true, retentionDays: 60 });
    expect(merged.backup?.target).toBe("/tmp/b");
  });

  it("shallow-merges archive so a partial write keeps siblings", () => {
    const current: Config = { archive: { enabled: true, retentionDays: 30 } };
    const merged = mergeConfig(current, { archive: { retentionDays: 45 } });
    expect(merged.archive).toEqual({ enabled: true, retentionDays: 45 });
  });

  it("nested-merges backup.encryption so setting one class doesn't wipe the other", () => {
    const current: Config = { backup: { target: "/t", encryption: { syncData: true, archive: true } } };
    const merged = mergeConfig(current, { backup: { encryption: { archive: false } } });
    expect(merged.backup).toEqual({ target: "/t", encryption: { syncData: true, archive: false } });
  });

  it("drops a hostile retentionDays but keeps the valid enabled flag", () => {
    const merged = mergeConfig({}, { archive: { enabled: false, retentionDays: -1 } });
    expect(merged.archive).toEqual({ enabled: false });
  });
});

describe("archive/backup config round-trip", () => {
  let configPath: string;
  afterEach(() => {
    try {
      fs.unlinkSync(configPath);
    } catch {
      /* ok */
    }
  });

  it("persists and reloads archive + backup", () => {
    configPath = path.join(os.tmpdir(), `cs-dp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cfg: Config = {
      archive: { enabled: true, retentionDays: 120 },
      backup: { target: "/tmp/bundle", encryption: { syncData: true, archive: true } },
    };
    saveConfig(cfg, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.archive?.retentionDays).toBe(120);
    expect(loaded.backup?.encryption?.syncData).toBe(true);
  });
});
