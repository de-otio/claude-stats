import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkThresholds } from "../alerts.js";
import { Store } from "../store/index.js";
import type { Config } from "../config.js";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-alerts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("checkThresholds", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns empty array when no thresholds configured", () => {
    const config: Config = {};
    const results = checkThresholds(store, config);
    expect(results).toEqual([]);
  });

  it("returns empty array when costThresholds is empty object", () => {
    const config: Config = { costThresholds: {} };
    const results = checkThresholds(store, config);
    expect(results).toEqual([]);
  });

  it("returns exceeded: true when cost exceeds threshold", () => {
    // Insert a session and messages with timestamps in the current day
    const now = Date.now();
    store.upsertSession({
      sessionId: "alert-sess-1",
      projectPath: "/proj/alert",
      sourceFile: "/proj/alert/alert-sess-1.jsonl",
      firstTimestamp: now,
      lastTimestamp: now + 1000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "main",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
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
        uuid: "alert-m1",
        sessionId: "alert-sess-1",
        timestamp: now,
        claudeVersion: "2.1.70",
        model: "claude-opus-4-6",
        stopReason: "end_turn",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
      },
    ]);

    // opus: 1M input = $15, 100K output = $7.50 → $22.50
    const config: Config = { costThresholds: { day: 5 } };
    const results = checkThresholds(store, config);

    expect(results).toHaveLength(1);
    expect(results[0]!.period).toBe("day");
    expect(results[0]!.exceeded).toBe(true);
    expect(results[0]!.currentCost).toBeCloseTo(22.5);
    expect(results[0]!.threshold).toBe(5);
    expect(results[0]!.percentage).toBeGreaterThan(100);
  });

  it("returns correct percentage when under threshold", () => {
    const now = Date.now();
    store.upsertSession({
      sessionId: "alert-sess-2",
      projectPath: "/proj/alert2",
      sourceFile: "/proj/alert2/alert-sess-2.jsonl",
      firstTimestamp: now,
      lastTimestamp: now + 1000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "main",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["claude-sonnet-4-6"],
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
        uuid: "alert-m2",
        sessionId: "alert-sess-2",
        timestamp: now,
        claudeVersion: "2.1.70",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
      },
    ]);

    // sonnet: 100K input = $0.30, 10K output = $0.15 → $0.45
    const config: Config = { costThresholds: { day: 50 } };
    const results = checkThresholds(store, config);

    expect(results).toHaveLength(1);
    expect(results[0]!.exceeded).toBe(false);
    expect(results[0]!.currentCost).toBeCloseTo(0.45);
    expect(results[0]!.percentage).toBeCloseTo(0.9);
  });

  it("handles unknown models gracefully (cost stays 0 for unknown)", () => {
    const now = Date.now();
    store.upsertSession({
      sessionId: "alert-sess-unk",
      projectPath: "/proj/alert-unk",
      sourceFile: "/proj/alert-unk/alert-sess-unk.jsonl",
      firstTimestamp: now,
      lastTimestamp: now + 1000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "main",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["mystery-model"],
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
        uuid: "alert-m-unk",
        sessionId: "alert-sess-unk",
        timestamp: now,
        claudeVersion: "2.1.70",
        model: "mystery-model",
        stopReason: "end_turn",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
      },
    ]);

    const config: Config = { costThresholds: { day: 5 } };
    const results = checkThresholds(store, config);
    expect(results).toHaveLength(1);
    // Unknown model contributes $0 cost
    expect(results[0]!.currentCost).toBe(0);
    expect(results[0]!.exceeded).toBe(false);
  });

  it("checks multiple periods independently", () => {
    const config: Config = { costThresholds: { day: 10, week: 50, month: 200 } };
    // No data in store, so all costs should be 0
    const results = checkThresholds(store, config);

    expect(results).toHaveLength(3);
    expect(results[0]!.period).toBe("day");
    expect(results[1]!.period).toBe("week");
    expect(results[2]!.period).toBe("month");

    for (const r of results) {
      expect(r.currentCost).toBe(0);
      expect(r.exceeded).toBe(false);
      expect(r.percentage).toBe(0);
    }
  });
});
