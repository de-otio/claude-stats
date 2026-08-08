/**
 * The recommendation engine's strings.
 *
 * These eleven rules were the last hardcoded English on the dashboard's
 * DEFAULT view: a German or Japanese user saw nine localized cards and then a
 * panel of English prose. This file covers the localization seam itself —
 * that every reader-facing string resolves through the injected translator,
 * that caller-supplied text (an MCP server name, a project directory) is
 * treated as data rather than as an interpolation template, and that numbers
 * are formatted BEFORE they reach a locale's sentence.
 *
 * `buildRecommendations` is exercised directly with an identity translator
 * where the assertion is about which KEY was chosen, and with the real `en`
 * translator where the assertion is about the rendered sentence. Neither
 * touches the process-wide i18n singleton, so these tests cannot leak a locale
 * into their neighbours.
 */
import { describe, it, expect } from "vitest";
import { buildRecommendations } from "../dashboard/index.js";
import type { DashboardData } from "../dashboard/index.js";
import { currentT } from "@claude-stats/core/i18n";
import { t } from "../i18n.js";

/** Renders the key itself — what a surface gets before any locale is loaded. */
const identity = (key: string) => key;

type Input = Parameters<typeof buildRecommendations>[1];

const EMPTY: Input = {
  totalCost: 0,
  totalPrompts: 0,
  cacheEfficiency: 0,
  planUtilization: null,
  modelEfficiency: null,
  contextAnalysis: null,
  spending: null,
  byConversationCost: [],
};

function modelEfficiency(over: Partial<{ potentialSavings: number; overusePercent: number; classifiedMessages: number }>) {
  return {
    summary: { potentialSavings: 0, overusePercent: 0, classifiedMessages: 0, ...over },
  } as unknown as NonNullable<Input["modelEfficiency"]>;
}

function contextAnalysis(over: Partial<{ sessionsNeedingCompaction: number; avgPeakInputTokens: number; compactionRate: number }>) {
  return {
    sessionsNeedingCompaction: 0,
    avgPeakInputTokens: 0,
    compactionRate: 0,
    ...over,
  } as unknown as NonNullable<Input["contextAnalysis"]>;
}

function mcpSpending(servers: Array<{ server: string; estimatedCost: number; totalCalls: number; avgTokensPerCall: number }>) {
  return { mcpServers: servers } as unknown as NonNullable<Input["spending"]>;
}

function conversations(costs: number[], top?: Partial<{ projectPath: string; promptCount: number }>) {
  return costs.map((estimatedCost, i) => ({
    sessionId: `s${i}`,
    projectPath: i === 0 ? (top?.projectPath ?? "/w/acme/web") : "/w/other/x",
    estimatedCost,
    promptCount: i === 0 ? (top?.promptCount ?? 40) : 5,
  })) as unknown as DashboardData["byConversationCost"];
}

// ─── The seam: every string resolves through the translator ─────────────────

describe("recommendation strings go through the translator, not a template literal", () => {
  it("emits only dashboard:recommendations.* keys — no rule kept its English", () => {
    const recs = buildRecommendations(identity, {
      ...EMPTY,
      totalCost: 100,
      totalPrompts: 200,
      cacheEfficiency: 10,
      modelEfficiency: modelEfficiency({ potentialSavings: 30, overusePercent: 42 }),
      contextAnalysis: contextAnalysis({ sessionsNeedingCompaction: 12, avgPeakInputTokens: 185_000 }),
      spending: mcpSpending([{ server: "docs", estimatedCost: 40, totalCalls: 20, avgTokensPerCall: 9000 }]),
      byConversationCost: conversations([60, 4, 3, 2, 1]),
    });

    expect(recs.length).toBeGreaterThan(4);
    for (const r of recs) {
      expect(r.title).toMatch(/^dashboard:recommendations\.[a-zA-Z]+\.title$/);
      expect(r.body).toMatch(/^dashboard:recommendations\.[a-zA-Z]+\.body$/);
      if (r.impact !== undefined) {
        expect(r.impact).toMatch(/^dashboard:recommendations\.[a-zA-Z]+\.impact$/);
      }
    }
  });

  it("covers every positive rule too — the success tier was localized with the rest", () => {
    const recs = buildRecommendations(identity, {
      ...EMPTY,
      totalCost: 100,
      totalPrompts: 200,
      cacheEfficiency: 82,
      modelEfficiency: modelEfficiency({ potentialSavings: 0, overusePercent: 3, classifiedMessages: 100 }),
      contextAnalysis: contextAnalysis({ compactionRate: 55, sessionsNeedingCompaction: 1 }),
      planUtilization: { weeklyPlanBudget: 10, avgWeeklyCost: 45 } as DashboardData["planUtilization"],
    });
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("good-cache");
    expect(ids).toContain("good-model-routing");
    expect(ids).toContain("good-plan-value");
    expect(ids).toContain("good-compaction");
    for (const r of recs) expect(r.title).toContain("dashboard:recommendations.");
  });

  it("keeps the panel headings out of the English source too", () => {
    // Regression guard for the two <div> labels above the panels, which were
    // still literal English when the rules themselves were localized.
    expect(t("dashboard:recommendations.panel.actions")).not.toContain("recommendations.panel");
    expect(t("dashboard:recommendations.panel.positives")).not.toContain("recommendations.panel");
  });
});

// ─── Caller text is data, never a template ──────────────────────────────────

describe("caller-supplied text is data, not an interpolation template", () => {
  it("does not let an MCP server name inject a placeholder into its own sentence", () => {
    const [rec] = buildRecommendations(t, {
      ...EMPTY,
      totalCost: 100,
      spending: mcpSpending([
        { server: "{{sharePercent}}-evil", estimatedCost: 40, totalCalls: 20, avgTokensPerCall: 9000 },
      ]),
    });
    expect(rec!.title).toContain("{{sharePercent}}-evil");
    // …and the sentence's own share is still a real number, not eaten by it.
    expect(rec!.body).toMatch(/40\.0% of your total spend/);
  });

  it("does not let a project directory name inject a placeholder", () => {
    const recs = buildRecommendations(t, {
      ...EMPTY,
      totalCost: 100,
      byConversationCost: conversations([60, 4, 3, 2, 1], { projectPath: "/w/{{ratio}}/{{cost}}" }),
    });
    const runaway = recs.find((r) => r.id === "runaway-conversation")!;
    expect(runaway.body).toContain("{{ratio}}/{{cost}}");
    expect(runaway.body).toContain("$60.00");
    expect(runaway.body).not.toMatch(/\{\{promptCount\}\}/);
  });
});

// ─── Numbers are formatted before they reach a sentence ─────────────────────

describe("numeric formatting happens before interpolation", () => {
  it("routes money through the shared formatter, thousands separators included", () => {
    const [rec] = buildRecommendations(t, {
      ...EMPTY,
      modelEfficiency: modelEfficiency({ potentialSavings: 1234.5, overusePercent: 20 }),
    });
    // `formatMoney`'s own >= 100 rule rounds to whole dollars and separates
    // thousands — a bare toFixed(2) would have produced "$1234.50".
    expect(rec!.impact).toBe("~$1,235 saveable");
  });

  it("renders whole-dollar plan figures without false ‑.00 precision", () => {
    const recs = buildRecommendations(t, {
      ...EMPTY,
      planUtilization: {
        currentPlanVerdict: "underusing",
        weeklyPlanBudget: 200 / 4.33,
        avgWeeklyCost: 20 / 4.33,
        totalWeeks: 8,
        recommendedPlan: "pro",
      } as DashboardData["planUtilization"],
    });
    const downgrade = recs.find((r) => r.id === "plan-underusing")!;
    expect(downgrade.body).toContain("~$20/mo");
    expect(downgrade.body).toContain("~$200/mo");
    expect(downgrade.body).not.toContain(".00/mo");
    expect(downgrade.impact).toBe("~$180/mo");
  });

  it("separates thousands in the tokens-per-call count without reading the runtime locale", () => {
    const [rec] = buildRecommendations(t, {
      ...EMPTY,
      totalCost: 100,
      spending: mcpSpending([{ server: "docs", estimatedCost: 40, totalCalls: 20, avgTokensPerCall: 12345 }]),
    });
    // Was `Number.toLocaleString()`, whose separators follow the MACHINE's
    // locale rather than the report's — two runs of the same report on two
    // machines could not be compared.
    expect(rec!.body).toContain("12,345 tokens per call");
  });
});

// ─── The optional clause is a key, not a conditional fragment ───────────────

describe("the 'N× the median' comparison is its own key", () => {
  it("appends the clause when there is a meaningful median to compare against", () => {
    const [rec] = buildRecommendations(t, {
      ...EMPTY,
      totalCost: 100,
      // Three servers, so the median lands on the MIDDLE one. With two, the
      // median is the higher of the pair and the heavy server's ratio is 1.
      spending: mcpSpending([
        { server: "heavy", estimatedCost: 40, totalCalls: 20, avgTokensPerCall: 20_000 },
        { server: "light", estimatedCost: 1, totalCalls: 20, avgTokensPerCall: 1_000 },
        { server: "light2", estimatedCost: 1, totalCalls: 20, avgTokensPerCall: 1_000 },
      ]),
    });
    expect(rec!.body).toContain("20.0× the median MCP server)");
  });

  it("omits it entirely when the ratio is not worth stating, leaving no stray punctuation", () => {
    const [rec] = buildRecommendations(t, {
      ...EMPTY,
      totalCost: 100,
      spending: mcpSpending([
        { server: "heavy", estimatedCost: 40, totalCalls: 20, avgTokensPerCall: 1_000 },
        { server: "light", estimatedCost: 1, totalCalls: 20, avgTokensPerCall: 1_000 },
      ]),
    });
    expect(rec!.body).not.toContain("the median MCP server");
    expect(rec!.body).toContain("tokens per call. Verify");
  });
});

// ─── The shared-singleton seam buildDashboard depends on ────────────────────

describe("currentT", () => {
  it("is populated once a surface has initialized i18n", () => {
    // `buildDashboard` resolves its translator from here rather than from the
    // CLI's own singleton, because the same function runs in the VS Code
    // extension host, which initializes a different one.
    expect(currentT()).not.toBeNull();
  });

  it("degrades to visible keys rather than to a silently empty panel", () => {
    // The state before any surface has initialized. Recommendations must still
    // be PRESENT — an empty list is indistinguishable from "nothing to
    // recommend", which is a legitimate state and would hide the fault.
    const recs = buildRecommendations(identity, {
      ...EMPTY,
      totalCost: 100,
      totalPrompts: 200,
      cacheEfficiency: 10,
    });
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]!.title).toContain("dashboard:recommendations.");
  });
});
