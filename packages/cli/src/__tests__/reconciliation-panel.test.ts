/**
 * The reconciliation panel — the dashboard keeping a promise it had been making
 * for three phases without keeping.
 *
 * `dashboard:insights.alerts.reconciliationDrift` told the reader, in all ten
 * locales, to see the cost card's caveat "for the residual and its candidate
 * causes". `costCaveat` renders the RATIO and nothing else. The residual, the
 * invoice total, the tolerance band and the named causes were all computed and
 * all discarded.
 *
 * **The contract here is behaviour comparison, not a DOM snapshot.** A golden
 * `Reconciliation` goes in and exact figures come out. Every assertion is made
 * against a sliced element (`data-recon-line="residual"`, the cause list) rather
 * than the whole page: the residual figure also appears inside the answer
 * sentence and inside the JSON payload the page embeds, so a page-wide
 * `toContain("$49.40")` passes with the panel deleted — which is precisely the
 * state this lane found and is fixing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderReconciliationPanel, RECONCILIATION_ANCHOR } from "../server/reconciliationPanel.js";
import { reconciliationDetail } from "@claude-stats/core/insight";
import { computeReconciliation } from "@claude-stats/core/reconciliation";
import type { Reconciliation } from "@claude-stats/core/types/insight";
import { Store } from "../store/index.js";
import { buildDashboard, attachInsights, attachCalibration } from "../dashboard/index.js";
import { buildAlerts } from "../server/insights.js";
import { renderDashboard } from "../server/template.js";
import { NAV_TAB_IDS } from "../server/nav.js";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { t } from "../i18n.js";

/** Identity translator — shows exactly which key a string came from. */
const idT = (key: string) => key;

/**
 * The golden drift case, matching the figures the Phase 2c verification
 * observed end to end: a residual of 49.4 against a $50 invoice, with
 * `scope-mismatch` as the sole named cause.
 */
const DRIFT: Reconciliation = computeReconciliation({
  bottomUp: 0.6,
  invoiceTotal: 50,
  tolerance: 0.05,
})!;

const WITHIN: Reconciliation = computeReconciliation({
  bottomUp: 49.5,
  invoiceTotal: 50,
  tolerance: 0.05,
  scopeNote: "Metered account, March",
})!;

/** One `data-recon-line` row's own markup. */
function reconLine(html: string, id: string): string {
  const at = html.indexOf(`data-recon-line="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<div", at);
  const end = html.indexOf("</div>", at);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The `<ul>` of named causes, or null when the panel renders none. */
function causeList(html: string): string | null {
  const at = html.indexOf('<ul class="cs-recon-cause-list">');
  if (at === -1) return null;
  const end = html.indexOf("</ul>", at);
  expect(end).toBeGreaterThan(at);
  return html.slice(at, end);
}

describe("the fixture itself is the case that was verified broken", () => {
  it("has a non-zero residual and a named cause — otherwise every test below is vacuous", () => {
    expect(DRIFT.withinTolerance).toBe(false);
    expect(DRIFT.residual).toBeCloseTo(49.4, 10);
    expect(DRIFT.candidateCauses).toEqual(["scope-mismatch"]);
    expect(WITHIN.withinTolerance).toBe(true);
    expect(WITHIN.candidateCauses).toEqual([]);
  });
});

describe("renderReconciliationPanel — the residual and its causes are on the page", () => {
  it("renders the residual as a figure, in its own row", () => {
    const html = renderReconciliationPanel(DRIFT, t);
    expect(reconLine(html, "residual")).toContain("$49.40");
  });

  it("renders the invoice total and the local estimate as separate, correct figures", () => {
    const html = renderReconciliationPanel(DRIFT, t);
    // Two different numbers in two different rows. A panel that printed one
    // figure twice would satisfy any looser check.
    expect(reconLine(html, "invoiceTotal")).toContain("$50.00");
    expect(reconLine(html, "bottomUp")).toContain("$0.60");
    expect(reconLine(html, "invoiceTotal")).not.toContain("$0.60");
  });

  it("renders the tolerance band the verdict was decided against", () => {
    // Without the band, "does not reconcile" is a verdict with no stated
    // threshold — the reader cannot tell a 6% miss from a 600% one.
    expect(reconLine(renderReconciliationPanel(DRIFT, t), "tolerance")).toContain("±5");
  });

  it("names every candidate cause, one list item each", () => {
    const both = computeReconciliation({
      bottomUp: 1,
      invoiceTotal: 50,
      unknownTokens: 900,
      anyFallbackRates: true,
    })!;
    expect(both.candidateCauses).toEqual(["unpriced-usage", "fallback-rates", "scope-mismatch"]);
    const list = causeList(renderReconciliationPanel(both, t))!;
    expect(list.match(/<li>/g)).toHaveLength(3);
    // Distinct sentences, not three copies of one: a `Record` lookup that
    // resolved every cause to the same key would still produce three items.
    const items = list.match(/<li>([^<]*)<\/li>/g)!;
    expect(new Set(items).size).toBe(3);
  });

  it("resolves a DIFFERENT key per cause", () => {
    const both = computeReconciliation({
      bottomUp: 1,
      invoiceTotal: 50,
      unknownTokens: 900,
      anyFallbackRates: true,
    })!;
    const list = causeList(renderReconciliationPanel(both, idT))!;
    expect(list).toContain("common:insight.reconciliation.cause.unpricedUsage");
    expect(list).toContain("common:insight.reconciliation.cause.fallbackRates");
    expect(list).toContain("common:insight.reconciliation.cause.scopeMismatch");
  });

  it("omits the cause list AND its heading when there is nothing to explain", () => {
    const html = renderReconciliationPanel(WITHIN, t);
    expect(causeList(html)).toBeNull();
    // A heading over an empty list reads as a finding that was withheld.
    expect(html).not.toContain("cs-recon-causes-label");
  });

  it("still renders the figures when the reconciliation PASSES", () => {
    // Evidence, not a failure notice. Hiding the figures on success would make
    // "reconciles at 99%" a claim the reader has no way to check.
    const html = renderReconciliationPanel(WITHIN, t);
    expect(reconLine(html, "residual")).toContain("$0.50");
    expect(reconLine(html, "invoiceTotal")).toContain("$50.00");
  });

  it("renders nothing at all when no invoice figure is configured", () => {
    // Not an empty panel: an empty panel implies a check ran.
    expect(renderReconciliationPanel(null, t)).toBe("");
    expect(renderReconciliationPanel(undefined, t)).toBe("");
  });

  it("states the invoice scope verbatim when configured, and says so when not", () => {
    expect(renderReconciliationPanel(WITHIN, t)).toContain("Metered account, March");
    expect(renderReconciliationPanel(DRIFT, idT)).toContain(
      "common:insight.reconciliation.scopeUnstated",
    );
  });

  it("escapes a scope note rather than letting it reach the page as markup", () => {
    const hostile = computeReconciliation({
      bottomUp: 49.5,
      invoiceTotal: 50,
      scopeNote: '</div><script>alert(1)</script>',
    })!;
    const html = renderReconciliationPanel(hostile, t);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries the anchor the drift alert links to", () => {
    expect(renderReconciliationPanel(DRIFT, t)).toContain(`id="${RECONCILIATION_ANCHOR}"`);
  });

  it("uses an anchor that is not also a tab id", () => {
    // The alert's action is `href="#<anchor>"`, and the page's `hashchange`
    // handler switches tabs for any hash that matches a tab id. An anchor
    // colliding with one would navigate the reader AWAY from the panel the
    // alert just promised — the same broken promise in a new shape. The
    // constant's exact spelling is free to change; this property is not.
    expect(NAV_TAB_IDS as readonly string[]).not.toContain(RECONCILIATION_ANCHOR);
    expect(NAV_TAB_IDS.length).toBeGreaterThan(1);
  });
});

describe("the residual's DIRECTION is a sentence, never a minus sign", () => {
  it("says the invoice is higher when it is, with a positive magnitude", () => {
    const html = renderReconciliationPanel(DRIFT, idT);
    const row = reconLine(html, "residual");
    expect(row).toContain("common:insight.reconciliation.residualInvoiceHigher");
    expect(row).not.toContain("residualLocalHigher");
  });

  it("says the local estimate is higher when it is — a different sentence, not a sign flip", () => {
    const localHigher = computeReconciliation({ bottomUp: 80, invoiceTotal: 50 })!;
    expect(localHigher.residual).toBeLessThan(0);
    const row = reconLine(renderReconciliationPanel(localHigher, idT), "residual");
    expect(row).toContain("common:insight.reconciliation.residualLocalHigher");
    expect(row).not.toContain("residualInvoiceHigher");
  });

  it("never prints a negative money figure or a negative percentage", () => {
    const localHigher = computeReconciliation({ bottomUp: 80, invoiceTotal: 50 })!;
    const row = reconLine(renderReconciliationPanel(localHigher, t), "residual");
    expect(row).toContain("$30.00");
    expect(row).not.toContain("-30");
    expect(row).not.toContain("$-");
    expect(row).not.toMatch(/-\d+%/);
  });
});

describe("reconciliationDetail formats through the shared money formatter", () => {
  it("uses the caller's currency, not a hardcoded dollar sign", () => {
    const eur = reconciliationDetail(t, DRIFT, "EUR");
    expect(eur.lines.find((l) => l.id === "invoiceTotal")!.value).toBe("€50.00");
    const usd = reconciliationDetail(t, DRIFT, "USD");
    expect(usd.lines.find((l) => l.id === "invoiceTotal")!.value).toBe("$50.00");
  });

  it("keeps cents on a figure large enough that the glanceable form would round them away", () => {
    // formatMoney's default rounds to whole units at >= 100. A residual is a
    // reconciliation figure read against an invoice line, so it keeps its cents;
    // "$1,234" beside "$1,234" would read as reconciling exactly.
    const big = computeReconciliation({ bottomUp: 1234.56, invoiceTotal: 1300 })!;
    const detail = reconciliationDetail(t, big, "USD");
    expect(detail.lines.find((l) => l.id === "bottomUp")!.value).toBe("$1,234.56");
  });
});

/**
 * Every test above pins a MONEY figure or a translation key. The panel also
 * renders three quantities that are neither: the verdict's ratio, the
 * residual's percentage, and the tolerance band. Mutation-tested at review:
 * the verdict's `rec.ratio` could be replaced by `rec.residualRatio` or by
 * `invoiceTotal / bottomUp`, the residual's denominator could be swapped from
 * the invoice to the local estimate, and the band could be multiplied by 100 —
 * all four with the whole suite still green, because the only band assertion
 * was `toContain("±5")`, which "±500%" satisfies.
 *
 * The fixture is chosen so each quantity is a DIFFERENT number, and every
 * plausible wrong divisor is a different number again. 80 against 100 gives
 * ratio 80%, residual-over-invoice 20%, residual-over-local 25%, and
 * invoice-over-local 125% — four values no single assertion could confuse.
 */
describe("the panel's three percentages, and the divisor each is taken over", () => {
  /** ratio 0.8 · residual 20 · residualRatio 0.2 · tolerance band 5%. */
  const EIGHTY: Reconciliation = computeReconciliation({
    bottomUp: 80,
    invoiceTotal: 100,
    tolerance: 0.05,
  })!;

  it("states the verdict's ratio as the local estimate over the invoice", () => {
    const { verdict } = reconciliationDetail(t, EIGHTY, "USD");
    expect(verdict).toContain("80%");
    // The two figures that are also to hand and would each be wrong: the
    // residual's share (20%) and the inverted divisor (125%).
    expect(verdict).not.toContain("20%");
    expect(verdict).not.toContain("125%");
  });

  it("takes the residual's percentage over the INVOICE, not over the local estimate", () => {
    // 20/100, not 20/80. The sentence around it names both quantities, so the
    // reader has no way to tell which denominator produced the number — which
    // is exactly why it has to be the one the verdict already uses.
    const residual = reconciliationDetail(t, EIGHTY, "USD").lines.find((l) => l.id === "residual")!;
    expect(residual.value).toContain("$20.00");
    expect(residual.value).toContain("(20%)");
    expect(residual.value).not.toContain("25%");
  });

  it("states the tolerance band at its own magnitude, exactly", () => {
    // Not `toContain("±5")`: that passes for "±500%" and for "±5000%". The
    // band is the threshold the verdict was decided against, so a hundredfold
    // error here turns "does not reconcile" into an unreadable claim.
    const tolerance = reconciliationDetail(t, EIGHTY, "USD").lines.find(
      (l) => l.id === "tolerance",
    )!;
    expect(tolerance.value).toBe("±5%");
  });
});

// ─── End to end: the alert and the evidence on the same page ──────────────────

const T0 = 1_700_000_000_000;

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "recon-panel-sess",
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
    ...overrides,
  };
}

describe("end to end — the alert's promise and the page agree", () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    // A mkdtemp SUBDIRECTORY, never os.tmpdir() itself — cleaning up the shared
    // temp root has broken this build before.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-recon-panel-"));
    store = new Store(path.join(dir, "stats.db"));
    store.upsertSession(makeSession());
    store.upsertMessages([
      {
        uuid: "recon-panel-msg",
        sessionId: "recon-panel-sess",
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
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** ~$0.60 of real spend against a $50 invoice — residual 49.4. */
  const driftConfig: Config = { reconciliation: { invoiceTotal: 50, tolerancePercent: 5 } };

  it("fires the drift alert AND renders the residual it names, in one render", () => {
    const data = attachInsights(store, buildDashboard(store, {}), {}, driftConfig);
    const recon = data.insights!.reconciliation!;
    expect(recon.withinTolerance).toBe(false);
    expect(recon.residual).toBeCloseTo(49.4, 2);

    const alerts = buildAlerts(data, t);
    expect(alerts.some((a) => a.id === "reconciliation-drift")).toBe(true);

    const html = renderDashboard(data, t);
    // The panel exists, and the residual is inside the residual ROW of it —
    // the exact thing the page did not have when the alert was written.
    const panelAt = html.indexOf(`id="${RECONCILIATION_ANCHOR}"`);
    expect(panelAt).toBeGreaterThan(-1);
    expect(reconLine(html, "residual")).toContain("$49.40");
    expect(causeList(html)).toContain("Scope mismatch");
  });

  it("the drift alert's action link resolves to the panel, not to a tab that lacks it", () => {
    const data = attachInsights(store, buildDashboard(store, {}), {}, driftConfig);
    const alert = buildAlerts(data, t).find((a) => a.id === "reconciliation-drift")!;
    expect(alert.anchor).toBe(RECONCILIATION_ANCHOR);

    const html = renderDashboard(data, t);
    const alertAt = html.indexOf('data-alert-id="reconciliation-drift"');
    expect(alertAt).toBeGreaterThan(-1);
    const block = html.slice(alertAt, html.indexOf("</div>", alertAt) + 6);
    expect(block).toContain(`href="#${RECONCILIATION_ANCHOR}"`);
    // …and the destination is an element that is actually on the page.
    expect(html).toContain(`id="${RECONCILIATION_ANCHOR}"`);
  });

  it("renders no panel on a page with no invoice configured", () => {
    const data = attachInsights(store, buildDashboard(store, {}), {}, {});
    expect(data.insights!.reconciliation).toBeNull();
    expect(renderDashboard(data, t)).not.toContain(`id="${RECONCILIATION_ANCHOR}"`);
  });

  // ── The other half of the scope disclosure ──────────────────────────────────
  //
  // `attachCalibration` decides the window the outcome figure is counted over,
  // and it is NOT the dashboard's period: `all` is capped at a month for
  // performance. The scope it stamps must be the window it queried, or the
  // caveat quotes a span that was never measured.

  it("stamps the window it actually queried, which is not always the period on screen", async () => {
    for (const [period, expected] of [
      ["day", "day"],
      ["week", "week"],
      ["month", "month"],
      // The trap: the heading says "all time", the query says one month.
      ["all", "month"],
    ] as const) {
      const data = await attachCalibration(store, buildDashboard(store, { period }), { period });
      expect(data.calibrationScope, `period=${period}`).toBe(expected);
    }
  });

  it("stamps custom-range for an explicit since/until, not the preset it capped to", async () => {
    const opts = { since: "2023-11-01", until: "2023-11-30" };
    const data = await attachCalibration(store, buildDashboard(store, opts), opts);
    expect(data.calibrationScope).toBe("custom-range");
  });

  it("leaves the scope null when no report was built — never a window with no report", async () => {
    // A scope describing a report that does not exist is a scope claim with no
    // basis. `attachCalibration` never throws, so the failure path is forced
    // here by handing it a closed store.
    const closedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-recon-closed-"));
    const closed = new Store(path.join(closedDir, "s.db"));
    const data = buildDashboard(closed, {});
    closed.close();
    const out = await attachCalibration(closed, data, {});
    expect(out.calibration).toBeNull();
    expect(out.calibrationScope).toBeNull();
    fs.rmSync(closedDir, { recursive: true, force: true });
  });
});
