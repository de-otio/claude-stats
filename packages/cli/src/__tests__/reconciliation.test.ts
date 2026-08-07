import { describe, it, expect } from "vitest";
import {
  computeReconciliation,
  parseCostExplorerCsv,
  formatCsvImportError,
  DEFAULT_RECONCILIATION_TOLERANCE,
} from "@claude-stats/core/reconciliation";

// ─── computeReconciliation ──────────────────────────────────────────────────

describe("computeReconciliation", () => {
  it("returns null when no invoice total is configured", () => {
    expect(computeReconciliation({ bottomUp: 100, invoiceTotal: null })).toBeNull();
    expect(computeReconciliation({ bottomUp: 100, invoiceTotal: undefined })).toBeNull();
    expect(computeReconciliation({ bottomUp: 100, invoiceTotal: 0 })).toBeNull();
    expect(computeReconciliation({ bottomUp: 100, invoiceTotal: -5 })).toBeNull();
    expect(computeReconciliation({ bottomUp: 100, invoiceTotal: NaN })).toBeNull();
  });

  it("returns null when there is no local (bottom-up) spend — the honest-empty state, not a manufactured residual", () => {
    expect(computeReconciliation({ bottomUp: 0, invoiceTotal: 500 })).toBeNull();
    expect(computeReconciliation({ bottomUp: -1, invoiceTotal: 500 })).toBeNull();
  });

  it("reconciles when the ratio is within the default ±5% tolerance", () => {
    const r = computeReconciliation({ bottomUp: 97, invoiceTotal: 100 });
    expect(r).not.toBeNull();
    expect(r!.withinTolerance).toBe(true);
    expect(r!.ratio).toBeCloseTo(0.97);
    expect(r!.tolerancePercent).toBe(5);
    expect(r!.candidateCauses).toEqual([]);
  });

  // The band edge is the value a user tuning `tolerancePercent` is most likely
  // to land on, and it was previously decided by IEEE-754 representation error
  // rather than by the number they configured: `1 - 95/100` is
  // 0.050000000000000044 (edge EXCLUDED from a ±5% band) while `1 - 90/100` is
  // 0.09999999999999998 (same exact edge INCLUDED in a ±10% band). These pin
  // the documented inclusive semantics on both sides and at several scales, so
  // a regression in the comparison cannot pass unnoticed again.
  it("includes the exact band edge — a figure exactly at ±tolerance reconciles", () => {
    for (const [bottomUp, invoiceTotal, tolerance] of [
      [95, 100, 0.05],
      [105, 100, 0.05], // over the invoice, same distance
      [9.5, 10, 0.05],
      [47.5, 50, 0.05],
      [90, 100, 0.1],
      [0.57, 0.6, 0.05], // non-representable in binary: 0.6 - 0.57 !== 0.03
    ] as const) {
      const r = computeReconciliation({ bottomUp, invoiceTotal, tolerance });
      expect(r, `${bottomUp}/${invoiceTotal} @ ${tolerance}`).not.toBeNull();
      expect(r!.withinTolerance, `${bottomUp}/${invoiceTotal} @ ${tolerance} should be at/inside the band`).toBe(true);
    }
  });

  it("excludes a figure just outside the band edge — the band still has a far side", () => {
    for (const [bottomUp, invoiceTotal, tolerance] of [
      [94.9, 100, 0.05],
      [105.1, 100, 0.05],
      [89.9, 100, 0.1],
    ] as const) {
      const r = computeReconciliation({ bottomUp, invoiceTotal, tolerance });
      expect(r!.withinTolerance, `${bottomUp}/${invoiceTotal} @ ${tolerance} should be outside the band`).toBe(false);
    }
  });

  it("does NOT reconcile when the ratio is outside tolerance — can conclude the estimate is wrong", () => {
    const r = computeReconciliation({ bottomUp: 50, invoiceTotal: 100 });
    expect(r).not.toBeNull();
    expect(r!.withinTolerance).toBe(false);
    expect(r!.residual).toBe(50);
    expect(r!.residualRatio).toBeCloseTo(0.5);
  });

  it("respects a configured tolerance", () => {
    const strict = computeReconciliation({ bottomUp: 90, invoiceTotal: 100, tolerance: 0.05 });
    const loose = computeReconciliation({ bottomUp: 90, invoiceTotal: 100, tolerance: 0.15 });
    expect(strict!.withinTolerance).toBe(false);
    expect(loose!.withinTolerance).toBe(true);
  });

  it("defaults tolerance to 5% when not given", () => {
    const r = computeReconciliation({ bottomUp: 94, invoiceTotal: 100 });
    expect(r!.tolerancePercent).toBe(Math.round(DEFAULT_RECONCILIATION_TOLERANCE * 100));
  });

  it("names unpriced-usage as a candidate cause when unknownTokens > 0", () => {
    const r = computeReconciliation({ bottomUp: 50, invoiceTotal: 100, unknownTokens: 5000 });
    expect(r!.candidateCauses).toContain("unpriced-usage");
  });

  it("names fallback-rates as a candidate cause when anyFallbackRates is set", () => {
    const r = computeReconciliation({ bottomUp: 50, invoiceTotal: 100, anyFallbackRates: true });
    expect(r!.candidateCauses).toContain("fallback-rates");
  });

  it("names scope-mismatch when no scopeNote was given — it cannot be ruled out", () => {
    const r = computeReconciliation({ bottomUp: 50, invoiceTotal: 100 });
    expect(r!.candidateCauses).toContain("scope-mismatch");
    expect(r!.scopeNote).toBeNull();
  });

  it("does not name scope-mismatch when a scopeNote was explicitly given", () => {
    const r = computeReconciliation({
      bottomUp: 50,
      invoiceTotal: 100,
      scopeNote: "AWS account 123456789012, Bedrock only",
    });
    expect(r!.candidateCauses).not.toContain("scope-mismatch");
    expect(r!.scopeNote).toBe("AWS account 123456789012, Bedrock only");
  });

  it("falls back to 'unexplained' when withinTolerance is false and no cause applies", () => {
    const r = computeReconciliation({
      bottomUp: 50,
      invoiceTotal: 100,
      scopeNote: "whole org, this month",
      unknownTokens: 0,
      anyFallbackRates: false,
    });
    expect(r!.candidateCauses).toEqual(["unexplained"]);
  });

  it("blank/whitespace-only scopeNote is treated as unset", () => {
    const r = computeReconciliation({ bottomUp: 50, invoiceTotal: 100, scopeNote: "   " });
    expect(r!.scopeNote).toBeNull();
    expect(r!.candidateCauses).toContain("scope-mismatch");
  });

  it("candidate causes list several reasons at once, ordered", () => {
    const r = computeReconciliation({
      bottomUp: 50,
      invoiceTotal: 100,
      unknownTokens: 100,
      anyFallbackRates: true,
    });
    expect(r!.candidateCauses).toEqual(["unpriced-usage", "fallback-rates", "scope-mismatch"]);
  });

  it("MUTATION CHECK: swapping ratio's numerator/denominator would flip the verdict silently", () => {
    // bottomUp 200 vs invoice 100 -> ratio 2.0, clearly not reconciled. A
    // mutant computing invoiceTotal/bottomUp would read 0.5 and could pass
    // some naive "within range" check by coincidence at other values, so this
    // asserts the actual direction.
    const r = computeReconciliation({ bottomUp: 200, invoiceTotal: 100 });
    expect(r!.ratio).toBeCloseTo(2.0);
    expect(r!.withinTolerance).toBe(false);
  });
});

// ─── parseCostExplorerCsv ────────────────────────────────────────────────────

describe("parseCostExplorerCsv", () => {
  it("sums a plain Cost column across data rows", () => {
    const csv = "Service,Cost\nEC2,100.50\nS3,25.25\nBedrock,300.00\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.total).toBeCloseTo(425.75);
      expect(result.value.rowCount).toBe(3);
    }
  });

  it("recognizes UnblendedCost / Amount / 'Total costs ($)' headers case-insensitively", () => {
    for (const header of ["UnblendedCost", "Amount", "Total costs ($)", "AMORTIZEDCOST"]) {
      const csv = `Group,${header}\nA,10\nB,20\n`;
      const result = parseCostExplorerCsv(csv);
      expect(result.ok, `header "${header}" should parse`).toBe(true);
    }
  });

  it("prefers an explicit 'Total' row's own value over re-summing prior rows", () => {
    const csv = "Group,Cost\nEC2,100\nS3,50\nTotal costs,987.65\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.total).toBe(987.65);
      expect(result.value.rowCount).toBe(0);
    }
  });

  it("handles quoted fields and thousands separators", () => {
    const csv = 'Service,Cost\n"Amazon EC2, US East","1,234.56"\n';
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total).toBeCloseTo(1234.56);
  });

  it("handles accounting-style negative numbers in parens", () => {
    const csv = "Service,Cost\nRefund,(12.50)\nEC2,100\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total).toBeCloseTo(87.5);
  });

  it("rejects an empty file with a clear error, not a silent zero", () => {
    const result = parseCostExplorerCsv("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("empty");
      expect(formatCsvImportError(result.error)).toMatch(/empty/i);
    }
  });

  it("rejects a header with no recognizable cost column", () => {
    const csv = "Service,Region\nEC2,us-east-1\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("missing-cost-column");
      expect(formatCsvImportError(result.error)).toContain("Service, Region");
    }
  });

  it("rejects a header row with no data rows", () => {
    const csv = "Service,Cost\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("no-data-rows");
  });

  it("rejects a single unparseable cost cell — never silently drops it from the sum", () => {
    const csv = "Service,Cost\nEC2,100\nS3,N/A\nBedrock,50\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-number");
      if (result.error.kind === "invalid-number") {
        expect(result.error.line).toBe(3);
        expect(result.error.raw).toBe("N/A");
      }
      expect(formatCsvImportError(result.error)).toContain("Line 3");
    }
  });

  it("MUTATION CHECK: a malformed row must fail, not silently sum to less than the real total", () => {
    // If invalid rows were skipped instead of erroring, this csv would sum to
    // 150 instead of failing — a confidently wrong (understated) total,
    // exactly what 04 §4.3 rule 1 forbids ("malformed CSV must produce a
    // clear error, never a silently wrong number").
    const csv = "Service,Cost\nEC2,100\nGarbageRow,not-a-number\nS3,50\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(false);
  });

  it("rejects a header row that is blank/whitespace-only cells", () => {
    const result = parseCostExplorerCsv(",,\nEC2,us-east-1,100\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("no-header");
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    const csv = 'Service,Cost\n"Say ""hi""",42\n';
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total).toBe(42);
  });

  it("formats every error kind to a non-empty, kind-specific message", () => {
    expect(formatCsvImportError({ kind: "no-header" })).toMatch(/header/i);
    expect(formatCsvImportError({ kind: "no-data-rows" })).toMatch(/data rows/i);
  });

  it("ignores blank lines", () => {
    const csv = "Service,Cost\nEC2,100\n\n\nS3,50\n";
    const result = parseCostExplorerCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total).toBeCloseTo(150);
  });
});
