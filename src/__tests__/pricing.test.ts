import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupPricing, estimateCost, formatCost, lookupPlanFee } from "../pricing.js";
import { printSummary } from "../reporter/index.js";
import { Store } from "../store/index.js";
import os from "os";
import path from "path";
import fs from "fs";

// ── lookupPricing ────────────────────────────────────────────────────────────

describe("lookupPricing", () => {
  it("matches claude-opus-4-6 exactly", () => {
    const p = lookupPricing("claude-opus-4-6");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(5);
    expect(p!.outputPerMillion).toBe(25);
  });

  it("matches claude-opus-4 (legacy) with correct pricing", () => {
    const p = lookupPricing("claude-opus-4-20250514");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(15);
    expect(p!.outputPerMillion).toBe(75);
  });

  it("matches claude-sonnet-4-6 exactly", () => {
    const p = lookupPricing("claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(3);
    expect(p!.outputPerMillion).toBe(15);
  });

  it("matches claude-haiku-4-5 exactly", () => {
    const p = lookupPricing("claude-haiku-4-5");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(1);
  });

  it("matches claude-3-5-sonnet-20241022 to claude-3-5-sonnet entry", () => {
    const p = lookupPricing("claude-3-5-sonnet-20241022");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(3);
  });

  it("returns null for unknown model", () => {
    expect(lookupPricing("unknown-model")).toBeNull();
    expect(lookupPricing("gpt-4o")).toBeNull();
  });
});

// ── estimateCost ─────────────────────────────────────────────────────────────

describe("estimateCost", () => {
  it("computes cost for 1M input tokens on opus 4.6", () => {
    const result = estimateCost("claude-opus-4-6", 1_000_000, 0, 0, 0);
    expect(result.known).toBe(true);
    expect(result.cost).toBe(5);
  });

  it("computes cost for 1M output tokens on opus 4.6", () => {
    const result = estimateCost("claude-opus-4-6", 0, 1_000_000, 0, 0);
    expect(result.known).toBe(true);
    expect(result.cost).toBe(25);
  });

  it("computes cost for cache tokens on sonnet", () => {
    const result = estimateCost("claude-sonnet-4-6", 0, 0, 1_000_000, 1_000_000);
    expect(result.known).toBe(true);
    expect(result.cost).toBeCloseTo(0.3 + 3.75);
  });

  it("combines all token types on opus 4.6", () => {
    const result = estimateCost("claude-opus-4-6", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(result.known).toBe(true);
    // $5 input + $25 output + $0.50 cache read + $6.25 cache write
    expect(result.cost).toBeCloseTo(5 + 25 + 0.50 + 6.25);
  });

  it("returns zero cost and known=false for unknown model", () => {
    const result = estimateCost("unknown-model", 1_000_000, 1_000_000, 0, 0);
    expect(result.known).toBe(false);
    expect(result.cost).toBe(0);
  });

  it("returns zero cost for zero tokens", () => {
    const result = estimateCost("claude-opus-4-6", 0, 0, 0, 0);
    expect(result.known).toBe(true);
    expect(result.cost).toBe(0);
  });
});

// ── formatCost ───────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats small amounts", () => {
    expect(formatCost(1.23)).toBe("$1.23");
  });

  it("formats large amounts with comma separators", () => {
    expect(formatCost(1234.56)).toBe("$1,234.56");
  });

  it("rounds to two decimal places", () => {
    expect(formatCost(0.001)).toBe("$0.00");
    expect(formatCost(0.005)).toBe("$0.01");
  });
});

// ── lookupPlanFee ────────────────────────────────────────────────────────────

describe("lookupPlanFee", () => {
  it("returns fee for exact match", () => {
    expect(lookupPlanFee("pro")).toBe(20);
    expect(lookupPlanFee("max_5x")).toBe(100);
    expect(lookupPlanFee("max_20x")).toBe(200);
    expect(lookupPlanFee("team")).toBe(25);
    expect(lookupPlanFee("team_standard")).toBe(25);
    expect(lookupPlanFee("team_premium")).toBe(125);
  });

  it("normalizes case and separators", () => {
    expect(lookupPlanFee("Pro")).toBe(20);
    expect(lookupPlanFee("MAX-5X")).toBe(100);
    expect(lookupPlanFee("Max 20x")).toBe(200);
    expect(lookupPlanFee("Team-Premium")).toBe(125);
  });

  it("matches by prefix for variants", () => {
    expect(lookupPlanFee("pro_annual")).toBe(20);
    expect(lookupPlanFee("max_5x_monthly")).toBe(100);
    expect(lookupPlanFee("team_premium_annual")).toBe(125);
  });

  it("returns null for unknown types", () => {
    expect(lookupPlanFee("enterprise")).toBeNull();
    expect(lookupPlanFee("free")).toBeNull();
    expect(lookupPlanFee("")).toBeNull();
    expect(lookupPlanFee(null)).toBeNull();
  });
});

// ── Reporter cost line ───────────────────────────────────────────────────────

describe("printSummary cost line", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-pricing-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("shows Cost line with known model", () => {
    store.upsertSession({
      sessionId: "cost-sess-1",
      projectPath: "/proj/cost",
      sourceFile: "/proj/cost/cost-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "main",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 2,
      assistantMessageCount: 2,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["claude-opus-4-6"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    store.upsertMessages([
      {
        uuid: "m-cost-1",
        sessionId: "cost-sess-1",
        timestamp: 1_700_000_000_000,
        claudeVersion: "2.1.70",
        model: "claude-opus-4-6",
        stopReason: "end_turn",
        inputTokens: 500_000,
        outputTokens: 50_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: null,
      },
      {
        uuid: "m-cost-2",
        sessionId: "cost-sess-1",
        timestamp: 1_700_000_050_000,
        claudeVersion: "2.1.70",
        model: "claude-opus-4-6",
        stopReason: "end_turn",
        inputTokens: 500_000,
        outputTokens: 50_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: null,
      },
    ]);

    printSummary(store, { timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(
      c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []
    );
    const costCall = calls.find(s => s.includes("Cost"));
    expect(costCall).toBeDefined();
    expect(costCall).toContain("equivalent API cost");
    // 1M input on opus 4.6 = $5, 100K output = $2.50 → $7.50
    expect(costCall).toContain("$7.50");
  });

  it("shows unknown model warning when model is not in pricing table", () => {
    store.upsertSession({
      sessionId: "cost-sess-2",
      projectPath: "/proj/cost2",
      sourceFile: "/proj/cost2/cost-sess-2.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["mystery-model-9"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    store.upsertMessages([
      {
        uuid: "m-cost-3",
        sessionId: "cost-sess-2",
        timestamp: 1_700_000_000_000,
        claudeVersion: "2.1.70",
        model: "mystery-model-9",
        stopReason: "end_turn",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: null,
      },
    ]);

    printSummary(store, { timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(
      c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []
    );
    const costCall = calls.find(s => s.includes("Cost"));
    expect(costCall).toBeDefined();
    expect(costCall).toContain("unknown models excluded");
  });
});
