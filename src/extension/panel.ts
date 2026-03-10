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
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import type { ReportOptions } from "../reporter/index.js";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private period: ReportOptions["period"] = "all";
  private readonly chartJsUri: vscode.Uri;

  /**
   * Refresh the currently visible dashboard panel (if any).
   * Called by the AutoCollector after each successful collection.
   */
  static refreshIfVisible(): void {
    DashboardPanel.instance?.refresh();
  }

  static createOrShow(context: vscode.ExtensionContext): void {
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

    DashboardPanel.instance = new DashboardPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.chartJsUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "media", "chart.min.js"),
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { command: string; period?: string }) => this.handleMessage(msg),
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
      const data = buildDashboard(store, { period: this.period });
      const html = renderDashboard(data);
      this.panel.webview.html = patchForWebview(
        html,
        this.panel.webview.cspSource,
        this.chartJsUri.toString(),
      );
    } finally {
      store.close();
    }
  }

  private handleMessage(msg: { command: string; period?: string }): void {
    if (msg.command === "changePeriod" && msg.period) {
      this.period = msg.period as ReportOptions["period"];
      this.refresh();
    } else if (msg.command === "refresh") {
      this.refresh();
    }
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    for (const d of this.disposables) d.dispose();
  }
}

/** Generate a random nonce string for CSP script-src. */
function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
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
export function patchForWebview(html: string, cspSource: string, chartJsUri: string): string {
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

  // 5. Inject bridge script that wires up VS Code messaging and event handlers
  const bridgeScript = `<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();

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
})();
</script>`;
  html = html.replace("</body>", `${bridgeScript}\n</body>`);

  return html;
}
