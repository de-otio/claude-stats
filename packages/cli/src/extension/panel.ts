/**
 * Webview panel that displays the Claude Stats dashboard inside VS Code.
 * Reuses buildDashboard() and renderDashboard() from the core library,
 * with HTML patched for webview CSP and message-based navigation.
 *
 * The panel does not own a Store or refresh timer — the AutoCollector
 * calls refreshIfVisible() after each collection run.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { Store } from "../store/index.js";
import { getNonce, escapeHtml } from "./utils.js";
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import { loadConfig, saveConfig, getPlanConfig, type Config } from "../config.js";
import type { ReportOptions } from "../reporter/index.js";
import type { SidebarProvider } from "./sidebar.js";
import { t } from "./i18n.js";
import { paths } from "@claude-stats/core/paths";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private period: ReportOptions["period"] = "all";
  private activeTab: string = "overview";
  private readonly chartJsUri: vscode.Uri;
  private readonly sidebar: SidebarProvider | undefined;

  /**
   * Refresh the currently visible dashboard panel (if any).
   * Called by the AutoCollector after each successful collection.
   */
  static refreshIfVisible(): void {
    DashboardPanel.instance?.refresh();
  }

  static createOrShow(context: vscode.ExtensionContext, sidebar?: SidebarProvider): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      return;
    }

    const mediaUri = vscode.Uri.joinPath(context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel(
      "claudeStatsDashboard",
      t("extension:panel.title"),
      vscode.ViewColumn.Two,
      { enableScripts: true, localResourceRoots: [mediaUri] },
    );

    DashboardPanel.instance = new DashboardPanel(panel, context, sidebar);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, sidebar?: SidebarProvider) {
    this.panel = panel;
    this.sidebar = sidebar;
    this.chartJsUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "chart.min.js"),
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { command: string; period?: string; tab?: string }) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.refresh();
  }

  private refresh(): void {
    // Open and close the store on each refresh so we always read
    // the latest committed data (safe with WAL + busy_timeout)
    const store = new Store();
    try {
      // Empty-data short-circuit: if no sessions have ever been collected,
      // show a welcome screen with clear instructions instead of an empty
      // dashboard full of zeroed-out charts.
      const anySession = store.getSessions({ includeCI: false });
      if (anySession.length === 0) {
        this.panel.webview.html = renderWelcome(this.panel.webview.cspSource);
        return;
      }

      const cfg = loadConfig();
      const planCfg = getPlanConfig(cfg);
      const data = buildDashboard(store, { period: this.period, planFee: planCfg?.monthlyFee, planType: planCfg?.type });
      const html = renderDashboard(data, t);
      this.panel.webview.html = patchForWebview(
        html,
        this.panel.webview.cspSource,
        this.chartJsUri.toString(),
        this.activeTab,
      );
    } finally {
      store.close();
    }
  }

  private handleMessage(msg: { command: string; period?: string; tab?: string; config?: Config; callbackId?: number }): void {
    if (msg.command === "changePeriod" && msg.period) {
      this.period = msg.period as ReportOptions["period"];
      this.refresh();
    } else if (msg.command === "refresh") {
      this.refresh();
    } else if (msg.command === "tabChanged" && msg.tab) {
      this.activeTab = msg.tab;
      this.sidebar?.setActiveTab(msg.tab);
    } else if (msg.command === "getConfig" && msg.callbackId) {
      try {
        const cfg = loadConfig();
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, data: cfg });
      } catch {
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, error: t("extension:panel.errors.failedToLoadConfig") });
      }
    } else if (msg.command === "saveConfig" && msg.callbackId) {
      try {
        const incoming = msg.config ?? {};
        const current = loadConfig();
        const merged: Config = {
          ...current,
          ...incoming,
          plan: incoming.plan !== undefined
            ? { ...current.plan, ...incoming.plan }
            : current.plan,
          costThresholds: incoming.costThresholds !== undefined
            ? { ...current.costThresholds, ...incoming.costThresholds }
            : current.costThresholds,
        };
        saveConfig(merged);
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, data: { ok: true, config: merged } });
        this.refresh();
      } catch {
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, error: t("extension:panel.errors.failedToSaveConfig") });
      }
    }
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }
}


/**
 * Patch the HTML produced by renderDashboard() for use inside a VS Code webview:
 *
 * 1. Replace CDN Chart.js with a local webview resource URI.
 * 2. Inject a nonce-based Content-Security-Policy (per VS Code webview best practices).
 * 3. Add nonce attributes to all <script> tags so they execute under the CSP.
 * 4. Remove inline event handlers (blocked by nonce CSP) and replace them
 *    with a nonce'd bridge script that uses addEventListener + postMessage.
 */
export function patchForWebview(html: string, cspSource: string, chartJsUri: string, activeTab?: string): string {
  const nonce = getNonce();

  // 1. Replace CDN script tag with local webview resource
  html = html.replace(
    /<script src="https:\/\/cdn\.jsdelivr\.net\/[^"]*chart[^"]*"><\/script>/,
    `<script nonce="${nonce}" src="${chartJsUri}"></script>`,
  );

  // 2. Add nonce to all remaining <script> tags (both inline and src-based)
  // INVARIANT: renderDashboard() only emits <script> tags the template owns itself;
  // all user-controlled data is HTML-escaped (and JSON payloads have `<` escaped to
  // <) before interpolation. If that invariant ever changes, this blanket
  // nonce rewrite becomes an XSS gift-wrap — an injected <script> would be handed
  // a valid CSP nonce. Audit template.ts before relaxing its escaping.
  html = html.replace(/<script>/g, `<script nonce="${nonce}">`);

  // 3. Remove inline event handlers (nonce-based CSP blocks them)
  html = html.replace(/ onchange="[^"]*"/g, "");
  html = html.replace(/ onclick="[^"]*"/g, "");

  // 4. Inject CSP meta tag using nonce (not 'unsafe-inline')
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
  ].join("; ");
  html = html.replace(
    "<head>",
    `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );

  // 5. Set active tab so the main script restores the correct tab on refresh.
  //    Also initialize __vscodeApi early so it is available when the main script
  //    runs initSettings() (the bridge script runs later, after </body>).
  const earlyInit = activeTab
    ? `window.__ACTIVE_TAB__='${activeTab}';window.__vscodeApi=acquireVsCodeApi();`
    : `window.__vscodeApi=acquireVsCodeApi();`;
  html = html.replace(
    `<script nonce="${nonce}">window.__DASHBOARD__`,
    `<script nonce="${nonce}">${earlyInit}window.__DASHBOARD__`,
  );

  // 6. Inject bridge script that wires up VS Code messaging and event handlers
  const bridgeScript = `<script nonce="${nonce}">
(function() {
  // __vscodeApi is already set early (before the main script) so that
  // initSettings() can use postMessage for config I/O on first render.
  var vscode = window.__vscodeApi;

  // Wire up period selector
  var sel = document.getElementById('period-select');
  if (sel) {
    sel.addEventListener('change', function() {
      vscode.postMessage({ command: 'changePeriod', period: sel.value });
    });
  }

  // Wire up refresh button
  var btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.addEventListener('click', function() {
      vscode.postMessage({ command: 'refresh' });
    });
  }

  // Hide auto-refresh button (not applicable in webview)
  var autoBtn = document.getElementById('autorefresh-btn');
  if (autoBtn) autoBtn.style.display = 'none';

  // Override global functions in case they're called from chart init script
  window.changePeriod = function(val) {
    vscode.postMessage({ command: 'changePeriod', period: val });
  };
  window.doRefresh = function() {
    vscode.postMessage({ command: 'refresh' });
  };
  window.toggleRefresh = function() {
    vscode.postMessage({ command: 'refresh' });
  };

  // Notify extension when dashboard tab changes (for sidebar context)
  var tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = this.getAttribute('data-tab');
      if (tab) vscode.postMessage({ command: 'tabChanged', tab: tab });
    });
  });
  // Also send initial tab on load
  var activeTab = document.querySelector('.tab-btn.active');
  if (activeTab) {
    var tab = activeTab.getAttribute('data-tab');
    if (tab) vscode.postMessage({ command: 'tabChanged', tab: tab });
  }
})();
</script>`;
  html = html.replace("</body>", `${bridgeScript}\n</body>`);

  return html;
}

/**
 * Render a welcome / empty-state page shown in place of the dashboard when no
 * sessions have been collected yet.
 *
 * We distinguish two cases so the instructions are actionable:
 *   1. ~/.claude/projects/ is missing → Claude Code itself is likely not installed
 *      (or has never been run). We walk the user through installing it.
 *   2. The directory exists but is empty, or the collector has not yet produced
 *      any sessions → Claude Code is present, but the user hasn't had a real
 *      conversation yet (or the initial collection is still running).
 *
 * The page is fully self-contained: nonce-based CSP, VS Code theme colors, and
 * a single "Refresh now" button wired through postMessage to trigger a new
 * collection via the existing `refresh` command in handleMessage().
 */
export function renderWelcome(cspSource: string): string {
  const nonce = getNonce();
  const projectsDirExists = fs.existsSync(paths.projectsDir);
  const state = projectsDirExists ? "noSessions" : "noClaudeCode";

  const title = escapeHtml(t(`extension:welcome.${state}.title`));
  const intro = escapeHtml(t(`extension:welcome.${state}.intro`));
  const stepsHeading = escapeHtml(t("extension:welcome.stepsHeading"));
  const whatNextHeading = escapeHtml(t("extension:welcome.whatNextHeading"));
  const whatNext = escapeHtml(t(`extension:welcome.${state}.whatNext`));
  const refreshLabel = escapeHtml(t("extension:welcome.refresh"));
  const refreshHint = escapeHtml(t("extension:welcome.refreshHint"));
  const projectsDirLabel = escapeHtml(t("extension:welcome.projectsDirLabel"));
  const projectsDirPath = escapeHtml(paths.projectsDir);
  const dbPathLabel = escapeHtml(t("extension:welcome.dbPathLabel"));
  const dbPath = escapeHtml(paths.statsDb);
  const privacyNote = escapeHtml(t("extension:welcome.privacyNote"));

  const rawSteps = t(`extension:welcome.${state}.steps`, { returnObjects: true }) as unknown;
  const steps: Array<{ heading: string; body: string }> = Array.isArray(rawSteps)
    ? (rawSteps as Array<{ heading: string; body: string }>)
    : [];

  const stepsHtml = steps
    .map(
      (s, i) => `<li class="step">
        <div class="step-num">${i + 1}</div>
        <div class="step-body">
          <div class="step-heading">${escapeHtml(s.heading)}</div>
          <div class="step-text">${escapeHtml(s.body)}</div>
        </div>
      </li>`,
    )
    .join("\n");

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${title}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      line-height: 1.55;
    }
    .container {
      max-width: 640px;
      margin: 0 auto;
      padding: 32px 28px 40px 28px;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      margin: 0 0 10px 0;
    }
    p.intro {
      font-size: 0.95rem;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 22px 0;
    }
    h2 {
      font-size: 0.78rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin: 24px 0 10px 0;
    }
    ol.steps {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li.step {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 10px 0;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #2a2a2a));
    }
    li.step:first-child {
      border-top: none;
    }
    .step-num {
      flex: 0 0 22px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 0.75rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 1px;
    }
    .step-body {
      flex: 1;
      min-width: 0;
    }
    .step-heading {
      font-weight: 600;
      font-size: 0.9rem;
      margin-bottom: 2px;
    }
    .step-text {
      font-size: 0.85rem;
      color: var(--vscode-descriptionForeground);
      white-space: pre-line;
    }
    .step-text code, .path-row code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.82rem;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
      padding: 1px 5px;
      border-radius: 3px;
    }
    .what-next {
      font-size: 0.88rem;
      color: var(--vscode-foreground);
      background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-button-background));
      padding: 10px 14px;
      margin: 8px 0 22px 0;
      white-space: pre-line;
    }
    .refresh-row {
      display: flex;
      gap: 12px;
      align-items: center;
      margin: 26px 0 4px 0;
    }
    button.refresh {
      padding: 7px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      font-family: inherit;
      font-size: 0.88rem;
      cursor: pointer;
    }
    button.refresh:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .refresh-hint {
      font-size: 0.78rem;
      color: var(--vscode-descriptionForeground);
    }
    .path-row {
      font-size: 0.8rem;
      color: var(--vscode-descriptionForeground);
      margin: 3px 0;
    }
    .path-label {
      display: inline-block;
      min-width: 130px;
      opacity: 0.85;
    }
    .privacy {
      margin-top: 24px;
      padding-top: 14px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #2a2a2a));
      font-size: 0.78rem;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p class="intro">${intro}</p>

    <h2>${stepsHeading}</h2>
    <ol class="steps">
      ${stepsHtml}
    </ol>

    <h2>${whatNextHeading}</h2>
    <div class="what-next">${whatNext}</div>

    <div class="refresh-row">
      <button class="refresh" id="refresh-btn" type="button">${refreshLabel}</button>
      <span class="refresh-hint">${refreshHint}</span>
    </div>

    <div style="margin-top:22px;">
      <div class="path-row"><span class="path-label">${projectsDirLabel}</span><code>${projectsDirPath}</code></div>
      <div class="path-row"><span class="path-label">${dbPathLabel}</span><code>${dbPath}</code></div>
    </div>

    <div class="privacy">${privacyNote}</div>
  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      var btn = document.getElementById('refresh-btn');
      if (btn) {
        btn.addEventListener('click', function() {
          vscode.postMessage({ command: 'refresh' });
        });
      }
    })();
  </script>
</body>
</html>`;
}
