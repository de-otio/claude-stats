/**
 * Invoice reconciliation — pure model builder + a defensive Cost Explorer CSV
 * importer.
 *
 * Design: doc/analysis/ticket-attribution/04-reporting-and-roi.md §4.3,
 *         doc/analysis/constraint-impact/04-pricing-model-comparison.md.
 *
 * Why this exists (I1): every cost figure claude-stats produces is estimated
 * from token counts and a rate table. `costCaveat` already accepts a
 * `reconciledRatio`, and nothing computed one until this module — the caveat
 * was wired and starved. `computeReconciliation` is that integration point,
 * and it is deliberately able to conclude the estimates are WRONG: a
 * reconciliation feature that can only ever confirm its own numbers is
 * theatre, not evidence.
 *
 * No I/O here — `parseCostExplorerCsv` takes a string the caller already
 * read, and `computeReconciliation` takes numbers the caller already
 * gathered. Both are frozen-clock-safe by construction (neither touches the
 * clock at all).
 */

import type { Reconciliation, ReconciliationCause } from "./types/insight.js";

export const DEFAULT_RECONCILIATION_TOLERANCE = 0.05;

/**
 * Relative slack on the tolerance-band comparison, to absorb binary
 * floating-point representation error in the residual and the band (neither
 * `0.6 - 0.57` nor `0.05 * 0.6` is exact in IEEE-754). One part in a billion
 * is far below any figure a currency amount can express, so it cannot change
 * a verdict a user could otherwise observe — it only stops the band edge from
 * landing on whichever side the representation error happens to fall.
 */
const BAND_EDGE_EPSILON = 1e-9;

export interface ReconciliationInput {
  /** The store's own bottom-up figure for the same period/scope. */
  bottomUp: number;
  /** The imported top-down figure — a Cost Explorer CSV total or a plain
   *  configured number. Must be > 0; anything else means "not configured". */
  invoiceTotal: number | null | undefined;
  /** Fraction, e.g. 0.05 for ±5%. Defaults to {@link DEFAULT_RECONCILIATION_TOLERANCE}. */
  tolerance?: number;
  /** `TicketCostReport.unknownTokens` for the same window — unpriced usage is
   *  a named candidate cause for a residual (04 §4.3 rule 3). */
  unknownTokens?: number;
  /** `TicketCostReport.anyFallbackRates` for the same window — partner-rate
   *  fallback is a named candidate cause for a residual. */
  anyFallbackRates?: boolean;
  /** The user's own description of what the invoice covers (account, date
   *  range, tag/profile mapping). Passed straight through to the result and
   *  rendered wherever reconciliation appears — an unstated scope is neither
   *  proof of nor an excuse for a mismatch, so it stays a visible fact rather
   *  than a hidden assumption either way. */
  scopeNote?: string | null;
}

/**
 * Compare a bottom-up figure against an imported invoice total. Returns null
 * when there is nothing to reconcile against (`invoiceTotal` absent, non-
 * finite, or not positive) — the honest "not configured" state, never a
 * fabricated 100%.
 *
 * Can and does conclude "does not reconcile": `withinTolerance` is computed
 * from the actual ratio, not assumed true. When it is false, `candidateCauses`
 * names what could explain the gap from what THIS call was told — an empty
 * `unknownTokens`/`anyFallbackRates`/`scopeNote` still yields `"unexplained"`
 * rather than silently omitting a cause list, so "does not reconcile" is
 * always paired with either a lead or an honest admission that none is known.
 */
export function computeReconciliation(input: ReconciliationInput): Reconciliation | null {
  const { invoiceTotal } = input;
  if (invoiceTotal == null || !Number.isFinite(invoiceTotal) || invoiceTotal <= 0) return null;
  if (!Number.isFinite(input.bottomUp) || input.bottomUp <= 0) return null;
  // A zero (or negative) bottom-up figure means this period has no local
  // record at all — the same honest-empty state `answerCost` gives a period
  // with no usage, not a reconciliation failure. A configured invoice total
  // is not itself period-scoped (it is the figure for whichever period the
  // caller is currently generating), so comparing it against an unrelated
  // empty period would manufacture a residual out of a scope mismatch this
  // function has no way to detect, rather than a genuine estimate error.

  const tolerance = input.tolerance ?? DEFAULT_RECONCILIATION_TOLERANCE;
  const ratio = input.bottomUp / invoiceTotal;
  const residual = invoiceTotal - input.bottomUp;
  const residualRatio = residual / invoiceTotal;
  // Compare the residual against the tolerance band IN CURRENCY rather than
  // `|1 - ratio|` against the fraction. The two are the same predicate in
  // exact arithmetic, but dividing first and then subtracting from 1 loses
  // precision exactly at the band edge: `1 - 95/100` evaluates to
  // 0.050000000000000044, which is NOT <= 0.05, so a bottom-up figure exactly
  // 5.00% under the invoice fell OUTSIDE a configured ±5% tolerance — the one
  // case the inclusive `<=` exists to include. Worse, it was inconsistent:
  // `1 - 90/100` is 0.09999999999999998, so the same exact-edge input landed
  // INSIDE a ±10% band. Which side of a user's configured boundary a figure
  // fell on was decided by binary representation, not by the number they
  // typed. Deriving it from the `residual` this function already computes
  // also means the verdict and the rendered residual can never disagree.
  const withinTolerance = Math.abs(residual) <= tolerance * invoiceTotal * (1 + BAND_EDGE_EPSILON);
  const scopeNote = input.scopeNote && input.scopeNote.trim().length > 0 ? input.scopeNote.trim() : null;

  const candidateCauses: ReconciliationCause[] = [];
  if (!withinTolerance) {
    if ((input.unknownTokens ?? 0) > 0) candidateCauses.push("unpriced-usage");
    if (input.anyFallbackRates) candidateCauses.push("fallback-rates");
    // The scope was never stated, so a mismatch between what the invoice
    // covers and what the local store covers cannot be ruled out — naming it
    // is more honest than letting an unstated assumption go unmentioned.
    if (!scopeNote) candidateCauses.push("scope-mismatch");
    if (candidateCauses.length === 0) candidateCauses.push("unexplained");
  }

  return {
    bottomUp: input.bottomUp,
    invoiceTotal,
    ratio,
    withinTolerance,
    tolerancePercent: Math.round(tolerance * 100),
    residual,
    residualRatio,
    candidateCauses,
    scopeNote,
  };
}

// ─── Cost Explorer CSV import ──────────────────────────────────────────────────

export interface CostImportValue {
  total: number;
  /** Number of data rows summed (0 when a "Total…" row was used directly). */
  rowCount: number;
}

export type CsvImportError =
  | { kind: "empty" }
  | { kind: "no-header" }
  | { kind: "missing-cost-column"; header: readonly string[] }
  | { kind: "invalid-number"; line: number; column: string; raw: string }
  | { kind: "no-data-rows" };

export type CsvImportResult =
  | { ok: true; value: CostImportValue }
  | { ok: false; error: CsvImportError };

/** Human-readable message for a {@link CsvImportError} — used by the CLI so a
 *  malformed import fails with a clear reason, never a silently wrong number. */
export function formatCsvImportError(error: CsvImportError): string {
  switch (error.kind) {
    case "empty":
      return "The file is empty.";
    case "no-header":
      return "The file has no header row.";
    case "missing-cost-column":
      return (
        `No cost/amount column found. Header was: ${error.header.join(", ") || "(none)"}. ` +
        `Expected one of: Cost, Amount, UnblendedCost, AmortizedCost, "Total costs ($)".`
      );
    case "invalid-number":
      return `Line ${error.line}: "${error.column}" column value "${error.raw}" is not a number.`;
    case "no-data-rows":
      return "The file has a header row but no data rows.";
  }
}

// Column names Cost Explorer's console "Download CSV" and Cost & Usage Report
// exports use across their various group-by shapes. Matched case-insensitively
// against the whole header cell, most-specific first so a report that HAS a
// "Total costs ($)" summary column prefers it over a same-file generic "Cost".
const COST_COLUMN_PATTERNS: readonly RegExp[] = [
  /^total\s*costs?\s*\(\$\)$/i,
  /^total\s*cost$/i,
  /^unblended\s*cost$/i,
  /^amortized\s*cost$/i,
  /^net\s*(unblended\s*)?cost$/i,
  /^cost\s*\(\$\)$/i,
  /^cost$/i,
  /^amount$/i,
];

/** Minimal RFC4180 line splitter: quoted fields, `""` escapes an embedded
 *  quote, commas inside quotes are not field separators. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

/** `"$1,234.56"` / `"1234.56"` / `"(1234.56)"` (accounting negatives) → number,
 *  or null when the cell is not a recognizable number. */
function parseMoneyCell(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/^\(|\)$/g, "").replace(/^\$/, "").replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Parse an AWS Cost Explorer CSV export (or a Cost & Usage Report with an
 * equivalent cost column) into a single total for the period it covers.
 *
 * Defensive by construction (04 §4.3 rule 1 — "the top-down figure is
 * imported, never fetched"; nothing here makes a network call, and nothing
 * here guesses past an unrecognizable cell):
 *  - No header, no cost column, or no data rows → a typed error, never a
 *    silent 0 or NaN.
 *  - Any data-row cell in the cost column that isn't a parseable number is a
 *    hard error naming the line — a single corrupt export row must not
 *    silently drop out of the sum and understate the invoice.
 *  - When a row's first cell reads "Total…" (the summary row Cost Explorer's
 *    console export appends), that row's own cost-column value is used
 *    directly as the total rather than re-summing — the export's own total is
 *    authoritative over a re-derived one, and using both would double count
 *    if the export already nests groups under it.
 */
export function parseCostExplorerCsv(csv: string): CsvImportResult {
  const lines = csv.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { ok: false, error: { kind: "empty" } };

  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  if (header.length === 0 || header.every((h) => h === "")) {
    return { ok: false, error: { kind: "no-header" } };
  }

  let costIdx = -1;
  for (const pattern of COST_COLUMN_PATTERNS) {
    const idx = header.findIndex((h) => pattern.test(h));
    if (idx >= 0) {
      costIdx = idx;
      break;
    }
  }
  if (costIdx === -1) return { ok: false, error: { kind: "missing-cost-column", header } };
  const columnName = header[costIdx]!;

  let sum = 0;
  let rowCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const first = (cells[0] ?? "").trim();
    const raw = cells[costIdx] ?? "";
    const isTotalRow = /^total\b/i.test(first);
    const n = parseMoneyCell(raw);
    if (n === null) {
      return { ok: false, error: { kind: "invalid-number", line: i + 1, column: columnName, raw } };
    }
    if (isTotalRow) {
      return { ok: true, value: { total: n, rowCount: 0 } };
    }
    sum += n;
    rowCount += 1;
  }

  if (rowCount === 0) return { ok: false, error: { kind: "no-data-rows" } };
  return { ok: true, value: { total: sum, rowCount } };
}
