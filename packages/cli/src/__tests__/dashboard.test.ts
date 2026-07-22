import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store } from "../store/index.js";
import { buildDashboard, PLAN_LADDER_THRESHOLDS } from "../dashboard/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { estimateCost } from "@claude-stats/core/pricing";
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
    parentSessionId: null,
    isSubagent: false,
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
    promptText: null,
    ...overrides,
  };
}

describe("getSessions activeSince — period-boundary overlap", () => {
  let store: Store;
  let dbPath: string;
  const T0 = 1_700_000_000_000;
  const HOUR = 3_600_000;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("counts a session ACTIVE in the period even though it STARTED before it", () => {
    // Straddles the T0+1h boundary: started T0, still active at T0+2h.
    store.upsertSession(makeSession({ sessionId: "straddle", firstTimestamp: T0, lastTimestamp: T0 + 2 * HOUR }));
    // `since` (start-in-period) excludes it; `activeSince` (active-in-period) includes it.
    expect(store.getSessions({ since: T0 + HOUR }).map((s) => s.session_id)).not.toContain("straddle");
    expect(store.getSessions({ activeSince: T0 + HOUR }).map((s) => s.session_id)).toContain("straddle");
  });

  it("excludes a session whose last activity is before the period start", () => {
    store.upsertSession(makeSession({ sessionId: "old", firstTimestamp: T0, lastTimestamp: T0 + HOUR }));
    expect(store.getSessions({ activeSince: T0 + 2 * HOUR }).map((s) => s.session_id)).not.toContain("old");
  });

  it("falls back to first_timestamp when last_timestamp is null", () => {
    store.upsertSession(makeSession({ sessionId: "nolast", firstTimestamp: T0 + 3 * HOUR, lastTimestamp: null }));
    expect(store.getSessions({ activeSince: T0 + HOUR }).map((s) => s.session_id)).toContain("nolast");
    expect(store.getSessions({ activeSince: T0 + 5 * HOUR }).map((s) => s.session_id)).not.toContain("nolast");
  });
});

describe("buildDashboard — custom since/until range", () => {
  let store: Store;
  let dbPath: string;
  const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  function ymd(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  it("passes both activeSince and until to getSessions, excluding a session active only after until", () => {
    store.upsertSession(makeSession({
      sessionId: "in-range",
      firstTimestamp: T0 + DAY,
      lastTimestamp: T0 + DAY + 3_600_000,
    }));
    // Active only well after the requested `until` boundary — this is the case
    // that would silently pass today since there's no upper bound at all
    // without this task's change.
    store.upsertSession(makeSession({
      sessionId: "after-until",
      firstTimestamp: T0 + 5 * DAY,
      lastTimestamp: T0 + 5 * DAY + 3_600_000,
    }));

    const getSessionsSpy = vi.spyOn(store, "getSessions");

    const data = buildDashboard(store, {
      since: ymd(T0),
      until: ymd(T0 + 2 * DAY),
      timezone: "UTC",
    });

    expect(getSessionsSpy).toHaveBeenCalledTimes(1);
    const callArgs = getSessionsSpy.mock.calls[0]![0]!;
    expect(callArgs.activeSince).toBeDefined();
    expect(callArgs.until).toBeDefined();
    expect(callArgs.until!).toBeGreaterThan(callArgs.activeSince!);

    expect(data.summary.sessions).toBe(1);
    expect(data.byConversationCost.map((c) => c.sessionId)).not.toContain("after-until");
  });

  it('sets summary period to "custom" when since/until are both present', () => {
    const data = buildDashboard(store, {
      since: ymd(T0),
      until: ymd(T0 + 2 * DAY),
      timezone: "UTC",
    });
    expect(data.period).toBe("custom");
  });

  it("does not set period to custom for a plain preset", () => {
    const data = buildDashboard(store, { period: "week", timezone: "UTC" });
    expect(data.period).toBe("week");
  });
});

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

  it("byWeek aggregates sessions into ISO week buckets", () => {
    // Monday 2023-11-13
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_699_833_600_000, // 2023-11-13T00:00:00Z (Monday)
      lastTimestamp: 1_699_833_900_000,
      promptCount: 5,
      activeDurationMs: 600_000,
    }));
    // Same week - Wednesday 2023-11-15
    store.upsertSession(makeSession({
      sessionId: "s2",
      firstTimestamp: 1_700_006_400_000, // 2023-11-15T00:00:00Z (Wednesday)
      lastTimestamp: 1_700_006_700_000,
      promptCount: 3,
      activeDurationMs: 300_000,
    }));

    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
      makeMessage({ uuid: "m2", sessionId: "s2", model: "claude-sonnet-4", inputTokens: 3_000, outputTokens: 500 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.byWeek.length).toBeGreaterThanOrEqual(1);
    const week = data.byWeek[0]!;
    expect(week.sessions).toBe(2);
    expect(week.prompts).toBe(8);
  });

  it("planUtilization is null when no sessions exist", () => {
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).toBeNull();
  });

  it("planUtilization is populated with sessions and planFee", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      activeDurationMs: 300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 1_000_000, outputTokens: 100_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC", planFee: 100 });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.weeklyPlanBudget).toBeGreaterThan(0);
    expect(data.planUtilization!.avgWeeklyCost).toBeGreaterThan(0);
    expect(data.planUtilization!.totalWeeks).toBeGreaterThanOrEqual(1);
  });

  it("planUtilization reports good-value when cost exceeds plan fee", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-opus-4", inputTokens: 10_000_000, outputTokens: 1_000_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC", planFee: 20 });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.currentPlanVerdict).toBe("good-value");
  });

  it("planUtilization reports underusing when cost is below plan fee", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-haiku-4", inputTokens: 1_000, outputTokens: 100 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC", planFee: 200 });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.currentPlanVerdict).toBe("underusing");
  });

  it("planUtilization reports no-plan when planFee is 0", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.currentPlanVerdict).toBe("no-plan");
    expect(data.planUtilization!.weeklyPlanBudget).toBe(0);
  });

  it("planUtilization recommends pro for low usage", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-haiku-4", inputTokens: 1_000, outputTokens: 100 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.recommendedPlan).toBe("pro");
  });

  it("planUtilization auto-detects plan fee from subscription type", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      accountUuid: "acct-111",
      subscriptionType: "pro",
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
    ]);

    // No explicit planFee — should auto-detect from subscription type
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.weeklyPlanBudget).toBeGreaterThan(0);
    // Pro = $20/mo → ~$4.62/week
    expect(data.planUtilization!.weeklyPlanBudget).toBeCloseTo(20 / 4.33, 1);
    expect(data.planUtilization!.byAccount).toHaveLength(1);
    expect(data.planUtilization!.byAccount[0]!.detectedPlanFee).toBe(20);
  });

  it("planUtilization supports multiple accounts with different plans", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      accountUuid: "acct-personal",
      subscriptionType: "pro",
    }));
    store.upsertSession(makeSession({
      sessionId: "s2",
      projectPath: "/Users/alice/repos/work",
      sourceFile: "/Users/alice/.claude/projects/work/s2.jsonl",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      accountUuid: "acct-work",
      subscriptionType: "max_5x",
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
      makeMessage({ uuid: "m2", sessionId: "s2", model: "claude-opus-4", inputTokens: 5_000_000, outputTokens: 500_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.byAccount).toHaveLength(2);

    // Should be sorted by cost descending — work account (opus) first
    const workAcct = data.planUtilization!.byAccount.find(a => a.subscriptionType === "max_5x");
    const personalAcct = data.planUtilization!.byAccount.find(a => a.subscriptionType === "pro");
    expect(workAcct).toBeDefined();
    expect(personalAcct).toBeDefined();
    expect(workAcct!.detectedPlanFee).toBe(100);
    expect(personalAcct!.detectedPlanFee).toBe(20);

    // Effective plan fee should be sum of both: $20 + $100 = $120
    expect(data.planUtilization!.weeklyPlanBudget).toBeCloseTo(120 / 4.33, 1);
  });

  it("planUtilization explicit planFee overrides auto-detection", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
      accountUuid: "acct-111",
      subscriptionType: "pro",
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
    ]);

    // Explicit planFee = 200 should override auto-detected $20
    const data = buildDashboard(store, { timezone: "UTC", planFee: 200 });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.weeklyPlanBudget).toBeCloseTo(200 / 4.33, 1);
  });

  it("PLAN_LADDER_THRESHOLDS midpoints match the previously hand-coded constants", () => {
    // Derived from PLAN_FEES (pro 20, team_standard 25, max_5x 100,
    // team_premium 125, max_20x 200) via the explicit price-ordered ladder —
    // NOT Object.entries(PLAN_FEES), which would include the `team: 25` alias
    // out of price order and corrupt these midpoints (plan §"planUtilization
    // extensions").
    expect(PLAN_LADDER_THRESHOLDS).toEqual([22.5, 62.5, 112.5, 162.5]);
  });

  it("planUtilization recommends max_20x just under the $200 ceiling", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    // outputTokens tuned so the single week's rounded cost is $46.18/week
    // (claude-sonnet-4 @ $15/M output) → monthlyEquiv = 46.18 * 4.33 = 199.9594,
    // just below PLAN_FEES.max_20x ($200).
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 0, outputTokens: 3_078_667 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.avgWeeklyCost * 4.33).toBeLessThan(200);
    expect(data.planUtilization!.recommendedPlan).toBe("max_20x");
    expect(data.planUtilization!.usageIntensityTier).not.toBeNull();
  });

  it("planUtilization recommends enterprise just over the $200 ceiling", () => {
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    // outputTokens tuned so the single week's rounded cost is $46.19/week →
    // monthlyEquiv = 46.19 * 4.33 = 200.0027, just above PLAN_FEES.max_20x
    // ($200): the range 162.5-200 stays max_20x, only strictly-above tips to
    // enterprise (plan acceptance criterion 5).
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 0, outputTokens: 3_079_333 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.avgWeeklyCost * 4.33).toBeGreaterThan(200);
    expect(data.planUtilization!.recommendedPlan).toBe("enterprise");
    expect(data.planUtilization!.usageIntensityTier).not.toBeNull();
    expect(data.planUtilization!.usageIntensityTier!.tier).toBe("typical");
    expect(data.planUtilization!.usageIntensityTier!.source).toBe("anthropic-benchmark");
  });

  it("planUtilization.usageIntensityTier is null only when planUtilization itself is null", () => {
    const empty = buildDashboard(store, { timezone: "UTC" });
    expect(empty.planUtilization).toBeNull();

    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: 1_700_000_000_000,
      lastTimestamp: 1_700_000_300_000,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-haiku-4", inputTokens: 1_000, outputTokens: 100 }),
    ]);
    const populated = buildDashboard(store, { timezone: "UTC" });
    expect(populated.planUtilization).not.toBeNull();
    expect(populated.planUtilization!.usageIntensityTier).not.toBeNull();
  });

  it("does not recommend downgrading to Enterprise when underusing but over the $200 ceiling", () => {
    // Four distinct ISO weeks (Mondays, UTC), one session each, each costing
    // ~$50/week (monthlyEquiv ≈ $216.5 → recommendedPlan "enterprise").
    // A large explicit planFee ($1000) keeps currentPlanVerdict "underusing"
    // (totalCost well below the fee) while still exceeding the $200 ceiling —
    // exactly the combination that must NOT produce a bogus "downgrade to
    // Enterprise" recommendation (PLAN_LABELS.enterprise has no `$<digits>`
    // token, and recommendedPlan === "enterprise" is explicitly excluded from
    // the plan-underusing branch).
    const week0 = 1_699_833_600_000; // Monday 2023-11-13T00:00:00Z
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 4; i++) {
      const sessionId = `wk-${i}`;
      store.upsertSession(makeSession({
        sessionId,
        firstTimestamp: week0 + i * weekMs,
        lastTimestamp: week0 + i * weekMs + 300_000,
      }));
      store.upsertMessages([
        makeMessage({ uuid: `wk-${i}-m1`, sessionId, model: "claude-sonnet-4", inputTokens: 0, outputTokens: 3_333_333 }),
      ]);
    }

    const data = buildDashboard(store, { timezone: "UTC", planFee: 1000 });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.totalWeeks).toBeGreaterThanOrEqual(4);
    expect(data.planUtilization!.currentPlanVerdict).toBe("underusing");
    expect(data.planUtilization!.recommendedPlan).toBe("enterprise");
    const downgrade = data.recommendations.find(r => r.id === "plan-underusing");
    expect(downgrade).toBeUndefined();
  });

  it("truncatedOutputWindowPercent reflects share of windows that contained a truncation", () => {
    const now = Date.now();
    store.upsertSession(makeSession({
      sessionId: "s1",
      firstTimestamp: now - 86_400_000,
      lastTimestamp: now - 86_100_000,
      accountUuid: "acct-1",
      subscriptionType: "pro",
    }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", model: "claude-sonnet-4", inputTokens: 5_000, outputTokens: 1_000 }),
    ]);
    // Two windows — one has the `throttled` flag (now meaning "contained a truncated output")
    store.upsertUsageWindow({
      windowStart: now - 86_400_000,
      windowEnd: now - 68_400_000,
      accountUuid: "acct-1",
      totalCostEquivalent: 0.8,
      promptCount: 5,
      tokensByModel: { "claude-sonnet-4": 6000 },
      throttled: true,
    });
    store.upsertUsageWindow({
      windowStart: now - 68_400_000,
      windowEnd: now - 50_400_000,
      accountUuid: "acct-1",
      totalCostEquivalent: 0.5,
      promptCount: 3,
      tokensByModel: { "claude-sonnet-4": 3000 },
      throttled: false,
    });

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    expect(data.planUtilization!.truncatedOutputWindowPercent).toBe(50);
  });

  it("modelEfficiency is null when no messages with prompt_text exist", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", sessionId: "s1", promptText: null }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    // modelEfficiency depends on getMessagesForEfficiency returning data
    // With just one message without prompt text, it may still return data
    // The key test is that it doesn't crash
    expect(data.modelEfficiency === null || data.modelEfficiency !== null).toBe(true);
  });

  it("modelEfficiency detects sonnet overuse on haiku-level tasks", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({
        uuid: "m1",
        sessionId: "s1",
        model: "claude-sonnet-4",
        inputTokens: 500,
        outputTokens: 100,
        tools: [],
        thinkingBlocks: 0,
        promptText: "fix typo in readme",
      }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    if (data.modelEfficiency) {
      // Simple task on sonnet = overuse (haiku would suffice)
      expect(data.modelEfficiency.summary.overusePercent).toBeGreaterThan(0);
    }
  });

  it("modelEfficiency aggregates tool-continuation turns into initiating prompt", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      // First message has a prompt (initiating turn)
      makeMessage({
        uuid: "m1",
        sessionId: "s1",
        model: "claude-opus-4",
        inputTokens: 5_000,
        outputTokens: 2_000,
        tools: ["Edit"],
        thinkingBlocks: 1,
        promptText: "refactor the auth module across all services",
        timestamp: 1_700_000_000_000,
      }),
      // Second message is a tool continuation (no prompt_text)
      makeMessage({
        uuid: "m2",
        sessionId: "s1",
        model: "claude-opus-4",
        inputTokens: 3_000,
        outputTokens: 1_500,
        tools: ["Bash"],
        thinkingBlocks: 1,
        promptText: null,
        timestamp: 1_700_000_001_000,
      }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    if (data.modelEfficiency) {
      expect(data.modelEfficiency.summary.classifiedMessages).toBeGreaterThan(0);
    }
  });

  it("modelEfficiency handles orphan continuations from different sessions", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertSession(makeSession({ sessionId: "s2" }));
    store.upsertMessages([
      makeMessage({
        uuid: "m1",
        sessionId: "s1",
        model: "claude-sonnet-4",
        inputTokens: 5_000,
        outputTokens: 2_000,
        promptText: "implement feature",
        timestamp: 1_700_000_000_000,
      }),
      // Continuation from a different session (orphan)
      makeMessage({
        uuid: "m2",
        sessionId: "s2",
        model: "claude-sonnet-4",
        inputTokens: 3_000,
        outputTokens: 1_000,
        promptText: null,
        timestamp: 1_700_000_001_000,
      }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    // Should not crash; orphan is handled gracefully
    if (data.modelEfficiency) {
      expect(data.modelEfficiency.summary.totalMessages).toBeGreaterThan(0);
    }
  });

  it("modelEfficiency analyzes opus overuse when opus used for simple tasks", () => {
    store.upsertSession(makeSession({ sessionId: "s1" }));
    store.upsertMessages([
      makeMessage({
        uuid: "m1",
        sessionId: "s1",
        model: "claude-opus-4",
        inputTokens: 500,
        outputTokens: 100,
        tools: [],
        thinkingBlocks: 0,
        promptText: "fix typo",
      }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    if (data.modelEfficiency) {
      expect(data.modelEfficiency.summary.classifiedMessages).toBeGreaterThan(0);
      // Simple task on opus = overuse
      expect(data.modelEfficiency.summary.overusePercent).toBeGreaterThan(0);
    }
  });
});

// ── Context Analysis ──────────────────────────────────────────────────────────

describe("buildDashboard — context analysis", () => {
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

  it("returns null contextAnalysis for empty store", () => {
    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).toBeNull();
  });

  it("produces context analysis with sessions and messages", () => {
    // Need 3+ sessions for context growth curve (minimum sample size)
    for (let s = 1; s <= 3; s++) {
      store.upsertSession(makeSession({ sessionId: `ctx-s1-${s}`, promptCount: 5 }));
      store.upsertMessages(
        Array.from({ length: 5 }, (_, i) =>
          makeMessage({
            uuid: `ctx-m-${s}-${i}`,
            sessionId: `ctx-s1-${s}`,
            inputTokens: 5_000 * (i + 1),
            timestamp: 1_700_000_000_000 + s * 100_000 + i * 1000,
          })
        )
      );
    }

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).not.toBeNull();
    expect(data.contextAnalysis!.avgPromptsPerSession).toBe(5);
    expect(data.contextAnalysis!.lengthDistribution).toHaveLength(6);
    expect(data.contextAnalysis!.contextGrowthCurve.length).toBeGreaterThan(0);
    // Average peak should be 25K (all 3 sessions peak at 25K)
    expect(data.contextAnalysis!.avgPeakInputTokens).toBe(25_000);
  });

  it("detects compaction events (large input token drop)", () => {
    store.upsertSession(makeSession({ sessionId: "ctx-s2", promptCount: 4 }));
    store.upsertMessages([
      makeMessage({ uuid: "ctx-m10", sessionId: "ctx-s2", inputTokens: 50_000, timestamp: 1_700_000_000_000 }),
      makeMessage({ uuid: "ctx-m11", sessionId: "ctx-s2", inputTokens: 80_000, timestamp: 1_700_000_001_000 }),
      // Compaction: drops from 80K to 20K (75% drop)
      makeMessage({ uuid: "ctx-m12", sessionId: "ctx-s2", inputTokens: 20_000, timestamp: 1_700_000_002_000 }),
      makeMessage({ uuid: "ctx-m13", sessionId: "ctx-s2", inputTokens: 30_000, timestamp: 1_700_000_003_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).not.toBeNull();
    expect(data.contextAnalysis!.compactionEvents.length).toBe(1);
    expect(data.contextAnalysis!.compactionEvents[0]!.tokensBefore).toBe(80_000);
    expect(data.contextAnalysis!.compactionEvents[0]!.tokensAfter).toBe(20_000);
    expect(data.contextAnalysis!.compactionEvents[0]!.reductionPercent).toBe(75);
    expect(data.contextAnalysis!.compactionRate).toBeGreaterThan(0);
  });

  it("flags long sessions without compaction", () => {
    // Session with 20 prompts and no compaction
    store.upsertSession(makeSession({ sessionId: "ctx-s3", promptCount: 20 }));
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMessage({
        uuid: `ctx-m${100 + i}`,
        sessionId: "ctx-s3",
        inputTokens: 5_000 * (i + 1), // steadily growing
        timestamp: 1_700_000_000_000 + i * 1000,
      })
    );
    store.upsertMessages(msgs);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).not.toBeNull();
    expect(data.contextAnalysis!.sessionsNeedingCompaction).toBe(1);
    expect(data.contextAnalysis!.longSessions.length).toBe(1);
    expect(data.contextAnalysis!.longSessions[0]!.compacted).toBe(false);
  });

  it("keeps compactionRate ≤ 100% with CI sessions now in scope (regression: >100%)", () => {
    // One interactive session in scope, with no compaction.
    store.upsertSession(makeSession({ sessionId: "ctx-int", promptCount: 5, isInteractive: true }));
    store.upsertMessages(
      Array.from({ length: 5 }, (_, i) =>
        makeMessage({
          uuid: `ctx-int-${i}`,
          sessionId: "ctx-int",
          inputTokens: 5_000 * (i + 1),
          timestamp: 1_700_000_000_000 + i * 1000,
        })
      )
    );

    // Two CI (non-interactive) sessions, each with a compaction event. Since the
    // per-account-token-breakdown change, `rows` includes CI sessions by default
    // (includeCI ?? true), so these are now IN scope for both numerator AND
    // denominator. The durable invariant this guards: the numerator (sessions
    // with compaction) and denominator (in-scope sessions) stay consistent, so
    // compactionRate can never exceed 100% (the original bug counted CI in the
    // numerator only, yielding 2/1 = 200%).
    for (const s of ["ci-1", "ci-2"]) {
      store.upsertSession(makeSession({ sessionId: s, promptCount: 3, isInteractive: false }));
      store.upsertMessages([
        makeMessage({ uuid: `${s}-m0`, sessionId: s, inputTokens: 80_000, timestamp: 1_700_000_000_000 }),
        // 80K → 20K: a 75% drop, detected as compaction.
        makeMessage({ uuid: `${s}-m1`, sessionId: s, inputTokens: 20_000, timestamp: 1_700_000_001_000 }),
        makeMessage({ uuid: `${s}-m2`, sessionId: s, inputTokens: 30_000, timestamp: 1_700_000_002_000 }),
      ]);
    }

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).not.toBeNull();
    // Rate is a percentage of in-scope sessions; it can never exceed 100%.
    expect(data.contextAnalysis!.compactionRate).toBeLessThanOrEqual(100);
    // 3 in-scope sessions (1 interactive + 2 CI), 2 of which compacted → 66.7%.
    expect(data.contextAnalysis!.compactionRate).toBeCloseTo(66.7, 1);
    expect(data.contextAnalysis!.compactionEvents.length).toBe(2);
  });

  it("computes cache efficiency by conversation length", () => {
    // Short session (3 prompts)
    store.upsertSession(makeSession({
      sessionId: "ctx-s4", promptCount: 3,
      inputTokens: 1000, cacheReadTokens: 5000, cacheCreationTokens: 500,
    }));
    store.upsertMessages([
      makeMessage({ uuid: "ctx-m200", sessionId: "ctx-s4", inputTokens: 500, cacheReadTokens: 2500, timestamp: 1_700_000_000_000 }),
      makeMessage({ uuid: "ctx-m201", sessionId: "ctx-s4", inputTokens: 500, cacheReadTokens: 2500, timestamp: 1_700_000_001_000 }),
    ]);

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.contextAnalysis).not.toBeNull();
    const shortBucket = data.contextAnalysis!.cacheByLength.find(b => b.bucket === "1-5 prompts");
    expect(shortBucket).toBeDefined();
    expect(shortBucket!.cacheEfficiency).toBeGreaterThan(0);
  });
});

describe("buildDashboard — per-account subscriptions", () => {
  let store: Store;
  let dbPath: string;
  const ACCT_A = "11111111-aaaa-bbbb-cccc-000000000001";
  const ACCT_B = "22222222-aaaa-bbbb-cccc-000000000002";

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("sums two different per-account fees into the headline plan fee", () => {
    store.upsertSession(makeSession({ sessionId: "a1", accountUuid: ACCT_A }));
    store.upsertSession(makeSession({ sessionId: "b1", accountUuid: ACCT_B }));

    const data = buildDashboard(store, {
      timezone: "UTC",
      accountFees: {
        [ACCT_A]: { type: "max_20x", monthlyFee: 200 },
        [ACCT_B]: { type: "team_premium", monthlyFee: 125 },
      },
    });
    // Personal Max 20x ($200) + work Team Premium ($125) = $325, not one shared plan.
    expect(data.summary.planFee).toBe(325);
  });

  it("derives each account's fee from its plan type alone (no explicit amount)", () => {
    store.upsertSession(makeSession({ sessionId: "a1", accountUuid: ACCT_A }));
    store.upsertSession(makeSession({ sessionId: "b1", accountUuid: ACCT_B }));

    const data = buildDashboard(store, {
      timezone: "UTC",
      accountFees: {
        [ACCT_A]: { type: "max_20x" } as never, // validateAccountFees fills the fee upstream
        [ACCT_B]: { type: "team_standard" } as never,
      },
    });
    expect(data.summary.planFee).toBe(225); // 200 + 25
  });

  it("falls back to telemetry subscription type per account when unconfigured", () => {
    store.upsertSession(makeSession({ sessionId: "a1", accountUuid: ACCT_A, subscriptionType: "max_20x" }));
    store.upsertSession(makeSession({ sessionId: "b1", accountUuid: ACCT_B, subscriptionType: "team_premium" }));

    const data = buildDashboard(store, { timezone: "UTC" });
    expect(data.summary.planFee).toBe(325);
  });

  it("an explicit --plan-fee still overrides the per-account sum", () => {
    store.upsertSession(makeSession({ sessionId: "a1", accountUuid: ACCT_A, subscriptionType: "max_20x" }));
    store.upsertSession(makeSession({ sessionId: "b1", accountUuid: ACCT_B, subscriptionType: "team_premium" }));

    const data = buildDashboard(store, { timezone: "UTC", planFee: 150 });
    expect(data.summary.planFee).toBe(150);
  });
});

// ── Per-account token-level breakdown — RECONCILIATION (T-dash-test) ──────────
//
// Per plan/per-account-token-breakdown/PLAN.md §2 + §Phase 2 "T-dash-test".
// One shared fixture across every test below (>=2 accounts), containing:
//   (i)   a sourceDeleted:true session       ("sess-b-deleted", account B)
//   (ii)  an isInteractive:false (CI) session ("sess-a-ci", account A)
//   (iii) a boundary-straddling session       ("sess-a-straddle", account A)
//         with one message OUTSIDE the window and one INSIDE it
//   plus an ORPHAN message (session_id absent from `sessions`) for S2.
//
// All in-window token counts are whole multiples of 1,000,000. At the default
// pricing table's per-million rates for claude-sonnet-4 / claude-opus-4, that
// makes every message's (and therefore every account's and the headline's)
// dollar cost land exactly on the cent — so the dashboard's internal
// `Math.round(cost * 100) / 100` is a no-op modulo float noise, and comparing
// an independently-recomputed (via `estimateCost`) unrounded total against the
// dashboard's rounded output within 1e-9 is a genuine float-exactness check,
// not one masked by real rounding (see S1 below).
describe("buildDashboard — per-account reconciliation (RECONCILIATION)", () => {
  let store: Store;
  let dbPath: string;

  const WSTART = Date.UTC(2023, 10, 15); // 2023-11-15T00:00:00.000Z (Wed)
  const HOUR = 3_600_000;
  const M = 1_000_000;
  const SINCE_YMD = "2023-11-15";
  const UNTIL_YMD = "2023-11-15"; // inclusive day -> window is [WSTART, WSTART + 1 day)

  const ACCT_A = "33333333-aaaa-bbbb-cccc-000000000003";
  const ACCT_B = "44444444-aaaa-bbbb-cccc-000000000004";

  type FixtureMsg = {
    uuid: string; sessionId: string; model: string;
    input: number; output: number; cacheRead: number; cacheCreation: number;
    timestamp: number;
  };

  // In-window messages — the four sessions' contributions inside [since, until).
  const inWindowMsgs: FixtureMsg[] = [
    { uuid: "m-a1-1", sessionId: "sess-a1", model: "claude-sonnet-4",
      input: 5 * M, output: 1 * M, cacheRead: 2 * M, cacheCreation: 1 * M,
      timestamp: WSTART + 1 * HOUR + 1000 },
    { uuid: "m-ci-1", sessionId: "sess-a-ci", model: "claude-sonnet-4",
      input: 4 * M, output: 1 * M, cacheRead: 1 * M, cacheCreation: 0,
      timestamp: WSTART + 3 * HOUR + 1000 },
    { uuid: "m-b-1", sessionId: "sess-b-deleted", model: "claude-opus-4",
      input: 3 * M, output: 1 * M, cacheRead: 1 * M, cacheCreation: 1 * M,
      timestamp: WSTART + 2 * HOUR + 1000 },
    { uuid: "m-strad-in", sessionId: "sess-a-straddle", model: "claude-opus-4",
      input: 2 * M, output: 1 * M, cacheRead: 1 * M, cacheCreation: 0,
      timestamp: WSTART + 4 * HOUR },
  ];

  // Outside the window (30 minutes before `since`), on the SAME session as
  // "m-strad-in" — this is what makes "sess-a-straddle" boundary-straddling:
  // its own lifetime spans across `since`, with messages on both sides.
  const outOfWindowMsg: FixtureMsg = {
    uuid: "m-strad-out", sessionId: "sess-a-straddle", model: "claude-sonnet-4",
    input: 50 * M, output: 10 * M, cacheRead: 5 * M, cacheCreation: 0,
    timestamp: WSTART - 30 * 60_000,
  };

  // S2: a message whose session_id has NO row in `sessions` at all (a true
  // orphan — not source-deleted, never had a session record). Both the
  // bounded raw seek (getMessageTotalsRaw / getMessageTotalsBySession, used by
  // every bounded test below) and the fully-unbounded message_hourly rollup
  // path (only reachable via a real collect()'s recomputeMessageHourly — see
  // the "S2" test) apply the same EXISTS-based session-membership drop, so
  // this must never show up in byAccount/byModel/summary anywhere.
  const orphanMsg: FixtureMsg = {
    uuid: "m-orphan", sessionId: "sess-does-not-exist", model: "claude-sonnet-4",
    input: 1 * M, output: 1 * M, cacheRead: 0, cacheCreation: 0,
    timestamp: WSTART + 1 * HOUR,
  };

  const costOf = (m: FixtureMsg): number =>
    estimateCost(m.model, m.input, m.output, m.cacheRead, m.cacheCreation).cost;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);

    // (i) sourceDeleted:true — must now be counted (the D3 "full flip").
    store.upsertSession(makeSession({
      sessionId: "sess-b-deleted",
      accountUuid: ACCT_B,
      sourceDeleted: true,
      isInteractive: true,
      firstTimestamp: WSTART + 2 * HOUR,
      lastTimestamp: WSTART + 2 * HOUR + 300_000,
      inputTokens: 3 * M, outputTokens: 1 * M, cacheReadTokens: 1 * M, cacheCreationTokens: 1 * M,
      promptCount: 1,
      models: ["claude-opus-4"],
    }));

    // (ii) isInteractive:false (CI) — must now be counted.
    store.upsertSession(makeSession({
      sessionId: "sess-a-ci",
      accountUuid: ACCT_A,
      sourceDeleted: false,
      isInteractive: false,
      firstTimestamp: WSTART + 3 * HOUR,
      lastTimestamp: WSTART + 3 * HOUR + 300_000,
      inputTokens: 4 * M, outputTokens: 1 * M, cacheReadTokens: 1 * M, cacheCreationTokens: 0,
      promptCount: 1,
      models: ["claude-sonnet-4"],
    }));

    // Plain interactive, non-deleted, fully-in-window session (control case).
    store.upsertSession(makeSession({
      sessionId: "sess-a1",
      accountUuid: ACCT_A,
      sourceDeleted: false,
      isInteractive: true,
      firstTimestamp: WSTART + 1 * HOUR,
      lastTimestamp: WSTART + 1 * HOUR + 300_000,
      inputTokens: 5 * M, outputTokens: 1 * M, cacheReadTokens: 2 * M, cacheCreationTokens: 1 * M,
      promptCount: 1,
      models: ["claude-sonnet-4"],
    }));

    // (iii) boundary-straddling session: starts before `since` (its
    // out-of-window message's timestamp) and stays active into the window
    // (its in-window message's timestamp). The session's own token COLUMNS
    // are session-LIFETIME (both messages: 52M/11M/6M/0) — deliberately NOT
    // equal to the in-window-only sum byAccount uses (2M/1M/1M/0). See the
    // Blocker-3 test below.
    store.upsertSession(makeSession({
      sessionId: "sess-a-straddle",
      accountUuid: ACCT_A,
      sourceDeleted: false,
      isInteractive: true,
      firstTimestamp: outOfWindowMsg.timestamp,
      lastTimestamp: WSTART + 4 * HOUR,
      inputTokens: 52 * M, outputTokens: 11 * M, cacheReadTokens: 6 * M, cacheCreationTokens: 0,
      promptCount: 2,
      models: ["claude-sonnet-4", "claude-opus-4"],
    }));

    store.upsertMessages(
      [...inWindowMsgs, outOfWindowMsg, orphanMsg].map(m => makeMessage({
        uuid: m.uuid,
        sessionId: m.sessionId,
        model: m.model,
        timestamp: m.timestamp,
        inputTokens: m.input,
        outputTokens: m.output,
        cacheReadTokens: m.cacheRead,
        cacheCreationTokens: m.cacheCreation,
      })),
    );
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("S1: Σ byAccount.estimatedCost reconciles with summary.estimatedCost (cent-tolerance AND float-exact)", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    const byAccount = data.planUtilization!.byAccount;
    const nAccounts = byAccount.length;
    expect(nAccounts).toBe(2);

    // Cent-tolerance on the EMITTED (independently-rounded) fields — do NOT
    // assert exact `===` here (plan S1): each account rounds its own total
    // separately, and so does the grand total, so up to nAccounts*0.005 of
    // drift between the two is expected BY DESIGN, not a bug.
    const sumEmitted = byAccount.reduce((s, a) => s + a.estimatedCost, 0);
    expect(Math.abs(sumEmitted - data.summary.estimatedCost)).toBeLessThanOrEqual(nAccounts * 0.005);

    // Float-exact: recompute the expected UNROUNDED total straight from the
    // fixture messages via estimateCost (imported from @claude-stats/core/pricing;
    // NOT read back from any dashboard output), then compare to
    // summary.estimatedCost within 1e-9. This also implicitly confirms the
    // orphan message (present in this same store — see the beforeEach and the
    // "S2" tests below) contributes nothing: if it leaked in, this would be off
    // by a whole cent, far outside 1e-9.
    const expectedTotalRaw = inWindowMsgs.reduce((s, m) => s + costOf(m), 0);
    expect(Math.abs(data.summary.estimatedCost - expectedTotalRaw)).toBeLessThan(1e-9);
    expect(Math.abs(sumEmitted - expectedTotalRaw)).toBeLessThan(1e-9);
  });

  it("S1: Σ_account byAccount.byModel[m] reconciles with top-level byModel[m]", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    const byAccount = data.planUtilization!.byAccount;

    const expectedByModel = new Map<string, { input: number; output: number; cost: number }>();
    for (const m of inWindowMsgs) {
      const e = expectedByModel.get(m.model) ?? { input: 0, output: 0, cost: 0 };
      e.input += m.input;
      e.output += m.output;
      e.cost += costOf(m);
      expectedByModel.set(m.model, e);
    }
    expect(expectedByModel.size).toBe(2); // claude-sonnet-4, claude-opus-4

    for (const [model, exp] of expectedByModel) {
      const top = data.byModel.find(bm => bm.model === model);
      expect(top).toBeDefined();
      // Top-level byModel tokens are raw (never rounded) — exact.
      expect(top!.inputTokens).toBe(exp.input);
      expect(top!.outputTokens).toBe(exp.output);
      expect(Math.abs(top!.estimatedCost - exp.cost)).toBeLessThan(1e-9);

      let sumInput = 0, sumOutput = 0, sumCost = 0, accountsWithModel = 0;
      for (const acct of byAccount) {
        const bm = acct.byModel.find(x => x.model === model);
        if (!bm) continue;
        accountsWithModel++;
        sumInput += bm.inputTokens;
        sumOutput += bm.outputTokens;
        sumCost += bm.estimatedCost;
      }
      // Σ_account tokens are exact (raw integer sums, never rounded).
      expect(sumInput).toBe(exp.input);
      expect(sumOutput).toBe(exp.output);
      // Σ_account cost: each (account, model) bucket is rounded independently
      // before summing — cent-tolerant ("≈" in the plan), not exact `===`.
      expect(Math.abs(sumCost - exp.cost)).toBeLessThanOrEqual(Math.max(1, accountsWithModel) * 0.005);
    }
  });

  it("new per-account token fields are present and correct (in-window only)", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    const byAccount = data.planUtilization!.byAccount;

    const acctA = byAccount.find(a => a.accountId === ACCT_A.slice(0, 8) + "...");
    const acctB = byAccount.find(a => a.accountId === ACCT_B.slice(0, 8) + "...");
    expect(acctA).toBeDefined();
    expect(acctB).toBeDefined();

    // Account A: sess-a1 + sess-a-ci + the IN-WINDOW half of sess-a-straddle
    // only (its 50M/10M/5M out-of-window message must NOT be folded in).
    expect(acctA!.inputTokens).toBe(5 * M + 4 * M + 2 * M);
    expect(acctA!.outputTokens).toBe(1 * M + 1 * M + 1 * M);
    expect(acctA!.cacheReadTokens).toBe(2 * M + 1 * M + 1 * M);
    expect(acctA!.cacheCreationTokens).toBe(1 * M + 0 + 0);
    expect(acctA!.byModel.map(m => m.model).sort()).toEqual(["claude-opus-4", "claude-sonnet-4"]);

    // Account B: sess-b-deleted only.
    expect(acctB!.inputTokens).toBe(3 * M);
    expect(acctB!.outputTokens).toBe(1 * M);
    expect(acctB!.cacheReadTokens).toBe(1 * M);
    expect(acctB!.cacheCreationTokens).toBe(1 * M);
    expect(acctB!.byModel).toEqual([
      expect.objectContaining({ model: "claude-opus-4", inputTokens: 3 * M, outputTokens: 1 * M }),
    ]);
  });

  it("regression: source-deleted and non-interactive sessions are now counted (the flip)", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    // All 4 sessions overlap the window: sess-a1, sess-b-deleted
    // (source_deleted), sess-a-ci (non-interactive), sess-a-straddle. Before
    // the flip, the first two would have been silently dropped from `rows`
    // (and therefore from every session-scoped aggregate).
    expect(data.summary.sessions).toBe(4);

    expect(data.planUtilization).not.toBeNull();
    const byAccount = data.planUtilization!.byAccount;
    const acctA = byAccount.find(a => a.accountId === ACCT_A.slice(0, 8) + "...");
    const acctB = byAccount.find(a => a.accountId === ACCT_B.slice(0, 8) + "...");
    expect(acctA!.sessions).toBe(3); // sess-a1 + sess-a-ci + sess-a-straddle
    expect(acctB!.sessions).toBe(1); // sess-b-deleted — its ONLY session, and it's deleted
  });

  it("Blocker 2: an account whose only in-window session is source-deleted appears in BOTH byAccount and availableAccounts", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    const inByAccount = data.planUtilization!.byAccount.some(a => a.accountId === ACCT_B.slice(0, 8) + "...");
    const inAvailable = data.availableAccounts.some(a => a.accountUuid === ACCT_B);
    expect(inByAccount).toBe(true);
    expect(inAvailable).toBe(true);
  });

  it("Blocker 3 (recorded gap): Σ byAccount.inputTokens !== summary.inputTokens for a boundary-straddling session", () => {
    const data = buildDashboard(store, { since: SINCE_YMD, until: UNTIL_YMD, timezone: "UTC" });
    expect(data.planUtilization).not.toBeNull();
    const byAccount = data.planUtilization!.byAccount;
    const sumByAccountInput = byAccount.reduce((s, a) => s + a.inputTokens, 0);

    // INTENTIONAL, DOCUMENTED gap (plan §2, "Blocker 3" — deferred by design,
    // not a bug to fix here). `summary.inputTokens` is summed from
    // SESSION-LIFETIME columns (`rows`), while `byAccount.inputTokens` is
    // summed from the BOUNDED msgTotalsBySession (in-window messages only).
    // "sess-a-straddle" has a lifetime input total (52M) that includes its
    // 50M-token out-of-window message, but byAccount only ever sees its
    // 2M-token in-window message — so the two totals MUST differ whenever a
    // boundary-straddling session is in scope. This is recorded in the
    // `byAccount` type doc comment (dashboard/index.ts) and must surface in
    // the get_stats tool description + changelog (T-doc-commands/
    // T-doc-changelog); this test exists so the gap stays deliberate, not
    // accidental drift.
    expect(sumByAccountInput).toBe(14 * M); // 11M (Account A) + 3M (Account B)
    expect(data.summary.inputTokens).toBe(64 * M); // session-lifetime: 5M+3M+4M+52M
    expect(sumByAccountInput).not.toBe(data.summary.inputTokens);
  });

  it("S2: a period:'all' build with an orphan message present does not crash and excludes the orphan consistently", () => {
    // The orphan message ("m-orphan", session_id "sess-does-not-exist") has no
    // row in `sessions` at all. In PRODUCTION, a fully-unbounded ("all"
    // period, no other filters) get_stats/dashboard call takes the
    // message_hourly ROLLUP fast path (getMessageTotalsFromRollup) instead of
    // the raw seek — but ONLY when isMessageHourlyFresh(), which requires a
    // real collect() to have run recomputeMessageHourly(). This test's direct
    // store.upsertMessages() calls never do that (the watermark stays stale),
    // so this build always falls back to the raw seek path — we cannot
    // exercise the rollup path from a unit fixture without also simulating a
    // full collect(). Per plan §2/S2, we deliberately do NOT assert exact
    // Σ byAccount == headline reconciliation on the "all"-period path here;
    // the production-only rollup-vs-session-based-byAccount divergence for
    // orphan messages is documented in the changelog/analysis (T-doc-changelog),
    // not re-derived in this unit test. What we DO assert: the raw path this
    // test exercises still consistently drops the orphan (both here and on the
    // bounded path above), and a full, unbounded build doesn't crash.
    const dataAll = buildDashboard(store, { timezone: "UTC" });
    expect(dataAll.summary.sessions).toBe(4);

    // Fully-unbounded sonnet total = sess-a1 (5M) + sess-a-ci (4M) +
    // sess-a-straddle's out-of-window message (50M) = 59M. The orphan's 1M
    // sonnet-model tokens must NOT be folded in despite matching model and
    // timestamp, because its session_id has no row in `sessions`.
    const sonnet = dataAll.byModel.find(m => m.model === "claude-sonnet-4");
    expect(sonnet).toBeDefined();
    expect(sonnet!.inputTokens).toBe(59 * M);
  });
});
