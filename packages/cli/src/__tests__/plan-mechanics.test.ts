/**
 * Unit + property tests for the pure plan-mechanics core
 * (`packages/core/src/planMechanics.ts`).
 *
 * Covers: staleness string, usage-intensity thresholds (derived from the
 * benchmark table), seat-range boundaries, procurement-motion classification,
 * validation failure paths, and fast-check invariants for `sizeSeats`
 * (monotonicity in headcount; output independent of tierMix key ordering) with
 * a FIXED seed so runs are deterministic.
 *
 * All headcount/fraction values are fictional round numbers (public-repo
 * confidentiality).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  PLAN_MECHANICS_VERIFIED_DATE,
  TEAM_SEAT_RANGE,
  ENTERPRISE_MINIMUMS,
  SEAT_PRICING,
  PER_USER_MONTHLY_BENCHMARKS,
  ENTERPRISE_ADDS,
  USAGE_INTENSITY_THRESHOLDS,
  DEFAULT_TIER_MIX,
  DEFAULT_ADOPTION_SCENARIOS,
  MAX_ADOPTION_SCENARIOS,
  staleWarningFor,
  classifyUsageIntensity,
  procurementMotionForSeats,
  sizeSeats,
  SeatSizingError,
  type TierMix,
} from "@claude-stats/core/planMechanics";

const FC_SEED = 424242;

// ─── snapshot constants ──────────────────────────────────────────────────────

describe("plan-mechanics constants", () => {
  it("verified date is the pinned snapshot", () => {
    expect(PLAN_MECHANICS_VERIFIED_DATE).toBe("2026-07-03");
  });

  it("Team seat range is 5–150", () => {
    expect(TEAM_SEAT_RANGE.min).toBe(5);
    expect(TEAM_SEAT_RANGE.max).toBe(150);
  });

  it("Enterprise minimums are 20 (self-serve) / 50 (sales-assisted)", () => {
    expect(ENTERPRISE_MINIMUMS.selfServe).toBe(20);
    expect(ENTERPRISE_MINIMUMS.salesAssisted).toBe(50);
  });

  it("seat prices match the reference (annual/monthly billing)", () => {
    expect(SEAT_PRICING.team_standard.annualBillingMonthly).toBe(20);
    expect(SEAT_PRICING.team_standard.monthlyBillingMonthly).toBe(25);
    expect(SEAT_PRICING.team_premium.annualBillingMonthly).toBe(100);
    expect(SEAT_PRICING.team_premium.monthlyBillingMonthly).toBe(125);
    expect(SEAT_PRICING.enterprise.seatFeeFloorMonthly).toBe(20);
    expect(SEAT_PRICING.enterprise.usageModel).toBe("metered-at-api-rates");
  });

  it("per-user Claude Code benchmarks match the consumption guide", () => {
    expect(PER_USER_MONTHLY_BENCHMARKS.claude_code).toEqual({
      power: 500,
      typical: 215,
      light: 40,
    });
    expect(PER_USER_MONTHLY_BENCHMARKS.cowork).toEqual({ power: 100, typical: 40, light: 10 });
    expect(PER_USER_MONTHLY_BENCHMARKS.chat).toEqual({ power: 90, typical: 30, light: 5 });
  });

  it("lists the six Enterprise-adds facts, each a verified-fact with a source", () => {
    expect(ENTERPRISE_ADDS).toHaveLength(6);
    for (const entry of ENTERPRISE_ADDS) {
      expect(entry.kind).toBe("verified-fact");
      expect(entry.source).toMatch(/^https:\/\//);
      expect(entry.feature.length).toBeGreaterThan(0);
    }
  });
});

// ─── staleWarningFor ─────────────────────────────────────────────────────────

describe("staleWarningFor", () => {
  it("renders the mandated warning with the given date", () => {
    expect(staleWarningFor("2026-07-03")).toBe(
      "cached reference as of 2026-07-03; re-verify at claude.com/pricing before purchasing",
    );
  });

  it("defaults to the module snapshot date", () => {
    expect(staleWarningFor()).toContain(PLAN_MECHANICS_VERIFIED_DATE);
  });

  it("is pure — same input, same output", () => {
    expect(staleWarningFor("2020-01-01")).toBe(staleWarningFor("2020-01-01"));
  });
});

// ─── classifyUsageIntensity ──────────────────────────────────────────────────

describe("classifyUsageIntensity", () => {
  it("derives thresholds as midpoints of the Claude Code benchmarks", () => {
    // (40 + 215) / 2 = 127.5 ; (215 + 500) / 2 = 357.5
    expect(USAGE_INTENSITY_THRESHOLDS.lightToTypical).toBe(127.5);
    expect(USAGE_INTENSITY_THRESHOLDS.typicalToPower).toBe(357.5);
  });

  it("classifies below the first threshold as light", () => {
    expect(classifyUsageIntensity(0).tier).toBe("light");
    expect(classifyUsageIntensity(40).tier).toBe("light");
    expect(classifyUsageIntensity(127.49).tier).toBe("light");
  });

  it("boundary: exactly the light→typical midpoint is typical", () => {
    expect(classifyUsageIntensity(127.5).tier).toBe("typical");
  });

  it("classifies between the thresholds as typical", () => {
    expect(classifyUsageIntensity(215).tier).toBe("typical");
    expect(classifyUsageIntensity(357.49).tier).toBe("typical");
  });

  it("boundary: exactly the typical→power midpoint is power", () => {
    expect(classifyUsageIntensity(357.5).tier).toBe("power");
  });

  it("classifies at/above the second threshold as power", () => {
    expect(classifyUsageIntensity(500).tier).toBe("power");
    expect(classifyUsageIntensity(10_000).tier).toBe("power");
  });

  it("returns the matching benchmark and the fixed source", () => {
    expect(classifyUsageIntensity(10)).toEqual({
      tier: "light",
      benchmarkUsd: 40,
      source: "anthropic-benchmark",
    });
    expect(classifyUsageIntensity(1_000)).toEqual({
      tier: "power",
      benchmarkUsd: 500,
      source: "anthropic-benchmark",
    });
  });
});

// ─── procurementMotionForSeats ───────────────────────────────────────────────

describe("procurementMotionForSeats", () => {
  it("is team-self-serve at and below the 150 ceiling", () => {
    expect(procurementMotionForSeats(5)).toBe("team-self-serve");
    expect(procurementMotionForSeats(149)).toBe("team-self-serve");
    expect(procurementMotionForSeats(150)).toBe("team-self-serve");
  });

  it("is enterprise-sales-assisted above the 150 ceiling", () => {
    expect(procurementMotionForSeats(151)).toBe("enterprise-sales-assisted");
    expect(procurementMotionForSeats(200)).toBe("enterprise-sales-assisted");
  });
});

// ─── sizeSeats: happy path + seat-range boundaries ───────────────────────────

describe("sizeSeats — scenario table", () => {
  it("uses default adoption scenarios and benchmark tier mix", () => {
    const table = sizeSeats({ headcount: 400, technicalFraction: 0.5 });
    expect(table.rows).toHaveLength(DEFAULT_ADOPTION_SCENARIOS.length);
    expect(table.tierMix).toEqual(DEFAULT_TIER_MIX);
    expect(table.tierMixSource).toBe("anthropic-benchmark");
    expect(table.technicalPopulation).toBe(200);
    expect(table.verifiedDate).toBe(PLAN_MECHANICS_VERIFIED_DATE);
    expect(table.staleWarning).toContain("re-verify");
  });

  it("acceptance: headcount 400 × 0.5 → full adoption is 200 seats, Enterprise sales-assisted, Team ceiling exceeded", () => {
    const table = sizeSeats({ headcount: 400, technicalFraction: 0.5 });
    const full = table.rows.find((r) => r.adoptionFraction === 1.0)!;
    expect(full.seats).toBe(200);
    expect(full.fitsTeamRange).toBe(false);
    expect(full.procurementMotion).toBe("enterprise-sales-assisted");
  });

  it("boundary 149/150/151 seats — fitsTeamRange flips at 150", () => {
    // Pick headcount×fraction×adoption to land exactly on each seat count.
    const at149 = sizeSeats({ headcount: 149, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
    const at150 = sizeSeats({ headcount: 150, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
    const at151 = sizeSeats({ headcount: 151, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
    expect([at149.seats, at150.seats, at151.seats]).toEqual([149, 150, 151]);
    expect(at149.fitsTeamRange).toBe(true);
    expect(at150.fitsTeamRange).toBe(true);
    expect(at151.fitsTeamRange).toBe(false);
    expect(at150.procurementMotion).toBe("team-self-serve");
    expect(at151.procurementMotion).toBe("enterprise-sales-assisted");
  });

  it("boundary 19/20 and 49/50 seats fit the Team range (Enterprise minimums are choices, not ceilings)", () => {
    for (const n of [19, 20, 49, 50]) {
      const row = sizeSeats({ headcount: n, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
      expect(row.seats).toBe(n);
      expect(row.fitsTeamRange).toBe(true);
      expect(row.procurementMotion).toBe("team-self-serve");
    }
  });

  it("below the 5-seat Team minimum does not fit the Team range", () => {
    const row = sizeSeats({ headcount: 4, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
    expect(row.seats).toBe(4);
    expect(row.fitsTeamRange).toBe(false);
  });

  it("splits seats into Standard/Premium by the tier mix and labels every figure as an estimate", () => {
    // 100 seats, mix light .5 / typical .4 / power .1 → premium = round(100 × .5) = 50.
    const row = sizeSeats({ headcount: 100, technicalFraction: 1, adoptionScenarios: [1] }).rows[0]!;
    expect(row.seats).toBe(100);
    expect(row.teamPremiumSeats).toBe(50);
    expect(row.teamStandardSeats).toBe(50);
    // Team cost = 50 × 25 + 50 × 125 = 7500.
    expect(row.teamMonthlyCost.value).toBe(7500);
    // Enterprise seat fee = 100 × 20 = 2000.
    expect(row.enterpriseSeatFeeMonthly.value).toBe(2000);
    // Metered per seat = .5×40 + .4×215 + .1×500 = 20 + 86 + 50 = 156 → ×100 = 15600.
    expect(row.enterpriseMeteredMonthly.value).toBeCloseTo(15600, 6);
    expect(row.enterpriseTotalMonthly.value).toBeCloseTo(17600, 6);
    for (const fig of [
      row.teamMonthlyCost,
      row.enterpriseSeatFeeMonthly,
      row.enterpriseMeteredMonthly,
      row.enterpriseTotalMonthly,
    ]) {
      expect(fig.kind).toBe("estimate");
    }
  });

  it("marks a caller-supplied measured mix as 'measured'", () => {
    const table = sizeSeats({
      headcount: 50,
      technicalFraction: 1,
      tierMix: { light: 0.2, typical: 0.5, power: 0.3 },
      tierMixMeasured: true,
    });
    expect(table.tierMixSource).toBe("measured");
    expect(table.tierMix).toEqual({ light: 0.2, typical: 0.5, power: 0.3 });
  });

  it("treats a supplied mix without the measured flag as benchmark-labelled", () => {
    const table = sizeSeats({
      headcount: 50,
      technicalFraction: 1,
      tierMix: { light: 0.2, typical: 0.5, power: 0.3 },
    });
    expect(table.tierMixSource).toBe("anthropic-benchmark");
  });

  it("never returns a plan verdict, and always surfaces open questions", () => {
    const table = sizeSeats({ headcount: 400, technicalFraction: 0.5 });
    expect(table).not.toHaveProperty("recommendedPlan");
    expect(table).not.toHaveProperty("verdict");
    expect(table.openQuestions.length).toBeGreaterThanOrEqual(2);
    expect(table.openQuestions.join(" ")).toMatch(/compliance/i);
    expect(table.openQuestions.join(" ")).toMatch(/spend.limit/i);
  });

  it("accepts exactly the 20-scenario cap", () => {
    const scenarios = Array.from({ length: MAX_ADOPTION_SCENARIOS }, (_, i) => (i + 1) / MAX_ADOPTION_SCENARIOS);
    const table = sizeSeats({ headcount: 100, technicalFraction: 1, adoptionScenarios: scenarios });
    expect(table.rows).toHaveLength(20);
  });
});

// ─── sizeSeats: failure paths ────────────────────────────────────────────────

describe("sizeSeats — validation", () => {
  it("rejects a non-integer headcount", () => {
    expect(() => sizeSeats({ headcount: 10.5, technicalFraction: 0.5 })).toThrowError(SeatSizingError);
    try {
      sizeSeats({ headcount: 10.5, technicalFraction: 0.5 });
    } catch (e) {
      expect((e as SeatSizingError).code).toBe("headcount-invalid");
    }
  });

  it("rejects a headcount below 1", () => {
    expect(() => sizeSeats({ headcount: 0, technicalFraction: 0.5 })).toThrowError(/headcount/);
  });

  it("rejects a technical fraction outside [0, 1]", () => {
    for (const f of [-0.1, 1.1, Number.NaN]) {
      let code: string | undefined;
      try {
        sizeSeats({ headcount: 100, technicalFraction: f });
      } catch (e) {
        code = (e as SeatSizingError).code;
      }
      expect(code).toBe("fraction-invalid");
    }
  });

  it("rejects a tier mix that does not sum to 1", () => {
    let code: string | undefined;
    try {
      sizeSeats({
        headcount: 100,
        technicalFraction: 1,
        tierMix: { light: 0.5, typical: 0.4, power: 0.2 },
      });
    } catch (e) {
      code = (e as SeatSizingError).code;
    }
    expect(code).toBe("tiermix-sum");
  });

  it("rejects a tier-mix component outside [0, 1]", () => {
    let code: string | undefined;
    try {
      sizeSeats({
        headcount: 100,
        technicalFraction: 1,
        tierMix: { light: -0.5, typical: 1.0, power: 0.5 },
      });
    } catch (e) {
      code = (e as SeatSizingError).code;
    }
    expect(code).toBe("tiermix-invalid");
  });

  it("rejects more than 20 adoption scenarios", () => {
    const scenarios = Array.from({ length: 21 }, () => 0.5);
    let code: string | undefined;
    try {
      sizeSeats({ headcount: 100, technicalFraction: 1, adoptionScenarios: scenarios });
    } catch (e) {
      code = (e as SeatSizingError).code;
    }
    expect(code).toBe("too-many-scenarios");
  });

  it("rejects an adoption fraction outside [0, 1]", () => {
    let code: string | undefined;
    try {
      sizeSeats({ headcount: 100, technicalFraction: 1, adoptionScenarios: [0.5, 2] });
    } catch (e) {
      code = (e as SeatSizingError).code;
    }
    expect(code).toBe("adoption-fraction-invalid");
  });

  it("tolerates tiny floating-point drift in the tier-mix sum", () => {
    // 0.1 + 0.2 + 0.7 is not exactly 1 in IEEE-754.
    expect(() =>
      sizeSeats({
        headcount: 100,
        technicalFraction: 1,
        tierMix: { light: 0.1, typical: 0.2, power: 0.7 },
      }),
    ).not.toThrow();
  });
});

// ─── sizeSeats: property-based invariants (fixed seed) ───────────────────────

describe("sizeSeats — properties", () => {
  const validMix = (): fc.Arbitrary<TierMix> =>
    fc
      .tuple(fc.nat({ max: 100 }), fc.nat({ max: 100 }), fc.nat({ max: 100 }))
      .filter(([a, b, c]) => a + b + c > 0)
      .map(([a, b, c]) => {
        const total = a + b + c;
        // Divide each count by the total so every fraction is independently in
        // [0, 1]; the sum lands within sizeSeats' 1e-6 tolerance. (Deriving the
        // last as 1 - light - typical can yield a tiny NEGATIVE via FP rounding,
        // which the [0,1] component check legitimately rejects.)
        const light = a / total;
        const typical = b / total;
        const power = c / total;
        return { light, typical, power };
      });

  it("seats are monotonic non-decreasing in headcount (fixed fraction/adoption)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (a, delta) => {
          const fraction = 0.5;
          const adoption = [1];
          const seatsSmall = sizeSeats({ headcount: a, technicalFraction: fraction, adoptionScenarios: adoption }).rows[0]!.seats;
          const seatsBig = sizeSeats({ headcount: a + delta, technicalFraction: fraction, adoptionScenarios: adoption }).rows[0]!.seats;
          return seatsBig >= seatsSmall;
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it("total Enterprise monthly cost is monotonic non-decreasing in headcount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (a, delta) => {
          const opts = { technicalFraction: 0.5, adoptionScenarios: [1] as const };
          const small = sizeSeats({ headcount: a, ...opts }).rows[0]!.enterpriseTotalMonthly.value;
          const big = sizeSeats({ headcount: a + delta, ...opts }).rows[0]!.enterpriseTotalMonthly.value;
          return big >= small;
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it("output is independent of tierMix key ordering", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3000 }), validMix(), (headcount, mix) => {
        const inOrder = sizeSeats({
          headcount,
          technicalFraction: 0.5,
          tierMix: { light: mix.light, typical: mix.typical, power: mix.power },
        });
        // Same values, keys inserted in a different order.
        const reordered = sizeSeats({
          headcount,
          technicalFraction: 0.5,
          tierMix: { power: mix.power, light: mix.light, typical: mix.typical },
        });
        expect(reordered.rows).toEqual(inOrder.rows);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});
