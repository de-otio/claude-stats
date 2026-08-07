/**
 * Sidebar webview provider for Claude Stats.
 *
 * Displays the "Open Dashboard" button plus dynamic contextual help
 * that updates based on the currently active dashboard tab.
 */
import * as vscode from "vscode";
import { getNonce, escapeHtml } from "./utils.js";
import { t } from "./i18n.js";
import { NAV_VIEWS, NAV_VIEW_IDS, DEFAULT_NAV_VIEW, type NavViewId } from "../server/nav.js";

/** Known view IDs for help content lookup — derived from the single nav
 *  definition in `server/nav.ts` so this list can't drift from the nav bar
 *  the dashboard actually renders (doc/analysis/gui-redesign/03 §3.3 item 2).
 *
 *  Views, not sections, since the domain-view regrouping: the dashboard posts
 *  the id of the thing the user clicked, and what the user clicks is a view. */
const VIEW_IDS = NAV_VIEW_IDS;

/** Sections of a view, for composing its help body. */
const SECTIONS_OF = new Map<NavViewId, readonly string[]>(
  NAV_VIEWS.map((v) => [v.id as NavViewId, v.sections as readonly string[]]),
);

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claude-stats.dashboardView";

  private view?: vscode.WebviewView;
  // The help panel opens on whatever view the dashboard opens on; hardcoding
  // "overview" here would show Overview help beside the Insights view.
  private currentTab: string = DEFAULT_NAV_VIEW;

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

    const viewId = (VIEW_IDS.includes(this.currentTab as NavViewId) ? this.currentTab : DEFAULT_NAV_VIEW) as NavViewId;
    // The view's own localized name for the header, and its SECTIONS' existing
    // help for the body. Composing rather than authoring new per-view copy is
    // deliberate: a view is exactly the sections it groups, so the help it owes
    // the reader is those sections' help — and a fifth parallel description of
    // the same screens is one more thing to drift (03 §3.3 item 2).
    const helpTitle = t(`dashboard:views.${viewId}`);
    const sectionIds = SECTIONS_OF.get(viewId) ?? [];
    const nonce = getNonce();

    // A single-section view (Insights, Sessions, Energy, Settings) shows its
    // section's help with no extra heading — the pill above already names it.
    // A multi-section view prefixes each block with the section's own name, so
    // the reader can tell which half of the view a paragraph is about.
    const sectionsHtml = sectionIds
      .flatMap((sectionId) => {
        const blocks = t(`extension:tabHelp.${sectionId}.sections`, { returnObjects: true }) as unknown as Array<{
          heading: string;
          body: string;
        }>;
        const prefix = sectionIds.length > 1 ? `${t(`dashboard:tabs.${sectionId}`)} — ` : "";
        return (Array.isArray(blocks) ? blocks : []).map(
          (s) =>
            `<div class="section">
            <h3>${escapeHtml(prefix + s.heading)}</h3>
            <p>${escapeHtml(s.body)}</p>
          </div>`,
        );
      })
      .join("\n");

    // Build view indicator pills
    const tabPills = VIEW_IDS
      .map(
        (id) =>
          `<span class="pill${id === viewId ? " active" : ""}">${escapeHtml(t(`dashboard:views.${id}`))}</span>`,
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

