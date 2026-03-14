import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { formatTokens, formatBytes, formatDuration, periodStart, printSummary, printStatus, formatEntrypoint, printSessionList, printSessionDetail, buildBuckets, printTrend } from "../reporter/index.js";
import { Store } from "../store/index.js";
import os from "os";
import path from "path";
import fs from "fs";

// ── formatTokens ─────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("formats numbers below 1K as plain digits", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands as K", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(12_345)).toBe("12K");
    expect(formatTokens(999_999)).toBe("1000K");
  });

  it("formats millions as M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

// ── formatDuration ───────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns '< 1m' for 0ms", () => {
    expect(formatDuration(0)).toBe("< 1m");
  });

  it("returns '< 1m' for 30_000ms (30s)", () => {
    expect(formatDuration(30_000)).toBe("< 1m");
  });

  it("returns '5m' for 300_000ms (5 minutes)", () => {
    expect(formatDuration(300_000)).toBe("5m");
  });

  it("returns '1h 05m' for 3_900_000ms (65 minutes)", () => {
    expect(formatDuration(3_900_000)).toBe("1h 05m");
  });

  it("returns '2h 00m' for 7_200_000ms (120 minutes)", () => {
    expect(formatDuration(7_200_000)).toBe("2h 00m");
  });
});

// ── formatBytes ──────────────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1_024)).toBe("1 KB");
    expect(formatBytes(2_048)).toBe("2 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(3_145_728)).toBe("3.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
  });
});

// ── periodStart ──────────────────────────────────────────────────────────────

describe("periodStart", () => {
  it("returns 0 for undefined period", () => {
    expect(periodStart(undefined, "UTC")).toBe(0);
  });

  it("returns 0 for unknown period string", () => {
    expect(periodStart("year", "UTC")).toBe(0);
  });

  it("returns a positive number for 'day'", () => {
    const start = periodStart("day", "UTC");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThanOrEqual(Date.now());
  });

  it("returns a positive number for 'week'", () => {
    const start = periodStart("week", "UTC");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThanOrEqual(Date.now());
  });

  it("returns a positive number for 'month'", () => {
    const start = periodStart("month", "UTC");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThanOrEqual(Date.now());
  });

  it("day start is <= week start is <= month start for same point in time", () => {
    // All three start at or before now, and day >= month (day is more recent)
    const day = periodStart("day", "UTC");
    const week = periodStart("week", "UTC");
    const month = periodStart("month", "UTC");
    expect(month).toBeLessThanOrEqual(week);
    expect(week).toBeLessThanOrEqual(day);
  });
});

// ── printSummary ──────────────────────────────────────────────────────────────

describe("printSummary", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("prints 'No sessions found' when store is empty", () => {
    printSummary(store, { includeCI: true });
    expect(consoleSpy).toHaveBeenCalledWith("No sessions found for the given filters.");
  });

  it("prints summary header with period label", () => {
    // Insert a minimal interactive session so it appears
    store.upsertSession({
      sessionId: "rep-sess-1",
      projectPath: "/proj/alpha",
      sourceFile: "/proj/alpha/rep-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "main",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 3,
      assistantMessageCount: 3,
      inputTokens: 1_500,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 800,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [{ name: "Read", count: 5 }, { name: "Edit", count: 2 }],
      models: ["claude-opus-4-6"],
      repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    });

    printSummary(store, { timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("all time"))).toBe(true);
    expect(calls.some((s) => s.includes("Sessions"))).toBe(true);
    expect(calls.some((s) => s.includes("Models"))).toBe(true);
    expect(calls.some((s) => s.includes("Top tools"))).toBe(true);
  });

  it("prints period label for 'day'", () => {
    store.upsertSession({
      sessionId: "rep-sess-2",
      projectPath: "/proj/beta",
      sourceFile: "/proj/beta/rep-sess-2.jsonl",
      firstTimestamp: Date.now(),
      lastTimestamp: Date.now(),
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: [],
      repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    });

    printSummary(store, { period: "day", timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("day"))).toBe(true);
  });

  it("includes duration in Sessions line when sessions have timestamps", () => {
    store.upsertSession({
      sessionId: "rep-sess-dur",
      projectPath: "/proj/dur",
      sourceFile: "/proj/dur/rep-sess-dur.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_000_000 + 3_900_000, // 65 minutes
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 5,
      assistantMessageCount: 5,
      inputTokens: 2_000,
      outputTokens: 1_000,
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
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    printSummary(store, { timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("Sessions") && s.includes("1h 05m total"))).toBe(true);
  });

  it("prints 'By Project' table when multiple projects present", () => {
    for (const [id, proj] of [["s1", "/proj/a"], ["s2", "/proj/b"]] as const) {
      store.upsertSession({
        sessionId: id,
        projectPath: proj,
        sourceFile: `${proj}/${id}.jsonl`,
        firstTimestamp: 1_700_000_000_000,
        lastTimestamp: 1_700_000_100_000,
        claudeVersion: "2.1.70",
        entrypoint: "claude",
        gitBranch: null,
        permissionMode: null,
        isInteractive: true,
        promptCount: 1,
        assistantMessageCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        toolUseCounts: [],
        models: [],
        repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
      });
    }

    printSummary(store, { includeCI: true });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("By Project"))).toBe(true);
  });

  it("prints Stops line with stop reason distribution", () => {
    store.upsertSession({
      sessionId: "stop-sess-1",
      projectPath: "/proj/stops",
      sourceFile: "/proj/stops/stop-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 3,
      assistantMessageCount: 3,
      inputTokens: 1_000,
      outputTokens: 500,
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
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });
    store.upsertMessages([
      { uuid: "sr-m1", sessionId: "stop-sess-1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "sr-m2", sessionId: "stop-sess-1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "sr-m3", sessionId: "stop-sess-1", timestamp: 1002, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);

    printSummary(store, { timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    const stopsLine = calls.find((s) => s.includes("Stops"));
    expect(stopsLine).toBeDefined();
    expect(stopsLine).toContain("end_turn:2");
    expect(stopsLine).toContain("tool_use:1");
  });

  it("prints max_tokens warning when truncated responses exist", () => {
    store.upsertSession({
      sessionId: "trunc-sess-1",
      projectPath: "/proj/trunc",
      sourceFile: "/proj/trunc/trunc-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 2,
      assistantMessageCount: 2,
      inputTokens: 1_000,
      outputTokens: 500,
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
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });
    store.upsertMessages([
      { uuid: "tr-m1", sessionId: "trunc-sess-1", timestamp: 1000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "tr-m2", sessionId: "trunc-sess-1", timestamp: 1001, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "max_tokens", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);

    printSummary(store, { timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("1 responses were truncated (max_tokens)"))).toBe(true);
  });
});

// ── printStatus ───────────────────────────────────────────────────────────────

describe("printStatus", () => {
  it("prints status info", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printStatus({ dbSize: 1_024, sessionCount: 5, messageCount: 42, quarantineCount: 1, lastCollected: 1_700_000_000_000 });
    const calls = (spy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("Sessions"))).toBe(true);
    expect(calls.some((s) => s.includes("Messages"))).toBe(true);
    spy.mockRestore();
  });

  it("prints 'never' when lastCollected is null", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printStatus({ dbSize: 0, sessionCount: 0, messageCount: 0, quarantineCount: 0, lastCollected: null });
    const calls = (spy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("never"))).toBe(true);
    spy.mockRestore();
  });
});

// ── formatEntrypoint ─────────────────────────────────────────────────────────

describe("formatEntrypoint", () => {
  it("maps 'claude' to 'cli'", () => {
    expect(formatEntrypoint("claude")).toBe("cli");
  });

  it("maps 'claude-vscode' to 'vscode'", () => {
    expect(formatEntrypoint("claude-vscode")).toBe("vscode");
  });

  it("returns raw value for unknown entrypoints", () => {
    expect(formatEntrypoint("something-else")).toBe("something-else");
  });
});

// ── Source line in printSummary ───────────────────────────────────────────────

describe("printSummary — Source line", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-src-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("shows Source line with mixed entrypoints sorted by count desc", () => {
    // Insert 3 CLI sessions and 1 vscode session
    for (let i = 0; i < 3; i++) {
      store.upsertSession({
        sessionId: `cli-${i}`,
        projectPath: "/proj/x",
        sourceFile: `/proj/x/cli-${i}.jsonl`,
        firstTimestamp: 1_700_000_000_000 + i,
        lastTimestamp: 1_700_000_100_000 + i,
        claudeVersion: "2.1.70",
        entrypoint: "claude",
        gitBranch: null,
        permissionMode: null,
        isInteractive: true,
        promptCount: 1,
        assistantMessageCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        toolUseCounts: [],
        models: [],
        repoUrl: null,
        accountUuid: null,
        organizationUuid: null,
        subscriptionType: null,
        thinkingBlocks: 0,
        parentSessionId: null,
        isSubagent: false,
        sourceDeleted: false,
        throttleEvents: 0,
        activeDurationMs: null,
        medianResponseTimeMs: null,
      });
    }
    store.upsertSession({
      sessionId: "vsc-0",
      projectPath: "/proj/x",
      sourceFile: "/proj/x/vsc-0.jsonl",
      firstTimestamp: 1_700_000_000_010,
      lastTimestamp: 1_700_000_100_010,
      claudeVersion: "2.1.70",
      entrypoint: "claude-vscode",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: [],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    printSummary(store, { timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    const sourceLine = calls.find((s) => s.startsWith("Source"));
    expect(sourceLine).toBeDefined();
    expect(sourceLine).toContain("cli (3)");
    expect(sourceLine).toContain("vscode (1)");
    // cli should come before vscode (higher count)
    expect(sourceLine!.indexOf("cli")).toBeLessThan(sourceLine!.indexOf("vscode"));
  });
});

// ── printSessionList ────────────────────────────────────────────────────────

describe("printSessionList", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-list-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("prints 'No sessions found' when store is empty", () => {
    printSessionList(store, { includeCI: true });
    expect(consoleSpy).toHaveBeenCalledWith("No sessions found for the given filters.");
  });

  it("prints session rows and totals when sessions exist", () => {
    store.upsertSession({
      sessionId: "list-sess-1",
      projectPath: "/proj/list",
      sourceFile: "/proj/list/list-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_000_000 + 300_000, // 5 minutes
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 3,
      assistantMessageCount: 3,
      inputTokens: 5_000,
      outputTokens: 1_000,
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
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    printSessionList(store, { timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("Sessions"))).toBe(true);
    expect(calls.some((s) => s.includes("list-s"))).toBe(true); // truncated session ID
    expect(calls.some((s) => s.includes("1 session"))).toBe(true); // totals row
  });
});

// ── printSessionDetail ──────────────────────────────────────────────────────

describe("printSessionDetail", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-detail-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("prints 'No session found' for unknown session", () => {
    printSessionDetail(store, "nonexistent", {});
    expect(consoleSpy).toHaveBeenCalledWith('No session found matching "nonexistent".');
  });

  it("prints session header and message table for valid session", () => {
    store.upsertSession({
      sessionId: "detail-sess-1",
      projectPath: "/proj/detail",
      sourceFile: "/proj/detail/detail-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: "feature/test",
      permissionMode: "default",
      isInteractive: true,
      promptCount: 2,
      assistantMessageCount: 2,
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreationTokens: 200,
      cacheReadTokens: 3_000,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["claude-opus-4-6"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });
    store.upsertMessages([
      { uuid: "d-m1", sessionId: "detail-sess-1", timestamp: 1_700_000_000_000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "tool_use", inputTokens: 2_000, outputTokens: 500, cacheCreationTokens: 100, cacheReadTokens: 1_500, tools: ["Read"], thinkingBlocks: 1, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
      { uuid: "d-m2", sessionId: "detail-sess-1", timestamp: 1_700_000_100_000, claudeVersion: "2.1.70", model: "claude-opus-4-6", stopReason: "end_turn", inputTokens: 3_000, outputTokens: 500, cacheCreationTokens: 100, cacheReadTokens: 1_500, tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null },
    ]);

    printSessionDetail(store, "detail-sess-1", {});
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    expect(calls.some((s) => s.includes("Project  : /proj/detail"))).toBe(true);
    expect(calls.some((s) => s.includes("Branch   : feature/test"))).toBe(true);
    expect(calls.some((s) => s.includes("Version  : 2.1.70"))).toBe(true);
    expect(calls.some((s) => s.includes("Totals"))).toBe(true);
    expect(calls.some((s) => s.includes("Read"))).toBe(true);
  });
});

// ── printSummary — Thinking line ─────────────────────────────────────────────

describe("printSummary — Thinking line", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-think-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("shows Thinking line when thinking blocks > 0", () => {
    store.upsertSession({
      sessionId: "think-sess-1",
      projectPath: "/proj/think",
      sourceFile: "/proj/think/think-sess-1.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_100_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: 3,
      assistantMessageCount: 5,
      inputTokens: 1_000,
      outputTokens: 500,
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
      thinkingBlocks: 7,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    });

    printSummary(store, { timezone: "UTC" });
    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c => typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []);
    const thinkingLine = calls.find((s) => s.includes("Thinking"));
    expect(thinkingLine).toBeDefined();
    expect(thinkingLine).toContain("7 blocks");
  });
});

// ── buildBuckets ─────────────────────────────────────────────────────────────

describe("buildBuckets", () => {
  it("returns 7 daily buckets for 'week'", () => {
    // Monday March 2, 2026 00:00 UTC
    const start = Date.UTC(2026, 2, 2, 0, 0, 0); // Mon Mar 2
    const end = start + 7 * 24 * 60 * 60 * 1000;
    const buckets = buildBuckets("week", "UTC", start, end);
    expect(buckets).toHaveLength(7);
    // Each bucket should span exactly one day
    for (const b of buckets) {
      expect(b.endMs - b.startMs).toBe(24 * 60 * 60 * 1000);
    }
    // First bucket starts at rangeStart
    expect(buckets[0]!.startMs).toBe(start);
    // Last bucket ends at rangeEnd
    expect(buckets[6]!.endMs).toBe(end);
    // Labels should contain day names
    expect(buckets[0]!.label).toContain("Mon");
    expect(buckets[1]!.label).toContain("Tue");
    expect(buckets[6]!.label).toContain("Sun");
  });

  it("returns 4-5 weekly buckets for 'month'", () => {
    // March 1, 2026 00:00 UTC (a Sunday)
    const start = Date.UTC(2026, 2, 1, 0, 0, 0);
    const end = Date.UTC(2026, 3, 1, 0, 0, 0); // April 1
    const buckets = buildBuckets("month", "UTC", start, end);
    expect(buckets.length).toBeGreaterThanOrEqual(4);
    expect(buckets.length).toBeLessThanOrEqual(5);
    // First bucket starts at rangeStart
    expect(buckets[0]!.startMs).toBe(start);
    // Last bucket ends at rangeEnd
    expect(buckets[buckets.length - 1]!.endMs).toBe(end);
    // Buckets should be contiguous
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.startMs).toBe(buckets[i - 1]!.endMs);
    }
  });

  it("returns monthly buckets for 'all'", () => {
    const start = Date.UTC(2026, 0, 15, 0, 0, 0); // Jan 15
    const end = Date.UTC(2026, 2, 20, 0, 0, 0);   // Mar 20
    const buckets = buildBuckets("all", "UTC", start, end);
    expect(buckets).toHaveLength(3); // Jan, Feb, Mar
    expect(buckets[0]!.label).toContain("Jan");
    expect(buckets[1]!.label).toContain("Feb");
    expect(buckets[2]!.label).toContain("Mar");
  });
});

// ── printTrend ──────────────────────────────────────────────────────────────

describe("printTrend", () => {
  let store: Store;
  let dbPath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  function makeSession(id: string, timestamp: number, prompts = 1, input = 100, output = 50) {
    return {
      sessionId: id,
      projectPath: "/proj/trend",
      sourceFile: `/proj/trend/${id}.jsonl`,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp + 60_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude",
      gitBranch: null,
      permissionMode: null,
      isInteractive: true,
      promptCount: prompts,
      assistantMessageCount: prompts,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [] as Array<{ name: string; count: number }>,
      models: ["claude-opus-4-6"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: null,
      medianResponseTimeMs: null,
    };
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-rep-trend-${Date.now()}.db`);
    store = new Store(dbPath);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("prints 'No sessions found.' when store is empty", () => {
    printTrend(store, { period: "week", timezone: "UTC", includeCI: true });
    expect(consoleSpy).toHaveBeenCalledWith("No sessions found.");
  });

  it("assigns sessions to correct daily buckets for week period", () => {
    // Place sessions within the current week so periodStart("week") includes them
    const weekStart = periodStart("week", "UTC");
    const day0 = weekStart + 2 * 60 * 60 * 1000; // 2 hours into first day
    const day2 = weekStart + 2 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000; // 3rd day

    store.upsertSession(makeSession("t-day0", day0, 3, 1000, 500));
    store.upsertSession(makeSession("t-day2", day2, 5, 2000, 800));

    printTrend(store, { period: "week", timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c =>
      typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []
    );
    // Should have a "Weekly Trend" header
    expect(calls.some((s) => s.includes("Weekly Trend"))).toBe(true);
    // Should have a "Total" row
    expect(calls.some((s) => s.includes("Total"))).toBe(true);
  });

  it("shows empty buckets with zero values", () => {
    // Place a single session on the first day of the current week
    const weekStart = periodStart("week", "UTC");
    const day0 = weekStart + 2 * 60 * 60 * 1000;
    store.upsertSession(makeSession("t-only-day0", day0, 3, 1000, 500));

    printTrend(store, { period: "week", timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c =>
      typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []
    );
    // Count data rows (not header, separator, or Total)
    const dataRows = calls.filter(s =>
      !s.includes("───") && !s.includes("Day") && !s.includes("Total") && !s.startsWith("─") && s.trim().length > 0
    );
    // Should have 7 day rows (including empties)
    expect(dataRows.length).toBe(7);
    // At least some rows should have 0 sessions
    const zeroRows = dataRows.filter(s => /\b0\b/.test(s));
    expect(zeroRows.length).toBeGreaterThanOrEqual(6); // 6 empty days
  });

  it("defaults to month period when no period specified", () => {
    const now = Date.now();
    store.upsertSession(makeSession("t-now", now, 2, 500, 200));

    printTrend(store, { timezone: "UTC" });

    const calls = (consoleSpy.mock.calls as unknown[][]).flatMap(c =>
      typeof c[0] === "string" && c[0].length > 0 ? [c[0]] : []
    );
    expect(calls.some((s) => s.includes("Monthly Trend"))).toBe(true);
  });
});
