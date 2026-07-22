/**
 * Tests for:
 *  - redactDashboardForHttp (sec#1 email leak + sec#8 raw tier/billing/seat)
 *  - tryRenderDashboard XSS error-fallback escape (sec#2)
 *  - derivePlanLabel and buildAccountsForConfig planLabel derivation
 */
import { describe, it, expect } from "vitest";
import { redactDashboardForHttp } from "../server/index.js";
import { derivePlanLabel, buildAccountsForConfig } from "../config.js";
import { escapeHtml } from "../server/utils.js";
import type { DashboardData } from "../dashboard/index.js";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  sampleAccountA,
  sampleAccountB,
} from "./fixtures/accounts.js";

// ─── Minimal DashboardData factory ───────────────────────────────────────────

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated: "2026-01-15T10:00:00.000Z",
    period: "week",
    timezone: "UTC",
    sinceIso: "2026-01-09",
    summary: {
      sessions: 10,
      prompts: 50,
      inputTokens: 100000,
      outputTokens: 20000,
      cacheReadTokens: 50000,
      cacheCreationTokens: 10000,
      cacheEfficiency: 28.6,
      estimatedCost: 1.5,
      totalDurationMs: 3600000,
      planFee: 0,
      planMultiplier: 0,
      costPerPrompt: 0,
      costPerActiveHour: 0,
      dailyValueRate: 0,
      tokensPerMinute: 0,
      outputTokensPerPrompt: 0,
      promptsPerHour: 0,
      totalActiveHours: 1.0,
      avgSessionDurationMinutes: 6.0,
      truncatedOutputs: 0,
      currentWindowStart: null,
      currentWindowPrompts: 0,
      currentWindowCost: 0,
      subagentSessions: 0,
      parentSessionsWithChildren: 0,
    },
    byDay: [],
    byProject: [],
    byModel: [],
    byEntrypoint: [],
    stopReasons: [],
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
    experimentalSignalsEnabled: false,
    recommendations: [],
    availableAccounts: [],
    selectedAccountUuid: null,
    ...overrides,
  };
}

// ─── redactDashboardForHttp ───────────────────────────────────────────────────

describe("redactDashboardForHttp", () => {
  it("nulls emailAddress in availableAccounts", () => {
    const data = makeDashboardData({
      availableAccounts: [
        {
          accountUuid: ACCOUNT_A_UUID,
          emailAddress: "a@example.com",
          subscriptionType: "team_premium",
          sessionCount: 5,
          isCurrent: true,
        },
        {
          accountUuid: ACCOUNT_B_UUID,
          emailAddress: "b@example.com",
          subscriptionType: "pro",
          sessionCount: 3,
          isCurrent: false,
        },
      ],
    });
    const redacted = redactDashboardForHttp(data);
    for (const a of redacted.availableAccounts) {
      expect(a.emailAddress).toBeNull();
    }
  });

  it("preserves accountUuid and subscriptionType in availableAccounts after redaction", () => {
    const data = makeDashboardData({
      availableAccounts: [
        {
          accountUuid: ACCOUNT_A_UUID,
          emailAddress: "a@example.com",
          subscriptionType: "team_premium",
          sessionCount: 5,
          isCurrent: true,
        },
      ],
    });
    const redacted = redactDashboardForHttp(data);
    expect(redacted.availableAccounts[0]?.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(redacted.availableAccounts[0]?.subscriptionType).toBe("team_premium");
    expect(redacted.availableAccounts[0]?.sessionCount).toBe(5);
    expect(redacted.availableAccounts[0]?.isCurrent).toBe(true);
  });

  it("nulls emailAddress in planUtilization.byAccount", () => {
    const data = makeDashboardData({
      planUtilization: {
        weeklyPlanBudget: 25,
        avgWeeklyCost: 20,
        peakWeeklyCost: 35,
        weeksBelowPlan: 2,
        weeksAbovePlan: 1,
        totalWeeks: 3,
        avgWindowCost: 5,
        medianWindowCost: 4,
        windowsPerWeek: 2.5,
        truncatedOutputWindowPercent: 0,
        totalWindows: 8,
        recommendedPlan: null,
        currentPlanVerdict: "good-value",
        usageIntensityTier: null,
        byAccount: [
          {
            accountId: ACCOUNT_A_UUID.slice(0, 8),
            emailAddress: "a@example.com",
            subscriptionType: "team_premium",
            detectedPlanFee: 125,
            sessions: 5,
            estimatedCost: 20,
            planVerdict: "good-value",
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [],
          },
          {
            accountId: ACCOUNT_B_UUID.slice(0, 8),
            emailAddress: "b@example.com",
            subscriptionType: "pro",
            detectedPlanFee: 20,
            sessions: 3,
            estimatedCost: 5,
            planVerdict: "underusing",
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [],
          },
        ],
      },
    });
    const redacted = redactDashboardForHttp(data);
    expect(redacted.planUtilization).not.toBeNull();
    for (const ba of redacted.planUtilization!.byAccount) {
      expect(ba.emailAddress).toBeNull();
    }
  });

  it("preserves non-email fields in planUtilization.byAccount after redaction", () => {
    const data = makeDashboardData({
      planUtilization: {
        weeklyPlanBudget: 25,
        avgWeeklyCost: 20,
        peakWeeklyCost: 35,
        weeksBelowPlan: 2,
        weeksAbovePlan: 1,
        totalWeeks: 3,
        avgWindowCost: 5,
        medianWindowCost: 4,
        windowsPerWeek: 2.5,
        truncatedOutputWindowPercent: 0,
        totalWindows: 8,
        recommendedPlan: null,
        currentPlanVerdict: "good-value",
        usageIntensityTier: null,
        byAccount: [
          {
            accountId: ACCOUNT_A_UUID.slice(0, 8),
            emailAddress: "a@example.com",
            subscriptionType: "team_premium",
            detectedPlanFee: 125,
            sessions: 5,
            estimatedCost: 20,
            planVerdict: "good-value",
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: [],
          },
        ],
      },
    });
    const redacted = redactDashboardForHttp(data);
    const ba = redacted.planUtilization!.byAccount[0]!;
    expect(ba.subscriptionType).toBe("team_premium");
    expect(ba.detectedPlanFee).toBe(125);
    expect(ba.sessions).toBe(5);
    expect(ba.estimatedCost).toBe(20);
    expect(ba.planVerdict).toBe("good-value");
  });

  it("handles null planUtilization gracefully", () => {
    const data = makeDashboardData({ planUtilization: null });
    const redacted = redactDashboardForHttp(data);
    expect(redacted.planUtilization).toBeNull();
  });

  it("does not mutate the original data object", () => {
    const originalEmail = "a@example.com";
    const data = makeDashboardData({
      availableAccounts: [
        {
          accountUuid: ACCOUNT_A_UUID,
          emailAddress: originalEmail,
          subscriptionType: "team_premium",
          sessionCount: 5,
          isCurrent: true,
        },
      ],
    });
    redactDashboardForHttp(data);
    // Original must be untouched
    expect(data.availableAccounts[0]?.emailAddress).toBe(originalEmail);
  });
});

// ─── escapeHtml (sec#2 XSS fix) ──────────────────────────────────────────────

describe("escapeHtml (server/utils)", () => {
  it("escapes < so a <script> payload cannot inject HTML", () => {
    const payload = '<script>alert("xss")</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("escapes > & \" '", () => {
    expect(escapeHtml("a & b")).toContain("&amp;");
    expect(escapeHtml('say "hello"')).toContain("&quot;");
    expect(escapeHtml("it's")).toContain("&#39;");
    expect(escapeHtml("a > b")).toContain("&gt;");
  });

  it("returns the same string when no special chars are present", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });
});

// ─── derivePlanLabel ─────────────────────────────────────────────────────────

describe("derivePlanLabel", () => {
  it("returns human label for known subscription types", () => {
    expect(derivePlanLabel("team_premium")).toBe("Team Premium");
    expect(derivePlanLabel("team_standard")).toBe("Team Standard");
    expect(derivePlanLabel("max_20x")).toBe("Max 20x");
    expect(derivePlanLabel("max_5x")).toBe("Max 5x");
    expect(derivePlanLabel("pro")).toBe("Pro");
    expect(derivePlanLabel("custom")).toBe("Custom");
  });

  it("maps alias subscription types via SUBSCRIPTION_TYPE_MAP", () => {
    // claude_pro → pro → "Pro"
    expect(derivePlanLabel("claude_pro")).toBe("Pro");
    // max → max_5x → "Max 5x"
    expect(derivePlanLabel("max")).toBe("Max 5x");
    // team → team_standard → "Team Standard"
    expect(derivePlanLabel("team")).toBe("Team Standard");
    // claude_team → team_standard → "Team Standard"
    expect(derivePlanLabel("claude_team")).toBe("Team Standard");
  });

  it("returns 'Unknown plan' for null input", () => {
    expect(derivePlanLabel(null)).toBe("Unknown plan");
  });

  it("returns raw string for unknown subscription types (passthrough)", () => {
    expect(derivePlanLabel("some_unknown_plan")).toBe("some_unknown_plan");
  });

  it("is case-insensitive (uses lowercased lookup)", () => {
    expect(derivePlanLabel("Team_Premium")).toBe("Team Premium");
    expect(derivePlanLabel("PRO")).toBe("Pro");
  });
});

// ─── buildAccountsForConfig planLabel ────────────────────────────────────────

describe("buildAccountsForConfig — planLabel", () => {
  const baseAccounts = [
    { accountUuid: ACCOUNT_A_UUID, subscriptionType: "team_premium", sessionCount: 5 },
    { accountUuid: ACCOUNT_B_UUID, subscriptionType: null, sessionCount: 2 },
  ];

  it("includes planLabel derived from subscriptionType", () => {
    const result = buildAccountsForConfig(baseAccounts, null, false);
    expect(result[0]?.planLabel).toBe("Team Premium");
    expect(result[1]?.planLabel).toBe("Unknown plan");
  });

  it("uses fullAccounts subscriptionType when provided (richer data wins)", () => {
    const fullAccounts = [
      { accountUuid: ACCOUNT_A_UUID, subscriptionType: "max_20x" },
      { accountUuid: ACCOUNT_B_UUID, subscriptionType: "pro" },
    ];
    const result = buildAccountsForConfig(baseAccounts, null, false, fullAccounts);
    // ACCOUNT_A: fullAccounts has max_20x, overrides team_premium from baseAccounts
    expect(result[0]?.planLabel).toBe("Max 20x");
    // ACCOUNT_B: fullAccounts has pro, overrides null from baseAccounts
    expect(result[1]?.planLabel).toBe("Pro");
  });

  it("uses fixture AccountRecord fields for planLabel", () => {
    const fullAccounts = [sampleAccountA, sampleAccountB];
    const result = buildAccountsForConfig(baseAccounts, null, false, fullAccounts);
    // sampleAccountA.subscriptionType = "team_premium"
    expect(result[0]?.planLabel).toBe("Team Premium");
    // sampleAccountB.subscriptionType = "team_standard"
    expect(result[1]?.planLabel).toBe("Team Standard");
  });

  it("sets email when includeEmail=true and account matches current", () => {
    const current = { accountUuid: ACCOUNT_A_UUID, emailAddress: "a@example.com" };
    const result = buildAccountsForConfig(baseAccounts, current, true);
    expect(result[0]?.email).toBe("a@example.com");
    expect(result[1]?.email).toBeNull();
  });

  it("sets email to null for all accounts when includeEmail=false", () => {
    const current = { accountUuid: ACCOUNT_A_UUID, emailAddress: "a@example.com" };
    const result = buildAccountsForConfig(baseAccounts, current, false);
    for (const a of result) {
      expect(a.email).toBeNull();
    }
  });

  it("preserves all existing fields alongside planLabel", () => {
    const result = buildAccountsForConfig(baseAccounts, null, false);
    expect(result[0]?.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(result[0]?.subscriptionType).toBe("team_premium");
    expect(result[0]?.sessionCount).toBe(5);
    expect(result[0]?.planLabel).toBe("Team Premium");
  });
});
