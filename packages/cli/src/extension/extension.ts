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
  const jaExt = _require("@claude-stats/core/locales/ja/extension.json") as Record<string, unknown>;
  const jaDash = _require("@claude-stats/core/locales/ja/dashboard.json") as Record<string, unknown>;
  const zhCnExt = _require("@claude-stats/core/locales/zh-CN/extension.json") as Record<string, unknown>;
  const zhCnDash = _require("@claude-stats/core/locales/zh-CN/dashboard.json") as Record<string, unknown>;
  const frExt = _require("@claude-stats/core/locales/fr/extension.json") as Record<string, unknown>;
  const frDash = _require("@claude-stats/core/locales/fr/dashboard.json") as Record<string, unknown>;
  const esExt = _require("@claude-stats/core/locales/es/extension.json") as Record<string, unknown>;
  const esDash = _require("@claude-stats/core/locales/es/dashboard.json") as Record<string, unknown>;
  const ptBrExt = _require("@claude-stats/core/locales/pt-BR/extension.json") as Record<string, unknown>;
  const ptBrDash = _require("@claude-stats/core/locales/pt-BR/dashboard.json") as Record<string, unknown>;
  const plExt = _require("@claude-stats/core/locales/pl/extension.json") as Record<string, unknown>;
  const plDash = _require("@claude-stats/core/locales/pl/dashboard.json") as Record<string, unknown>;
  const ukExt = _require("@claude-stats/core/locales/uk/extension.json") as Record<string, unknown>;
  const ukDash = _require("@claude-stats/core/locales/uk/dashboard.json") as Record<string, unknown>;

  // VS Code returns lowercase locale codes (e.g. "zh-cn", "pt-br"). Normalize
  // the regionalized ones to match our resource keys (BCP 47 casing). All
  // other codes collapse to their primary subtag.
  const rawLang = vscode.env.language.toLowerCase();
  const lng = rawLang.startsWith("zh-cn")
    ? "zh-CN"
    : rawLang.startsWith("pt-br")
      ? "pt-BR"
      : rawLang.split("-")[0];

  void initI18n({
    lng,
    ns: ["extension", "dashboard", "common"],
    resources: {
      en: { extension: enExt, dashboard: enDash },
      de: { extension: deExt, dashboard: deDash },
      ja: { extension: jaExt, dashboard: jaDash },
      "zh-CN": { extension: zhCnExt, dashboard: zhCnDash },
      fr: { extension: frExt, dashboard: frDash },
      es: { extension: esExt, dashboard: esDash },
      "pt-BR": { extension: ptBrExt, dashboard: ptBrDash },
      pl: { extension: plExt, dashboard: plDash },
      uk: { extension: ukExt, dashboard: ukDash },
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
