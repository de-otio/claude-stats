import { describe, it, expect } from "vitest";
import { buildFeeAttribution, type FeeAttributionInput } from "../dashboard/fee-attribution.js";

/** Sum of every project slice across all currency blocks. */
function attributedTotal(input: FeeAttributionInput): number {
  const r = buildFeeAttribution(input);
  return r.byCurrency.reduce((s, b) => s + b.perProject.reduce((ps, p) => ps + p.amount, 0), 0);
}

const MONTH = 30.4;

describe("buildFeeAttribution — per-account pooling", () => {
  it("distributes each account's fee only across that account's projects (no cross-account leak)", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH, // prorate = 1
      fees: {
        work: { monthlyFee: 125, currency: "EUR", label: "Work" },
        personal: { monthlyFee: 214, currency: "EUR", label: "Personal" },
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "client-api", cost: 4 },
        { accountUuid: "work", projectPath: "internal", cost: 1 },
        { accountUuid: "personal", projectPath: "claude-stats", cost: 6 },
        { accountUuid: "personal", projectPath: "blog", cost: 2 },
      ],
    });
    expect(r.byCurrency).toHaveLength(1);
    const eur = r.byCurrency[0]!;
    const byProj = Object.fromEntries(eur.perProject.map((p) => [p.projectPath, p.amount]));
    // Work pool 125 split 80/20; personal 214 split 75/25 — no mixing.
    expect(byProj["client-api"]).toBeCloseTo(100, 6); // 125 * 0.8
    expect(byProj["internal"]).toBeCloseTo(25, 6);    // 125 * 0.2
    expect(byProj["claude-stats"]).toBeCloseTo(160.5, 6); // 214 * 0.75
    expect(byProj["blog"]).toBeCloseTo(53.5, 6);      // 214 * 0.25
    // client-api draws nothing from the personal pool.
    expect(byProj["client-api"]).toBeLessThan(125 + 1e-9);
  });

  it("reconciles: sum of project slices equals the pro-rated pool total (M5)", () => {
    const input: FeeAttributionInput = {
      periodDays: 7, // prorate = 7/30.4
      fees: {
        work: { monthlyFee: 125, currency: "EUR", label: "Work" },
        personal: { monthlyFee: 214, currency: "EUR", label: "Personal" },
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "client-api", cost: 4 },
        { accountUuid: "work", projectPath: "internal", cost: 1 },
        { accountUuid: "personal", projectPath: "claude-stats", cost: 6 },
        { accountUuid: "personal", projectPath: "blog", cost: 2 },
      ],
    };
    const r = buildFeeAttribution(input);
    const expectedPool = ((125 + 214) * 7) / MONTH;
    expect(attributedTotal(input)).toBeCloseTo(expectedPool, 6);
    expect(r.byCurrency[0]!.periodTotal).toBeCloseTo(expectedPool, 6);
    expect(r.byCurrency[0]!.attributed).toBeCloseTo(expectedPool, 6);
  });
});

describe("buildFeeAttribution — shared project across accounts (S3)", () => {
  it("accumulates slices from both pools into one project", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: {
        work: { monthlyFee: 100, currency: "USD", label: "Work" },
        personal: { monthlyFee: 50, currency: "USD", label: "Personal" },
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "shared", cost: 10 }, // 100% of work
        { accountUuid: "personal", projectPath: "shared", cost: 5 }, // 100% of personal
      ],
    });
    const shared = r.byCurrency[0]!.perProject.find((p) => p.projectPath === "shared")!;
    expect(shared.amount).toBeCloseTo(150, 6); // 100 + 50
  });
});

describe("buildFeeAttribution — idle pools (M4)", () => {
  it("routes a configured fee with zero in-period cost to idle, never to projects", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: {
        work: { monthlyFee: 125, currency: "EUR", label: "Work" },
        personal: { monthlyFee: 214, currency: "EUR", label: "Personal" },
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "client-api", cost: 4 },
        // personal account: no rows this period
      ],
    });
    const eur = r.byCurrency[0]!;
    expect(eur.perProject).toHaveLength(1);
    expect(eur.perProject[0]!.amount).toBeCloseTo(125, 6); // full work pool to its sole project
    expect(eur.idle).toEqual([{ label: "Personal", amount: 214 }]);
  });

  it("treats an account with usage but ZERO API-equivalent cost as idle (M4)", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: { work: { monthlyFee: 100, currency: "USD", label: "Work" } },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "free-tier", cost: 0 },
      ],
    });
    expect(r.byCurrency[0]!.perProject).toHaveLength(0);
    expect(r.byCurrency[0]!.idle).toEqual([{ label: "Work", amount: 100 }]);
  });

  it("configured is true even when every pool is idle (N3)", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: { work: { monthlyFee: 100, currency: "USD", label: "Work" } },
      costByAccountProject: [],
    });
    expect(r.configured).toBe(true);
    expect(r.byCurrency[0]!.idle).toHaveLength(1);
    expect(r.byCurrency[0]!.perProject).toHaveLength(0);
  });
});

describe("buildFeeAttribution — currencies never mix (S2)", () => {
  it("produces one block per currency, sorted, with no blended total", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: {
        work: { monthlyFee: 125, currency: "EUR", label: "Work" },
        personal: { monthlyFee: 100, currency: "USD", label: "Personal" },
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "a", cost: 1 },
        { accountUuid: "personal", projectPath: "b", cost: 1 },
      ],
    });
    expect(r.byCurrency.map((b) => b.currency)).toEqual(["EUR", "USD"]); // sorted
    const eur = r.byCurrency.find((b) => b.currency === "EUR")!;
    const usd = r.byCurrency.find((b) => b.currency === "USD")!;
    expect(eur.periodTotal).toBeCloseTo(125, 6);
    expect(usd.periodTotal).toBeCloseTo(100, 6);
    // No field sums across currencies — there is no scalar total surface.
    expect((r as unknown as { total?: number }).total).toBeUndefined();
  });
});

describe("buildFeeAttribution — unattributed usage and unknown bucket (S4)", () => {
  it("an account with usage but no resolved fee receives no share", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: {
        work: { monthlyFee: 100, currency: "USD", label: "Work" },
        "(unknown)": null,
      },
      costByAccountProject: [
        { accountUuid: "work", projectPath: "a", cost: 5 },
        { accountUuid: "(unknown)", projectPath: "mystery", cost: 5 }, // no fee → ignored
      ],
    });
    const byProj = Object.fromEntries(r.byCurrency[0]!.perProject.map((p) => [p.projectPath, p.amount]));
    expect(byProj["a"]).toBeCloseTo(100, 6); // full pool, undiluted by mystery's cost
    expect(byProj["mystery"]).toBeUndefined();
  });
});

describe("buildFeeAttribution — proration and edges", () => {
  it("prorates the monthly fee to the period length", () => {
    const r = buildFeeAttribution({
      periodDays: 7,
      fees: { work: { monthlyFee: 304, currency: "USD", label: "Work" } },
      costByAccountProject: [{ accountUuid: "work", projectPath: "a", cost: 1 }],
    });
    expect(r.prorate).toBeCloseTo(7 / MONTH, 9);
    expect(r.byCurrency[0]!.perProject[0]!.amount).toBeCloseTo((304 * 7) / MONTH, 6);
    expect(r.byCurrency[0]!.perProject[0]!.monthlyEquivalent).toBeCloseTo(304, 6);
  });

  it("clamps periodDays < 1 to 1", () => {
    const a = buildFeeAttribution({
      periodDays: 0,
      fees: { w: { monthlyFee: 30.4, currency: "USD", label: "W" } },
      costByAccountProject: [{ accountUuid: "w", projectPath: "a", cost: 1 }],
    });
    expect(a.prorate).toBeCloseTo(1 / MONTH, 9);
  });

  it("empty input → not configured, no blocks", () => {
    const r = buildFeeAttribution({ periodDays: MONTH, fees: {}, costByAccountProject: [] });
    expect(r.configured).toBe(false);
    expect(r.byCurrency).toHaveLength(0);
  });

  it("percentOfTotal reflects share of the currency pool", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: { w: { monthlyFee: 100, currency: "USD", label: "W" } },
      costByAccountProject: [
        { accountUuid: "w", projectPath: "a", cost: 3 },
        { accountUuid: "w", projectPath: "b", cost: 1 },
      ],
    });
    const byProj = Object.fromEntries(r.byCurrency[0]!.perProject.map((p) => [p.projectPath, p.percentOfTotal]));
    expect(byProj["a"]).toBeCloseTo(75, 6);
    expect(byProj["b"]).toBeCloseTo(25, 6);
  });

  it("sorts projects by amount descending", () => {
    const r = buildFeeAttribution({
      periodDays: MONTH,
      fees: { w: { monthlyFee: 100, currency: "USD", label: "W" } },
      costByAccountProject: [
        { accountUuid: "w", projectPath: "small", cost: 1 },
        { accountUuid: "w", projectPath: "big", cost: 9 },
      ],
    });
    expect(r.byCurrency[0]!.perProject.map((p) => p.projectPath)).toEqual(["big", "small"]);
  });
});
