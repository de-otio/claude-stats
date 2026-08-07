import { describe, it, expect } from "vitest";
import { NAV_TABS, NAV_TAB_IDS, visibleNavTabs } from "../server/nav.js";
import type { DashboardData } from "../dashboard/index.js";

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

  it("includes classify and spending, and does not include the removed models tab", () => {
    // Regression guard for the exact drift diagnosed in
    // doc/analysis/gui-redesign/01-diagnosis.md §1.1: a stale "models" tab
    // that outlived its removal, and a missing "classify" tab.
    expect(NAV_TAB_IDS).toContain("classify");
    expect(NAV_TAB_IDS).toContain("spending");
    expect(NAV_TAB_IDS).not.toContain("models");
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
