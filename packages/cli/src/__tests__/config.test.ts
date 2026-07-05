import { describe, it, expect, afterEach } from "vitest";
import {
  loadConfig,
  saveConfig,
  getCostThreshold,
  getPlanConfig,
  validateAccountFees,
  mergeConfig,
  resolveAccountFee,
  buildAccountsForConfig,
  redactConfigForHttp,
  type Config,
} from "../config.js";
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
    expect(getPlanConfig({ plan: { type: "max_5x" } })?.monthlyFee).toBe(100);
    expect(getPlanConfig({ plan: { type: "max_20x" } })?.monthlyFee).toBe(200);
    expect(getPlanConfig({ plan: { type: "team_standard" } })?.monthlyFee).toBe(25);
    expect(getPlanConfig({ plan: { type: "team_premium" } })?.monthlyFee).toBe(125);
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
    expect(getPlanConfig({}, "max")?.type).toBe("max_5x");
    expect(getPlanConfig({}, "max_5x")?.type).toBe("max_5x");
    expect(getPlanConfig({}, "max_20x")?.type).toBe("max_20x");
  });

  it("config plan type takes precedence over subscriptionType", () => {
    const result = getPlanConfig({ plan: { type: "team_standard" } }, "pro");
    expect(result?.type).toBe("team_standard");
    expect(result?.monthlyFee).toBe(25);
  });

  it("returns null for unknown subscriptionType", () => {
    expect(getPlanConfig({}, "unknown_plan_xyz")).toBeNull();
  });

  it("custom plan type returns 0 default fee", () => {
    expect(getPlanConfig({ plan: { type: "custom" } })?.monthlyFee).toBe(0);
  });
});

describe("validateAccountFees", () => {
  const UUID = "3f9a1c2e-aaaa-bbbb-cccc-0123456789ab";

  it("accepts a well-formed entry and resolves currency default", () => {
    const out = validateAccountFees({ [UUID]: { monthlyFee: 125, currency: "EUR", label: "Work" } });
    expect(out[UUID]).toEqual({ monthlyFee: 125, currency: "EUR", label: "Work" });
  });

  it("rejects prototype-polluting keys", () => {
    const out = validateAccountFees({ __proto__: { monthlyFee: 1 }, constructor: { monthlyFee: 2 }, prototype: { monthlyFee: 3 } });
    expect(Object.keys(out)).toHaveLength(0);
    // Prototype is untouched.
    expect(({} as Record<string, unknown>).monthlyFee).toBeUndefined();
  });

  it("drops non-finite, negative, and over-ceiling fees", () => {
    expect(validateAccountFees({ [UUID]: { monthlyFee: Number.NaN } })[UUID]).toBeUndefined();
    expect(validateAccountFees({ [UUID]: { monthlyFee: Number.POSITIVE_INFINITY } })[UUID]).toBeUndefined();
    expect(validateAccountFees({ [UUID]: { monthlyFee: -5 } })[UUID]).toBeUndefined();
    expect(validateAccountFees({ [UUID]: { monthlyFee: 1_000_000 } })[UUID]).toBeUndefined();
  });

  it("drops bad currency to undefined and truncates long labels", () => {
    const out = validateAccountFees({ [UUID]: { monthlyFee: 10, currency: "euros", label: "x".repeat(500) } });
    expect(out[UUID]!.currency).toBeUndefined();
    expect(out[UUID]!.label!.length).toBe(100);
  });

  it("caps the number of entries at 50", () => {
    const input: Record<string, { monthlyFee: number }> = {};
    for (let i = 0; i < 80; i++) input[`abcdef${i.toString().padStart(4, "0")}aa`] = { monthlyFee: 1 };
    expect(Object.keys(validateAccountFees(input)).length).toBeLessThanOrEqual(50);
  });

  it("ignores non-object input", () => {
    expect(validateAccountFees(null)).toEqual({});
    expect(validateAccountFees("nope")).toEqual({});
  });

  it("keeps a valid per-account plan type alongside the explicit fee", () => {
    const out = validateAccountFees({ [UUID]: { type: "max_20x", monthlyFee: 200, currency: "USD" } });
    expect(out[UUID]).toEqual({ type: "max_20x", monthlyFee: 200, currency: "USD" });
  });

  it("derives the default fee from a non-custom type when the amount is missing", () => {
    const out = validateAccountFees({ [UUID]: { type: "team_premium" } });
    expect(out[UUID]).toEqual({ type: "team_premium", monthlyFee: 125 });
  });

  it("drops an invalid plan type but keeps the entry when a fee is present", () => {
    const out = validateAccountFees({ [UUID]: { type: "platinum", monthlyFee: 99 } });
    expect(out[UUID]).toEqual({ monthlyFee: 99 });
  });

  it("drops a row with a custom/auto type and no fee (no implied default)", () => {
    expect(validateAccountFees({ [UUID]: { type: "custom" } })[UUID]).toBeUndefined();
    expect(validateAccountFees({ [UUID]: {} })[UUID]).toBeUndefined();
  });
});

describe("mergeConfig", () => {
  const UUID = "3f9a1c2e-aaaa-bbbb-cccc-0123456789ab";

  it("only copies allow-listed top-level keys (no injection)", () => {
    const merged = mergeConfig({}, { plan: { type: "pro" }, evil_key: "payload" } as unknown);
    expect((merged as Record<string, unknown>).evil_key).toBeUndefined();
    expect(merged.plan?.type).toBe("pro");
  });

  it("shallow-merges accountFees without clobbering siblings", () => {
    const current: Config = { accountFees: { [UUID]: { monthlyFee: 125 } } };
    const OTHER = "99999999-aaaa-bbbb-cccc-0123456789ab";
    const merged = mergeConfig(current, { accountFees: { [OTHER]: { monthlyFee: 214 } } });
    expect(merged.accountFees?.[UUID]?.monthlyFee).toBe(125);
    expect(merged.accountFees?.[OTHER]?.monthlyFee).toBe(214);
  });

  it("validates accountFees during merge", () => {
    const merged = mergeConfig({}, { accountFees: { __proto__: { monthlyFee: 1 }, [UUID]: { monthlyFee: -1 } } });
    expect(Object.keys(merged.accountFees ?? {})).toHaveLength(0);
  });

  it("floors autoRefreshSeconds to the 60s minimum", () => {
    expect(mergeConfig({}, { autoRefreshSeconds: 5 }).autoRefreshSeconds).toBe(60);
    expect(mergeConfig({}, { autoRefreshSeconds: 90 }).autoRefreshSeconds).toBe(90);
  });

  it("ignores a non-numeric autoRefreshSeconds", () => {
    const merged = mergeConfig({}, { autoRefreshSeconds: "fast" } as unknown);
    expect(merged.autoRefreshSeconds).toBeUndefined();
  });
});

describe("resolveAccountFee", () => {
  const UUID = "3f9a1c2e-aaaa-bbbb-cccc-0123456789ab";

  it("prefers an explicit per-account fee in its own currency", () => {
    const cfg: Config = { accountFees: { [UUID]: { monthlyFee: 214, currency: "EUR" } } };
    expect(resolveAccountFee(cfg, UUID, "max_20x", 2)).toEqual({ monthlyFee: 214, currency: "EUR" });
  });

  it("falls back to plan.monthly_fee only for a single account", () => {
    const cfg: Config = { plan: { monthly_fee: 99 } };
    expect(resolveAccountFee(cfg, UUID, null, 1)).toEqual({ monthlyFee: 99, currency: "USD" });
    expect(resolveAccountFee(cfg, UUID, null, 2)).toBeNull();
  });

  it("falls back to the subscription-type default", () => {
    expect(resolveAccountFee({}, UUID, "max_5x", 2)).toEqual({ monthlyFee: 100, currency: "USD" });
  });

  it("returns null when nothing is known", () => {
    expect(resolveAccountFee({}, UUID, null, 2)).toBeNull();
  });
});

describe("buildAccountsForConfig", () => {
  const accounts = [
    { accountUuid: "aaaa1111", subscriptionType: "max_20x", sessionCount: 10 },
    { accountUuid: "bbbb2222", subscriptionType: null, sessionCount: 3 },
  ];

  it("includes the current account's email only when allowed", () => {
    const out = buildAccountsForConfig(accounts, { accountUuid: "aaaa1111", emailAddress: "you@example.com" }, true);
    expect(out[0]!.email).toBe("you@example.com");
    expect(out[1]!.email).toBeNull();
  });

  it("omits email entirely when includeEmail is false (HTTP path)", () => {
    const out = buildAccountsForConfig(accounts, { accountUuid: "aaaa1111", emailAddress: "you@example.com" }, false);
    expect(out.every((a) => a.email === null)).toBe(true);
  });

  it("falls back to the persisted emailLabel for a non-current account", () => {
    const fullAccounts = [
      { accountUuid: "aaaa1111", subscriptionType: "max_20x", emailLabel: "stale@example.com" },
      { accountUuid: "bbbb2222", subscriptionType: "team_premium", emailLabel: "teammate@example.com" },
    ];
    const out = buildAccountsForConfig(
      accounts,
      { accountUuid: "aaaa1111", emailAddress: "you@example.com" },
      true,
      fullAccounts,
    );
    // Current account: live email wins over its own stale persisted label.
    expect(out[0]!.email).toBe("you@example.com");
    // Non-current account: persisted emailLabel is used instead of null.
    expect(out[1]!.email).toBe("teammate@example.com");
  });

  it("never leaks a persisted emailLabel when includeEmail is false", () => {
    const fullAccounts = [{ accountUuid: "bbbb2222", subscriptionType: "team_premium", emailLabel: "teammate@example.com" }];
    const out = buildAccountsForConfig(
      accounts,
      { accountUuid: "aaaa1111", emailAddress: "you@example.com" },
      false,
      fullAccounts,
    );
    expect(out.every((a) => a.email === null)).toBe(true);
  });
});

describe("redactConfigForHttp", () => {
  it("strips the llmJudge apiKey", () => {
    const cfg: Config = { llmJudge: { enabled: true, apiKey: "secret-123", endpoint: "http://x", model: "m" } };
    expect(redactConfigForHttp(cfg).llmJudge?.apiKey).toBeUndefined();
    expect(redactConfigForHttp(cfg).llmJudge?.endpoint).toBe("http://x");
    // original untouched
    expect(cfg.llmJudge?.apiKey).toBe("secret-123");
  });

  it("returns the config unchanged when there is no apiKey", () => {
    const cfg: Config = { plan: { type: "pro" } };
    expect(redactConfigForHttp(cfg)).toBe(cfg);
  });
});

describe("accountFees round-trip", () => {
  let configPath: string;
  afterEach(() => { try { fs.unlinkSync(configPath); } catch { /* ok */ } });

  it("persists and reloads accountFees", () => {
    configPath = path.join(os.tmpdir(), `cs-fee-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cfg: Config = { accountFees: { "3f9a1c2e-aaaa": { monthlyFee: 125, currency: "EUR", label: "Work" } } };
    saveConfig(cfg, configPath);
    expect(loadConfig(configPath).accountFees?.["3f9a1c2e-aaaa"]?.monthlyFee).toBe(125);
  });
});
