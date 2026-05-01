import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock vscode module before any imports that depend on it
vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: () => ({
      show: vi.fn(),
      dispose: vi.fn(),
      text: "",
      command: "",
      tooltip: "",
    }),
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultVal: unknown) => defaultVal,
    }),
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Two: 2 },
}));

import { formatTokens } from "../extension/statusBar.js";
import { patchForWebview, renderWelcome } from "../extension/panel.js";
import { AutoCollector } from "../extension/collector.js";
import { promptReloadIfUpgraded } from "../extension/extension.js";
import * as vscode from "vscode";

// ── formatTokens ──────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_500)).toBe("2k");
    expect(formatTokens(142_000)).toBe("142k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(4_200_000)).toBe("4.2M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });
});

// ── patchForWebview ───────────────────────────────────────────────────────────

describe("patchForWebview", () => {
  const CDN_SCRIPT = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>';
  const LOCAL_CHART_URI = "vscode-resource://extension/media/chart.min.js";
  const CSP_SOURCE = "https://file+.vscode-resource.vscode-cdn.net";

  const sampleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test</title>
  ${CDN_SCRIPT}
</head>
<body>
  <select id="period-select" onchange="changePeriod(this.value)"></select>
  <button id="refresh-btn" onclick="toggleRefresh()">Auto-refresh: off</button>
  <script>window.__DASHBOARD__ = {};</script>
</body>
</html>`;

  it("injects nonce-based Content-Security-Policy meta tag", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).toContain('http-equiv="Content-Security-Policy"');
    expect(result).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
    // Style-src still uses unsafe-inline (safe for styles)
    expect(result).toContain("'unsafe-inline'");
    // Should NOT use unsafe-inline for scripts
    expect(result).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("adds nonce attribute to all script tags", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    // Every <script> tag should have a nonce
    const scriptTags = result.match(/<script[\s>]/g) || [];
    const noncedTags = result.match(/<script nonce="/g) || [];
    expect(scriptTags.length).toBe(noncedTags.length);
    expect(scriptTags.length).toBeGreaterThan(0);
  });

  it("uses the same nonce across CSP and all script tags", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    const cspNonce = result.match(/script-src 'nonce-([A-Za-z0-9]+)'/);
    expect(cspNonce).not.toBeNull();
    const nonce = cspNonce![1];
    // All script nonces should match the CSP nonce
    const tagNonces = [...result.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map(m => m[1]);
    expect(tagNonces.length).toBeGreaterThan(0);
    for (const n of tagNonces) {
      expect(n).toBe(nonce);
    }
  });

  it("removes inline event handlers", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).not.toContain('onchange=');
    expect(result).not.toContain('onclick=');
  });

  it("injects the VS Code messaging bridge script", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).toContain("acquireVsCodeApi");
    expect(result).toContain("changePeriod");
    expect(result).toContain("postMessage");
  });

  it("exposes __vscodeApi early (before main script) for settings config bridge", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    // __vscodeApi must be set in the same script block as __DASHBOARD__ so it
    // is available when initSettings() runs during initial tab setup
    expect(result).toContain("window.__vscodeApi=acquireVsCodeApi()");
    const apiIdx = result.indexOf("window.__vscodeApi=acquireVsCodeApi()");
    const dashboardIdx = result.indexOf("window.__DASHBOARD__");
    expect(apiIdx).toBeLessThan(dashboardIdx);
  });

  it("wires up event listeners in bridge script", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).toContain("addEventListener");
    expect(result).toContain("vscode.postMessage({ command: 'refresh' })");
  });

  it("preserves the original HTML structure", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("window.__DASHBOARD__");
    expect(result).toContain("</html>");
  });

  it("places CSP before other head content", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    const cspIdx = result.indexOf("Content-Security-Policy");
    const charsetIdx = result.indexOf('charset="UTF-8"');
    expect(cspIdx).toBeLessThan(charsetIdx);
  });

  it("places bridge script before closing body tag", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    const bridgeIdx = result.indexOf("acquireVsCodeApi");
    const bodyCloseIdx = result.indexOf("</body>");
    expect(bridgeIdx).toBeLessThan(bodyCloseIdx);
    expect(bridgeIdx).toBeGreaterThan(0);
  });

  it("replaces CDN chart.js script tag with local URI", () => {
    const result = patchForWebview(sampleHtml, CSP_SOURCE, LOCAL_CHART_URI);
    expect(result).not.toContain("cdn.jsdelivr.net");
    expect(result).toContain(`src="${LOCAL_CHART_URI}"`);
  });
});

// ── renderWelcome ─────────────────────────────────────────────────────────────

describe("renderWelcome", () => {
  const CSP_SOURCE = "https://file+.vscode-resource.vscode-cdn.net";

  it("produces a self-contained HTML page with nonce-based CSP", () => {
    const html = renderWelcome(CSP_SOURCE);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
    // No unsafe-inline for scripts.
    expect(html).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("uses a single nonce consistently across CSP and script tags", () => {
    const html = renderWelcome(CSP_SOURCE);
    const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9]+)'/);
    expect(cspNonce).not.toBeNull();
    const nonce = cspNonce![1];
    const tagNonces = [...html.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map(m => m[1]);
    expect(tagNonces.length).toBeGreaterThan(0);
    for (const n of tagNonces) expect(n).toBe(nonce);
  });

  it("includes a refresh button wired to postMessage", () => {
    const html = renderWelcome(CSP_SOURCE);
    expect(html).toContain('id="refresh-btn"');
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain("postMessage");
    expect(html).toContain("command: 'refresh'");
  });

  it("explains what to do next with numbered steps", () => {
    const html = renderWelcome(CSP_SOURCE);
    // Steps are numbered ordered-list items rendered by the welcome template.
    expect(html).toContain('class="step"');
    // Should mention how to start using Claude Code.
    expect(html.toLowerCase()).toContain("claude code");
  });

  it("surfaces the local paths so the user can self-serve", () => {
    const html = renderWelcome(CSP_SOURCE);
    expect(html).toContain(".claude");
    expect(html).toContain(".claude-stats");
  });

  it("includes a privacy note so the user understands nothing is uploaded", () => {
    const html = renderWelcome(CSP_SOURCE);
    expect(html.toLowerCase()).toMatch(/local|leaves your machine|never leaves/);
  });
});

// ── AutoCollector ─────────────────────────────────────────────────────────────

describe("AutoCollector", () => {
  let collector: AutoCollector;

  beforeEach(() => {
    collector = new AutoCollector();
  });

  afterEach(() => {
    collector.dispose();
  });

  it("can be constructed and disposed without errors", () => {
    expect(collector).toBeDefined();
    collector.dispose();
  });

  it("fires onDidCollect callbacks after collectNow()", async () => {
    const cb = vi.fn();
    collector.onDidCollect(cb);
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops firing after callback disposable is disposed", async () => {
    const cb = vi.fn();
    const sub = collector.onDidCollect(cb);
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1);

    sub.dispose();
    await collector.collectNow();
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });

  it("handles errors in callbacks without breaking collector", async () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    collector.onDidCollect(bad);
    collector.onDidCollect(good);

    await collector.collectNow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1); // still called despite prior error
  });
});

// ── promptReloadIfUpgraded ───────────────────────────────────────────────────

describe("promptReloadIfUpgraded", () => {
  function makeContext(
    previousVersion: string | undefined,
    currentVersion: string,
  ): { ctx: vscode.ExtensionContext; updateSpy: ReturnType<typeof vi.fn> } {
    const updateSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      extension: { packageJSON: { version: currentVersion } },
      globalState: {
        get: vi.fn().mockReturnValue(previousVersion),
        update: updateSpy,
      },
    } as unknown as vscode.ExtensionContext;
    return { ctx, updateSpy };
  }

  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.commands.executeCommand).mockReset();
  });

  it("does NOT prompt on fresh install (no stored previous version)", () => {
    const { ctx, updateSpy } = makeContext(undefined, "0.2.1");
    promptReloadIfUpgraded(ctx);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    // But still records the current version so the NEXT activation can detect drift.
    expect(updateSpy).toHaveBeenCalledWith(
      "claude-stats.lastActivatedVersion",
      "0.2.1",
    );
  });

  it("does NOT prompt when versions match", () => {
    const { ctx } = makeContext("0.2.1", "0.2.1");
    promptReloadIfUpgraded(ctx);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("prompts with Reload + Later when version changed", () => {
    const { ctx } = makeContext("0.2.0", "0.2.1");
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      undefined as unknown as vscode.MessageItem,
    );

    promptReloadIfUpgraded(ctx);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const args = vi.mocked(vscode.window.showInformationMessage).mock.calls[0]! as unknown as [
      string,
      string,
      string,
    ];
    const [message, reloadLabel, laterLabel] = args;
    // Message contains both the old and new version so the user knows what
    // changed without digging through the marketplace.
    expect(message).toContain("0.2.0");
    expect(message).toContain("0.2.1");
    // The two action labels must be non-empty (localized) so clicking one is
    // distinguishable from dismissing.
    expect(typeof reloadLabel).toBe("string");
    expect(reloadLabel.length).toBeGreaterThan(0);
    expect(typeof laterLabel).toBe("string");
    expect(laterLabel.length).toBeGreaterThan(0);
    expect(reloadLabel).not.toBe(laterLabel);
  });

  it("executes workbench.action.reloadWindow when user clicks Reload", async () => {
    const { ctx } = makeContext("0.1.4", "0.2.0");
    // Capture the "reload" label we pass so we can echo it back as the choice.
    let capturedReloadLabel = "";
    vi.mocked(vscode.window.showInformationMessage).mockImplementation(
      (async (_msg: string, ...items: string[]) => {
        capturedReloadLabel = items[0]!;
        return capturedReloadLabel; // simulate user clicking Reload
      }) as unknown as typeof vscode.window.showInformationMessage,
    );

    promptReloadIfUpgraded(ctx);
    // Let the promise resolve.
    await new Promise((r) => setImmediate(r));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.reloadWindow",
    );
  });

  it("does NOT execute reload when user dismisses or clicks Later", async () => {
    const { ctx } = makeContext("0.1.4", "0.2.0");
    vi.mocked(vscode.window.showInformationMessage).mockImplementation(
      (async (_msg: string, _reload: string, later: string) => {
        return later; // clicking "Later"
      }) as unknown as typeof vscode.window.showInformationMessage,
    );

    promptReloadIfUpgraded(ctx);
    await new Promise((r) => setImmediate(r));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("updates stored version on every run (upgrade or not)", () => {
    const { ctx, updateSpy } = makeContext("0.2.0", "0.2.1");
    promptReloadIfUpgraded(ctx);
    expect(updateSpy).toHaveBeenCalledWith(
      "claude-stats.lastActivatedVersion",
      "0.2.1",
    );
  });

  it("does not throw if extension.packageJSON is missing", () => {
    const ctx = {
      extension: undefined,
      globalState: { get: vi.fn(), update: vi.fn() },
    } as unknown as vscode.ExtensionContext;
    expect(() => promptReloadIfUpgraded(ctx)).not.toThrow();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
