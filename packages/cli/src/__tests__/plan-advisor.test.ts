/**
 * Tests for `plan-advisor.ts` — the covered logic module behind the
 * `plan-advisor` CLI command (`cli/**` is coverage-excluded, so all
 * meaningful assertions live here: flag parsing and report formatting).
 *
 * All headcount/fraction values are fictional round numbers (public-repo
 * confidentiality; plan sec-8): 400, 200, 50.
 */
import { describe, it, expect } from "vitest";
import {
  parseHeadcountFlag,
  parseTechnicalFractionFlag,
  parseTierMixFlag,
  formatPlanAdvisorReport,
  runPlanAdvisor,
} from "../plan-advisor.js";
import { sizeSeats, TEAM_SEAT_RANGE } from "@claude-stats/core/planMechanics";

// ─── parseHeadcountFlag ───────────────────────────────────────────────────────

describe("parseHeadcountFlag", () => {
  it("parses a whole-number string", () => {
    expect(parseHeadcountFlag("400")).toBe(400);
  });

  it("returns NaN for non-numeric input (sizeSeats rejects it downstream)", () => {
    expect(parseHeadcountFlag("nope")).toBeNaN();
  });
});

// ─── parseTechnicalFractionFlag ───────────────────────────────────────────────

describe("parseTechnicalFractionFlag", () => {
  it("passes a bare fraction through unchanged", () => {
    expect(parseTechnicalFractionFlag("0.5")).toBe(0.5);
  });

  it("treats a value > 1 as a percentage", () => {
    expect(parseTechnicalFractionFlag("50")).toBe(0.5);
  });

  it("strips a trailing % before parsing as a percentage", () => {
    expect(parseTechnicalFractionFlag("50%")).toBe(0.5);
  });

  it("treats exactly 1 as a fraction, not 1%", () => {
    expect(parseTechnicalFractionFlag("1")).toBe(1);
  });

  it("returns NaN for non-numeric input", () => {
    expect(parseTechnicalFractionFlag("abc")).toBeNaN();
  });
});

// ─── parseTierMixFlag ─────────────────────────────────────────────────────────

describe("parseTierMixFlag", () => {
  it("parses a comma-separated light,typical,power triple", () => {
    expect(parseTierMixFlag("0.5,0.4,0.1")).toEqual({
      light: 0.5,
      typical: 0.4,
      power: 0.1,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTierMixFlag(" 0.5 , 0.4 , 0.1 ")).toEqual({
      light: 0.5,
      typical: 0.4,
      power: 0.1,
    });
  });

  it("yields NaN for a missing segment (sizeSeats rejects it downstream)", () => {
    const parsed = parseTierMixFlag("0.5,0.4");
    expect(parsed.light).toBe(0.5);
    expect(parsed.typical).toBe(0.4);
    expect(parsed.power).toBeNaN();
  });

  it("yields NaN for a non-numeric segment", () => {
    const parsed = parseTierMixFlag("a,b,c");
    expect(parsed.light).toBeNaN();
    expect(parsed.typical).toBeNaN();
    expect(parsed.power).toBeNaN();
  });
});

// ─── runPlanAdvisor / formatPlanAdvisorReport ────────────────────────────────

describe("runPlanAdvisor", () => {
  it("succeeds with fictional round-number inputs and prints a scenario table", () => {
    const result = runPlanAdvisor({
      headcount: 400,
      technicalFraction: 0.5,
      compliance: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    const text = result.lines.join("\n");
    expect(text).toContain("Seat sizing for a company rollout");
    expect(text).toContain("Headcount 400");
    // technicalPopulation = round(400 * 0.5) = 200
    expect(text).toContain("technical population 200");
  });

  it("flags the Team ceiling exceeded and Enterprise sales-assisted at 200 technical seats (acceptance criterion 4)", () => {
    // headcount 400 * technicalFraction 0.5 = 200 technical population; at
    // 100% adoption that is 200 seats, past the Team 150-seat ceiling.
    const result = runPlanAdvisor({
      headcount: 400,
      technicalFraction: 0.5,
      compliance: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    const text = result.lines.join("\n");
    expect(text).toContain("technical population 200");
    expect(text).toContain("Enterprise sales-assisted");
    expect(text).toContain("Team 150-seat ceiling exceeded");
  });

  it("does not flag the ceiling when every scenario row fits inside the Team range", () => {
    // 50 headcount * 0.5 technical fraction -> 25 technical population; even at
    // 100% adoption (25 seats) that stays within Team's 5-150 range.
    const result = runPlanAdvisor({
      headcount: 50,
      technicalFraction: 0.5,
      compliance: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    const text = result.lines.join("\n");
    expect(text).not.toContain("Team 150-seat ceiling exceeded");
    expect(text).toContain("Team self-serve");
  });

  it("labels the tier mix as the Anthropic benchmark when none is supplied", () => {
    const result = runPlanAdvisor({ headcount: 200, technicalFraction: 0.5, compliance: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.lines.join("\n")).toContain("Anthropic benchmark");
  });

  it("labels the tier mix as measured when tierMixMeasured is set", () => {
    const result = runPlanAdvisor({
      headcount: 200,
      technicalFraction: 0.5,
      tierMix: { light: 0.3, typical: 0.5, power: 0.2 },
      tierMixMeasured: true,
      compliance: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.lines.join("\n")).toContain("measured");
  });

  it("omits the standalone compliance header by default", () => {
    // Note: the compliance trigger is always the first entry in `openQuestions`
    // and is always listed at the bottom either way — `--compliance` is only
    // about surfacing it a second time, prominently, near the top.
    const result = runPlanAdvisor({ headcount: 200, technicalFraction: 0.5, compliance: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.lines).not.toContain("Compliance trigger");
  });

  it("surfaces the compliance open question prominently with --compliance", () => {
    const result = runPlanAdvisor({ headcount: 200, technicalFraction: 0.5, compliance: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.lines).toContain("Compliance trigger");
    expect(result.lines.some((l) => l.includes("does your org handle regulated"))).toBe(true);
  });

  it("--compliance never changes the scenario numbers (no verdict flip)", () => {
    const withCompliance = runPlanAdvisor({
      headcount: 200,
      technicalFraction: 0.5,
      compliance: true,
    });
    const without = runPlanAdvisor({ headcount: 200, technicalFraction: 0.5, compliance: false });
    expect(withCompliance.ok).toBe(true);
    expect(without.ok).toBe(true);
    if (!withCompliance.ok || !without.ok) throw new Error("expected ok results");
    // Strip the two extra compliance lines (the standalone header and its
    // indented question) and blank-line spacing differences around them;
    // every other line (table, costs, open-questions list, footer) must be
    // identical between the two runs.
    const stripCompliance = (lines: readonly string[]): string[] =>
      lines.filter(
        (l) => l !== "" && l !== "Compliance trigger" && !l.startsWith("  Compliance trigger:"),
      );
    expect(stripCompliance(withCompliance.lines).join("\n")).toBe(
      stripCompliance(without.lines).join("\n"),
    );
  });

  it("returns a translated error message and no lines for invalid headcount", () => {
    const result = runPlanAdvisor({ headcount: NaN, technicalFraction: 0.5, compliance: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.message).toBe("Headcount must be a whole number of at least 1.");
  });

  it("returns a translated error message for an invalid technical fraction", () => {
    const result = runPlanAdvisor({ headcount: 400, technicalFraction: 1.5, compliance: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.message).toBe(
      "Technical fraction must be between 0 and 1 (or 0–100%).",
    );
  });

  it("returns a translated error message for a tier mix that does not sum to 1", () => {
    const result = runPlanAdvisor({
      headcount: 400,
      technicalFraction: 0.5,
      tierMix: { light: 0.5, typical: 0.5, power: 0.5 },
      tierMixMeasured: true,
      compliance: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.message).toBe("Tier-mix values must sum to 1 (e.g. 0.5,0.4,0.1).");
  });

  it("returns a translated error message for an out-of-range tier mix component", () => {
    const result = runPlanAdvisor({
      headcount: 400,
      technicalFraction: 0.5,
      tierMix: { light: 1.5, typical: -0.4, power: -0.1 },
      tierMixMeasured: true,
      compliance: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.message).toBe("Each tier-mix value must be between 0 and 1.");
  });
});

// ─── formatPlanAdvisorReport (direct, against a real sizeSeats table) ────────

describe("formatPlanAdvisorReport", () => {
  it("renders one table row per adoption scenario plus a stale-warning footer", () => {
    const table = sizeSeats({ headcount: 400, technicalFraction: 0.5 });
    const lines = formatPlanAdvisorReport(table, false);
    const text = lines.join("\n");
    expect(text).toContain(table.staleWarning);
    for (const row of table.rows) {
      expect(text).toContain(`${row.seats}`);
    }
  });

  it("prints yes/no for fitsTeamRange rather than booleans", () => {
    const table = sizeSeats({ headcount: 50, technicalFraction: 0.2 });
    const lines = formatPlanAdvisorReport(table, false);
    const text = lines.join("\n");
    expect(text).not.toContain("true");
    expect(text).not.toContain("false");
    expect(text).toContain("yes");
  });

  it("flags the ceiling exactly when a row's seats exceed the Team max", () => {
    const table = sizeSeats({
      headcount: 400,
      technicalFraction: 1,
      adoptionScenarios: [1],
    });
    expect(table.rows[0]!.seats).toBeGreaterThan(TEAM_SEAT_RANGE.max);
    const lines = formatPlanAdvisorReport(table, false);
    expect(lines.join("\n")).toContain("Team 150-seat ceiling exceeded");
  });
});
