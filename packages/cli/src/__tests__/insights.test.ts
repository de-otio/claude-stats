/**
 * Lane G1 — the Insights tab.
 *
 * **The test contract is behaviour comparison, not DOM snapshots.** A golden
 * `DashboardData` goes in; the exact rendered figures come out and must not
 * move. A snapshot of the page would pass for any markup at all and is
 * explicitly forbidden (plan §3, CLAUDE.md default 14).
 *
 * Two habits every assertion here follows, both learned from Phase 1's four
 * assertions that could not fail:
 *
 *  - **Slice the card, then assert.** A page-wide `toContain("$312")` is
 *    vacuous: the summary bar prints the same dollar figure in several tiles,
 *    and `CARD_CSS`/`INSIGHTS_CSS` are embedded in every page and contain the
 *    class tokens verbatim. Every figure assertion below runs against one
 *    card's own markup.
 *  - **Assert the value element, not just the sentence.** The answer sentence
 *    embeds the number too, so asserting on the card as a whole still passes
 *    with the headline value element deleted.
 */
import { describe, it, expect } from "vitest";
import {
  buildAlerts,
  buildInsightAnswers,
  renderInsightsTab,
  resolveDashboardCostVocabulary,
  EVIDENCE_TAB,
  type InsightBuildOptions,
} from "../server/insights.js";
import { renderDashboard } from "../server/template.js";
import { answerCost } from "@claude-stats/core/insight";
import { calibrate } from "@claude-stats/core/calibration";
import { NAV_TAB_IDS } from "../server/nav.js";
import type { DashboardData } from "../dashboard/index.js";
import { resolveAccountMode, type Config } from "../config.js";
import type { TranslateFn } from "../server/template.js";
import { initI18n } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Relative into this worktree's own source — see the same note in
// template.test.ts: a bare package specifier can resolve to a different
// checkout's dist and silently read a new key as missing.
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;
/** Identity translator — proves a label went through `t()` rather than being
 *  a hardcoded literal that happens to equal its own English translation. */
const rawT: TranslateFn = (key) => key;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The empty case: a fresh install. Every card must be honestly unavailable. */
const emptyData: DashboardData = {
  generated: "2026-01-15T10:00:00.000Z",
  period: "month",
  timezone: "UTC",
  sinceIso: null,
  summary: {
    sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, cacheEfficiency: 0, estimatedCost: 0, anyFallbackRates: false,
    totalDurationMs: 0, planFee: 0, planMultiplier: 0, costPerPrompt: 0, costPerActiveHour: 0,
    dailyValueRate: 0, tokensPerMinute: 0, outputTokensPerPrompt: 0, promptsPerHour: 0,
    totalActiveHours: 0, avgSessionDurationMinutes: 0, truncatedOutputs: 0,
    currentWindowStart: null, currentWindowPrompts: 0, currentWindowCost: 0,
    subagentSessions: 0, parentSessionsWithChildren: 0,
  },
  byDay: [], byProject: [], byModel: [], byEntrypoint: [], stopReasons: [], byHour: [],
  byWindow: [], byConversationCost: [], byWeek: [],
  planUtilization: null, feeAttribution: null, modelEfficiency: null, contextAnalysis: null,
  spending: null, energy: null, costPerTask: null, calibration: null,
  experimentalSignalsEnabled: false, recommendations: [], availableAccounts: [],
  selectedAccountUuid: null, insights: null,
};

/**
 * The golden payload. Every number here is chosen so its rendering is
 * unambiguous — no two figures on the page collide, so an assertion that finds
 * one has found the right one.
 */
const goldenData: DashboardData = {
  ...emptyData,
  summary: {
    ...emptyData.summary,
    sessions: 61,
    prompts: 940,
    estimatedCost: 312.4,
    planFee: 0,
    planMultiplier: 0,
  },
  // Only `successCount` and `efficiency.recoverableWaste` are read by
  // `buildInsightAnswers`; the remaining fields are populated because
  // `renderDashboard` also renders the pre-existing cost-per-task card from
  // the same block, and this fixture drives the whole page.
  costPerTask: {
    period: "month", windowStart: 0, windowEnd: 0,
    tasksTotal: 55, observable: 48, coverage: 48 / 55,
    successCount: 41, failedCount: 5, inFlightCount: 1, unobservableCount: 7,
    successRate: 41 / 48, totalCostObservable: 280, meanCostPerAttempt: 5.83,
    costPerSuccessfulTask: 6.83, labelledCount: 12, byModel: [],
    efficiency: {
      basis: "completion_proxy", realisedCost: 150, frontierCost: 111.5,
      recoverableWaste: 38.5, byArchetype: [], levers: [],
    },
  } as unknown as DashboardData["costPerTask"],
  recommendations: [
    { id: "model-tier-waste", severity: "critical", title: "Route simpler prompts to cheaper models", body: "…", impact: "~$41.00 saveable" },
    { id: "context-compaction", severity: "warning", title: "Use /compact more aggressively", body: "…" },
    { id: "praise", severity: "success", title: "Cache use is excellent", body: "…" },
  ],
  planUtilization: {
    currentPlanVerdict: "good-value", recommendedPlan: "max_5x", byAccount: [],
    weeklyPlanBudget: 23, avgWeeklyCost: 72, peakWeeklyCost: 90, weeksBelowPlan: 0,
    weeksAbovePlan: 4, totalWeeks: 4, avgWindowCost: 4, medianWindowCost: 3,
    windowsPerWeek: 18, truncatedOutputWindowPercent: 0, totalWindows: 72,
  } as unknown as DashboardData["planUtilization"],
  insights: {
    vocabulary: { vocabulary: "metered", basis: "accounts", planAccounts: 0, meteredAccounts: 1 },
    ticketCoverage: {
      attributedCost: 259.3,
      totalCost: 312.4,
      ratio: 0.83,
      byConfidence: { high: 186.7, medium: 54.5, low: 18.1 },
      ambiguousSessions: 2,
    },
    topTicket: { key: "PROJ-123", cost: 41.2 },
    hourlyRate: 90,
    currency: "USD",
    attributionCalibration: null,
    reconciliation: null,
  },
};

const buildOpts: InsightBuildOptions = {
  t,
  vocabulary: "metered",
  hourlyRate: 90,
  currency: "USD",
  verdictSentence: "Your plan is good value for how much you use it",
};

/** One card's own markup, sliced out by its DOM id. */
function card(html: string, id: string): string {
  const idAt = html.indexOf(`id="${id}"`);
  expect(idAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="cs-card', idAt);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("\n    </div>", start);
  expect(end).toBeGreaterThan(start);
  const sliced = html.slice(start, end);
  expect(sliced.length).toBeGreaterThan(40);
  expect(sliced).toContain(`id="${id}"`);
  return sliced;
}

/** The headline value element's text, or null when the card renders none. */
function headlineValue(cardHtml: string): string | null {
  const m = cardHtml.match(/<div class="cs-card-value">\s*<span>([^<]*)<\/span>/);
  return m ? m[1]! : null;
}

const renderTab = (data: DashboardData, opts = buildOpts, tr: TranslateFn = t) =>
  renderInsightsTab(buildInsightAnswers(data, opts), buildAlerts(data, tr), tr);

// ─── The golden numbers ───────────────────────────────────────────────────────

describe("Insights tab — the rendered figures do not move", () => {
  it("renders exactly five cards, in the documented question order", () => {
    const answers = buildInsightAnswers(goldenData, buildOpts);
    expect(answers.map((a) => a.question)).toEqual(["cost", "bought", "efficiency", "setup", "change"]);

    const html = renderTab(goldenData);
    const ids = [...html.matchAll(/id="(insight-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["insight-cost", "insight-bought", "insight-efficiency", "insight-setup", "insight-change"]);
  });

  it("Q1 — cost: $312 headline, the dev-time clause at the configured rate, and no unqualified metered claim beyond the truth", () => {
    const c = card(renderTab(goldenData), "insight-cost");
    // The VALUE element, not merely the sentence: the sentence embeds "$312"
    // too, so a card-wide assertion passes with the value element deleted.
    expect(headlineValue(c)).toBe("$312");
    // 312.4 / 90 = 3.47 dev-hours. Computed by the shared formatter; asserted
    // here so a change to the rate arithmetic is visible on the card.
    expect(c).toContain("≈ 3.5 dev-hours at your configured rate");
    expect(c).toContain("Actual metered cost.");
  });

  it("Q1 — the dev-time clause is absent, not zeroed, when no hourly rate is configured", () => {
    const c = card(renderTab(goldenData, { ...buildOpts, hourlyRate: null }), "insight-cost");
    expect(headlineValue(c)).toBe("$312");
    expect(c).not.toContain("dev-hours");
    expect(c).not.toContain("at your configured rate");
  });

  it("Q2 — bought: 41 completed tasks, 83% attributed, the top ticket, and the confidence mix as its caveat", () => {
    const c = card(renderTab(goldenData), "insight-bought");
    expect(headlineValue(c)).toBe("83%");
    expect(c).toContain("41 tasks completed");
    expect(c).toContain("biggest: PROJ-123 ($41.20)");
    // The coverage denominator's honesty obligation: the confidence split of
    // the ATTRIBUTED cost (186.7 / 54.5 / 18.1 of 259.3), plus the ambiguity.
    expect(c).toContain("72% high · 21% medium · 7% low confidence · 2 sessions ambiguous.");
  });

  it("Q3 — efficiency: the recoverable figure and its share of spend", () => {
    const c = card(renderTab(goldenData), "insight-efficiency");
    expect(headlineValue(c)).toBe("$38.50");
    // 38.5 / 312.4 = 12.3% -> 12%.
    expect(c).toContain("$38.50 recoverable (12% of spend)");
  });

  it("Q4 — setup: the translated plan verdict, and no invented saving", () => {
    const c = card(renderTab(goldenData), "insight-setup");
    expect(c).toContain("Your plan is good value for how much you use it.");
    // Lane E computes the projected saving. Until it lands there must be no
    // figure — a plausible-looking invented one is the worst placeholder on a
    // card a manager reads.
    expect(c).not.toContain("would save");
    expect(headlineValue(c)).toBeNull();
  });

  it("Q5 — change: leads with the top recommendation and its impact, and counts the rest", () => {
    const c = card(renderTab(goldenData), "insight-change");
    expect(headlineValue(c)).toBe("3");
    expect(c).toContain("Route simpler prompts to cheaper models — ~$41.00 saveable (+2 more).");
  });

  it("is deterministic — the same payload renders byte-identically", () => {
    expect(renderTab(goldenData)).toBe(renderTab(goldenData));
  });

  // Every card asserted above is found by its DOM id, which says nothing about
  // whether the TITLE above it belongs to that question. Swapping two entries
  // of `QUESTION_TITLE_KEY` mislabels a card — "What did AI cost?" over the
  // coverage percentage — while every figure assertion stays green (verified by
  // mutation). The identity translator makes the key itself visible, so this
  // also proves each title went through `t()`.
  it("titles every card with its OWN question's key, never a neighbour's", () => {
    const raw = renderInsightsTab(buildInsightAnswers(goldenData, buildOpts), [], rawT);
    for (const q of ["cost", "bought", "efficiency", "setup", "change"] as const) {
      expect(card(raw, `insight-${q}`)).toContain(
        `<div class="cs-card-title">dashboard:insights.cards.${q}</div>`,
      );
    }
  });
});

// ─── Honest-empty states: the most important part of the lane ─────────────────

describe("Insights tab — honest-empty states", () => {
  it("renders all five cards on a fresh install, none of them blank and none of them a fabricated zero", () => {
    const html = renderTab(emptyData, { ...buildOpts, hourlyRate: null, verdictSentence: null });
    const ids = [...html.matchAll(/id="(insight-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(5);
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain(">0%<");
  });

  it("each unavailable card states what is missing AND how to enable it", () => {
    const html = renderTab(emptyData, { ...buildOpts, hourlyRate: null, verdictSentence: null });

    const cost = card(html, "insight-cost");
    expect(cost).toContain('class="cs-card cs-card-unavailable"');
    expect(cost).toContain("No usage recorded for this period.");
    expect(cost).toContain("Run a Claude Code session, then refresh");

    const bought = card(html, "insight-bought");
    expect(bought).toContain("No spend attributed to work items yet.");
    expect(bought).toContain("Settings → Tickets");

    const eff = card(html, "insight-efficiency");
    expect(eff).toContain("Not enough completed work to measure efficiency.");
    expect(eff).toContain("check back after more usage");

    const setup = card(html, "insight-setup");
    expect(setup).toContain("Not enough data to judge your plan fit.");
    expect(setup).toContain("a few weeks of usage");

    // Q5 is the exception BY DESIGN: "nothing needs attention" is a real
    // answer, not a missing one, so it renders as an answer and not as an
    // unavailable card.
    const change = card(html, "insight-change");
    expect(change).not.toContain("cs-card-unavailable");
    expect(change).toContain("Nothing needs attention right now.");
  });

  it("every unavailable card carries an enablement line — asserted structurally, not per-card", () => {
    const html = renderTab(emptyData, { ...buildOpts, hourlyRate: null, verdictSentence: null });
    const unavailable = [...html.matchAll(/<div class="cs-card cs-card-unavailable"[\s\S]*?\n    <\/div>/g)].map((m) => m[0]);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const u of unavailable) {
      expect(u).toContain("cs-card-enablement");
      // An enablement line that renders empty is the empty widget this rule
      // exists to prevent.
      expect(u).toMatch(/<div class="cs-card-enablement">.{10,}<\/div>/);
    }
  });

  it("distinguishes 'ticket attribution not enabled' from 'enabled but nothing attributed this period'", () => {
    // Spend exists, extraction ran, but nothing matched. A bare 0% here would
    // read identically to "unconfigured", so the caveat must name the fix.
    const zeroCoverage: DashboardData = {
      ...goldenData,
      insights: {
        ...goldenData.insights!,
        ticketCoverage: {
          attributedCost: 0, totalCost: 312.4, ratio: 0,
          byConfidence: { high: 0, medium: 0, low: 0 }, ambiguousSessions: 0,
        },
        topTicket: null,
      },
    };
    const c = card(renderTab(zeroCoverage), "insight-bought");
    expect(c).not.toContain("cs-card-unavailable");
    expect(c).toContain("config.tickets.projectKeys");

    // …versus never enabled at all: no coverage object, so the card is
    // unavailable and points at Settings.
    const notEnabled: DashboardData = {
      ...goldenData,
      insights: { ...goldenData.insights!, ticketCoverage: null, topTicket: null },
    };
    const c2 = card(renderTab(notEnabled), "insight-bought");
    expect(c2).toContain("cs-card-unavailable");
    expect(c2).toContain("Settings → Tickets");
  });
});

// ─── The account-mode decision ────────────────────────────────────────────────

const acct = (uuid: string, subscriptionType: string | null) => ({
  accountUuid: uuid, emailAddress: null, subscriptionType, sessionCount: 1, isCurrent: false,
});

// ─── Lane K: calibration reaches the card that quotes the figures ────────────

describe("Q2 carries calibration for exactly the figures it states", () => {
  const withCalibration = (over: Partial<DashboardData>): DashboardData =>
    ({ ...goldenData, ...over }) as DashboardData;

  const boughtCaveat = (data: DashboardData): string | null =>
    buildInsightAnswers(data, buildOpts)[1]!.caveat;

  it("attaches the attribution estimate when coverage is stated", () => {
    const caveat = boughtCaveat(
      withCalibration({
        insights: {
          ...goldenData.insights!,
          attributionCalibration: calibrate("attribution", { agreed: 2, disagreed: 1 }),
        },
        costPerTask: null,
      }),
    );
    expect(caveat).toContain(t("common:insight.calibration.uncalibrated.attribution", { n: 3, minN: 30 }));
  });

  it("states no calibration on the honest-unavailable card, whatever it is handed", () => {
    // With no coverage the card is unavailable and carries no caveat at all.
    // This pins the OBSERVABLE rule; it is deliberately NOT paired with a
    // `coverage &&` guard in `buildInsightAnswers`, because such a guard cannot
    // change this outcome — see the comment there.
    const answer = buildInsightAnswers(
      withCalibration({
        insights: {
          ...goldenData.insights!,
          ticketCoverage: null,
          attributionCalibration: calibrate("attribution", { agreed: 40, disagreed: 0 }),
        },
        calibration: { n: 40, floor: 0.7, proxyOnly: { n: 40, hits: 40 }, withSignals: { n: 40, hits: 40 } } as unknown as DashboardData["calibration"],
      }),
      buildOpts,
    )[1]!;
    expect(answer.unavailable?.reason).toBe("not-enabled");
    expect(answer.caveat).toBeNull();
    // And the sentence must not smuggle a rate in through the answer text.
    expect(answer.answer).not.toContain("100%");
  });

  it("attaches the outcome estimate only when a completed-task count is stated", () => {
    const report = {
      n: 40, floor: 0.7,
      proxyOnly: { n: 40, hits: 27 },
      withSignals: { n: 40, hits: 27 },
    } as unknown as DashboardData["calibration"];

    // 27 of 40 = 68%, with the 95% Wilson interval 52%–80%. Asserting the
    // whole composed sentence rather than a substring: a "68%" that came from
    // some other computation would still satisfy a substring check.
    const expected = t("common:insight.calibration.measured.outcome", {
      percent: "68%", n: 40, lo: "52%", hi: "80%",
    });
    const withCount = boughtCaveat(withCalibration({ calibration: report }));
    expect(withCount).toContain(expected);

    // `costPerTask: null` means no success count is rendered, so outcome
    // detection qualifies nothing on this card.
    const withoutCount = boughtCaveat(withCalibration({ calibration: report, costPerTask: null }));
    expect(withoutCount).not.toContain(expected);
  });

  it("leaves Q2's caveat unchanged when nothing has been calibrated", () => {
    // The pre-Lane-K rendering, byte for byte. A caveat that grew an empty
    // clause would be a visible regression on the default tab.
    const bare = boughtCaveat(
      withCalibration({
        insights: { ...goldenData.insights!, attributionCalibration: null },
        calibration: null,
      }),
    );
    expect(bare).toBe(t("common:insight.coverage.mixAmbiguous", {
      parts: [
        t("common:insight.coverage.tier", { percent: "72%", tier: t("common:insight.confidence.high") }),
        t("common:insight.coverage.tier", { percent: "21%", tier: t("common:insight.confidence.medium") }),
        t("common:insight.coverage.tier", { percent: "7%", tier: t("common:insight.confidence.low") }),
      ].join(t("common:insight.punctuation.dotJoin")),
      count: 2,
    }));
  });

  it("renders the calibration sentence into the actual card, not just the answer object", () => {
    const data = withCalibration({
      insights: {
        ...goldenData.insights!,
        attributionCalibration: calibrate("attribution", { agreed: 2, disagreed: 1 }),
      },
    });
    const boughtCard = card(renderTab(data), "insight-bought");
    expect(boughtCard).toContain("30");
    expect(boughtCard).toContain(t("common:insight.calibration.uncalibrated.attribution", { n: 3, minN: 30 }));
  });
});

describe("cost vocabulary — resolving one answer for a dashboard spanning N accounts", () => {
  const noConfig: Config = {};

  it("an explicit config.pricing.mode wins over every inference", () => {
    const data: DashboardData = {
      ...goldenData,
      availableAccounts: [acct("a", "max_20x"), acct("b", null)],
    };
    // Accounts alone would say "mixed"; the declaration overrides it.
    expect(resolveDashboardCostVocabulary(data, noConfig).vocabulary).toBe("mixed");
    const r = resolveDashboardCostVocabulary(data, { pricing: { mode: "metered" } });
    expect(r).toMatchObject({ vocabulary: "metered", basis: "config" });
  });

  it("agreeing accounts give their shared vocabulary", () => {
    const plan: DashboardData = { ...goldenData, availableAccounts: [acct("a", "pro"), acct("b", "max_5x")] };
    expect(resolveDashboardCostVocabulary(plan, noConfig)).toMatchObject({
      vocabulary: "plan", basis: "accounts", planAccounts: 2, meteredAccounts: 0,
    });

    const metered: DashboardData = { ...goldenData, availableAccounts: [acct("a", null), acct("b", null)] };
    expect(resolveDashboardCostVocabulary(metered, noConfig)).toMatchObject({
      vocabulary: "metered", basis: "accounts", planAccounts: 0, meteredAccounts: 2,
    });
  });

  it("disagreeing accounts resolve to `mixed` — the mode is not silently picked", () => {
    const data: DashboardData = { ...goldenData, availableAccounts: [acct("a", "max_20x"), acct("b", null)] };
    expect(resolveDashboardCostVocabulary(data, noConfig)).toMatchObject({
      vocabulary: "mixed", basis: "mixed-accounts", planAccounts: 1, meteredAccounts: 1,
    });
  });

  it("a filtered-to dashboard uses only the selected account, so filtering resolves the ambiguity", () => {
    const base: DashboardData = { ...goldenData, availableAccounts: [acct("a", "max_20x"), acct("b", null)] };
    // `availableAccounts` is documented as INDEPENDENT of the account filter,
    // so an unfiltered read of it would keep saying "mixed" after the user
    // narrowed to one account — the filter would appear not to work.
    expect(resolveDashboardCostVocabulary({ ...base, selectedAccountUuid: "a" }, noConfig).vocabulary).toBe("plan");
    expect(resolveDashboardCostVocabulary({ ...base, selectedAccountUuid: "b" }, noConfig).vocabulary).toBe("metered");
  });

  it("a configured per-account fee counts as plan billing even with no detected subscription type", () => {
    // The regression this guards: an account whose subscription metadata never
    // reached the store, but for which the user recorded a monthly fee, would
    // otherwise be called `metered` — relabelling its equivalent-value figure
    // "Actual metered cost.", which is exactly the quietly-wrong number I1
    // forbids.
    const data: DashboardData = {
      ...goldenData,
      availableAccounts: [acct("a", null)],
      planUtilization: {
        ...goldenData.planUtilization!,
        byAccount: [{ accountId: "a", subscriptionType: null, detectedPlanFee: 100 }],
      } as unknown as DashboardData["planUtilization"],
    };
    expect(resolveDashboardCostVocabulary(data, noConfig)).toMatchObject({
      vocabulary: "plan", basis: "accounts", planAccounts: 1,
    });
  });

  it("with no per-account evidence at all, falls back to the plan-fee proxy — today's behaviour, unchanged", () => {
    const noAccounts: DashboardData = { ...goldenData, availableAccounts: [], planUtilization: null };
    expect(resolveDashboardCostVocabulary(noAccounts, noConfig)).toMatchObject({
      vocabulary: "metered", basis: "fee-proxy",
    });
    const withFee: DashboardData = {
      ...noAccounts, summary: { ...noAccounts.summary, planFee: 100 },
    };
    expect(resolveDashboardCostVocabulary(withFee, noConfig)).toMatchObject({
      vocabulary: "plan", basis: "fee-proxy",
    });
  });

  // `resolveDashboardCostVocabulary` reimplements the per-account rule rather
  // than calling `resolveAccountMode`, and it has to: `config.pricing.mode` is
  // already consumed above it, so passing the config down would collapse every
  // account to the same declared answer and make the N-account loop pointless.
  // The cost is that two functions now decide one fact about one account, with
  // nothing holding them together — the drift the shared-formatter rule exists
  // to prevent, one level down. This pins them.
  it("agrees with resolveAccountMode on the subscription-type axis, so one account cannot get two answers", () => {
    for (const subscriptionType of ["pro", "max_5x", "max_20x", "team", "enterprise", null]) {
      const one: DashboardData = {
        ...goldenData,
        planUtilization: null, // force the availableAccounts path: type only, no fee
        availableAccounts: [acct("a", subscriptionType)],
      };
      expect(
        resolveDashboardCostVocabulary(one, noConfig).vocabulary,
        `subscriptionType=${subscriptionType}`,
      ).toBe(resolveAccountMode(noConfig, subscriptionType));
    }
  });

  it("documents the ONE axis on which the two deliberately differ — a fee only the dashboard can see", () => {
    // `resolveAccountMode` takes a subscription type and nothing else, so it
    // cannot know about a hand-configured `accountFees` entry. The dashboard
    // can, and treats it as plan billing. Asserted so the divergence is a
    // recorded decision rather than a latent surprise.
    const fee: DashboardData = {
      ...goldenData,
      availableAccounts: [acct("a", null)],
      planUtilization: {
        ...goldenData.planUtilization!,
        byAccount: [{ accountId: "a", subscriptionType: null, detectedPlanFee: 100 }],
      } as unknown as DashboardData["planUtilization"],
    };
    expect(resolveDashboardCostVocabulary(fee, noConfig).vocabulary).toBe("plan");
    expect(resolveAccountMode(noConfig, null)).toBe("metered");
  });

  it("suppresses the plan multiplier inside the shared formatter, not at the call site", () => {
    // Asserted directly on `answerCost` because the caller passes planFee and
    // planMultiplier UNCONDITIONALLY: if the caller gated them instead, this
    // guard would be unreachable from the dashboard and the pack would be free
    // to render a multiplier the dashboard suppresses. (This test exists
    // because the first version of the mixed-card test below passed with the
    // formatter's guard broken.)
    const mixed = answerCost(t, { mode: "mixed", cost: 312.4, previousCost: null, planFee: 100, planMultiplier: 3.1 });
    expect(mixed.answer).not.toContain("3.1×");
    const plan = answerCost(t, { mode: "plan", cost: 312.4, previousCost: null, planFee: 100, planMultiplier: 3.1 });
    expect(plan.answer).toContain("3.1× your $100/mo plan");
  });

  it("says so on the card when the vocabulary is ambiguous, and drops the plan multiplier", () => {
    const mixedData: DashboardData = {
      ...goldenData,
      summary: { ...goldenData.summary, planFee: 100, planMultiplier: 3.1 },
    };
    const c = card(renderTab(mixedData, { ...buildOpts, vocabulary: "mixed" }), "insight-cost");
    expect(headlineValue(c)).toBe("$312");
    expect(c).toContain("Mixed billing across the accounts in view");
    // The multiplier would divide the WHOLE period's cost by a fee covering
    // only part of it — an overstatement, so it must not appear.
    expect(c).not.toContain("3.1×");
    expect(c).not.toContain("/mo plan");
    // …and it must not fall back to either single-mode claim.
    expect(c).not.toContain("Actual metered cost.");
    expect(c).not.toContain("not what your plan charges");
  });
});

// ─── The alerts strip ─────────────────────────────────────────────────────────

describe("alerts strip — precision over recall", () => {
  it("is absent entirely when nothing warrants attention", () => {
    const quiet: DashboardData = { ...goldenData, recommendations: [], summary: { ...goldenData.summary, anyFallbackRates: false } };
    expect(buildAlerts(quiet, t)).toEqual([]);
    expect(renderTab(quiet)).not.toContain("cs-alerts");
  });

  it("fires on partner-platform fallback pricing — a recorded fact, not a heuristic", () => {
    const data: DashboardData = {
      ...goldenData, recommendations: [], summary: { ...goldenData.summary, anyFallbackRates: true },
    };
    const alerts = buildAlerts(data, t);
    expect(alerts.map((a) => a.id)).toEqual(["fallback-rates"]);
    expect(alerts[0]!.text).toContain("partner platform");
    expect(renderTab(data)).toContain('data-alert-id="fallback-rates"');
  });

  it("promotes only `critical` recommendations — warning, info and success stay off the strip", () => {
    const alerts = buildAlerts(goldenData, t);
    expect(alerts.map((a) => a.id)).toEqual(["rec:model-tier-waste"]);
    expect(alerts[0]!.text).toBe("Route simpler prompts to cheaper models — ~$41.00 saveable");
    // The warning and success recommendations are present in the payload and
    // deliberately not promoted — that non-promotion is the precision rule.
    expect(goldenData.recommendations.map((r) => r.severity)).toContain("warning");
    expect(alerts.map((a) => a.id)).not.toContain("rec:context-compaction");
    expect(alerts.map((a) => a.id)).not.toContain("rec:praise");
  });

  it("renders a critical recommendation with no impact tag as the bare title, not a dangling separator", () => {
    const noImpact: DashboardData = {
      ...goldenData,
      recommendations: [{ id: "x", severity: "critical", title: "Something is badly wrong", body: "…" }],
    };
    const alerts = buildAlerts(noImpact, t);
    expect(alerts[0]!.text).toBe("Something is badly wrong");
    expect(alerts[0]!.text).not.toContain("—");
  });

  it("does not double-report a mixed vocabulary — that is the cost card's caveat, not an alert", () => {
    const mixedData: DashboardData = { ...goldenData, recommendations: [] };
    expect(buildAlerts(mixedData, t)).toEqual([]);
  });

  // An alert is "one line + one action link" (02 §2.3). Both halves of that
  // were unasserted: nothing checked an alert's severity — which is the only
  // thing separating the red critical rail from the amber warning rail — and
  // nothing checked where "Review" actually goes. Downgrading every critical
  // alert to `warning`, and routing the fallback-rates alert away from
  // Settings (where the fix lives) to the Efficiency tab, both left the suite
  // green.
  it("carries each alert's severity and action destination into the rendered strip", () => {
    const data: DashboardData = {
      ...goldenData, summary: { ...goldenData.summary, anyFallbackRates: true },
    };
    // The fact-based alert leads, and each one keeps its own severity and the
    // tab on which the reader can act.
    expect(buildAlerts(data, t).map((a) => [a.id, a.severity, a.tab])).toEqual([
      ["fallback-rates", "warning", "settings"],
      ["rec:model-tier-waste", "critical", "efficiency"],
    ]);

    const html = renderTab(data);
    const stripStart = html.indexOf('<div class="cs-alerts"');
    expect(stripStart).toBeGreaterThan(-1);
    // Sliced: the cards below carry `data-evidence-link` attributes of their
    // own, so a page-wide search for an href would find the wrong element.
    const strip = html.slice(stripStart, html.indexOf('<div class="cs-insights-grid">'));
    expect(strip).toContain('<div class="cs-alert cs-alert-warning" data-alert-id="fallback-rates">');
    expect(strip).toContain('<div class="cs-alert cs-alert-critical" data-alert-id="rec:model-tier-waste">');
    expect(strip).toContain('href="#settings" data-evidence-link="settings"');
    expect(strip).toContain('href="#efficiency" data-evidence-link="efficiency"');
  });

  // `insights.ts` keeps its own escaper (deliberately independent of
  // `card.ts`'s), and nothing exercised it: replacing it with the identity
  // function left every test green. Recommendation titles and impacts are
  // engine-composed strings that interpolate plan labels and figures, so this
  // is defence in depth rather than a live injection — but an unexercised
  // escaper is one refactor away from not being one.
  it("escapes recommendation text and alert ids rather than trusting them as markup", () => {
    const hostile: DashboardData = {
      ...goldenData,
      summary: { ...goldenData.summary, anyFallbackRates: false },
      recommendations: [
        {
          id: 'x" onload="alert(1)',
          severity: "critical",
          title: "<img src=x onerror=alert(1)>",
          body: "…",
          impact: '"><script>alert(2)</script>',
        },
      ],
    };
    const html = renderTab(hostile);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    // The id lands in a quoted attribute, where an unescaped `"` breaks out of
    // the attribute rather than merely rendering a stray tag.
    expect(html).toContain('data-alert-id="rec:x&quot; onload=&quot;alert(1)"');
    expect(html.match(/\bdata-alert-id="/g)).toHaveLength(1);
  });

  it("localizes its own copy through t(), rather than hardcoding English", () => {
    const data: DashboardData = {
      ...goldenData, recommendations: [], summary: { ...goldenData.summary, anyFallbackRates: true },
    };
    // With the identity translator the strings arrive as i18n KEYS, which only
    // happens if they went through t(). Asserting the English text alone
    // cannot distinguish a translated string from a hardcoded literal.
    const raw = renderInsightsTab(buildInsightAnswers(data, buildOpts), buildAlerts(data, rawT), rawT);
    expect(raw).toContain("dashboard:insights.alerts.fallbackRates");
    expect(raw).toContain("dashboard:insights.alerts.action");
    expect(raw).toContain("dashboard:insights.cards.cost");
    expect(raw).toContain("dashboard:insights.lede");
  });
});

// ─── The two-click evidence promise ───────────────────────────────────────────

describe("evidence links reach a tab that exists", () => {
  it("maps every answer's domain-view id onto a real nav tab", () => {
    for (const [domainId, tabId] of Object.entries(EVIDENCE_TAB)) {
      expect(NAV_TAB_IDS, `${domainId} maps to a nav tab`).toContain(tabId);
    }
    // Every evidenceLink the formatters can emit must be in the map, or its
    // card would link to an anchor that is not on the page.
    const emitted = buildInsightAnswers(goldenData, buildOpts)
      .map((a) => a.evidenceLink)
      .filter((l): l is string => l !== null);
    expect(emitted.length).toBeGreaterThan(0);
    for (const link of emitted) expect(Object.keys(EVIDENCE_TAB)).toContain(link);
  });

  it("keeps the canonical domain id on the element while the href points at today's tab", () => {
    const c = card(renderTab(goldenData), "insight-cost");
    expect(c).toContain('href="#spending"');
    expect(c).toContain('data-evidence-link="cost-and-controlling"');
  });
});

// ─── Both hosts, on the real page ─────────────────────────────────────────────

describe("the served page", () => {
  it("makes Insights the default tab and renders its five cards into the active panel", () => {
    const html = renderDashboard(goldenData, t);
    expect(html).toMatch(/<button class="tab-btn active" data-tab="insights">/);
    const panelStart = html.indexOf('<div class="tab-panel active" id="tab-insights">');
    expect(panelStart).toBeGreaterThan(-1);
    const panel = html.slice(panelStart, html.indexOf('id="tab-overview"'));
    for (const q of ["cost", "bought", "efficiency", "setup", "change"]) {
      expect(panel).toContain(`id="insight-${q}"`);
    }
  });

  it("renders ONE cost figure twice, not two figures — the Overview card and Q1 are the same answer", () => {
    // The anti-drift contract in the flesh: Phase 1 of the migration is
    // additive, so both cards exist for a release. Two independently composed
    // renderings of one number is exactly the drift the shared formatters
    // exist to prevent.
    const html = renderDashboard(goldenData, t);
    const overview = card(html, "card-cost");
    const q1 = card(html, "insight-cost");
    expect(headlineValue(overview)).toBe(headlineValue(q1));
    expect(headlineValue(overview)).toBe("$312");
    const sentenceOf = (c: string) => c.match(/<div class="cs-card-answer">([^<]*)</)![1];
    expect(sentenceOf(overview)).toBe(sentenceOf(q1));
    const caveatOf = (c: string) => c.match(/<div class="cs-card-caveat">([^<]*)</)?.[1] ?? null;
    expect(caveatOf(overview)).toBe(caveatOf(q1));
  });

  // Everything above renders `renderInsightsTab` directly with a hand-built
  // `InsightBuildOptions`, which leaves the wiring in `template.ts` — the code
  // that DECIDES those options — completely unasserted. Deleting the
  // resolver's result from that call site and reverting to the `planFee > 0`
  // proxy, and separately nulling the configured hourly rate and flipping the
  // plan verdict, all left the suite green (verified by mutation). These two
  // tests assert the decisions, on the real page.
  it("takes the cost vocabulary from the resolver, not from the planFee proxy it replaced", () => {
    // Two accounts, one plan seat and one metered, and NO manually configured
    // plan fee — the case the proxy gets wrong. `planFee === 0` makes the proxy
    // say "metered", so the page would print "Actual metered cost." over a
    // figure that is half plan-equivalent value: precisely the confidently
    // wrong claim I1 forbids.
    const mixed: DashboardData = {
      ...goldenData,
      availableAccounts: [acct("a", "max_20x"), acct("b", null)],
      insights: {
        ...goldenData.insights!,
        vocabulary: { vocabulary: "mixed", basis: "mixed-accounts", planAccounts: 1, meteredAccounts: 1 },
      },
    };
    expect(mixed.summary.planFee).toBe(0);
    const c = card(renderDashboard(mixed, t), "insight-cost");
    expect(c).toContain("Mixed billing across the accounts in view");
    expect(c).not.toContain("Actual metered cost.");

    // The converse, and the more common one: a Max subscriber who never typed
    // a fee into Settings. The proxy calls that metered too.
    const plan: DashboardData = {
      ...goldenData,
      availableAccounts: [acct("a", "max_20x")],
      insights: {
        ...goldenData.insights!,
        vocabulary: { vocabulary: "plan", basis: "accounts", planAccounts: 1, meteredAccounts: 0 },
      },
    };
    const p = card(renderDashboard(plan, t), "insight-cost");
    expect(p).toContain("Equivalent API cost — not what your plan charges.");
    expect(p).not.toContain("Actual metered cost.");
  });

  it("feeds the cards the configured rate, currency and plan verdict from the payload", () => {
    const html = renderDashboard(goldenData, t);
    // $312.40 at the configured $90/h → 3.5 dev-hours. Asserted on the PAGE,
    // so the rate is proven to travel data.insights → template.ts → the card,
    // not merely to survive `buildInsightAnswers` when a test hands it over.
    const q1 = card(html, "insight-cost");
    expect(q1).toContain("≈ 3.5 dev-hours at your configured rate");
    expect(headlineValue(q1)).toBe("$312"); // USD from the payload, not a stray default
    // Q4 renders `planUtilization.currentPlanVerdict` translated by the host;
    // the golden verdict is "good-value", and the two other branches read
    // completely differently to a manager.
    const q4 = card(html, "insight-setup");
    expect(q4).toContain("Your plan is good value for how much you use it.");
    expect(q4).not.toContain("No plan detected");
    expect(q4).not.toContain("using less than your plan covers");
  });

  it("carries the tab label through t(), not as a hardcoded literal", () => {
    expect(renderDashboard(goldenData, t)).toContain('data-tab="insights">Insights<');
    expect(renderDashboard(goldenData, rawT)).toContain('data-tab="insights">dashboard:tabs.insights<');
  });

  it("declares the default tab from the nav definition and listens for evidence-link hash changes", () => {
    const html = renderDashboard(goldenData, t);
    expect(html).toContain("var defaultTab = 'insights';");
    expect(html).toContain("window.addEventListener('hashchange'");
  });
});
