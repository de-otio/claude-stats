import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, saveConfig, getCostThreshold, getPlanConfig } from "../config.js";
import os from "os";
import path from "path";
import fs from "fs";

function tmpConfigPath(): string {
  return path.join(os.tmpdir(), `cs-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe("loadConfig", () => {
  let configPath: string;

  afterEach(() => {
    try { fs.unlinkSync(configPath); } catch { /* ok */ }
  });

  it("returns {} when no file exists", () => {
    configPath = tmpConfigPath();
    const config = loadConfig(configPath);
    expect(config).toEqual({});
  });

  it("parses existing config file", () => {
    configPath = tmpConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ costThresholds: { day: 10 } }));
    const config = loadConfig(configPath);
    expect(config.costThresholds?.day).toBe(10);
  });

  it("throws on non-ENOENT errors (e.g., invalid JSON)", () => {
    configPath = tmpConfigPath();
    fs.writeFileSync(configPath, "not valid json{{{");
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe("saveConfig + loadConfig round-trip", () => {
  let configPath: string;

  afterEach(() => {
    try { fs.unlinkSync(configPath); } catch { /* ok */ }
  });

  it("saves and loads config correctly", () => {
    configPath = tmpConfigPath();
    const original = { costThresholds: { day: 10, week: 50, month: 200 } };
    saveConfig(original, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(original);
  });

  it("creates parent directories if needed", () => {
    const dir = path.join(os.tmpdir(), `cs-config-dir-${Date.now()}`);
    configPath = path.join(dir, "config.json");
    saveConfig({ costThresholds: { day: 5 } }, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.costThresholds?.day).toBe(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("getCostThreshold", () => {
  it("returns correct value for set period", () => {
    const config = { costThresholds: { day: 10, week: 50, month: 200 } };
    expect(getCostThreshold(config, "day")).toBe(10);
    expect(getCostThreshold(config, "week")).toBe(50);
    expect(getCostThreshold(config, "month")).toBe(200);
  });

  it("returns undefined for unset periods", () => {
    const config = { costThresholds: { day: 10 } };
    expect(getCostThreshold(config, "week")).toBeUndefined();
    expect(getCostThreshold(config, "month")).toBeUndefined();
  });

  it("returns undefined when no costThresholds configured", () => {
    const config = {};
    expect(getCostThreshold(config, "day")).toBeUndefined();
  });

  it("returns undefined for unknown period names", () => {
    const config = { costThresholds: { day: 10 } };
    expect(getCostThreshold(config, "year")).toBeUndefined();
  });
});

describe("getPlanConfig", () => {
  it("returns null when no plan config and no subscriptionType", () => {
    expect(getPlanConfig({})).toBeNull();
  });

  it("uses default fee for known plan types", () => {
    expect(getPlanConfig({ plan: { type: "pro" } })?.monthlyFee).toBe(20);
    expect(getPlanConfig({ plan: { type: "max" } })?.monthlyFee).toBe(100);
    expect(getPlanConfig({ plan: { type: "team" } })?.monthlyFee).toBe(200);
  });

  it("respects monthly_fee override", () => {
    const result = getPlanConfig({ plan: { type: "pro", monthly_fee: 25 } });
    expect(result?.monthlyFee).toBe(25);
    expect(result?.type).toBe("pro");
  });

  it("auto-detects plan from subscriptionType telemetry", () => {
    const result = getPlanConfig({}, "claude_pro");
    expect(result?.type).toBe("pro");
    expect(result?.monthlyFee).toBe(20);
  });

  it("auto-detects max plan from subscriptionType", () => {
    expect(getPlanConfig({}, "max")?.type).toBe("max");
  });

  it("config plan type takes precedence over subscriptionType", () => {
    const result = getPlanConfig({ plan: { type: "team" } }, "pro");
    expect(result?.type).toBe("team");
    expect(result?.monthlyFee).toBe(200);
  });

  it("returns null for unknown subscriptionType", () => {
    expect(getPlanConfig({}, "unknown_plan_xyz")).toBeNull();
  });

  it("custom plan type returns 0 default fee", () => {
    expect(getPlanConfig({ plan: { type: "custom" } })?.monthlyFee).toBe(0);
  });
});
