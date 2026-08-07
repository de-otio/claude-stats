/**
 * Single navigation definition for the dashboard's tab bar.
 *
 * Two hosts render tab-shaped UI from independent, hand-maintained lists
 * today: `template.ts`'s inline tab-button block and `extension/sidebar.ts`'s
 * `TAB_IDS` constant. They have already drifted — the sidebar still lists a
 * removed "models" tab and lacks "classify"
 * (doc/analysis/gui-redesign/01-diagnosis.md §1.1, 03 §3.3 item 2). Adding a
 * tab is meant to be a one-line change in one place; this module is that
 * place. `template.ts` renders the tab bar from `NAV_TABS`, and
 * `extension/sidebar.ts` derives its `TAB_IDS` from the same list, so a new
 * entry here reaches both hosts without a second edit.
 *
 * Order here is the on-screen tab order.
 */
import type { DashboardData } from "../dashboard/index.js";

export interface NavTab {
  /** Stable id — matches `data-tab`, the tab-panel id suffix, and the
   *  `extension:tabHelp.<id>` / `dashboard:tabs.<id>` locale namespaces. */
  id: string;
  /** i18n key for the tab-bar label (`dashboard:tabs.<id>`). */
  labelKey: string;
  /** When set, the tab is rendered only if this field of `DashboardData` is
   *  present (mirrors the conditional tabs already in `template.ts`). A tab
   *  with no predicate is always shown. */
  dataKey?: keyof Pick<DashboardData, "energy" | "spending" | "contextAnalysis" | "modelEfficiency">;
}

/** The canonical tab list. Both hosts consume this — do not hand-roll a
 *  second list anywhere else. */
export const NAV_TABS: readonly NavTab[] = [
  { id: "overview", labelKey: "dashboard:tabs.overview" },
  { id: "energy", labelKey: "dashboard:tabs.energy", dataKey: "energy" },
  { id: "spending", labelKey: "dashboard:tabs.spending", dataKey: "spending" },
  { id: "projects", labelKey: "dashboard:tabs.projects" },
  { id: "sessions", labelKey: "dashboard:tabs.sessions" },
  { id: "plan", labelKey: "dashboard:tabs.plan" },
  { id: "context", labelKey: "dashboard:tabs.context", dataKey: "contextAnalysis" },
  { id: "efficiency", labelKey: "dashboard:tabs.efficiency", dataKey: "modelEfficiency" },
  { id: "classify", labelKey: "dashboard:tabs.classify" },
  { id: "settings", labelKey: "dashboard:tabs.settings" },
] as const;

/** Every tab id, in display order — the sidebar's help-content lookup set. */
export const NAV_TAB_IDS: readonly string[] = NAV_TABS.map((tab) => tab.id);

/** The tabs actually shown for a given dashboard payload, in order. */
export function visibleNavTabs(data: DashboardData): NavTab[] {
  return NAV_TABS.filter((tab) => !tab.dataKey || data[tab.dataKey] != null);
}
