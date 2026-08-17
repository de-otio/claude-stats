/**
 * The per-ticket UI is opt-in — `tickets.showUi`, default OFF.
 *
 * Why hidden is the default: attribution precision is uncalibrated and
 * prompt-mention links dominate real stores (60%+ of attributed dollars at
 * `low` confidence in the store this was measured on), so the dollar figures
 * are not yet defensible as a default surface. The flag hides every ticket
 * surface the dashboard renders — the cost table, the link/negate card, Q2's
 * coverage figure, the ticket filter and the Settings allowlist block — while
 * the CLI report, MCP tools and the justification pack (deliberate,
 * evidence-carrying surfaces) stay untouched.
 *
 * The contract under test, per surface:
 *  - payload: hidden means ABSENT (`ticketTable` unset, coverage null), never
 *    null-meaning-broken — the section must read as not-there, not failed;
 *  - Q2: says "hidden pending validation" with the real enablement path,
 *    never `answerBought`'s "no spend attributed yet", which would be false
 *    over a store that holds links and would point at a Settings block this
 *    build does not render;
 *  - template: one predicate gates all three markup surfaces, so a build can
 *    never show the settings for a table it does not render.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { createRequire } from "node:module";
import { Store } from "../store/index.js";
import { buildDashboard, attachInsights, type DashboardData, type DashboardInsights } from "../dashboard/index.js";
import { buildInsightAnswers } from "../server/insights.js";
import { renderDashboard, type TranslateFn } from "../server/template.js";
import { mergeConfig, showTicketUi, validateTicketsConfig, type Config } from "../config.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { initI18n } from "@claude-stats/core/i18n";

// Relative into THIS worktree's own source — see ticket-table.test.ts.
const require = createRequire(import.meta.url);
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;
const enCommon = require("../../../core/src/locales/en/common.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard", "common"],
  resources: { en: { dashboard: enDashboard as unknown as object, common: enCommon as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;

const T0 = 1_700_000_000_000;

function seedSession(store: Store, sessionId: string): void {
  store.upsertSession({
    sessionId,
    projectPath: "/p",
    sourceFile: "/p/s.jsonl",
    firstTimestamp: T0,
    lastTimestamp: T0 + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 100_000,
    outputTokens: 20_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4-6"],
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
  } as SessionRecord);
  store.upsertMessages([
    {
      uuid: `msg-${sessionId}`,
      sessionId,
      timestamp: T0,
      claudeVersion: "2.1.70",
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      tools: [],
      thinkingBlocks: 0,
      serviceTier: null,
      inferenceGeo: null,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
      promptText: null,
      isTurnStart: true,
    } as MessageRecord,
  ]);
}

describe("attachInsights — the tickets.showUi gate", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
    seedSession(store, "sess-ui-1");
    store.addTicketLink({ sessionId: "sess-ui-1", ticketKey: "PROJ-1", source: "branch", confidence: "high" });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("hides by default: ticketTable UNSET (absent, not null-meaning-broken), coverage and topTicket null, flag raised", () => {
    const data = attachInsights(store, buildDashboard(store, {}), {}, {});
    expect("ticketTable" in data).toBe(false);
    expect(data.insights?.ticketCoverage).toBeNull();
    expect(data.insights?.topTicket).toBeNull();
    expect(data.insights?.ticketUiHidden).toBe(true);
  });

  it("shows when opted in: the same store yields the table, coverage and the top ticket", () => {
    const data = attachInsights(store, buildDashboard(store, {}), {}, { tickets: { showUi: true } });
    expect(data.insights?.ticketUiHidden).toBe(false);
    expect(data.ticketTable).not.toBeNull();
    expect(data.ticketTable?.rows.map((r) => r.ticketKey)).toContain("PROJ-1");
    expect(data.insights?.ticketCoverage).not.toBeNull();
    expect(data.insights?.topTicket?.key).toBe("PROJ-1");
  });

  it("keeps reconciliation working while hidden — it rides on the report's total, not on the ticket surfaces", () => {
    // claude-sonnet-4-6: $3/M in, $15/M out → 0.1×3 + 0.02×15 = $0.60.
    const config: Config = { reconciliation: { invoiceTotal: 0.6, tolerancePercent: 5 } };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    expect(data.insights?.ticketUiHidden).toBe(true);
    expect(data.insights?.reconciliation).not.toBeNull();
    expect(data.insights?.reconciliation?.bottomUp).toBeCloseTo(0.6, 5);
  });
});

describe("Q2 under the gate", () => {
  const boughtOf = (data: DashboardData) =>
    buildInsightAnswers(data, { t, vocabulary: "metered", hourlyRate: null, currency: "USD", verdictSentence: null })
      .find((a) => a.question === "bought")!;

  const insightsFor = (hidden: boolean): DashboardInsights => ({
    vocabulary: { vocabulary: "metered", basis: "fee-proxy", planAccounts: 0, meteredAccounts: 0 },
    ticketCoverage: null,
    topTicket: null,
    hourlyRate: null,
    currency: "USD",
    attributionCalibration: null,
    previousCost: null,
    reconciliation: null,
    ticketUiHidden: hidden,
  });

  it("says hidden-pending-validation with the real enablement path — never 'no spend attributed yet'", () => {
    const bought = boughtOf({ ...goldenDashboard, insights: insightsFor(true) });
    expect(bought.unavailable?.reason).toBe("not-enabled");
    expect(bought.answer).toContain("turned off while attribution accuracy is being validated");
    expect(bought.unavailable?.enablement).toContain("tickets.showUi");
    // The claim the card must NOT make: coverage-empty over a store the build
    // simply is not showing.
    expect(bought.answer).not.toContain("No spend attributed");
  });

  it("falls through to answerBought's own states when shown", () => {
    const bought = boughtOf({ ...goldenDashboard, insights: insightsFor(false) });
    // Null coverage while SHOWN is the genuine not-enabled state, with the
    // Settings pointer that exists again in this build.
    expect(bought.answer).toContain("No spend attributed");
    expect(bought.unavailable?.enablement).toContain("Settings");
  });
});

describe("the template gate — one predicate, every markup surface", () => {
  const hiddenData: DashboardData = {
    ...goldenDashboard,
    insights: {
      vocabulary: { vocabulary: "metered", basis: "fee-proxy", planAccounts: 0, meteredAccounts: 0 },
      ticketCoverage: null,
      topTicket: null,
      hourlyRate: null,
      currency: "USD",
      attributionCalibration: null,
      previousCost: null,
      reconciliation: null,
      ticketUiHidden: true,
    },
  };

  it("drops the tickets panel (heading included), the filter input and the Settings block together", () => {
    const html = renderDashboard(hiddenData, t);
    expect(html).not.toContain('id="tab-tickets"');
    expect(html).not.toContain('id="section-tickets"');
    expect(html).not.toContain('id="filter-ticket"');
    expect(html).not.toContain('id="cfg-ticket-keys"');
    expect(html).not.toContain('id="reextract-block"');
  });

  it("keeps the rest of the Tickets & Value view intact — projects and classify still render", () => {
    const html = renderDashboard(hiddenData, t);
    expect(html).toContain('id="tab-projects"');
    expect(html).toContain('id="tab-classify"');
  });

  it("keeps every surface when the payload carries no insights at all — a caller that never attached keeps its pre-flag page", () => {
    const html = renderDashboard(goldenDashboard, t);
    expect(html).toContain('id="tab-tickets"');
    expect(html).toContain('id="filter-ticket"');
    expect(html).toContain('id="cfg-ticket-keys"');
  });
});

describe("the config flag itself", () => {
  it("validateTicketsConfig accepts the boolean and drops junk", () => {
    expect(validateTicketsConfig({ showUi: true }).showUi).toBe(true);
    expect(validateTicketsConfig({ showUi: false }).showUi).toBe(false);
    expect(validateTicketsConfig({ showUi: "yes" }).showUi).toBeUndefined();
    expect(validateTicketsConfig({ showUi: 1 }).showUi).toBeUndefined();
  });

  it("showTicketUi is opt-in: only an explicit true shows", () => {
    expect(showTicketUi({})).toBe(false);
    expect(showTicketUi({ tickets: {} })).toBe(false);
    expect(showTicketUi({ tickets: { showUi: false } })).toBe(false);
    expect(showTicketUi({ tickets: { showUi: true } })).toBe(true);
  });

  it("saving project keys from the settings form preserves an opted-in showUi — the save must not silently re-hide", () => {
    const current: Config = { tickets: { showUi: true, projectKeys: ["OLD"] } };
    const merged = mergeConfig(current, { tickets: { projectKeys: ["PROJ"] } });
    expect(merged.tickets?.projectKeys).toEqual(["PROJ"]);
    expect(merged.tickets?.showUi).toBe(true);
  });
});
