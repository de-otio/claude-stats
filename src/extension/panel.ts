/**
 * Webview panel that displays the Claude Stats dashboard inside VS Code.
 * Reuses buildDashboard() and renderDashboard() from the core library,
 * with HTML patched for webview CSP and message-based navigation.
 *
 * The panel does not own a Store or refresh timer — the AutoCollector
 * calls refreshIfVisible() after each collection run.
 */
import * as vscode from "vscode";
import { Store } from "../store/index.js";
import { getNonce } from "./utils.js";
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import { loadConfig, saveConfig, getPlanConfig, type Config } from "../config.js";
import type { ReportOptions } from "../reporter/index.js";
import type { SidebarProvider } from "./sidebar.js";

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
      "Claude Stats",
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
      const cfg = loadConfig();
      const planCfg = getPlanConfig(cfg);
      const data = buildDashboard(store, { period: this.period, planFee: planCfg?.monthlyFee, planType: planCfg?.type });
      const html = renderDashboard(data);
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
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, error: "Failed to load config" });
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
        void this.panel.webview.postMessage({ command: "configResult", callbackId: msg.callbackId, error: "Failed to save config" });
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
