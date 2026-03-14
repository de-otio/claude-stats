/**
 * Sidebar webview provider for Claude Stats.
 *
 * Displays the "Open Dashboard" button plus dynamic contextual help
 * that updates based on the currently active dashboard tab.
 */
import * as vscode from "vscode";
import { getNonce, escapeHtml } from "./utils.js";
import { t } from "./i18n.js";

/** Known tab IDs for help content lookup. */
const TAB_IDS = ["overview", "models", "projects", "sessions", "plan", "context", "efficiency", "settings"] as const;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-stats.dashboardView";

  private view?: vscode.WebviewView;
  private currentTab = "overview";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === "openDashboard") {
        void vscode.commands.executeCommand("claude-stats.openDashboard");
      }
    });

    this.render();
  }

  /** Called by the extension when the dashboard tab changes. */
  setActiveTab(tabId: string): void {
    if (this.currentTab === tabId) return;
    this.currentTab = tabId;
    this.render();
  }

  private render(): void {
    if (!this.view) return;

    const tabId = TAB_IDS.includes(this.currentTab as typeof TAB_IDS[number]) ? this.currentTab : "overview";
    const helpTitle = t(`extension:tabHelp.${tabId}.title`);
    const sections = t(`extension:tabHelp.${tabId}.sections`, { returnObjects: true }) as unknown as Array<{ heading: string; body: string }>;
    const nonce = getNonce();

    const sectionsHtml = (Array.isArray(sections) ? sections : [])
      .map(
        (s) =>
          `<div class="section">
            <h3>${escapeHtml(s.heading)}</h3>
            <p>${escapeHtml(s.body)}</p>
          </div>`,
      )
      .join("\n");

    // Build tab indicator pills
    const tabPills = TAB_IDS
      .map(
        (id) =>
          `<span class="pill${id === this.currentTab ? " active" : ""}">${escapeHtml(t(`extension:tabHelp.${id}.title`))}</span>`,
      )
      .join("");

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0 12px 12px 12px;
      line-height: 1.5;
    }
    .btn-open {
      display: block;
      width: 100%;
      padding: 8px 12px;
      margin: 12px 0;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      text-align: center;
    }
    .btn-open:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
      margin: 12px 0;
    }
    .tab-indicator {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 10px;
    }
    .pill {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 9px;
      background: var(--vscode-badge-background, #333);
      color: var(--vscode-badge-foreground, #ccc);
      opacity: 0.5;
    }
    .pill.active {
      opacity: 1;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .tab-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: var(--vscode-foreground);
    }
    .section {
      margin-bottom: 12px;
    }
    .section h3 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 4px 0;
    }
    .section p {
      font-size: 12px;
      margin: 0;
      color: var(--vscode-foreground);
      white-space: pre-line;
    }
  </style>
</head>
<body>
  <button class="btn-open" id="open-btn">${escapeHtml(t("extension:sidebar.openDashboard"))}</button>

  <hr class="divider">

  <div class="tab-indicator">${tabPills}</div>
  <div class="tab-title">${escapeHtml(t("extension:sidebar.tabTitle", { title: helpTitle }))}</div>

  ${sectionsHtml}

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      document.getElementById('open-btn').addEventListener('click', function() {
        vscode.postMessage({ command: 'openDashboard' });
      });
    })();
  </script>
</body>
</html>`;
  }
}

