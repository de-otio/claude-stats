/**
 * Exercises the actual webview path end-to-end for this lane's changes:
 * render a real dashboard page (nav + card included), then run it through
 * `patchForWebview` exactly as `panel.ts` does, and assert the nav/card
 * markup survives — proof the extraction didn't just work for the served
 * host by accident. Not a redundant unit test: `patchForWebview`'s existing
 * tests use a hand-written HTML fixture, never the real renderer output.
 */
import { describe, it, expect, vi } from "vitest";

// `panel.ts` imports the `vscode` module, only present inside a real
// extension host. Mirrors the mock in extension.test.ts — `patchForWebview`
// is a pure string transform and never touches the vscode API itself, so an
// empty-enough stub is sufficient to import it under vitest.
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  ViewColumn: { Two: 2 },
}));

import { renderDashboard } from "../server/template.js";
import { patchForWebview } from "../extension/panel.js";
import type { DashboardData } from "../dashboard/index.js";

const minimalData: DashboardData = {
  generated: "2026-01-15T10:00:00.000Z",
  period: "week",
  timezone: "UTC",
  summary: {
    sessions: 0, prompts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, cacheEfficiency: 0, estimatedCost: 0, totalDurationMs: 0,
    planFee: 0, planMultiplier: 0, costPerPrompt: 0, costPerActiveHour: 0,
    dailyValueRate: 0, tokensPerMinute: 0, outputTokensPerPrompt: 0, promptsPerHour: 0,
    totalActiveHours: 0, avgSessionDurationMinutes: 0, truncatedOutputs: 0,
    currentWindowStart: null, currentWindowPrompts: 0, currentWindowCost: 0,
    subagentSessions: 0, parentSessionsWithChildren: 0,
  },
  byDay: [], byProject: [], byModel: [], byEntrypoint: [], stopReasons: [],
  sinceIso: null, byHour: [], byWindow: [], byConversationCost: [], byWeek: [],
  planUtilization: null, feeAttribution: null, modelEfficiency: null, contextAnalysis: null,
  spending: null, energy: null, costPerTask: null, calibration: null,
  experimentalSignalsEnabled: false, recommendations: [], availableAccounts: [],
  selectedAccountUuid: null,
};

describe("webview path — nav + card survive patchForWebview", () => {
  it("renders the honest-unavailable cost card and the reduced nav in the webview-patched HTML", () => {
    const served = renderDashboard(minimalData);
    const webview = patchForWebview(served, "vscode-webview://abc", "vscode-resource://chart.js", "overview");

    // The card module's output round-trips through the webview patch.
    // NB: assert the class ATTRIBUTE, not the bare token — `CARD_CSS` is
    // embedded in every page and itself contains "cs-card-unavailable", so
    // the bare token is satisfied by any render at all.
    expect(webview).toContain('id="card-cost"');
    expect(webview).toContain('class="cs-card cs-card-unavailable"');
    expect(webview).toContain("No usage recorded for this period.");

    // The nav-driven tab bar round-trips too — energy/spending/context/
    // efficiency are correctly absent for data-less DashboardData.
    expect(webview).toContain('data-tab="overview"');
    expect(webview).toContain('data-tab="classify"');
    expect(webview).not.toContain('data-tab="energy"');
    expect(webview).not.toContain('data-tab="spending"');

    // The webview CSP nonce rewrite reached the inline scripts our card CSS
    // sits beside — i.e. the page is still one coherent document, not two
    // that diverged at the seam.
    //
    // Asserting only that the CSP <meta> exists proves nothing: patchForWebview
    // injects it unconditionally, in a step entirely separate from the <script>
    // nonce rewrite. If the nonce rewrite regressed, the meta tag would still be
    // there and the webview would render a blank page (CSP blocks un-nonced
    // inline script). So: extract the nonce the CSP actually declares, and
    // require that every <script> in the document carries it.
    const csp = webview.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(csp).not.toBeNull();
    const nonce = csp![1]!.match(/'nonce-([A-Za-z0-9]+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const scriptTags = webview.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });
});
