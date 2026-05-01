import { describe, it, expect } from "vitest";
import { renderDashboard } from "../server/template.js";
import type { DashboardData } from "../dashboard/index.js";
import type { TranslateFn } from "../server/template.js";
import { initI18n } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const enDashboard = require("@claude-stats/core/locales/en/dashboard.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;

const mockData: DashboardData = {
  generated: "2026-01-15T10:00:00.000Z",
  period: "week",
  timezone: "UTC",
  summary: {
    sessions: 42,
    prompts: 150,
    inputTokens: 500000,
    outputTokens: 80000,
    cacheReadTokens: 200000,
    cacheCreationTokens: 50000,
    cacheEfficiency: 28.6,
    estimatedCost: 3.75,
    totalDurationMs: 7200000,
    planFee: 0,
    planMultiplier: 0,
    costPerPrompt: 0,
    costPerActiveHour: 0,
    dailyValueRate: 0,
    tokensPerMinute: 0,
    outputTokensPerPrompt: 0,
    promptsPerHour: 0,
    totalActiveHours: 2.0,
    avgSessionDurationMinutes: 2.9,
    truncatedOutputs: 0,
    currentWindowStart: null,
    currentWindowPrompts: 0,
    currentWindowCost: 0,
    subagentSessions: 0,
    parentSessionsWithChildren: 0,
  },
  byDay: [
    {
      date: "2026-01-14",
      sessions: 5,
      prompts: 20,
      inputTokens: 100000,
      outputTokens: 15000,
      cacheReadTokens: 80000,
      cacheCreationTokens: 20000,
      estimatedCost: 0.75,
    },
    {
      date: "2026-01-15",
      sessions: 8,
      prompts: 30,
      inputTokens: 150000,
      outputTokens: 25000,
      cacheReadTokens: 120000,
      cacheCreationTokens: 30000,
      estimatedCost: 1.10,
    },
  ],
  byProject: [
    {
      projectPath: "/home/user/myproject",
      sessions: 10,
      prompts: 50,
      inputTokens: 200000,
      outputTokens: 30000,
      estimatedCost: 1.50,
      thinkingBlocks: 120,
      workProfile: { exploring: 45, editing: 30, running: 15, researching: 5, planning: 5 },
    },
  ],
  byModel: [
    {
      model: "claude-opus-4-5",
      inputTokens: 300000,
      outputTokens: 50000,
      estimatedCost: 2.50,
    },
    {
      model: "claude-sonnet-4-5",
      inputTokens: 200000,
      outputTokens: 30000,
      estimatedCost: 1.25,
    },
  ],
  byEntrypoint: [
    { entrypoint: "claude", sessions: 35 },
    { entrypoint: "claude-vscode", sessions: 7 },
  ],
  stopReasons: [
    { reason: "end_turn", count: 120 },
    { reason: "tool_use", count: 28 },
    { reason: "max_tokens", count: 2 },
  ],
  sinceIso: "2026-01-09",
  byHour: [],
  byWindow: [],
  byConversationCost: [],
  byWeek: [],
  planUtilization: null,
  modelEfficiency: null,
  contextAnalysis: null,
  spending: null,
  energy: null,
  recommendations: [],
};

describe("renderDashboard", () => {
  it("returns a string starting with <!DOCTYPE html", () => {
    const html = renderDashboard(mockData, t);
    expect(typeof html).toBe("string");
    expect(html).toContain("<!DOCTYPE html");
  });

  it("contains session count from summary bar", () => {
    const html = renderDashboard(mockData, t);
    // The sessions value is 42 — it must appear in the rendered output
    expect(html).toContain("42");
  });

  it("contains window.__DASHBOARD__ assignment with valid JSON", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain("window.__DASHBOARD__");

    // Extract the JSON payload between the assignment and semicolon
    const match = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    expect(match).not.toBeNull();

    const parsed = JSON.parse(match![1]!);
    expect(parsed.period).toBe("week");
    expect(parsed.summary.sessions).toBe(42);
    expect(parsed.byModel).toHaveLength(2);
  });

  it("contains all 6 canvas IDs", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="chart-daily"');
    expect(html).toContain('id="chart-model"');
    expect(html).toContain('id="chart-project"');
    expect(html).toContain('id="chart-entrypoint"');
    expect(html).toContain('id="chart-stops"');
    expect(html).toContain('id="chart-cache"');
  });

  it("handles empty byDay array without crashing", () => {
    const emptyDay: DashboardData = {
      ...mockData,
      byDay: [],
    };
    let html: string;
    expect(() => {
      html = renderDashboard(emptyDay, t);
    }).not.toThrow();
    expect(html!).toContain("<!DOCTYPE html");
    expect(html!).toContain("window.__DASHBOARD__");
  });

  it("is pure — same input produces identical output on repeated calls", () => {
    const first = renderDashboard(mockData, t);
    const second = renderDashboard(mockData, t);
    expect(first).toBe(second);
  });

  it("includes the generated timestamp in the <title>", () => {
    const html = renderDashboard(mockData, t);
    // generated is "2026-01-15T10:00:00.000Z" — the date portion should appear in title
    expect(html).toContain("<title>");
    expect(html).toContain("2026-01-15");
  });

  it("pre-selects the correct period option", () => {
    const html = renderDashboard(mockData, t);
    // The period is "week" so that option should have selected attribute
    expect(html).toContain('<option value="week" selected>');
  });

  it("includes Chart.js CDN script tag", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain("https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js");
  });

  it("includes period selector element", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="period-select"');
    expect(html).toContain('<option value="day"');
    expect(html).toContain('<option value="week"');
    expect(html).toContain('<option value="month"');
    expect(html).toContain('<option value="all"');
  });

  it("includes auto-refresh toggle button", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="refresh-btn"');
  });

  it("includes auto-refresh script logic with setTimeout", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain("setTimeout");
    expect(html).toContain("location.reload");
    expect(html).toContain("refresh");
  });

  it("window.__DASHBOARD__ JSON contains full data structure", () => {
    const html = renderDashboard(mockData, t);
    const match = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as DashboardData;

    expect(parsed.generated).toBe("2026-01-15T10:00:00.000Z");
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.byDay).toHaveLength(2);
    expect(parsed.byProject).toHaveLength(1);
    expect(parsed.byEntrypoint).toHaveLength(2);
    expect(parsed.stopReasons).toHaveLength(3);
    expect(parsed.byWindow).toEqual([]);
    expect(parsed.byConversationCost).toEqual([]);
  });

  it("shows Plan Value card when planFee > 0", () => {
    const withPlan: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 100, planMultiplier: 3.75 },
    };
    const html = renderDashboard(withPlan, t);
    expect(html).toContain("Plan Value");
    expect(html).toContain("3.8×");
  });

  it("hides Plan Value card when planFee is 0", () => {
    const html = renderDashboard(mockData, t); // planFee: 0
    expect(html).not.toContain("Plan Value");
  });

  it("shows truncated outputs card when truncatedOutputs > 0", () => {
    const withTruncations: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, truncatedOutputs: 3 },
    };
    const html = renderDashboard(withTruncations, t);
    expect(html).toContain("Truncated Outputs");
    expect(html).toContain(">3<");
  });

  it("includes cumulative usage chart canvas", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="chart-cumulative"');
  });

  it("renders usage windows chart when byWindow is non-empty", () => {
    const withWindows: DashboardData = {
      ...mockData,
      byWindow: [{
        windowStart: 1_000_000,
        windowEnd: 1_018_000,
        accountUuid: null,
        totalCostEquivalent: 1.5,
        promptCount: 10,
        tokensByModel: {},
        throttled: false,
      }],
    };
    const html = renderDashboard(withWindows, t);
    expect(html).toContain('id="chart-windows"');
  });

  it("renders conversation cost chart when byConversationCost is non-empty", () => {
    const withCosts: DashboardData = {
      ...mockData,
      byConversationCost: [{
        sessionId: "abc123",
        projectPath: "/proj/foo",
        durationMs: 60000,
        estimatedCost: 0.25,
        percentOfPlanFee: 0,
        dominantModel: "claude-opus-4",
        promptCount: 5,
        isSubagent: false,
        childCount: 0,
      }],
    };
    const html = renderDashboard(withCosts, t);
    expect(html).toContain('id="chart-conv-cost"');
  });

  it("does not render window/conv-cost canvases when arrays are empty", () => {
    const html = renderDashboard(mockData, t);
    expect(html).not.toContain('id="chart-windows"');
    expect(html).not.toContain('id="chart-conv-cost"');
  });

  it("includes pricing panel with model rates", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="pricing-panel"');
    expect(html).toContain("Token Pricing");
    expect(html).toContain("claude-opus-4");
    expect(html).toContain("claude-sonnet-4");
    expect(html).toContain("claude-haiku-4");
    expect(html).toContain("$15"); // opus input
    expect(html).toContain("$75"); // opus output
  });

  it("includes pricing source attribution", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain("Anthropic API pricing");
    expect(html).toContain("last updated");
    expect(html).toContain("equivalent API rates");
  });

  it("includes pricing panel at the bottom of the page", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain("pricing-panel");
    // Pricing panel should appear after the last tab-panel and before the footer
    const pricingIdx = html.indexOf("pricing-panel");
    const footerIdx = html.indexOf('class="footer"');
    expect(pricingIdx).toBeLessThan(footerIdx);
  });

  it("includes Plan tab button", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('data-tab="plan"');
    expect(html).toContain(">Plan<");
  });

  it("renders Plan tab with no-data message when planUtilization is null", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="tab-plan"');
    expect(html).toContain("Not enough usage data");
  });

  it("renders Plan tab with utilization data when present", () => {
    const withPlanUtil: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 100, planMultiplier: 2.5 },
      byWeek: [
        { week: "2026-01-13", sessions: 10, prompts: 50, estimatedCost: 25.0, activeHoursEstimate: 5.0, windowCount: 3, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 23.09,
        avgWeeklyCost: 25.0,
        peakWeeklyCost: 25.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 8.33,
        medianWindowCost: 8.33,
        windowsPerWeek: 3.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 3,
        recommendedPlan: "max_5x",
        currentPlanVerdict: "good-value",
        byAccount: [],
      },
    };
    const html = renderDashboard(withPlanUtil, t);
    expect(html).toContain("Plan Verdict");
    expect(html).toContain("Good Value");
    expect(html).toContain("Suggested Plan");
    expect(html).toContain("Max 5x");
    expect(html).toContain("Avg Weekly Value");
    expect(html).toContain('id="chart-weekly-activity"');
  });

  it("renders underusing verdict when utilization is low", () => {
    const underusing: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 200, planMultiplier: 0.3 },
      byWeek: [
        { week: "2026-01-13", sessions: 2, prompts: 5, estimatedCost: 3.0, activeHoursEstimate: 0.5, windowCount: 1, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 46.19,
        avgWeeklyCost: 3.0,
        peakWeeklyCost: 3.0,
        weeksBelowPlan: 1,
        weeksAbovePlan: 0,
        totalWeeks: 1,
        avgWindowCost: 3.0,
        medianWindowCost: 3.0,
        windowsPerWeek: 1.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 1,
        recommendedPlan: "pro",
        currentPlanVerdict: "underusing",
        byAccount: [],
      },
    };
    const html = renderDashboard(underusing, t);
    expect(html).toContain("Underusing");
  });

  it("renders truncated-output windows in plan tab when present", () => {
    const withThrottled: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 100, planMultiplier: 1.5 },
      byWeek: [
        { week: "2026-01-13", sessions: 10, prompts: 50, estimatedCost: 30.0, activeHoursEstimate: 8.0, windowCount: 5, windowsWithTruncatedOutput: 2 },
      ],
      planUtilization: {
        weeklyPlanBudget: 23.09,
        avgWeeklyCost: 30.0,
        peakWeeklyCost: 30.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 6.0,
        medianWindowCost: 6.0,
        windowsPerWeek: 5.0,
        truncatedOutputWindowPercent: 40.0,
        totalWindows: 5,
        recommendedPlan: "max_5x",
        currentPlanVerdict: "good-value",
        byAccount: [],
      },
    };
    const html = renderDashboard(withThrottled, t);
    expect(html).toContain("Trunc. Output");
    expect(html).toContain("40%");
  });

  it("renders multi-account breakdown when multiple accounts present", () => {
    const multiAcct: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 0, planMultiplier: 0 },
      byWeek: [
        { week: "2026-01-13", sessions: 10, prompts: 50, estimatedCost: 25.0, activeHoursEstimate: 5.0, windowCount: 3, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 27.71,
        avgWeeklyCost: 25.0,
        peakWeeklyCost: 25.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 8.33,
        medianWindowCost: 8.33,
        windowsPerWeek: 3.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 3,
        recommendedPlan: "max_5x",
        currentPlanVerdict: "good-value",
        byAccount: [
          { accountId: "acct-wor...", emailAddress: "work@example.com", subscriptionType: "max_5x", detectedPlanFee: 100, sessions: 7, estimatedCost: 20.0, planVerdict: "underusing" },
          { accountId: "acct-per...", emailAddress: "personal@example.com", subscriptionType: "pro", detectedPlanFee: 20, sessions: 3, estimatedCost: 5.0, planVerdict: "underusing" },
        ],
      },
    };
    const html = renderDashboard(multiAcct, t);
    expect(html).toContain("2 accounts detected");
    // Should prefer email over truncated UUID
    expect(html).toContain("work@example.com");
    expect(html).toContain("personal@example.com");
    expect(html).toContain("max_5x");
    expect(html).toContain("Max 5x");
  });

  it("shows auto-detected fee source when no manual planFee", () => {
    const autoDetected: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 0, planMultiplier: 0 },
      byWeek: [
        { week: "2026-01-13", sessions: 5, prompts: 20, estimatedCost: 15.0, activeHoursEstimate: 3.0, windowCount: 2, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 4.62,
        avgWeeklyCost: 15.0,
        peakWeeklyCost: 15.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 7.5,
        medianWindowCost: 7.5,
        windowsPerWeek: 2.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 2,
        recommendedPlan: "pro",
        currentPlanVerdict: "good-value",
        byAccount: [{ accountId: "acct-111...", emailAddress: null, subscriptionType: "pro", detectedPlanFee: 20, sessions: 5, estimatedCost: 15.0, planVerdict: "good-value" }],
      },
    };
    const html = renderDashboard(autoDetected, t);
    expect(html).toContain("Account");
    expect(html).toContain("acct-111...");  // Falls back to UUID when no email
    expect(html).toContain("Pro");
    expect(html).toContain("$20/mo");
  });

  it("renders Current Plan card from subscriptionType telemetry", () => {
    const withPlan: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 0, planMultiplier: 0 },
      byWeek: [
        { week: "2026-01-13", sessions: 5, prompts: 20, estimatedCost: 15.0, activeHoursEstimate: 3.0, windowCount: 2, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 4.62,
        avgWeeklyCost: 15.0,
        peakWeeklyCost: 15.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 7.5,
        medianWindowCost: 7.5,
        windowsPerWeek: 2.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 2,
        recommendedPlan: "pro",
        currentPlanVerdict: "good-value",
        byAccount: [{ accountId: "acct-111...", emailAddress: "user@example.com", subscriptionType: "max_5x", detectedPlanFee: 100, sessions: 5, estimatedCost: 15.0, planVerdict: "good-value" }],
      },
    };
    const html = renderDashboard(withPlan, t);
    expect(html).toContain("Account");
    expect(html).toContain("user@example.com");
    expect(html).toContain("Max 5x");
    expect(html).toContain("$100/mo");
  });

  it("renders Current Plan card from fee fallback when no accounts", () => {
    const withPlan: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 100, planMultiplier: 2.5 },
      byWeek: [
        { week: "2026-01-13", sessions: 10, prompts: 50, estimatedCost: 25.0, activeHoursEstimate: 5.0, windowCount: 3, windowsWithTruncatedOutput: 0 },
      ],
      planUtilization: {
        weeklyPlanBudget: 23.09,
        avgWeeklyCost: 25.0,
        peakWeeklyCost: 25.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 8.33,
        medianWindowCost: 8.33,
        windowsPerWeek: 3.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 3,
        recommendedPlan: "max_5x",
        currentPlanVerdict: "good-value",
        byAccount: [],
      },
    };
    const html = renderDashboard(withPlan, t);
    expect(html).toContain("Current Plan");
    expect(html).toContain("Max 5x ($100/mo)");
  });

  it("renders Window Limit Usage chart when byWindow is non-empty", () => {
    const withWindows: DashboardData = {
      ...mockData,
      summary: { ...mockData.summary, planFee: 100, planMultiplier: 2.5 },
      byWeek: [
        { week: "2026-01-13", sessions: 5, prompts: 20, estimatedCost: 15.0, activeHoursEstimate: 3.0, windowCount: 2, windowsWithTruncatedOutput: 0 },
      ],
      byWindow: [{
        windowStart: 1_000_000,
        windowEnd: 1_018_000,
        accountUuid: null,
        totalCostEquivalent: 1.5,
        promptCount: 10,
        tokensByModel: {},
        throttled: false,
      }],
      planUtilization: {
        weeklyPlanBudget: 23.09,
        avgWeeklyCost: 15.0,
        peakWeeklyCost: 15.0,
        weeksBelowPlan: 0,
        weeksAbovePlan: 1,
        totalWeeks: 1,
        avgWindowCost: 1.5,
        medianWindowCost: 1.5,
        windowsPerWeek: 2.0,
        truncatedOutputWindowPercent: 0,
        totalWindows: 1,
        recommendedPlan: "max_5x",
        currentPlanVerdict: "good-value",
        byAccount: [],
      },
    };
    const html = renderDashboard(withWindows, t);
    expect(html).toContain('id="chart-window-limit-pct"');
  });

  it("does not render 5-Hour Window Utilization histogram", () => {
    const withWindows: DashboardData = {
      ...mockData,
      byWindow: [{
        windowStart: 1_000_000,
        windowEnd: 1_018_000,
        accountUuid: null,
        totalCostEquivalent: 1.5,
        promptCount: 10,
        tokensByModel: {},
        throttled: false,
      }],
    };
    const html = renderDashboard(withWindows, t);
    expect(html).not.toContain('id="chart-window-util"');
  });

  it("renders compaction events as a count instead of a chart", () => {
    const withContext: DashboardData = {
      ...mockData,
      contextAnalysis: {
        avgPromptsPerSession: 10,
        medianPromptsPerSession: 8,
        compactionRate: 50,
        avgPeakInputTokens: 100_000,
        sessionsNeedingCompaction: 1,
        lengthDistribution: [],
        contextGrowthCurve: [],
        longSessions: [],
        cacheByLength: [],
        compactionEvents: [
          { sessionId: "s1", promptPosition: 5, tokensBefore: 80_000, tokensAfter: 30_000, reductionPercent: 62 },
          { sessionId: "s2", promptPosition: 8, tokensBefore: 120_000, tokensAfter: 50_000, reductionPercent: 58 },
        ],
      },
    };
    const html = renderDashboard(withContext, t);
    expect(html).toContain("Compaction Events");
    // Should show the count, not a chart canvas
    expect(html).not.toContain('id="chart-compaction-events"');
    expect(html).toContain(">2<");
    expect(html).toContain("2 sessions");
  });

  it("pricing panel starts hidden (visible only on overview tab via JS)", () => {
    const html = renderDashboard(mockData, t);
    // Panel should exist but not have the visible class in the initial HTML
    expect(html).toContain('id="pricing-panel"');
    expect(html).toContain('class="pricing-panel"');
    expect(html).not.toContain('class="pricing-panel visible"');
    // JS should toggle visibility based on tab
    expect(html).toContain("pricingPanel");
    expect(html).toContain("overview");
  });

  it("includes efficiency tab button when modelEfficiency is present", () => {
    const withEff: DashboardData = {
      ...mockData,
      modelEfficiency: {
        byModelAndTier: [],
        summary: { totalMessages: 10, classifiedMessages: 8, totalCost: 1.0, potentialSavings: 0.5, overusePercent: 25 },
        opusScoreDistribution: [],
        topOveruse: [],
      },
    };
    const html = renderDashboard(withEff, t);
    expect(html).toContain('data-tab="efficiency"');
    expect(html).toContain("Potential Savings");
  });

  it("includes Settings tab with plan type select and monthly fee input", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('data-tab="settings"');
    expect(html).toContain('id="tab-settings"');
    expect(html).toContain('id="cfg-plan-type"');
    expect(html).toContain('id="cfg-monthly-fee"');
    expect(html).toContain('id="cfg-threshold-day"');
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('/api/config');
  });

  it("settings config I/O uses webview postMessage bridge when __vscodeApi is present", () => {
    const html = renderDashboard(mockData, t);
    // Verify the environment detection and both transport paths are present
    expect(html).toContain("window.__vscodeApi");
    expect(html).toContain("postMessage({ command: 'getConfig'");
    expect(html).toContain("postMessage({ command: 'saveConfig'");
    expect(html).toContain("command === 'configResult'");
    // Browser fallback path
    expect(html).toContain("fetch('/api/config'");
  });

  // ─── XSS hardening (B6/SF15) ────────────────────────────────────────────────
  describe("XSS hardening", () => {
    /** Extract the substring of rendered HTML that's outside the inline JSON
     *  payload between `window.__DASHBOARD__ = {…};</script>`. We want to
     *  assert no raw attacker string appears in the HTML body; inside the JSON
     *  it's fine because `<` is already \\u003c-escaped. */
    const htmlOutsideJson = (html: string): string => {
      const match = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
      if (!match) return html;
      return html.replace(match[1]!, "");
    };

    it("escapes projectPath so </script> breakout is neutralized in the DOM", () => {
      const malicious: DashboardData = {
        ...mockData,
        spending: {
          cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 },
          subagentOverhead: { agentCount: 0, totalCost: 0, estimatedCost: 0 },
          topSessionsByCost: [
            {
              sessionId: "abc",
              projectPath: "</script><img src=x onerror=alert(1)>",
              durationMs: 60000,
              estimatedCost: 0.25,
              percentOfPlanFee: 0,
              dominantModel: "claude-opus-4",
              promptCount: 5,
              isSubagent: false,
              childCount: 0,
            },
          ],
          expensivePrompts: [],
          mcpServerUsage: [],
        } as unknown as DashboardData["spending"],
      };
      const html = renderDashboard(malicious, t);
      const body = htmlOutsideJson(html);
      // Raw attacker markup must NOT appear outside the JSON payload.
      expect(body).not.toContain("</script><img src=x onerror=alert(1)>");
      expect(body).not.toContain("<img src=x onerror=alert(1)>");
      // The escaped form must be present — in the project cell AND the title attr.
      expect(body).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    });

    it("escapes promptPreview so injected <script> does not appear as a real tag", () => {
      const malicious: DashboardData = {
        ...mockData,
        spending: {
          cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 },
          subagentOverhead: { agentCount: 0, totalCost: 0, estimatedCost: 0 },
          topSessionsByCost: [],
          expensivePrompts: [
            {
              sessionId: "s1",
              projectPath: "/p",
              promptPreview: "<script>alert(1)</script>",
              totalTokens: 1000,
              estimatedCost: 0.5,
              timesAvg: 2,
              flags: ["<svg onload=alert(1)>"],
            } as unknown as DashboardData["spending"] extends (infer U) ? U extends { expensivePrompts: (infer P)[] } ? P : never : never,
          ],
          mcpServerUsage: [],
        } as unknown as DashboardData["spending"],
      };
      const html = renderDashboard(malicious, t);
      const body = htmlOutsideJson(html);
      // The attacker's literal opening tag must not round-trip to the body.
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain("<svg onload=alert(1)>");
      // But the escaped form should be there.
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(body).toContain("&lt;svg onload=alert(1)&gt;");
    });

    it("escapes dominantModel so <img> in the model name is neutralized", () => {
      const malicious: DashboardData = {
        ...mockData,
        spending: {
          cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 },
          subagentOverhead: { agentCount: 0, totalCost: 0, estimatedCost: 0 },
          topSessionsByCost: [
            {
              sessionId: "abc",
              projectPath: "/safe/project",
              durationMs: 60000,
              estimatedCost: 0.25,
              percentOfPlanFee: 0,
              dominantModel: "claude-<img src=x onerror=alert(1)>-evil",
              promptCount: 5,
              isSubagent: false,
              childCount: 0,
            },
          ],
          expensivePrompts: [],
          mcpServerUsage: [],
        } as unknown as DashboardData["spending"],
      };
      const html = renderDashboard(malicious, t);
      const body = htmlOutsideJson(html);
      expect(body).not.toContain("<img src=x onerror=alert(1)>");
      // The literal "claude-" prefix is stripped (`.replace("claude-", "")`),
      // so the remaining escaped payload should be present:
      expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;-evil");
    });

    it("JSON-in-script payload escapes `<` so </script> cannot break out", () => {
      const malicious: DashboardData = {
        ...mockData,
        byProject: [
          {
            projectPath: "</script><img src=x onerror=alert(1)>",
            sessions: 1,
            prompts: 1,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
            thinkingBlocks: 0,
            workProfile: { exploring: 0, editing: 0, running: 0, researching: 0, planning: 0 },
          },
        ],
      };
      const html = renderDashboard(malicious, t);
      // The JSON payload must not contain a raw </script> — the leading `<`
      // must be escaped to < so the surrounding <script> block cannot
      // be broken out of.
      const jsonRegion = html.match(/window\.__DASHBOARD__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
      expect(jsonRegion).not.toBeNull();
      const jsonText = jsonRegion![1]!;
      expect(jsonText).not.toContain("</script>");
      expect(jsonText).toContain("\\u003c/script>");
      // And the payload must still parse back as valid JSON with the raw value preserved.
      const parsed = JSON.parse(jsonText) as DashboardData;
      expect(parsed.byProject[0]!.projectPath).toBe("</script><img src=x onerror=alert(1)>");
    });

    it("escapes MCP server name so injected markup is neutralized", () => {
      const malicious: DashboardData = {
        ...mockData,
        spending: {
          cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 },
          subagentOverhead: { agentCount: 0, totalCost: 0, estimatedCost: 0 },
          topSessionsByCost: [],
          expensivePrompts: [],
          mcpServerUsage: [
            {
              server: "<script>alert(1)</script>",
              estimatedCost: 1,
              inputTokens: 100,
              outputTokens: 50,
              callCount: 1,
              messageCount: 1,
              tools: [{ method: "<b>evil</b>", calls: 1 }],
            } as unknown as NonNullable<DashboardData["spending"]>["mcpServerUsage"] extends (infer U)[] ? U : never,
          ],
        } as unknown as DashboardData["spending"],
      };
      const html = renderDashboard(malicious, t);
      const body = htmlOutsideJson(html);
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain("<b>evil</b>");
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });
});
