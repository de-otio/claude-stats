/**
 * The consolidated cost-quality card (03 §3.3 item 1).
 *
 * The lesson this build keeps re-learning is that presence assertions go green
 * on materially wrong output: the previous lane's reconciliation panel survived
 * four injected mutations — including a 100× unit error — because nothing pinned
 * a VALUE. So the assertions here are values: exact strings, at exact places,
 * computed by hand from the golden fixture, plus the ORDER of the three layers,
 * which is the substance of the consolidation and not decoration.
 *
 * Golden inputs (fixtures/golden-dashboard.ts):
 *   efficiency: realised 88.4, frontier 61.9, recoverable 26.5
 *               levers: route_by_archetype ~18.25, cache_hygiene ~6.40
 *   costPerTask: 100 tasks, 40 observable (40%), 12 success, 28 failed,
 *                30 in-flight, 30 unobservable, success rate 30%,
 *                mean/attempt 10.5, per successful task 35, 5 labelled
 *   calibration: n=34, floor 0.7; proxy 62% / 0.214 / 58%,
 *                withSignals 77% / 0.131 / 81%, meetsFailedFloor true
 */
import { describe, it, expect } from "vitest";
import { renderDashboard } from "../server/template.js";
import type { TranslateFn } from "../server/template.js";
import type { DashboardData } from "../dashboard/index.js";
import { renderCostQualityCard, COST_QUALITY_ANCHOR } from "../server/costQualityCard.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import { visibleText } from "./fixtures/figures.js";
import { initI18n } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;

/** The card's own markup, sliced out by its id. Page-wide assertions are
 *  vacuous here — COST_QUALITY_CSS is embedded in every page and contains the
 *  class tokens verbatim. */
function cardOf(html: string): string {
  const at = html.indexOf(`id="${COST_QUALITY_ANCHOR}"`);
  expect(at, "the cost-quality card is not on the page").toBeGreaterThan(-1);
  const start = html.lastIndexOf("<div", at);
  // The card ends where the next sibling in the Spending section begins.
  const end = html.indexOf('<div class="charts-grid">', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

const html = renderDashboard(goldenDashboard, t);
const card = cardOf(html);
const cardText = visibleText(card);

describe("three cards became one", () => {
  it("renders exactly one cost-quality card, not three stacked ones", () => {
    expect([...html.matchAll(/id="cost-quality"/g)]).toHaveLength(1);
    // The three predecessors each carried their own `.cpt-card` chrome; there
    // is now exactly one such element on the page.
    expect([...html.matchAll(/class="cpt-card[^"]*"/g)]).toHaveLength(1);
  });

  it("layers it frontier → cost-per-task → calibration, which is the consolidation", () => {
    // value-per-cost/06 and 03 §3.2: the frontier LEADS and cost-per-task nests
    // inside it. Before the regrouping the frontier card was rendered BELOW the
    // card it was supposed to demote (01 §1.4), so order is the substance here.
    const frontierAt = card.indexOf(t("dashboard:costQuality.frontierLayer"));
    const perTaskAt = card.indexOf(t("dashboard:costQuality.perTaskLayer"));
    const calibrationAt = card.indexOf(t("dashboard:costQuality.calibrationLayer"));
    expect(frontierAt).toBeGreaterThan(-1);
    expect(perTaskAt).toBeGreaterThan(frontierAt);
    expect(calibrationAt).toBeGreaterThan(perTaskAt);
  });

  it("collapses calibration behind a caveat that states the verdict and no figure", () => {
    expect(card).toContain("<details class=\"cs-cq-calibration\">");
    expect(card).toContain('<summary class="cs-cq-caveat">');
    const summary = card.match(/<summary class="cs-cq-caveat">([^<]*)</)![1]!;
    // The golden calibration meets the failed-precision floor.
    expect(summary).toBe("Outcome labels are calibrated — see how");
    // A figure in a collapsed summary is a figure whose caveats are hidden.
    expect(summary).not.toMatch(/\d/);
  });

  it("reads the SAME field the expanded readiness line does, so the two cannot disagree", () => {
    const notReady: DashboardData = {
      ...goldenDashboard,
      calibration: {
        ...goldenDashboard.calibration!,
        withSignals: { ...goldenDashboard.calibration!.withSignals, meetsFailedFloor: false },
      },
    };
    const c = cardOf(renderDashboard(notReady, t));
    expect(c.match(/<summary class="cs-cq-caveat">([^<]*)</)![1]).toBe(
      "Outcome labels are not calibrated yet — see why",
    );
    // …and the expanded body's own readiness line agrees.
    expect(visibleText(c)).toContain("Below the failed-precision floor");
  });

  it("says so plainly when nothing has been labelled at all", () => {
    const none: DashboardData = {
      ...goldenDashboard,
      calibration: { ...goldenDashboard.calibration!, n: 0 },
    };
    const c = cardOf(renderDashboard(none, t));
    expect(c.match(/<summary class="cs-cq-caveat">([^<]*)</)![1]).toBe(
      "Outcome labels are not calibrated — nothing labelled yet",
    );
  });
});

describe("consolidating did not move a figure", () => {
  // Each of these is the exact rendered string for a hand-computed input.
  // A mutation that rescales, rounds differently, or swaps two of them fails
  // here — which is precisely what a `toContain("realised")` presence check
  // would not do.
  it("keeps the frontier trio, and it still reconciles: realised − frontier = recoverable", () => {
    expect(card).toContain(">$88.40<"); // realisedCost
    expect(card).toContain(">$61.90<"); // frontierCost
    expect(card).toContain(">$26.50<"); // recoverableWaste
    expect(88.4 - 61.9).toBeCloseTo(26.5, 6);
  });

  it("keeps both levers with their savings, in rank order", () => {
    const first = card.indexOf("$18.25");
    const second = card.indexOf("$6.40");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("keeps the cost-per-task headline and its decomposition", () => {
    expect(card).toContain(">$35.00<"); // costPerSuccessfulTask
    // "$10.50 per attempt × 30% success" — the decomposition sentence, whose
    // two figures are a rate and a percentage and must not be interchanged.
    expect(cardText).toContain("$10.50");
    expect(cardText).toContain("30%");
  });

  it("keeps every coverage badge count, unrescaled", () => {
    expect(cardText).toContain("40/100 observable");
    expect(cardText).toContain("5/40 labelled");
    expect(cardText).toContain("12 success");
    expect(cardText).toContain("28 failed");
    expect(cardText).toContain("30 in-flight");
    expect(cardText).toContain("30 unobservable");
    // Coverage is a FRACTION rendered as a percent — the 100× class of error.
    expect(cardText).toContain("40%");
    expect(cardText).not.toContain("0.4%");
    expect(cardText).not.toContain("4000%");
  });

  it("keeps every calibration figure in the expanded body", () => {
    expect(cardText).toContain("62%"); // proxy accuracy
    expect(cardText).toContain("77%"); // with-signals accuracy
    expect(cardText).toContain("58%"); // proxy failed precision
    expect(cardText).toContain("81%"); // with-signals failed precision
    expect(cardText).toContain("0.214"); // proxy Brier
    expect(cardText).toContain("0.131"); // with-signals Brier
    expect(cardText).toContain("34"); // labelled count
  });

  it("keeps the webview-only controls the bridge binds to", () => {
    // The activation toggle lives inside the collapsed calibration layer now;
    // moving it out of the DOM would silently disable the feature in the
    // webview, where the bridge looks it up by id.
    expect(card).toContain('id="signals-toggle"');
  });
});

describe("the card appears only when it has something to say", () => {
  it("renders nothing at all when every layer is empty", () => {
    expect(renderCostQualityCard({ frontier: "", perTask: "", calibration: null }, t)).toBe("");
    expect(renderCostQualityCard({ frontier: "", perTask: "", calibration: { body: "", summary: "x" } }, t)).toBe("");
  });

  it("renders the layers that do have something, and only those", () => {
    const only = renderCostQualityCard({ frontier: "<p>F</p>", perTask: "", calibration: null }, t);
    expect(only).toContain("<p>F</p>");
    expect(only).toContain(t("dashboard:costQuality.frontierLayer"));
    expect(only).not.toContain(t("dashboard:costQuality.perTaskLayer"));
    expect(only).not.toContain("<details");
  });

  it("is absent from a page with no cost-per-task report and no calibration", () => {
    const bare: DashboardData = { ...goldenDashboard, costPerTask: null, calibration: null };
    expect(renderDashboard(bare, t)).not.toContain(`id="${COST_QUALITY_ANCHOR}"`);
  });
});
