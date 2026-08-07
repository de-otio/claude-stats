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

/**
 * The canonical tab list. Both hosts consume this — do not hand-roll a
 * second list anywhere else.
 *
 * `as const satisfies readonly NavTab[]` (not a plain `: readonly NavTab[]`
 * annotation) deliberately keeps each entry's `id` a string LITERAL instead
 * of widening it to `NavTab["id"]`'s plain `string` — that literal union is
 * what lets `NAV_TAB_IDS` (below) carry a real union type instead of
 * `string`, which is in turn what makes `extension/sidebar.ts`'s
 * `as typeof TAB_IDS[number]` cast an actual compile-time check rather than
 * a no-op that accepts any typo'd tab id.
 *
 * Every entry lists `dataKey` explicitly (`undefined` where there's no
 * predicate) rather than omitting the property. Preserving id literals via
 * `as const` also makes TS infer each entry's own precise object shape —
 * omitting `dataKey` on the unconditional entries would make it absent from
 * their type entirely (not merely `undefined`), so `NAV_TABS[number]` would
 * be a union of shapes some of which have no `dataKey` key at all, and
 * `tab.dataKey` below (and in nav.test.ts) would fail to typecheck across
 * the whole union.
 */
export const NAV_TABS = [
  // First, and therefore the default tab (`DEFAULT_NAV_TAB` below, and the
  // "first visible tab is active" rule the tab bar renders by). The whole
  // point of the answer-first IA is that the front door answers the five
  // business questions rather than showing token mechanics
  // (doc/analysis/gui-redesign/02-answer-first-ia.md §2.1). It carries no
  // `dataKey`: an Insights tab that disappeared when data was thin would take
  // the honest-empty states — the part that tells a new user what to enable —
  // away from exactly the user who needs them.
  { id: "insights", labelKey: "dashboard:tabs.insights", dataKey: undefined },
  { id: "overview", labelKey: "dashboard:tabs.overview", dataKey: undefined },
  { id: "energy", labelKey: "dashboard:tabs.energy", dataKey: "energy" },
  { id: "spending", labelKey: "dashboard:tabs.spending", dataKey: "spending" },
  { id: "projects", labelKey: "dashboard:tabs.projects", dataKey: undefined },
  { id: "sessions", labelKey: "dashboard:tabs.sessions", dataKey: undefined },
  { id: "plan", labelKey: "dashboard:tabs.plan", dataKey: undefined },
  { id: "context", labelKey: "dashboard:tabs.context", dataKey: "contextAnalysis" },
  { id: "efficiency", labelKey: "dashboard:tabs.efficiency", dataKey: "modelEfficiency" },
  { id: "classify", labelKey: "dashboard:tabs.classify", dataKey: undefined },
  { id: "settings", labelKey: "dashboard:tabs.settings", dataKey: undefined },
] as const satisfies readonly NavTab[];

/** The literal union of every tab id — `"overview" | "energy" | ... `,
 *  not plain `string`. */
export type NavTabId = (typeof NAV_TABS)[number]["id"];

/** Every tab id, in display order — the sidebar's help-content lookup set. */
export const NAV_TAB_IDS: readonly NavTabId[] = NAV_TABS.map((tab) => tab.id);

/**
 * The tab a host opens on, and the fallback for an unrecognised saved/hash tab.
 *
 * Derived from `NAV_TABS[0]` rather than written out, so "the default tab is
 * the first tab" cannot drift: the served page's hash restore, the webview's
 * remembered tab, and the sidebar's help panel all resolve through this.
 */
export const DEFAULT_NAV_TAB: NavTabId = NAV_TABS[0].id;

/** The tabs actually shown for a given dashboard payload, in order. */
export function visibleNavTabs(data: DashboardData): NavTab[] {
  return NAV_TABS.filter((tab) => !tab.dataKey || data[tab.dataKey] != null);
}
