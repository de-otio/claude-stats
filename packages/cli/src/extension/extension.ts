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
  const ruExt = _require("@claude-stats/core/locales/ru/extension.json") as Record<string, unknown>;
  const ruDash = _require("@claude-stats/core/locales/ru/dashboard.json") as Record<string, unknown>;

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
      ru: { extension: ruExt, dashboard: ruDash },
    },
  }).then((instance: import("i18next").i18n) => {
    setT(instance.t.bind(instance));
    // Check whether the extension was just upgraded and prompt the user to
    // reload the window. Runs after i18n is ready so the prompt is localized.
    promptReloadIfUpgraded(context);
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

/** Key used in globalState to remember which version we last activated under. */
const LAST_VERSION_KEY = "claude-stats.lastActivatedVersion";

/**
 * If the extension version changed since last activation, prompt the user to
 * reload the window. VS Code keeps already-open webviews attached to the old
 * extension host after an in-place update, which silently breaks message
 * passing — clicking Refresh or changing the period does nothing until the
 * window reloads. This surfaces that otherwise-invisible requirement.
 *
 * Exported (via the module) for direct testing. Skips on fresh install (no
 * stored prior version) so we don't prompt on the very first activation.
 */
export function promptReloadIfUpgraded(context: vscode.ExtensionContext): void {
  try {
    const currentVersion =
      (context.extension?.packageJSON as { version?: string } | undefined)?.version;
    if (!currentVersion) return;

    const previousVersion = context.globalState.get<string>(LAST_VERSION_KEY);

    // Always record the current version, even if we skip the prompt, so a
    // subsequent restart with the same version doesn't re-prompt.
    void context.globalState.update(LAST_VERSION_KEY, currentVersion);

    // No prompt on first install — only on real upgrades.
    if (!previousVersion || previousVersion === currentVersion) return;

    const reloadLabel = t("extension:upgrade.reload");
    const laterLabel = t("extension:upgrade.later");
    const message = t("extension:upgrade.message", {
      previous: previousVersion,
      current: currentVersion,
    });

    void vscode.window
      .showInformationMessage(message, reloadLabel, laterLabel)
      .then((choice) => {
        if (choice === reloadLabel) {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  } catch {
    // Never let the upgrade prompt break activation.
  }
}
