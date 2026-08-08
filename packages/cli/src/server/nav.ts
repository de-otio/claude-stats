/**
 * Single navigation definition for the dashboard — sections, and the domain
 * views that group them.
 *
 * Two hosts render tab-shaped UI from independent, hand-maintained lists
 * today: `template.ts`'s inline tab-button block and `extension/sidebar.ts`'s
 * `TAB_IDS` constant. They have already drifted — the sidebar still lists a
 * removed "models" tab and lacks "classify"
 * (doc/analysis/gui-redesign/01-diagnosis.md §1.1, 03 §3.3 item 2). Adding a
 * tab is meant to be a one-line change in one place; this module is that
 * place. Both hosts consume the exports below, so a nav change reaches the
 * served page and the webview without a second edit.
 *
 * ## Two levels, since the domain-view regrouping
 *
 * `NAV_TABS` is now the **section** registry: one entry per rendered panel, ids
 * unchanged. Sections are no longer the navigation — they are what the
 * navigation contains. `NAV_VIEWS` is the navigation: the four question-shaped
 * domain views from 02-answer-first-ia.md §2.4 plus Insights and the utility
 * surfaces, each naming the sections it groups.
 *
 * The diagnosis was that the tab bar mirrored the DATA MODEL — a tab existed
 * because a `DashboardData` block existed (01 §1.2) — so a reader had to know
 * which of four tabs held which fragment of the cost story. Grouping is the fix
 * and deletion is not: every section id in `NAV_TABS` still renders, still
 * carries its own panel, and is still reachable by its own hash. `viewForSection`
 * is what makes an old `#spending` link land somewhere real, and the
 * "every section belongs to exactly one view" invariant in `nav.test.ts` is what
 * stops a future edit making a panel unreachable by quietly dropping it from
 * every view's `sections`.
 *
 * Order within each list is the on-screen order.
 */
import type { DashboardData } from "../dashboard/index.js";

export interface NavTab {
  /** Stable id — matches the tab-panel id suffix, the section hash, and the
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
 * The canonical SECTION list — one entry per rendered panel. Both hosts consume
 * this; do not hand-roll a second list anywhere else.
 *
 * Since the regrouping these are no longer the tab bar (see `NAV_VIEWS`), but
 * the ids, label keys and predicates are deliberately unchanged: the panel ids,
 * the `dashboard:tabs.<id>` labels — now rendered as section headings inside a
 * view — and the sidebar's `extension:tabHelp.<id>` entries all keep working,
 * and an existing `#spending` deep link still resolves.
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
  // The section behind the default VIEW (`DEFAULT_NAV_VIEW`). The whole point
  // of the answer-first IA is that the front door answers the five business
  // questions rather than showing token mechanics
  // (doc/analysis/gui-redesign/02-answer-first-ia.md §2.1). It carries no
  // `dataKey`: an Insights surface that disappeared when data was thin would
  // take the honest-empty states — the part that tells a new user what to
  // enable — away from exactly the user who needs them.
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

/** The literal union of every section id — `"overview" | "energy" | ... `,
 *  not plain `string`. */
export type NavTabId = (typeof NAV_TABS)[number]["id"];

/** Every section id, in render order — the sidebar's help-content lookup set. */
export const NAV_TAB_IDS: readonly NavTabId[] = NAV_TABS.map((tab) => tab.id);

/** The sections actually rendered for a given dashboard payload, in order. */
export function visibleNavTabs(data: DashboardData): NavTab[] {
  return NAV_TABS.filter((tab) => !tab.dataKey || data[tab.dataKey] != null);
}

// ─── Domain views: the navigation ─────────────────────────────────────────────

export interface NavView {
  /** Stable id — matches `data-tab` on the view button, `data-view` on each of
   *  its section panels, and the `dashboard:views.<id>` locale namespace. */
  id: string;
  /** i18n key for the view's nav label (`dashboard:views.<id>`). */
  labelKey: string;
  /**
   * The sections this view contains, in the order they appear on screen.
   *
   * That order is asserted against the RENDERED page (`domain-views.test.ts`),
   * not merely declared: the panels stay top-level siblings in `template.ts` and
   * a view shows the subset that names it, so a `sections` array written in a
   * different order than the template renders them would be a comment that
   * lies. The test is what keeps the two honest.
   */
  sections: readonly NavTabId[];
}

/**
 * The four question-shaped domain views, plus Insights and the utility
 * surfaces — the whole navigation (02-answer-first-ia.md §2.4).
 *
 * Eleven data-shaped tabs become at most eight entries, and seven on a payload
 * with no energy block. What each grouping is FOR:
 *
 *  - **cost-and-controlling** — "what did AI cost?". Absorbs Spending (the cost
 *    charts, tables and the consolidated cost-quality card) and Overview.
 *    Overview lands here rather than surviving as its own tab because it is the
 *    volume-and-trend evidence UNDER the cost answer: raw token counts are
 *    evidence, and evidence lives one click down from the Insights headline
 *    (02 §2.6), not in a permanent tab of its own.
 *  - **tickets-and-value** — "what did it buy?". Projects (per-project cost,
 *    fee attribution, Nature of Work) and Classify, which 02 §2.4 says should
 *    stop being a permanent tab and live where its output matters.
 *  - **efficiency-and-hygiene** — "was it efficient?". Context (cache/context
 *    analysis) and Efficiency (model-tier analysis).
 *  - **plan-and-policy** — "is the setup right?". The Plan tab and the policy
 *    timeline.
 *
 * Sessions, Energy and Settings stay as their own single-section surfaces —
 * exactly what 02 §2.4's "remaining surfaces" paragraph asks for. Their view id
 * is deliberately IDENTICAL to their section id, which is what keeps every
 * existing consumer of the string `"settings"` (the auto-refresh guard that
 * must never reload the Settings screen, `panel.ts`'s pending-refresh gate)
 * correct without a translation table.
 */
export const NAV_VIEWS = [
  // First, and therefore the default view. The whole point of the answer-first
  // IA is that the front door answers the five business questions rather than
  // showing token mechanics (02 §2.1).
  { id: "insights", labelKey: "dashboard:views.insights", sections: ["insights"] },
  { id: "cost-and-controlling", labelKey: "dashboard:views.cost-and-controlling", sections: ["overview", "spending"] },
  { id: "tickets-and-value", labelKey: "dashboard:views.tickets-and-value", sections: ["projects", "classify"] },
  { id: "efficiency-and-hygiene", labelKey: "dashboard:views.efficiency-and-hygiene", sections: ["context", "efficiency"] },
  { id: "plan-and-policy", labelKey: "dashboard:views.plan-and-policy", sections: ["plan"] },
  { id: "sessions", labelKey: "dashboard:views.sessions", sections: ["sessions"] },
  { id: "energy", labelKey: "dashboard:views.energy", sections: ["energy"] },
  { id: "settings", labelKey: "dashboard:views.settings", sections: ["settings"] },
] as const satisfies readonly NavView[];

/** The literal union of every view id. */
export type NavViewId = (typeof NAV_VIEWS)[number]["id"];

/**
 * The four question-shaped views, as opposed to Insights and the utility
 * surfaces.
 *
 * Written out rather than derived from a shape test (e.g. "views with more than
 * one section"), because the distinction is EDITORIAL, not structural:
 * `plan-and-policy` has one section today and is still a domain view, and a
 * utility surface that later gained a second section must not silently become
 * one. This is what the local-filter bar is offered on — filters answer
 * questions about the work, and the utility surfaces are not questions.
 */
export const DOMAIN_VIEW_IDS = [
  "cost-and-controlling",
  "tickets-and-value",
  "efficiency-and-hygiene",
  "plan-and-policy",
] as const satisfies readonly NavViewId[];

/** Every view id, in display order. */
export const NAV_VIEW_IDS: readonly NavViewId[] = NAV_VIEWS.map((v) => v.id);

/**
 * The view a host opens on, and the fallback for an unrecognised saved/hash id.
 *
 * Derived from `NAV_VIEWS[0]` rather than written out, so "the default view is
 * the first view" cannot drift: the served page's hash restore, the webview's
 * remembered tab, and the sidebar's help panel all resolve through this.
 */
export const DEFAULT_NAV_VIEW: NavViewId = NAV_VIEWS[0].id;

/**
 * Back-compat alias. `panel.ts` and `sidebar.ts` seed their remembered tab from
 * this, and both now hold a VIEW id — the two levels share a namespace for the
 * utility surfaces, and the default is `insights`, which is both.
 */
export const DEFAULT_NAV_TAB: NavViewId = DEFAULT_NAV_VIEW;

/**
 * The view that owns a section — total over `NavTabId` by construction.
 *
 * Built by inverting `NAV_VIEWS` rather than written out as a second table:
 * a hand-maintained map is free to disagree with the grouping it describes, and
 * a section missing from it would render a panel no view can show. The
 * `Partial` is what lets `nav.test.ts` prove totality instead of assuming it —
 * a lookup that returns undefined is the "unreachable panel" defect, and it has
 * to be observable to be tested.
 */
const SECTION_VIEW: Partial<Record<NavTabId, NavViewId>> = Object.fromEntries(
  NAV_VIEWS.flatMap((view) => view.sections.map((section) => [section, view.id] as const)),
);

/** The view a section renders in, or undefined if no view claims it. */
export function viewForSection(section: NavTabId): NavViewId | undefined {
  return SECTION_VIEW[section];
}

/** A view together with the sections of it this payload actually renders. */
export interface VisibleNavView {
  view: NavView;
  sections: NavTab[];
}

/**
 * The views to render for a payload, in order, each with its visible sections.
 *
 * A view with no visible section is dropped — that is only ever the Energy and
 * Settings-shaped case where the single section's own `dataKey` is absent, and
 * it reproduces exactly the conditional-tab behaviour the payload had before.
 * A view with SOME sections missing still renders: the mental map stays put
 * (03 §3.3 item 5), which is the property the conditional tabs never had.
 */
export function visibleNavViews(data: DashboardData): VisibleNavView[] {
  const visible = new Set(visibleNavTabs(data).map((s) => s.id as NavTabId));
  const byId = new Map(NAV_TABS.map((s) => [s.id as NavTabId, s as NavTab]));
  return NAV_VIEWS.map((view) => ({
    view: view as NavView,
    sections: view.sections.filter((id) => visible.has(id)).map((id) => byId.get(id)!),
  })).filter((entry) => entry.sections.length > 0);
}
