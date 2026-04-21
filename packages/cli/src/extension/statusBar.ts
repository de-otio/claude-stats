/**
 * Status bar item showing today's token count and estimated cost.
 * Click opens the dashboard panel.
 *
 * The status bar does not poll on its own — the AutoCollector
 * calls refresh() after each collection run.
 */
import * as vscode from "vscode";
import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { t } from "./i18n.js";

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "claude-stats.openDashboard";
    this.item.tooltip = t("extension:statusBar.tooltip");
    this.item.text = t("extension:statusBar.idle");
    this.item.show();
  }

  refresh(): void {
    try {
      const store = new Store();
      try {
        const data = buildDashboard(store, { period: "day" });
        // No data collected yet: keep the status bar in its "idle" state.
        // Clicking it still opens the dashboard, which now shows a welcome
        // screen explaining how to set up Claude Code.
        if (data.summary.sessions === 0) {
          this.item.text = t("extension:statusBar.idle");
          this.item.tooltip = t("extension:statusBar.tooltipEmpty");
          return;
        }
        const tokens = data.summary.inputTokens + data.summary.outputTokens;
        const cost = data.summary.estimatedCost;
        this.item.text = t("extension:statusBar.withStats", { tokens: formatTokens(tokens), cost: cost.toFixed(2) });
        this.item.tooltip = t("extension:statusBar.tooltip");
      } finally {
        store.close();
      }
    } catch {
      this.item.text = t("extension:statusBar.idle");
      this.item.tooltip = t("extension:statusBar.tooltipEmpty");
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Format a token count with k/M suffix. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
