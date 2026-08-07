/**
 * Lane R — invoice reconciliation, wired into the dashboard's Insights tab.
 *
 * `computeReconciliation` itself is covered in `reconciliation.test.ts`; this
 * file covers the INTEGRATION: `attachInsights` computing it over the same
 * window/filters as the rest of the tab, `answerCost`'s caveat actually
 * stating the verdict, and the alerts strip firing on drift.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { Store } from "../store/index.js";
import { buildDashboard, attachInsights } from "../dashboard/index.js";
import { buildInsightAnswers, buildAlerts } from "../server/insights.js";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { t } from "../i18n.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-recon-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const T0 = 1_700_000_000_000;

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "recon-sess-1",
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
    inputTokens: 0,
    outputTokens: 0,
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
    ...overrides,
  };
}

function seedSession(store: Store, costTokens: { input: number; output: number }, sessionId = "recon-sess-1"): void {
  const session = makeSession({
    sessionId,
    inputTokens: costTokens.input,
    outputTokens: costTokens.output,
  });
  store.upsertSession(session);
  store.upsertMessages([
    {
      uuid: `msg-for-${sessionId}`,
      sessionId,
      timestamp: T0,
      claudeVersion: "2.1.70",
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      inputTokens: costTokens.input,
      outputTokens: costTokens.output,
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

describe("attachInsights — reconciliation wiring", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("is null when no invoice figure is configured", () => {
    seedSession(store, { input: 100_000, output: 20_000 });
    const config: Config = {};
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    expect(data.insights?.reconciliation).toBeNull();
  });

  it("computes a reconciliation over the SAME bottom-up total the ticket coverage denominator uses", () => {
    seedSession(store, { input: 100_000, output: 20_000 });
    // claude-sonnet-4-6: $3/M in, $15/M out -> 0.1*3 + 0.02*15 = 0.3 + 0.3 = $0.60
    const config: Config = { reconciliation: { invoiceTotal: 0.6, tolerancePercent: 5 } };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    const recon = data.insights?.reconciliation;
    expect(recon).not.toBeNull();
    // R-1: `recon.bottomUp` and `ticketCoverage.totalCost` are BOTH read off
    // the SAME `report.totalCost` inside `attachInsights` — `computeReconciliation`
    // passes `bottomUp` straight through, and `aggregateTicketCosts` sets
    // `coverage.totalCost = totalCost` verbatim (`packages/core/src/
    // attribution.ts`). The two are equal BY CONSTRUCTION regardless of
    // whether the wiring is correct, so asserting they agree with EACH OTHER
    // proves nothing; a bug that fed both the wrong window would still pass.
    // Pin `bottomUp` against the ground-truth figure the fixture's own
    // tokens dictate instead — an independent, computed-elsewhere expectation
    // a wiring bug can actually diverge from.
    expect(recon!.bottomUp).toBeCloseTo(0.6, 6);
    expect(recon!.bottomUp).toBeCloseTo(data.insights!.ticketCoverage!.totalCost);
    expect(recon!.withinTolerance).toBe(true);
  });

  it("concludes 'does not reconcile' when the invoice figure is far off — it can find the estimate wrong", () => {
    seedSession(store, { input: 100_000, output: 20_000 }); // ~$0.60
    const config: Config = { reconciliation: { invoiceTotal: 50, tolerancePercent: 5 } };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    const recon = data.insights?.reconciliation;
    expect(recon).not.toBeNull();
    expect(recon!.withinTolerance).toBe(false);
    expect(recon!.candidateCauses.length).toBeGreaterThan(0);
  });

  it("is null on a plan-mode account — cost there is equivalent-value, not money", () => {
    seedSession(store, { input: 100_000, output: 20_000 });
    const config: Config = {
      reconciliation: { invoiceTotal: 0.6, tolerancePercent: 5 },
      pricing: { mode: "plan" },
    };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    expect(data.insights?.reconciliation).toBeNull();
  });

  it("respects a configured scopeNote — no scope-mismatch cause when one is stated", () => {
    seedSession(store, { input: 100_000, output: 20_000 });
    const config: Config = {
      reconciliation: { invoiceTotal: 50, tolerancePercent: 5, scopeNote: "AWS account 111122223333" },
    };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    expect(data.insights?.reconciliation?.scopeNote).toBe("AWS account 111122223333");
    expect(data.insights?.reconciliation?.candidateCauses).not.toContain("scope-mismatch");
  });

  it("flows into answerCost's caveat via buildInsightAnswers", () => {
    seedSession(store, { input: 100_000, output: 20_000 });
    const config: Config = { reconciliation: { invoiceTotal: 50, tolerancePercent: 5 } };
    const data = attachInsights(store, buildDashboard(store, {}), {}, config);
    const answers = buildInsightAnswers(data, {
      t,
      vocabulary: "metered",
      hourlyRate: null,
      currency: "USD",
      verdictSentence: null,
    });
    const cost = answers[0]!;
    expect(cost.question).toBe("cost");
    expect(cost.caveat).toContain("Does not reconcile with the invoice");
  });

  it("fires the reconciliation-drift alert only when configured AND out of tolerance", () => {
    seedSession(store, { input: 100_000, output: 20_000 });

    const noConfig: Config = {};
    const dataNoConfig = attachInsights(store, buildDashboard(store, {}), {}, noConfig);
    expect(buildAlerts(dataNoConfig, t).some((a) => a.id === "reconciliation-drift")).toBe(false);

    const withinTolerance: Config = { reconciliation: { invoiceTotal: 0.6, tolerancePercent: 5 } };
    const dataOk = attachInsights(store, buildDashboard(store, {}), {}, withinTolerance);
    expect(buildAlerts(dataOk, t).some((a) => a.id === "reconciliation-drift")).toBe(false);

    const outOfTolerance: Config = { reconciliation: { invoiceTotal: 50, tolerancePercent: 5 } };
    const dataDrift = attachInsights(store, buildDashboard(store, {}), {}, outOfTolerance);
    expect(buildAlerts(dataDrift, t).some((a) => a.id === "reconciliation-drift")).toBe(true);
  });
});
