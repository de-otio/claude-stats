import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import type { SessionRecord, MessageRecord } from "../types.js";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-dash-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "dash-sess-1",
    projectPath: "/Users/alice/repos/myproject",
    sourceFile: "/Users/alice/.claude/projects/myproject/dash-sess-1.jsonl",
    firstTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_300_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 5,
    assistantMessageCount: 5,
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheCreationTokens: 500,
    cacheReadTokens: 8_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [{ name: "Read", count: 10 }],
    models: ["claude-sonnet-4"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid: "dash-msg-1",
    sessionId: "dash-sess-1",
    timestamp: 1_700_000_000_000,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "end_turn",
    inputTokens: 5_000,
    outputTokens: 1_000,
    cacheCreationTokens: 250,
    cacheReadTokens: 4_000,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    ...overrides,
  };
}

describe("buildDashboard — empty store", () => {
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

  it("returns zero-valued summary with empty store", () => {
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.summary.sessions).toBe(0);
    expect(data.summary.prompts).toBe(0);
    expect(data.summary.inputTokens).toBe(0);
    expect(data.summary.outputTokens).toBe(0);
    expect(data.summary.cacheReadTokens).toBe(0);
    expect(data.summary.cacheCreationTokens).toBe(0);
    expect(data.summary.cacheEfficiency).toBe(0);
    expect(data.summary.estimatedCost).toBe(0);
    expect(data.summary.totalDurationMs).toBe(0);
  });

  it("returns empty arrays for all groupings", () => {
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byDay).toHaveLength(0);
    expect(data.byProject).toHaveLength(0);
    expect(data.byModel).toHaveLength(0);
    expect(data.byEntrypoint).toHaveLength(0);
    expect(data.stopReasons).toHaveLength(0);
  });

  it("sets period and timezone correctly", () => {
    const data = buildDashboard(store, { period: "week", timezone: "UTC" });
    expect(data.period).toBe("week");
    expect(data.timezone).toBe("UTC");
  });

  it("defaults period to 'all'", () => {
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.period).toBe("all");
  });
});

describe("buildDashboard — with sessions", () => {
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

  it("returns correct aggregate totals", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 500,
      promptCount: 5,
    }));
    store.upsertSession(makeSession({
      sessionId: "s2",
      inputTokens: 20_000,
      outputTokens: 4_000,
      cacheReadTokens: 16_000,
      cacheCreationTokens: 1_000,
      promptCount: 10,
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.summary.sessions).toBe(2);
    expect(data.summary.prompts).toBe(15);
    expect(data.summary.inputTokens).toBe(30_000);
    expect(data.summary.outputTokens).toBe(6_000);
    expect(data.summary.cacheReadTokens).toBe(24_000);
    expect(data.summary.cacheCreationTokens).toBe(1_500);
  });

  it("computes cache efficiency correctly", () => {
    store.upsertSession(makeSession({
      inputTokens: 1_000,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 1_000,
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    // totalLogicalInput = 1000 + 1000 + 8000 = 10000
    // cacheEfficiency = (8000 / 10000) * 100 = 80.0
    expect(data.summary.cacheEfficiency).toBe(80.0);
  });

  it("computes totalDurationMs from timestamps", () => {
    store.upsertSession(makeSession({
      firstTimestamp: 1_000_000,
      lastTimestamp: 1_300_000, // 300_000ms duration
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.summary.totalDurationMs).toBe(300_000);
  });

  it("output is valid JSON (round-trip)", () => {
    store.upsertSession(makeSession());
    store.upsertMessages([makeMessage()]);

    const data = buildDashboard(store, { timezone: "UTC" });
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    expect(parsed.summary.sessions).toBe(1);
    expect(parsed.generated).toBeDefined();
  });

  it("byDay entries have correct YYYY-MM-DD date format", () => {
    // Nov 14, 2023 UTC
    store.upsertSession(makeSession({
      firstTimestamp: 1_700_000_000_000,
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byDay).toHaveLength(1);
    expect(data.byDay[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("byDay groups sessions by date", () => {
    // Two sessions on same day
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      inputTokens: 1_000,
    }));
    store.upsertSession(makeSession({
      sessionId: "s2",
      firstTimestamp: 1_700_000_000_000 + 3_600_000, // 1 hour later, same day
      inputTokens: 2_000,
    }));
    // One session on a different day
    store.upsertSession(makeSession({
      sessionId: "s3",
      firstTimestamp: 1_700_000_000_000 + 86_400_000, // next day
      inputTokens: 3_000,
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byDay).toHaveLength(2);
    // First day should have 2 sessions
    const day1 = data.byDay.find(d => d.sessions === 2);
    expect(day1).toBeDefined();
    expect(day1!.inputTokens).toBe(3_000);
  });

  it("byProject correctly splits sessions by project_path", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      projectPath: "/proj/alpha",
      inputTokens: 1_000,
      outputTokens: 500,
    }));
    store.upsertSession(makeSession({
      sessionId: "s2",
      projectPath: "/proj/beta",
      inputTokens: 2_000,
      outputTokens: 1_000,
    }));
    store.upsertSession(makeSession({
      sessionId: "s3",
      projectPath: "/proj/alpha",
      inputTokens: 3_000,
      outputTokens: 1_500,
    }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byProject).toHaveLength(2);

    const alpha = data.byProject.find(p => p.projectPath === "/proj/alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.sessions).toBe(2);
    expect(alpha!.inputTokens).toBe(4_000);

    const beta = data.byProject.find(p => p.projectPath === "/proj/beta");
    expect(beta).toBeDefined();
    expect(beta!.sessions).toBe(1);
  });

  it("byModel contains entries from getMessageTotals", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
      makeMessage({ uuid: "m2", sessionId: "s1", model: "claude-opus-4", inputTokens: 10_000, outputTokens: 3_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byModel.length).toBeGreaterThanOrEqual(2);

    const sonnet = data.byModel.find(m => m.model === "claude-sonnet-4");
    expect(sonnet).toBeDefined();
    expect(sonnet!.inputTokens).toBe(5_000);

    const opus = data.byModel.find(m => m.model === "claude-opus-4");
    expect(opus).toBeDefined();
    expect(opus!.inputTokens).toBe(10_000);
  });

  it("byModel includes estimatedCost", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 1_000_000, outputTokens: 100_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    const sonnet = data.byModel.find(m => m.model === "claude-sonnet-4");
    expect(sonnet).toBeDefined();
    expect(sonnet!.estimatedCost).toBeGreaterThan(0);
  });

  it("stopReasons contains entries from getStopReasonCounts", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", stopReason: "end_turn" }),
      makeMessage({ uuid: "m2", sessionId: "s1", stopReason: "end_turn" }),
      makeMessage({ uuid: "m3", sessionId: "s1", stopReason: "tool_use" }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.stopReasons.length).toBeGreaterThanOrEqual(2);

    const endTurn = data.stopReasons.find(s => s.reason === "end_turn");
    expect(endTurn).toBeDefined();
    expect(endTurn!.count).toBe(2);

    const toolUse = data.stopReasons.find(s => s.reason === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse!.count).toBe(1);
  });

  it("byEntrypoint groups sessions by entrypoint", () => {
    store.upsertSession(makeSession({ sessionId: "s1", entrypoint: "claude" }));
    store.upsertSession(makeSession({ sessionId: "s2", entrypoint: "claude" }));
    store.upsertSession(makeSession({ sessionId: "s3", entrypoint: "claude-vscode" }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byEntrypoint).toHaveLength(2);

    const cli = data.byEntrypoint.find(e => e.entrypoint === "claude");
    expect(cli).toBeDefined();
    expect(cli!.sessions).toBe(2);

    const vscode = data.byEntrypoint.find(e => e.entrypoint === "claude-vscode");
    expect(vscode).toBeDefined();
    expect(vscode!.sessions).toBe(1);
  });

  it("generated field is a valid ISO timestamp", () => {
    store.upsertSession(makeSession());
    const data = buildDashboard(store, { timezone: "UTC" });
    const date = new Date(data.generated);
    expect(date.getTime()).not.toBeNaN();
  });

  it("summary.estimatedCost is populated from message totals", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({
        uuid: "m1",
        sessionId: "s1",
        model: "claude-sonnet-4",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    // claude-sonnet-4: $3/M input + $15/M output = $3 + $1.5 = $4.50
    expect(data.summary.estimatedCost).toBeGreaterThan(0);
  });
});
