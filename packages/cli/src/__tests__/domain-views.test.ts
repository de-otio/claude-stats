/**
 * The domain-view regrouping (doc/analysis/gui-redesign/02 §2.4, 03 §3.2 phase 3).
 *
 * The test contract for a regrouping is a BEHAVIOUR COMPARISON, not a DOM
 * snapshot: a snapshot of a 3,000-line page fails on every whitespace change and
 * passes on a silently rescaled percentage, which is coverage filler. So the
 * headline assertion here compares the NUMBERS the page renders, per panel,
 * against a baseline captured from the renderer BEFORE the regrouping
 * (`fixtures/golden-figures.json`). Moving a card between views must not move a
 * figure; reordering cards inside a panel is invisible (the multiset is sorted);
 * losing, gaining or rescaling one is not.
 *
 * Everything else here pins the properties the brief calls non-negotiable:
 * nothing reachable before is unreachable now, the grouping is declared in one
 * place both hosts read, and the consolidated cost card kept every value.
 */
import { describe, it, expect, vi } from "vitest";

// `panel.ts` imports `vscode`, which does not exist outside the extension host.
// Only `patchForWebview` (a pure string transform) is exercised here, but the
// module-level import still has to resolve — same stub shape extension.test.ts
// uses.
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Two: 2 },
}));

import { renderDashboard } from "../server/template.js";
import type { TranslateFn } from "../server/template.js";
import type { DashboardData } from "../dashboard/index.js";
import {
  NAV_TABS,
  NAV_TAB_IDS,
  NAV_VIEWS,
  NAV_VIEW_IDS,
  DOMAIN_VIEW_IDS,
  DEFAULT_NAV_VIEW,
  viewForSection,
  visibleNavViews,
  type NavTabId,
} from "../server/nav.js";
import { patchForWebview } from "../extension/panel.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import { panelFigures, visibleText } from "./fixtures/figures.js";
import { initI18n } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Relative into THIS worktree's own source: a bare
// `require("@claude-stats/core/locales/en/dashboard.json")` resolves through
// Node's own package resolution, which from a worktree with no local
// node_modules walks up to the parent repo's checkout — so a key added here
// would read as missing.
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;
const baseline = require("./fixtures/golden-figures.json") as Record<string, string[]>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;

// ─── The behaviour comparison ─────────────────────────────────────────────────

describe("regrouping is figure-preserving", () => {
  it("renders exactly the figures it rendered before the regrouping, panel for panel", () => {
    const figures = panelFigures(renderDashboard(goldenDashboard, t));
    // Same panels, and the same numbers in each. Compared as a whole object so
    // a panel that gained or lost figures fails here rather than being skipped.
    expect(figures).toEqual(baseline);
  });

  it("the baseline is non-trivial — it would notice a figure going missing", () => {
    // A guard on the guard: an empty or near-empty baseline would make the
    // comparison above pass on a blank page. Verified by mutation — emptying
    // `figuresIn`'s regex makes THIS fail, not just the comparison.
    const total = Object.values(baseline).reduce((n, list) => n + list.length, 0);
    expect(total).toBeGreaterThan(100);
    expect(baseline.spending).toContain("$35.00");
    expect(baseline.spending).toContain("$88.40");
  });
});

// ─── The grouping itself ──────────────────────────────────────────────────────

describe("nav: sections group into domain views", () => {
  it("every section belongs to exactly one view — nothing becomes unreachable", () => {
    const owners = new Map<string, string[]>();
    for (const view of NAV_VIEWS) {
      for (const section of view.sections) {
        owners.set(section, [...(owners.get(section) ?? []), view.id]);
      }
    }
    for (const id of NAV_TAB_IDS) {
      expect(owners.get(id), `section "${id}" is in no view — its panel would be unreachable`).toHaveLength(1);
      expect(viewForSection(id)).toBe(owners.get(id)![0]);
    }
    // …and no view names a section that does not exist.
    const known = new Set<string>(NAV_TAB_IDS);
    for (const view of NAV_VIEWS) {
      for (const section of view.sections) expect(known.has(section), `unknown section "${section}"`).toBe(true);
    }
  });

  it("collapses twelve data-shaped tabs to eight navigation entries, four of them domain views", () => {
    // Twelve since the `tickets` section landed. The section count is NOT the
    // metric 03 §3.5 guards — a section is a panel inside a view, and adding one
    // is how a new analysis is meant to surface. The nav-entry count is the
    // metric, and it is unchanged at eight.
    expect(NAV_TAB_IDS).toHaveLength(12);
    expect(NAV_VIEW_IDS).toHaveLength(8);
    // The regression metric 03 §3.5 asks for: the nav must not grow back.
    expect(NAV_VIEW_IDS.length).toBeLessThan(NAV_TAB_IDS.length);
    expect([...DOMAIN_VIEW_IDS]).toEqual([
      "cost-and-controlling",
      "tickets-and-value",
      "efficiency-and-hygiene",
      "plan-and-policy",
    ]);
  });

  it("the four domain views absorb the tabs the IA assigns them", () => {
    const byId = new Map(NAV_VIEWS.map((v) => [v.id, v.sections as readonly string[]]));
    expect(byId.get("cost-and-controlling")).toContain("spending");
    expect(byId.get("cost-and-controlling")).toContain("overview");
    expect(byId.get("tickets-and-value")).toContain("tickets");
    expect(byId.get("tickets-and-value")).toContain("projects");
    expect(byId.get("tickets-and-value")).toContain("classify");
    expect(byId.get("efficiency-and-hygiene")).toContain("efficiency");
    expect(byId.get("efficiency-and-hygiene")).toContain("context");
    expect(byId.get("plan-and-policy")).toContain("plan");
  });

  it("Insights is still the front door", () => {
    expect(DEFAULT_NAV_VIEW).toBe("insights");
    expect(NAV_VIEW_IDS[0]).toBe("insights");
  });

  it("every view has its dashboard:views.<id> label — a missing one renders the raw key", () => {
    const views = (enDashboard as { views?: Record<string, string> }).views ?? {};
    for (const view of NAV_VIEWS) {
      expect(view.labelKey).toBe(`dashboard:views.${view.id}`);
      expect(typeof views[view.id], `missing dashboard:views.${view.id}`).toBe("string");
    }
    expect(Object.keys(views).sort()).toEqual([...NAV_VIEW_IDS].sort());
  });

  it("drops a view whose only section this payload does not render", () => {
    // Energy's single section is predicated on data.energy.
    const ids = visibleNavViews(goldenDashboard).map((e) => e.view.id);
    expect(ids).not.toContain("energy");
    expect(ids).toContain("cost-and-controlling");
  });

  it("keeps a partially-populated view — the mental map does not move (03 §3.3 item 5)", () => {
    // Cost & Controlling holds overview (unconditional) + spending
    // (conditional). Without spending the view must still be there, holding
    // overview alone, rather than vanishing the way the old tabs did.
    const noSpending: DashboardData = { ...goldenDashboard, spending: null };
    const entry = visibleNavViews(noSpending).find((e) => e.view.id === "cost-and-controlling");
    expect(entry).toBeDefined();
    expect(entry!.sections.map((s) => s.id)).toEqual(["overview"]);
  });
});

// ─── What the served page actually renders ────────────────────────────────────

// Every conditional block present at once, so all eleven panels render. Zeros
// and empty lists throughout: this fixture exists to make the PANELS appear,
// and the figures they carry are pinned by the behaviour comparison above
// against the richer golden payload. Module-scoped because two suites need it:
// section ORDER can only be checked on a payload that renders every section.
const everything: DashboardData = {
  ...goldenDashboard,
  energy: {
    totalEnergyWh: 12,
    totalCO2Grams: 3,
    co2GramsLow: 1,
    co2GramsHigh: 5,
    equivalents: {
      treesYears: 0,
      carKm: 0,
      transitKm: 0,
      solarPanelM2: 0,
      solarRegionKey: "world",
      naturalGasM3: 0,
      trainKm: 0,
      nuclearWasteMl: 0,
      windRotations: 0,
      hydroTurbineLiters: 0,
    },
    journeyAnchor: { key: "none", km: 0 },
    periodStartIso: "2026-01-09",
    periodEndIso: "2026-01-15",
    periodDays: 7,
    byDay: [],
    byModel: [],
    byProject: [],
    cacheImpact: { energySavedWh: 0, co2SavedGrams: 0, cacheEfficiencyPct: 0 },
    thinkingImpact: { sessionsWithThinking: 0, pctEnergyFromThinking: 0 },
    inferenceGeo: { detected: {}, coveragePct: 0 },
    region: "world",
    gridIntensity: 400,
    pue: 1.2,
    byClass: [],
  },
  contextAnalysis: {
    avgPromptsPerSession: 0,
    medianPromptsPerSession: 0,
    compactionRate: 0,
    avgPeakInputTokens: 0,
    sessionsNeedingCompaction: 0,
    lengthDistribution: [],
    contextGrowthCurve: [],
    longSessions: [],
    cacheByLength: [],
    compactionEvents: [],
  },
  modelEfficiency: {
    byModelAndTier: [],
    summary: {
      totalMessages: 0,
      classifiedMessages: 0,
      totalCost: 0,
      potentialSavings: 0,
      overusePercent: 0,
    },
    opusScoreDistribution: [],
    topOveruse: [],
  },
};

const everythingHtml = renderDashboard(everything, t);

describe("served page: views in the nav bar, sections in the panels", () => {
  const html = renderDashboard(goldenDashboard, t);

  it("the nav bar holds view buttons, not the eleven data-shaped tabs", () => {
    for (const id of visibleNavViews(goldenDashboard).map((e) => e.view.id)) {
      expect(html).toContain(`data-tab="${id}"`);
    }
    // The data-shaped ids that are NOT also view ids must have lost their button.
    for (const id of ["overview", "spending", "tickets", "projects", "classify", "context", "efficiency", "plan"]) {
      expect(html, `"${id}" still has a nav button`).not.toContain(`data-tab="${id}"`);
    }
  });

  it("labels come through t(), not a hardcoded literal", () => {
    const raw = renderDashboard(goldenDashboard, (k) => k);
    expect(raw).toContain('data-tab="cost-and-controlling">dashboard:views.cost-and-controlling<');
  });

  it("every rendered section panel keeps its id and declares the view that shows it", () => {
    for (const section of NAV_TABS) {
      const key = section.dataKey;
      if (key && goldenDashboard[key] == null) continue;
      const expected = viewForSection(section.id as NavTabId);
      expect(html).toContain(`id="tab-${section.id}" data-view="${expected}"`);
    }
  });

  it("only the default view's panels are pre-marked active", () => {
    const active = [...html.matchAll(/class="tab-panel active" id="tab-([a-z-]+)"/g)].map((m) => m[1]);
    expect(active).toEqual(["insights"]);
  });

  // NB: asserted against `everythingHtml`, not the golden page. The golden
  // payload has no contextAnalysis/modelEfficiency, so Efficiency & Hygiene
  // renders NEITHER of its sections there and an out-of-order `sections` array
  // for that view would sail through with nothing to compare (verified by
  // mutation: swapping its two entries survived until this moved).
  it("sections of a view render in the order nav.ts declares — the array is not a lie", () => {
    for (const view of NAV_VIEWS) {
      const positions = view.sections
        .map((id) => ({ id, at: everythingHtml.indexOf(`id="tab-${id}"`) }))
        .filter((p) => p.at >= 0);
      expect(positions.length, `${view.id} rendered no sections to compare`).toBe(view.sections.length);
      const sorted = [...positions].sort((a, b) => a.at - b.at).map((p) => p.id);
      expect(sorted, `${view.id} renders its sections out of declared order`).toEqual(positions.map((p) => p.id));
    }
  });

  it("a grouped view labels its sections; a single-section view adds no heading", () => {
    // "Spending" and "Overview" share Cost & Controlling, so both are named.
    expect(html).toContain('class="cs-section-heading" id="section-spending"');
    expect(html).toContain('class="cs-section-heading" id="section-overview"');
    // Insights is alone in its view — the nav button already names it.
    expect(html).not.toContain('id="section-insights"');
  });

  it("the client resolves a section hash to its view, so old deep links still land", () => {
    // EVIDENCE_TAB still emits '#spending'; the handler must map it.
    expect(html).toContain('href="#spending"');
    expect(html).toContain("function resolveHashTarget(target)");
    expect(html).toContain("SECTION_VIEW[target]");
    // The maps are interpolated from nav.ts, not hand-written in the script.
    expect(html).toContain('"spending":"cost-and-controlling"');
    expect(html).toContain('"cost-and-controlling":["overview","spending"]');
  });

  // The nav rewrite's real behaviour lives in a browser function no server-side
  // assertion can reach, so it is EXTRACTED from the rendered page and RUN here
  // against stubs. Pinning its source text instead would be theatre: a mutation
  // capping the init loop at one section leaves every plausible substring intact
  // (verified — that mutation survived a source-pinned version of this test).
  function runSwitchTab(pageHtml: string, viewId: string) {
    const grab = (re: RegExp): string => {
      const m = pageHtml.match(re);
      expect(m, `could not extract ${re}`).not.toBeNull();
      return m![0];
    };
    const maps =
      grab(/var VIEW_SECTIONS = \{[\s\S]*?\};/) + "\n" + grab(/var SECTION_VIEW = \{[\s\S]*?\};/);
    const fn = grab(/function switchTab\(viewId\) \{[\s\S]*?\n      \}/);

    const initCalls: string[] = [];
    const panels = [...pageHtml.matchAll(/id="tab-([a-z-]+)" data-view="([a-z-]*)"/g)].map(([, id, view]) => ({
      id,
      view,
      active: false,
    }));
    const buttons = [...pageHtml.matchAll(/class="tab-btn[^"]*" data-tab="([a-z-]+)"/g)].map(([, id]) => ({
      id,
      active: false,
    }));

    const harness = `
      ${maps}
      var initialized = {};
      var tabBtns = __btns.map(function (b) {
        return { getAttribute: function () { return b.id; }, classList: { toggle: function (_c, on) { b.active = on; } } };
      });
      var tabPanels = __panels.map(function (p) {
        return { getAttribute: function () { return p.view; }, classList: { toggle: function (_c, on) { p.active = on; } } };
      });
      var pricingPanel = { classList: { toggle: function (_c, on) { __state.pricingVisible = on; } } };
      var filterBar = { style: {}, getAttribute: function () { return __filterViews; } };
      var filterViews = __filterViews.split(' ');
      var window = { location: { hash: '' } };
      function initTab(id) { __initCalls.push(id); }
      ${fn}
      switchTab(__viewId);
      return { hash: window.location.hash, filterDisplay: filterBar.style.display, state: __state };
    `;
    const state: Record<string, unknown> = {};
    const filterViews = pageHtml.match(/data-filter-views="([^"]*)"/)![1]!;
    const result = new Function(
      "__btns",
      "__panels",
      "__initCalls",
      "__viewId",
      "__filterViews",
      "__state",
      harness,
    )(buttons, panels, initCalls, viewId, filterViews, state) as {
      hash: string;
      filterDisplay: string;
      state: Record<string, unknown>;
    };
    return { initCalls, panels, buttons, ...result };
  }

  it("a view shows every one of its sections and initialises every one of their charts", () => {
    const r = runSwitchTab(everythingHtml, "cost-and-controlling");
    // BOTH sections init — capping the loop at one leaves Spending's canvases blank.
    expect(r.initCalls).toEqual(["overview", "spending"]);
    // …and both panels are the ones made visible, and nothing else is.
    expect(r.panels.filter((p) => p.active).map((p) => p.id)).toEqual(["overview", "spending"]);
    expect(r.buttons.filter((b) => b.active).map((b) => b.id)).toEqual(["cost-and-controlling"]);
    // Assigned without a leading '#'; a real browser normalises it back on read.
    expect(r.hash).toBe("cost-and-controlling");
    // The pricing reference travels with the Overview section it prices.
    expect(r.state.pricingVisible).toBe(true);
    // A domain view offers the filters.
    expect(r.filterDisplay).toBe("");
  });

  it("switching to a utility surface shows only its own section and hides the filters", () => {
    const r = runSwitchTab(everythingHtml, "settings");
    expect(r.initCalls).toEqual(["settings"]);
    expect(r.panels.filter((p) => p.active).map((p) => p.id)).toEqual(["settings"]);
    expect(r.filterDisplay).toBe("none");
    expect(r.state.pricingVisible).toBe(false);
  });

  it("initialises a section once — returning to a view does not rebuild its charts", () => {
    // Chart.js leaks a canvas that is re-initialised, and the guard is keyed on
    // the SECTION so a section shared by two views could never be built twice.
    const r = runSwitchTab(everythingHtml, "efficiency-and-hygiene");
    expect(r.initCalls).toEqual(["context", "efficiency"]);
  });

  it("dispatches every section id to its own chart initialiser", () => {
    for (const [id, fn] of [
      ["overview", "initOverview"],
      ["spending", "initSpending"],
      ["projects", "initProjects"],
      ["classify", "initClassify"],
      ["context", "initContext"],
      ["efficiency", "initEfficiency"],
      ["plan", "initPlan"],
      ["sessions", "initSessions"],
      ["energy", "initEnergy"],
      ["settings", "initSettings"],
    ] as const) {
      expect(html, `no init dispatch for section "${id}"`).toContain(`case '${id}': ${fn}(); break;`);
    }
  });

  it("every inline <script> still parses (the nav rewrite lives in one)", () => {
    const bodies = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? "")
      .filter((b) => b.trim().length > 0);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(() => new Function(body)).not.toThrow();
  });
});

describe("nothing reachable before is unreachable now", () => {

  it("renders a panel for all eleven sections, each inside a view that is on screen", () => {
    const html = renderDashboard(everything, t);
    const viewsOnScreen = new Set(visibleNavViews(everything).map((e) => e.view.id));
    for (const id of NAV_TAB_IDS) {
      expect(html, `panel for "${id}" is missing`).toContain(`id="tab-${id}"`);
      const owner = viewForSection(id)!;
      expect(viewsOnScreen.has(owner), `"${id}" lives in view "${owner}", which has no button`).toBe(true);
      expect(html).toContain(`data-tab="${owner}"`);
    }
  });
});

// ─── Local filters ────────────────────────────────────────────────────────────

describe("local filters", () => {
  it("offers project, task class and ticket, and says which dimension is missing and why", () => {
    const html = renderDashboard(goldenDashboard, t);
    expect(html).toContain('id="filter-project"');
    expect(html).toContain('id="filter-taskclass"');
    expect(html).toContain('id="filter-ticket"');
    expect(html).toContain('id="filter-apply"');
    // No model control is shipped; the reason is stated rather than the control
    // being quietly absent (I1 — an unavailable answer states its own state).
    expect(html).not.toContain('id="filter-model"');
    expect(enDashboard).toHaveProperty("filters.modelUnavailable");
  });

  it("is offered on the domain views only", () => {
    const html = renderDashboard(goldenDashboard, t);
    expect(html).toContain(`data-filter-views="${DOMAIN_VIEW_IDS.join(" ")}"`);
    // Server-rendered hidden, because the default view is not a domain view —
    // otherwise it flashes above Insights, and stays there without scripts.
    expect(html).toMatch(/id="cs-filters" data-filter-views="[^"]*" style="display:none"/);
  });

  it("renders the controls in the state the data is actually in", () => {
    const filtered: DashboardData = {
      ...goldenDashboard,
      appliedFilters: { projectPath: "/home/user/project-y", ticket: "PROJ-123", taskClass: "debug" },
    };
    const html = renderDashboard(filtered, t);
    expect(html).toContain('<option value="/home/user/project-y" selected>');
    expect(html).toContain('<option value="debug" selected>');
    expect(html).toContain('value="PROJ-123"');
    // …and says how many are on, so a narrowed total is never read as the whole.
    expect(visibleText(html)).toContain("3 filters active");
  });

  it("uses the plural form for a single active filter", () => {
    const one: DashboardData = {
      ...goldenDashboard,
      appliedFilters: { projectPath: null, ticket: "PROJ-9", taskClass: null },
    };
    expect(visibleText(renderDashboard(one, t))).toContain("1 filter active");
  });

  it("shows no active-count and selects Any when nothing is filtered", () => {
    const html = renderDashboard(goldenDashboard, t);
    expect(visibleText(html)).not.toContain("filters active");
    expect(html).toContain('<option value="" selected>');
  });

  it("escapes a ticket key so it cannot break out of the value attribute", () => {
    const evil: DashboardData = {
      ...goldenDashboard,
      appliedFilters: { projectPath: null, ticket: '"><img src=x onerror=alert(1)>', taskClass: null },
    };
    const html = renderDashboard(evil, t);
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("names every task class from the classifier's own vocabulary", () => {
    const html = renderDashboard(goldenDashboard, t);
    for (const cls of ["debug", "greenfield", "refactor-multi-file", "config-chore", "review", "explore", "unknown"]) {
      expect(html, `no option for task class "${cls}"`).toContain(`<option value="${cls}"`);
    }
  });
});

// ─── Both hosts ───────────────────────────────────────────────────────────────

describe("both hosts render the regrouped nav", () => {
  const html = renderDashboard(goldenDashboard, t);
  const webview = patchForWebview(html, "vscode-resource:", "chart.js", "cost-and-controlling");

  it("the webview keeps the view buttons and the section panels", () => {
    expect(webview).toContain('data-tab="cost-and-controlling"');
    expect(webview).toContain('id="tab-spending" data-view="cost-and-controlling"');
    expect(webview).toContain("window.__ACTIVE_TAB__='cost-and-controlling'");
  });

  it("the webview re-binds the filter buttons to postMessage — it has no URL to navigate", () => {
    expect(webview).toContain("command: 'changeFilters'");
    expect(webview).toContain("window.applyFilters = function ()");
    // The served page's own listener is detached by cloning the node, so a
    // click cannot ALSO try to navigate the webview document.
    expect(webview).toContain("replaceChild(freshApply, applyFiltersBtn)");
  });

  it("the webview's remembered tab may be a pre-regrouping section id and still resolves", () => {
    const stale = patchForWebview(html, "vscode-resource:", "chart.js", "spending");
    expect(stale).toContain("window.__ACTIVE_TAB__='spending'");
    // resolveHashTarget maps it to the owning view rather than falling back to
    // the default, so a user who left the panel on Spending returns to it.
    expect(stale).toContain('"spending":"cost-and-controlling"');
    expect(stale).toContain("var startResolved = resolveHashTarget(startRaw)");
  });
});
