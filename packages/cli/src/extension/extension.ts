/**
 * VS Code extension entry point for claude-stats.
 *
 * Starts an AutoCollector that watches ~/.claude/projects/ for changes,
 * runs incremental collection, and refreshes the status bar and dashboard.
 */
import * as vscode from "vscode";
import { createRequire } from "node:module";
import { DashboardPanel } from "./panel.js";
import { SidebarProvider } from "./sidebar.js";
import { StatusBarManager } from "./statusBar.js";
import { AutoCollector } from "./collector.js";
import { initPricingCache } from "../pricing-cache.js";
import { initI18n } from "@claude-stats/core/i18n";
import { setT, t } from "./i18n.js";
import { ensureMcpServer } from "./mcp-register.js";

// Build a require() that works in both ESM and CJS (esbuild bundles).
const _url = typeof import.meta?.url === "string"
  ? import.meta.url
  : typeof __filename === "string"
    ? "file://" + __filename
    : "file:///placeholder.js";
const _require = createRequire(_url);

export function activate(context: vscode.ExtensionContext): void {
  // Initialize i18n with extension and dashboard namespaces
  const enExt = _require("@claude-stats/core/locales/en/extension.json") as Record<string, unknown>;
  const enDash = _require("@claude-stats/core/locales/en/dashboard.json") as Record<string, unknown>;
  const deExt = _require("@claude-stats/core/locales/de/extension.json") as Record<string, unknown>;
  const deDash = _require("@claude-stats/core/locales/de/dashboard.json") as Record<string, unknown>;

  void initI18n({
    lng: vscode.env.language.split("-")[0],
    ns: ["extension", "dashboard", "common"],
    resources: {
      en: { extension: enExt, dashboard: enDash },
      de: { extension: deExt, dashboard: deDash },
    },
  }).then((instance: import("i18next").i18n) => {
    setT(instance.t.bind(instance));
  });

  // Load cached pricing (sync) and refresh in background if stale
  void initPricingCache();
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      sidebarProvider,
    ),
  );

  const collector = new AutoCollector();
  context.subscriptions.push(collector);

  // After each collection, refresh the status bar and any open dashboard panel
  context.subscriptions.push(
    collector.onDidCollect(() => {
      statusBar.refresh();
      DashboardPanel.refreshIfVisible();
    }),
  );

  const openDashboard = vscode.commands.registerCommand(
    "claude-stats.openDashboard",
    () => {
      try {
        DashboardPanel.createOrShow(context, sidebarProvider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("sqlite") || msg.includes("SQLite")) {
          void vscode.window.showErrorMessage(
            t("extension:errors.sqliteRequired", { message: msg }),
          );
        } else {
          void vscode.window.showErrorMessage(t("extension:errors.generic", { message: msg }));
        }
      }
    },
  );
  context.subscriptions.push(openDashboard);

  // Register MCP server in Claude Code global settings if not already present
  ensureMcpServer(context);

  // Start watching and run initial collection
  collector.start();
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions handle cleanup
}
