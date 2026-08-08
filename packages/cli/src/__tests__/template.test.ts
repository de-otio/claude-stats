import { describe, it, expect } from "vitest";
import { renderDashboard } from "../server/template.js";
import type { DashboardData } from "../dashboard/index.js";
import type { TranslateFn } from "../server/template.js";
import { initI18n } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Deliberately NOT `require("@claude-stats/core/locales/en/dashboard.json")`:
// that's a raw Node `require`, unaffected by Vite/vitest aliasing, and Node's
// own package resolution from inside a git worktree (no local node_modules)
// walks up to the PARENT repo's node_modules/@claude-stats/core — a
// different checkout's dist — so a locale key added in this worktree would
// silently read as missing. A relative path into this worktree's own source
// is the only resolution that can't drift from the file under test.
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;

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
    anyFallbackRates: false,
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
  feeAttribution: null,
  modelEfficiency: null,
  contextAnalysis: null,
  spending: null,
  energy: null,
  costPerTask: null,
  calibration: null,
  calibrationScope: null,
  experimentalSignalsEnabled: false,
  recommendations: [],
  availableAccounts: [],
  selectedAccountUuid: null,
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

  it("contains all 4 canvas IDs", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('id="chart-daily"');
    expect(html).toContain('id="chart-project"');
    expect(html).toContain('id="chart-entrypoint"');
    expect(html).toContain('id="chart-cache"');
  });

  it("renders declared policy events as a timeline annotation under the daily chart", () => {
    const withEvents: DashboardData = {
      ...mockData,
      policyEvents: [{ date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" }],
    };
    const html = renderDashboard(withEvents, t);
    expect(html).toContain("2026-05-01");
    expect(html).toContain("model-removal");
    expect(html).toContain("opus");
    expect(html).toContain(t("dashboard:charts.policyEvents"));
    // Placement, not just presence: a substring assertion over the whole
    // document passes just as happily with the annotation parked under some
    // other chart. Pin it between the daily canvas and the next card's title.
    const canvasAt = html.indexOf('id="chart-daily"');
    const annotationAt = html.indexOf(t("dashboard:charts.policyEvents"));
    const nextCardAt = html.indexOf(t("dashboard:charts.tokenBreakdown"));
    expect(canvasAt).toBeGreaterThan(-1);
    expect(nextCardAt).toBeGreaterThan(-1);
    expect(annotationAt).toBeGreaterThan(canvasAt);
    expect(annotationAt).toBeLessThan(nextCardAt);
  });

  it("M-3: escapes HTML metacharacters in a policy event's date/kind/detail", () => {
    // `detail` is free-form local text (LOCAL-ONLY per PolicyEvent's own
    // doc-comment) rendered straight into the timeline annotation — the
    // string a user typed into their own config becomes markup verbatim if
    // `escapeHtml` is ever dropped from this path. Prove the injected markup
    // survives ONLY in escaped form and never appears as live tags.
    const withMarkup: DashboardData = {
      ...mockData,
      policyEvents: [
        {
          date: '2026-05-01"><img src=x onerror=alert(1)>',
          kind: "other",
          detail: "<script>alert('xss')</script> & \"quoted\" & 'single'",
          scope: "org",
        },
      ],
    };
    const html = renderDashboard(withMarkup, t);
    // The raw payloads must never appear unescaped.
    expect(html).not.toContain("<script>alert('xss')</script>");
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    // Their escaped forms must be present instead.
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
  });

  it("renders nothing extra when no policy events are declared or attached", () => {
    const noEvents = renderDashboard({ ...mockData, policyEvents: [] }, t);
    const undeclared = renderDashboard({ ...mockData, policyEvents: undefined }, t);
    expect(noEvents).not.toContain(t("dashboard:charts.policyEvents"));
    expect(undeclared).not.toContain(t("dashboard:charts.policyEvents"));
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

  it("auto-refresh never reloads while the Settings tab is active (recovery key is shown once)", () => {
    const html = renderDashboard(mockData, t);
    // The reload must sit behind the settings-tab guard: skip + re-arm
    // instead of reloading, so one-shot state (backup recovery key,
    // enroll form, disable-confirm) is never wiped mid-flow.
    expect(html).toContain(
      "if (active && active.id === 'tab-settings') { scheduleAutoRefresh(); return; }",
    );
    // Guard precedes the reload inside the scheduler.
    const scheduler = html.slice(html.indexOf("var scheduleAutoRefresh"));
    const guardIdx = scheduler.indexOf("'tab-settings'");
    const reloadIdx = scheduler.indexOf("location.reload()");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(reloadIdx).toBeGreaterThan(guardIdx);
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

  it("includes the Plan & Policy nav button, which is where the Plan section now lives", () => {
    const html = renderDashboard(mockData, t);
    // Since the domain-view regrouping the nav bar holds views, so the button
    // is the view's; the section keeps its own panel and heading.
    expect(html).toContain('data-tab="plan-and-policy"');
    expect(html).toContain(">Plan &amp; Policy<");
    expect(html).toContain('id="tab-plan" data-view="plan-and-policy"');
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
          { accountId: "acct-wor...", emailAddress: "work@example.com", subscriptionType: "max_5x", detectedPlanFee: 100, sessions: 7, estimatedCost: 20.0, planVerdict: "underusing", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [] },
          { accountId: "acct-per...", emailAddress: "personal@example.com", subscriptionType: "pro", detectedPlanFee: 20, sessions: 3, estimatedCost: 5.0, planVerdict: "underusing", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [] },
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
        byAccount: [{ accountId: "acct-111...", emailAddress: null, subscriptionType: "pro", detectedPlanFee: 20, sessions: 5, estimatedCost: 15.0, planVerdict: "good-value", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [] }],
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
        byAccount: [{ accountId: "acct-111...", emailAddress: "user@example.com", subscriptionType: "max_5x", detectedPlanFee: 100, sessions: 5, estimatedCost: 15.0, planVerdict: "good-value", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [] }],
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

  it("renders Usage Intensity card when usageIntensityTier is set", () => {
    const withIntensity: DashboardData = {
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
        usageIntensityTier: { tier: "typical", benchmarkUsd: 62.5, source: "anthropic-benchmark" },
      },
    };
    const html = renderDashboard(withIntensity, t);
    expect(html).toContain("Usage Intensity");
    expect(html).toContain("Typical");
    expect(html).toContain("63/mo");
  });

  it("omits Usage Intensity card when usageIntensityTier is null", () => {
    const withoutIntensity: DashboardData = {
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
        usageIntensityTier: null,
      },
    };
    const html = renderDashboard(withoutIntensity, t);
    expect(html).not.toContain("Usage Intensity");
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
    // Efficiency is a SECTION of the Efficiency & Hygiene view now, so what the
    // nav bar carries is the view; the panel and its figures are unchanged.
    expect(html).toContain('data-tab="efficiency-and-hygiene"');
    expect(html).toContain('id="tab-efficiency" data-view="efficiency-and-hygiene"');
    expect(html).toContain("Potential Savings");
  });

  it("includes Settings tab with per-account subscriptions and cost thresholds", () => {
    const html = renderDashboard(mockData, t);
    expect(html).toContain('data-tab="settings"');
    expect(html).toContain('id="tab-settings"');
    // Per-account subscription rows (plan type + fee) replace the old single
    // global plan-type/monthly-fee fields.
    expect(html).toContain('id="account-fees-rows"');
    expect(html).toContain('acct-fee-type');
    expect(html).toContain('PLAN_FEE_DEFAULTS');
    expect(html).not.toContain('id="cfg-plan-type"');
    expect(html).not.toContain('id="cfg-monthly-fee"');
    expect(html).toContain('id="cfg-threshold-day"');
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('/api/config');
    expect(html).toContain('id="cfg-auto-refresh"');
    expect(html).toContain('min="60"');
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

  describe("cost-per-task card", () => {
    const baseReport: NonNullable<DashboardData["costPerTask"]> = {
      period: "month",
      windowStart: 0,
      windowEnd: 0,
      tasksTotal: 100,
      observable: 40,
      coverage: 0.4,
      successCount: 12,
      failedCount: 28,
      inFlightCount: 30,
      unobservableCount: 30,
      successRate: 0.3,
      totalCostObservable: 420,
      meanCostPerAttempt: 10.5,
      costPerSuccessfulTask: 35,
      labelledCount: 5,
      byModel: [
        {
          model: "claude-opus-4-6", tasksObservable: 40, successCount: 12, successRate: 0.3,
          costObservable: 420, costByModelExact: 420, meanCostPerAttempt: 10.5, costPerSuccessfulTask: 35,
        },
      ],
    };

    // The detailed cost-per-task card lives in the Spending tab, which only
    // renders when data.spending is present (in production it always is when
    // there's data). These tests supply a minimal spending object so the card
    // is exercised; the overview tab shows only a summary box for the average.
    const emptySpending: NonNullable<DashboardData["spending"]> = {
      topSessionsByCost: [],
      topToolsByCost: [],
      costByModel: [],
      expensivePrompts: [],
      cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0 },
      mcpServers: [],
      mcpServerUsage: [],
      subagentOverhead: { totalCost: 0, agentCount: 0 },
    };

    it("does not render the card when costPerTask is null", () => {
      const html = renderDashboard(mockData, t);
      expect(html).not.toContain("Cost per Successful Task");
    });

    it("renders the headline, decomposition, badges and per-model row when present", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: baseReport }, t);
      expect(html).toContain("Cost per Successful Task");
      expect(html).toContain("$35.00");          // headline
      expect(html).toContain("$10.50");          // mean cost per attempt
      expect(html).toContain("40/100 observable"); // coverage badge
      expect(html).toContain("5/40 labelled");   // labelled badge
      expect(html).toContain("opus-4-6");        // per-model row (claude- stripped)
    });

    it("shows the low-coverage warning below the floor", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: { ...baseReport, coverage: 0.1 } }, t);
      expect(html).toContain("Low coverage");
    });

    it("omits the card entirely for an empty window", () => {
      const empty = { ...baseReport, tasksTotal: 0, observable: 0 };
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: empty }, t);
      expect(html).not.toContain("Cost per Successful Task");
    });

    it("renders no labelling controls when tasks is absent (read-only / serve)", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: baseReport }, t);
      expect(html).not.toContain("data-cpt-index");
      expect(html).not.toContain("Label task outcomes");
    });

    it("renders per-task labelling controls when tasks is present (webview)", () => {
      const withTasks = {
        ...baseReport,
        tasks: [
          {
            id: "task-1",
            title: "fix the auth flow",
            project: "/home/me/repos/app",
            outcome: "in_flight" as const,
            labelled: false,
            confidence: "medium" as const,
            signature: { projectPath: "/home/me/repos/app", filePaths: ["src/a.ts"], promptPrefix: "fix the auth flow" },
          },
        ],
      };
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: withTasks }, t);
      expect(html).toContain("Label task outcomes");
      expect(html).toContain('data-cpt-index="0"');
      expect(html).toContain('data-cpt-value="success"');
      expect(html).toContain('data-cpt-value="clear"');
      expect(html).toContain("fix the auth flow");
    });

    it("HTML-escapes the prompt-derived task title", () => {
      const evil = {
        ...baseReport,
        tasks: [{
          id: "x", title: "<img src=x onerror=alert(1)>", project: "/p",
          outcome: "unobservable" as const, labelled: false, confidence: "low" as const,
          signature: { projectPath: "/p", filePaths: [], promptPrefix: "x" },
        }],
      };
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: evil }, t);
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("shows the average as a summary box on the overview, pointing to the Spending tab", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: baseReport }, t);
      expect(html).toContain("$35.00");                          // average headline
      expect(html).toContain("Full breakdown on the Spending tab"); // overview pointer
    });

    it("does not show the overview summary box when the average is null", () => {
      const noAvg = { ...baseReport, costPerSuccessfulTask: null };
      const html = renderDashboard({ ...mockData, spending: emptySpending, costPerTask: noAvg }, t);
      expect(html).not.toContain("Full breakdown on the Spending tab");
    });

    // ── Calibration view + activation toggle (webview only) ──
    const emptyMetrics = {
      n: 0, hits: 0, accuracy: null, observableN: 0,
      perClass: {
        success: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        failed: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        in_flight: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        unobservable: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
      },
      brier: null, failedPrecision: null, meetsFailedFloor: false,
    };
    const calibration: NonNullable<DashboardData["calibration"]> = { n: 0, floor: 0.7, proxyOnly: emptyMetrics, withSignals: emptyMetrics };

    it("renders the calibration view and activation toggle when calibration is present", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, calibration }, t);
      expect(html).toContain('id="signals-toggle"');       // the toggle the bridge wires
      expect(html).toContain("Accuracy vs your labels");    // calibration.title
      expect(html).toContain("Label task outcomes");        // n===0 guidance
      expect(html).toContain("the proxy only");             // disabledNote (signals off)
    });

    it("checks the toggle and shows the enabled note when signals are on", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, calibration, experimentalSignalsEnabled: true }, t);
      expect(html).toContain('id="signals-toggle" checked');
      expect(html).toContain("folds in the accuracy signals"); // enabledNote
    });

    it("omits the calibration view entirely when calibration is null (serve/CLI)", () => {
      const html = renderDashboard({ ...mockData, spending: emptySpending, calibration: null }, t);
      expect(html).not.toContain('id="signals-toggle"');
    });
  });

  // The dashboard's client-side scripts live inside a template literal, so a
  // stray backtick or `${` silently breaks them at runtime with nothing in the
  // Node test suite exercising the browser code. Parse every inline <script>
  // with `new Function` (compiles without executing) so a syntax error fails
  // here rather than in a user's webview.
  describe("client script integrity", () => {
    function inlineScripts(html: string): string[] {
      const out: string[] = [];
      const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const body = m[1] ?? "";
        if (body.trim().length > 0) out.push(body);
      }
      return out;
    }

    it("every inline <script> parses as valid JavaScript", () => {
      const html = renderDashboard(mockData, t);
      const scripts = inlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const body of scripts) {
        // Throws on a syntax error; does not execute (no DOM needed).
        expect(() => new Function(body)).not.toThrow();
      }
    });

    it("renders the Classify panel inside Tickets & Value, with its init wired", () => {
      const html = renderDashboard(mockData, t);
      // 02 §2.4: Classify stops being a permanent tab and lives where its
      // output matters. The panel, and everything in it, is unchanged.
      expect(html).toContain('data-tab="tickets-and-value"');
      expect(html).toContain('id="tab-classify" data-view="tickets-and-value"');
      expect(html).toContain('id="classify-list"');
      expect(html).toContain('id="classify-apply"');
      // initClassify must be wired into the tab dispatch.
      expect(html).toContain("initClassify()");
    });

    it("renders the Backup & Sync section on the Settings tab", () => {
      const html = renderDashboard(mockData, t);
      // The card container the client JS renders into…
      expect(html).toContain('id="backup-body"');
      // …its localized copy (interpolated raw, like the other headings)…
      expect(html).toContain("Backup & Sync");
      // …and the section init wired into the Settings tab init.
      expect(html).toContain("initBackupSection()");
      // Host bridge present for both hosts (fetch + postMessage).
      expect(html).toContain("/api/backup/");
      expect(html).toContain("backupAction");
    });
  });

  // ─── G0/G3: nav definition drives the nav bar ──────────────────────────────
  // The bar holds the four domain views plus Insights and the utility surfaces
  // since the regrouping; the eleven section panels are unchanged and still
  // render. Section-level structure is asserted in domain-views.test.ts.
  describe("nav bar — driven by the single nav definition", () => {
    it("renders exactly the views NAV_VIEWS says are visible for this data, in order", () => {
      const html = renderDashboard(mockData, t);
      // mockData has no energy/spending/contextAnalysis/modelEfficiency.
      // Cost & Controlling survives on its unconditional Overview section even
      // though Spending is missing — that is the "mental map does not move"
      // property the old conditional tabs never had. Energy and Efficiency &
      // Hygiene drop out because EVERY section they hold is data-gated; a view
      // whose whole content is absent is the one honest case for dropping it.
      const order = [
        "insights",
        "cost-and-controlling",
        "tickets-and-value",
        "plan-and-policy",
        "sessions",
        "settings",
      ];
      let cursor = -1;
      for (const id of order) {
        const idx = html.indexOf(`data-tab="${id}"`);
        expect(idx, `no nav button for "${id}"`).toBeGreaterThan(cursor);
        cursor = idx;
      }
      expect(html).not.toContain('data-tab="energy"');
      expect(html).not.toContain('data-tab="efficiency-and-hygiene"');
      // Cost & Controlling is present on Overview alone.
      expect(html).toContain('id="tab-overview" data-view="cost-and-controlling"');
      expect(html).not.toContain('id="tab-spending"');
      // The data-shaped ids are sections now, never nav buttons.
      expect(html).not.toContain('data-tab="overview"');
      expect(html).not.toContain('data-tab="spending"');
      expect(html).not.toContain('data-tab="context"');
      expect(html).not.toContain('data-tab="efficiency"');
    });

    it("renders the Spending SECTION, localized, when data.spending is present", () => {
      const withSpending: DashboardData = {
        ...mockData,
        spending: {
          topSessionsByCost: [],
          topToolsByCost: [],
          costByModel: [],
          expensivePrompts: [],
          cacheEfficiency: { overallHitRate: 0, estimatedSavings: 0 },
          mcpServers: [],
          mcpServerUsage: [],
          subagentOverhead: { totalCost: 0, agentCount: 0 },
        } as unknown as DashboardData["spending"],
      };
      const html = renderDashboard(withSpending, t);
      expect(html).toContain('id="tab-spending" data-view="cost-and-controlling"');
      expect(html).toContain(">Spending<");
      // `>Spending<` alone cannot distinguish "localized" from "hardcoded" —
      // the en translation of dashboard:tabs.spending is the literal string
      // "Spending", so a hardcoded heading satisfies it too (verified by
      // mutation). Render with an identity translator: the label must arrive
      // as the i18n KEY, which only happens if it goes through t().
      const raw = renderDashboard(withSpending, (k) => k);
      expect(raw).toContain('id="section-spending">dashboard:tabs.spending<');
    });

    it("the first visible view is marked active — and it is Insights, the default", () => {
      const html = renderDashboard(mockData, t);
      expect(html).toMatch(/<button class="tab-btn active" data-tab="insights">/);
      // Exactly one button carries `active`; a second would leave two views lit.
      expect(html.match(/class="tab-btn active"/g)).toHaveLength(1);
      // …and the panel that starts visible is the same one.
      expect(html).toContain('<div class="tab-panel active" id="tab-insights"');
      expect(html).toContain('<div class="tab-panel" id="tab-overview"');
    });
  });

  // ─── G0: card module — behavior comparison, not a DOM snapshot ─────────────
  // Numbers must not move when markup moves. The pre-migration cost card
  // rendered `<div class="value">$3.75</div>`; the post-migration renderCard()
  // card must still surface the exact figure "$3.75" for the same
  // DashboardData, just inside new markup.
  //
  // Every assertion below is made against `costCard(html)`, NOT the whole page.
  // Page-wide `toContain` is vacuous here in two independent ways, both
  // verified by mutation: (a) the summary bar prints the identical dollar
  // figure in four other tiles, so `expect(html).toContain("$3.75")` still
  // passes when renderCard() emits no headline value at all; (b) `CARD_CSS` —
  // embedded in every page — literally contains the substring
  // "cs-card-unavailable", so `expect(html).toContain("cs-card-unavailable")`
  // passes for every render whether or not any card is in that state.
  /**
   * The rendered cost card element, sliced out of the full page.
   *
   * Anchored on `id="card-cost"` rather than "the first `.cs-card` on the
   * page": since the Insights tab landed, the page's first card is Insights'
   * Q1 — which renders the SAME answer object — so a positional slice would
   * quietly stop testing the Overview card it names.
   */
  function costCard(html: string): string {
    const idAt = html.indexOf('id="card-cost"');
    expect(idAt).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<div class="cs-card', idAt);
    expect(start).toBeGreaterThan(-1);
    // renderCard() closes the card at 4-space indent; its inner elements
    // close at 6. The first 4-space `</div>` after the open tag is the end.
    const end = html.indexOf("\n    </div>", start);
    expect(end).toBeGreaterThan(start);
    const card = html.slice(start, end);
    // Guard against the slice silently degenerating to nothing useful.
    expect(card.length).toBeGreaterThan(40);
    expect(card).toContain('id="card-cost"');
    return card;
  }

  describe("cost card — migrated to renderCard()", () => {
    it("renders the same dollar figure as before migration for a representative cost", () => {
      // mockData.summary.estimatedCost === 3.75, planFee === 0 (metered mode).
      const card = costCard(renderDashboard(mockData, t));
      // The headline value, not merely the answer sentence: the sentence also
      // embeds "$3.75", so asserting on the card as a whole would still pass
      // with the value element deleted.
      expect(card).toMatch(/<div class="cs-card-value">[\s\S]*?<span>\$3\.75<\/span>/);
      expect(card).not.toContain("cs-card-unavailable");
    });

    it("carries the plan-mode caveat and multiplier clause when on a plan", () => {
      const withPlan: DashboardData = {
        ...mockData,
        summary: { ...mockData.summary, planFee: 100, planMultiplier: 3.75 },
      };
      const card = costCard(renderDashboard(withPlan, t));
      // "3.8" alone is a 3-character substring that occurs elsewhere on the
      // page; anchor it to the multiplier clause inside the card.
      expect(card).toMatch(/3\.8×/);
      expect(card).toContain("Equivalent API cost");
    });

    it("renders the honest-unavailable state, not a fabricated $0.00, when there is no usage", () => {
      const noUsage: DashboardData = {
        ...mockData,
        summary: { ...mockData.summary, estimatedCost: 0 },
      };
      const html = renderDashboard(noUsage, t);
      const card = costCard(html);
      // Match the class attribute the unavailable branch actually emits, not
      // the bare token that CARD_CSS also contains.
      expect(card).toContain('class="cs-card cs-card-unavailable"');
      expect(card).toContain("No usage recorded for this period.");
      expect(card).not.toContain("cs-card-value");
      expect(html).not.toContain("$0.00");
    });

    it("does not assert unqualified 'Actual metered cost.' when the period's cost rests on a partner-platform fallback rate", () => {
      // A Bedrock/Vertex account with no configured partner rates: metered
      // mode (planFee === 0), but `anyFallbackRates` is true because
      // estimateCost() had to reuse first-party per-token prices for a
      // separately-priced partner platform (packages/core/src/pricing.ts).
      const fallbackPriced: DashboardData = {
        ...mockData,
        summary: { ...mockData.summary, planFee: 0, anyFallbackRates: true },
      };
      const card = costCard(renderDashboard(fallbackPriced, t));
      expect(card).not.toContain("Actual metered cost.");
      expect(card).toContain("first-party rates");
    });
  });
});
