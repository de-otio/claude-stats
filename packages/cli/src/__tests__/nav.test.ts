import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { NAV_TABS, NAV_TAB_IDS, visibleNavTabs } from "../server/nav.js";
import type { NavTabId } from "../server/nav.js";
import type { DashboardData } from "../dashboard/index.js";

// Relative paths into this worktree's own source, deliberately NOT
// `require("@claude-stats/core/locales/...")` — a bare specifier resolves out
// of a git worktree into the PARENT repo's node_modules, so a key added here
// would read as missing. Same reasoning as template.test.ts.
const require = createRequire(import.meta.url);
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as {
  tabs?: Record<string, unknown>;
};
const enExtension = require("../../../core/src/locales/en/extension.json") as {
  tabHelp?: Record<string, unknown>;
};

// Minimal DashboardData stub — only the fields visibleNavTabs reads.
function stub(overrides: Partial<Pick<DashboardData, "energy" | "spending" | "contextAnalysis" | "modelEfficiency">>): DashboardData {
  return {
    energy: null,
    spending: null,
    contextAnalysis: null,
    modelEfficiency: null,
    ...overrides,
  } as DashboardData;
}

describe("nav — single tab definition for both hosts", () => {
  it("NAV_TAB_IDS is derived from NAV_TABS, in order", () => {
    expect(NAV_TAB_IDS).toEqual(NAV_TABS.map((t) => t.id));
  });

  it("has no duplicate ids", () => {
    expect(new Set(NAV_TAB_IDS).size).toBe(NAV_TAB_IDS.length);
  });

  it("NAV_TAB_IDS carries a literal id union, not plain string (G4 regression guard)", () => {
    // Compile-time only. `NAV_TAB_IDS` used to be typed `readonly string[]`,
    // which made every `as typeof TAB_IDS[number]` cast in
    // extension/sidebar.ts a no-op accepting any string. If that regresses
    // (e.g. NAV_TABS loses `as const satisfies readonly NavTab[]`, or
    // NAV_TAB_IDS goes back to an explicit `readonly string[]` annotation),
    // `NavTabId` widens back to plain `string`, this assignment stops being
    // a type error, and the unmatched `@ts-expect-error` below itself
    // becomes a compile error ("Unused '@ts-expect-error' directive") —
    // failing `npm run typecheck`.
    // @ts-expect-error — an arbitrary string is not a valid NavTabId.
    const bad: NavTabId = "not-a-real-tab-id";
    void bad;
    expect(NAV_TAB_IDS.length).toBeGreaterThan(0);
  });

  it("includes classify and spending, and does not include the removed models tab", () => {
    // Regression guard for the exact drift diagnosed in
    // doc/analysis/gui-redesign/01-diagnosis.md §1.1: a stale "models" tab
    // that outlived its removal, and a missing "classify" tab.
    expect(NAV_TAB_IDS).toContain("classify");
    expect(NAV_TAB_IDS).toContain("spending");
    expect(NAV_TAB_IDS).not.toContain("models");
  });

  // The whole point of this module is "add a tab in ONE place and both hosts
  // pick it up". Nothing above actually holds that promise: adding an entry to
  // NAV_TABS without the matching locale keys makes the tab bar render the raw
  // key `dashboard:tabs.<id>` and the sidebar pill render
  // `extension:tabHelp.<id>.title` — i18next falls back to the key, silently,
  // and every existing test stays green. These two close that hole.
  it("every NAV_TABS entry has its dashboard:tabs.<id> label key", () => {
    const tabs = enDashboard.tabs ?? {};
    expect(Object.keys(tabs).length).toBeGreaterThan(0);
    for (const tab of NAV_TABS) {
      expect(tab.labelKey).toBe(`dashboard:tabs.${tab.id}`);
      expect(tabs).toHaveProperty(tab.id);
    }
    // …and no orphaned label survives a tab's removal (the "models" defect).
    expect(Object.keys(tabs).sort()).toEqual([...NAV_TAB_IDS].sort());
  });

  it("every NAV_TABS entry has its extension:tabHelp.<id> sidebar help entry", () => {
    const help = enExtension.tabHelp ?? {};
    expect(Object.keys(help).length).toBeGreaterThan(0);
    // sidebar.ts renders one pill per NAV_TAB_ID from tabHelp.<id>.title, so
    // the two sets must be equal in both directions.
    expect(Object.keys(help).sort()).toEqual([...NAV_TAB_IDS].sort());
    for (const id of NAV_TAB_IDS) {
      expect(help[id]).toHaveProperty("title");
      expect(help[id]).toHaveProperty("sections");
    }
  });

  it("unconditional tabs are always visible regardless of data", () => {
    const empty = stub({});
    const visible = visibleNavTabs(empty).map((t) => t.id);
    for (const tab of NAV_TABS) {
      if (!tab.dataKey) expect(visible).toContain(tab.id);
    }
  });

  it("conditional tabs are hidden when their data field is null", () => {
    const empty = stub({});
    const visible = visibleNavTabs(empty).map((t) => t.id);
    expect(visible).not.toContain("energy");
    expect(visible).not.toContain("spending");
    expect(visible).not.toContain("context");
    expect(visible).not.toContain("efficiency");
  });

  it("conditional tabs appear once their data field is present", () => {
    const withData = stub({
      energy: {} as DashboardData["energy"],
      spending: {} as DashboardData["spending"],
      contextAnalysis: {} as DashboardData["contextAnalysis"],
      modelEfficiency: {} as DashboardData["modelEfficiency"],
    });
    const visible = visibleNavTabs(withData).map((t) => t.id);
    expect(visible).toEqual(expect.arrayContaining(["energy", "spending", "context", "efficiency"]));
  });

  it("preserves display order for a mixed availability set", () => {
    const partial = stub({ spending: {} as DashboardData["spending"] });
    const visible = visibleNavTabs(partial).map((t) => t.id);
    expect(visible).toEqual([
      "overview",
      "spending",
      "projects",
      "sessions",
      "plan",
      "classify",
      "settings",
    ]);
  });
});
