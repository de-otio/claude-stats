/**
 * Cost-basis disclosure and the unpriced-model surface.
 *
 * Two facts qualify every cost total this tool prints after schema V23, and
 * both would otherwise be invisible:
 *
 *  1. **`cost_basis`.** Rows written before the usage-carrier fix carry
 *     `'pre-dedupe'` — one API response counted once per content block, ~2x
 *     on average. A total over a window that includes such rows is inflated
 *     by an amount nobody can compute (the ratio differs per token class, see
 *     `doc/analysis/cost-correctness-2026-09/04-scope.md` §4.3), so the only
 *     honest move is to SAY the window includes them. `cost_basis` is a closed
 *     machine token and is rendered unlocalised in machine fields; only the
 *     human label goes through i18n.
 *
 *  2. **Unpriced rows.** `estimateCost` now REFUSES a rate for a point-release
 *     model id rather than inheriting its predecessor's row, and returns
 *     `{cost: 0, known: false}`. Fifteen of nineteen call sites add `cost`
 *     straight into a total, so without a caveat the refusal converts a
 *     visible over-charge into an invisible under-charge. The module-side
 *     accumulator (`getPricingDriftFindings`) explains WHY a row was refused;
 *     `known: false` on the estimate says THAT it was.
 *
 * Everything here is pure over its inputs except `countCostBasis`, which reads
 * the store, and `collectPricingDrift`, which resets the module-side drift
 * accumulator so the findings belong to the pass that called it.
 */
import type { PricingDriftFinding, RateOverrides } from "@claude-stats/core/pricing";
import {
  clearPricingDriftFindings,
  estimateCost,
  getPricingDriftFindings,
} from "@claude-stats/core/pricing";
import type { CostBasis } from "@claude-stats/core/types";
import type { MessageFilter, MessageTotalRow, Store } from "../store/index.js";

// ─── cost basis ──────────────────────────────────────────────────────────────

/** Row counts per basis, over the rows that CONTRIBUTE to a cost total. */
export interface CostBasisCounts {
  /** Counted rows still carrying the pre-fix, per-entry usage. */
  preDedupeRows: number;
  /** Counted rows written (or repaired) under the carrier model. */
  perResponseRows: number;
}

/**
 * The verdict for a window, as a closed token. `"mixed"` is the common case
 * on a machine that upgraded mid-history: repaired and unrepairable sessions
 * sit side by side in every all-time view.
 */
export type CostBasisVerdict = CostBasis | "mixed" | "empty";

export interface CostBasisSummary extends CostBasisCounts {
  basis: CostBasisVerdict;
  /** `preDedupeRows / (preDedupeRows + perResponseRows)`, 0 when empty. */
  preDedupeShare: number;
}

export function summarizeCostBasis(counts: CostBasisCounts): CostBasisSummary {
  const total = counts.preDedupeRows + counts.perResponseRows;
  const basis: CostBasisVerdict =
    total === 0
      ? "empty"
      : counts.preDedupeRows === 0
        ? "per-response"
        : counts.perResponseRows === 0
          ? "pre-dedupe"
          : "mixed";
  return {
    preDedupeRows: counts.preDedupeRows,
    perResponseRows: counts.perResponseRows,
    basis,
    preDedupeShare: total === 0 ? 0 : counts.preDedupeRows / total,
  };
}

/** The subset of a `messages` row this module reads. */
export interface CostBasisRow {
  cost_basis?: string;
  usage_counted?: number;
  timestamp?: number | null;
}

/**
 * Count rows by basis, over the rows that contribute to a cost total.
 *
 * Non-carriers (`usage_counted = 0`) are skipped: their token columns are
 * zero by construction, so they contribute nothing to any total and their
 * label qualifies nothing. Every pre-V23 row reads back as counted, so the
 * inflated rows are never skipped by this rule.
 *
 * `range` applies the store's own message-timestamp predicate
 * (`m.timestamp >= since AND m.timestamp < until`); a NULL timestamp fails
 * either bound, exactly as it does in SQL.
 */
export function countCostBasisRows(
  rows: Iterable<CostBasisRow>,
  range: { since?: number; until?: number } = {},
): CostBasisCounts {
  const counts: CostBasisCounts = { preDedupeRows: 0, perResponseRows: 0 };
  for (const r of rows) {
    if (r.usage_counted === 0) continue;
    if (range.since !== undefined && !(r.timestamp != null && r.timestamp >= range.since)) continue;
    if (range.until !== undefined && !(r.timestamp != null && r.timestamp < range.until)) continue;
    // Anything that is not the vouched-for token is treated as the
    // pessimistic one: an unknown label is exactly the "nobody vouched for
    // this row" case the column default exists for.
    if (r.cost_basis === "per-response") counts.perResponseRows++;
    else counts.preDedupeRows++;
  }
  return counts;
}

/**
 * Cost-basis counts for a filtered window, read through the store.
 *
 * Reads every message row of every in-window session and counts in process.
 * The store exposes no `cost_basis` aggregate, and the store is not this
 * module's to extend. The right implementation is ONE SQL aggregate over the
 * same `messageWhereExists` predicate every other message-scoped read uses —
 * `SELECT cost_basis, COUNT(*) FROM messages m WHERE usage_counted = 1 AND
 * <filter> GROUP BY cost_basis` — and this function should become a one-line
 * delegation to it. Until then it is correct but O(rows in window), which is
 * acceptable for a CLI report and heavy for a dashboard refresh over 'all'.
 */
export function countCostBasis(store: Store, filters: MessageFilter = {}): CostBasisCounts {
  // One SQL aggregate over the same filter builder the totals use. This runs on
  // every dashboard build and every `get_stats`/`get_status` call, so walking
  // `getSessionMessages` per session (the first draft) was seconds per refresh
  // on a large database.
  return store.getCostBasisCounts(filters);
}

/** Convenience: the full summary for a filtered window. */
export function costBasisFor(store: Store, filters: MessageFilter = {}): CostBasisSummary {
  return summarizeCostBasis(countCostBasis(store, filters));
}

/** Translator shape shared by the CLI (`t`) and the template (`TranslateFn`). */
export type BasisTranslate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The human label for a window's basis, or `null` when the window is clean
 * (all `per-response`) or empty — a clean window needs no caveat, and printing
 * one would train readers to ignore it.
 *
 * Keys live under `cli:costBasis.*`; the dashboard bundle mirrors them under
 * `dashboard:costBasis.*` because the two hosts load different namespaces.
 */
export function costBasisLabel(
  summary: CostBasisSummary,
  t: BasisTranslate,
  ns: "cli" | "dashboard" = "cli",
): string | null {
  if (summary.basis === "per-response" || summary.basis === "empty") return null;
  const percent = Math.round(summary.preDedupeShare * 100);
  return summary.basis === "pre-dedupe"
    ? t(`${ns}:costBasis.allPreDedupe`, { rows: summary.preDedupeRows })
    : t(`${ns}:costBasis.mixed`, {
        rows: summary.preDedupeRows,
        total: summary.preDedupeRows + summary.perResponseRows,
        percent,
      });
}

// ─── unpriced models / pricing drift ─────────────────────────────────────────

/** A model id that resolved to no rate in this pass, with its token volume. */
export interface UnpricedModel {
  model: string;
  tokens: number;
}

export interface PricingDriftReport {
  /** Model ids `estimateCost` returned `known: false` for, most tokens first. */
  unpricedModels: UnpricedModel[];
  /** Σ tokens across `unpricedModels` — the volume the cost total excludes. */
  unpricedTokens: number;
  /**
   * The refusals with a cause: ids that prefix-matched a rate row and were
   * refused it by the suffix-shape rule. A subset of `unpricedModels` by id
   * (an id nobody has a row for at all is unpriced but not drift).
   */
  findings: PricingDriftFinding[];
}

const EMPTY_DRIFT: PricingDriftReport = { unpricedModels: [], unpricedTokens: 0, findings: [] };

/**
 * Price a set of per-model totals for the sole purpose of learning which of
 * them CANNOT be priced.
 *
 * Clears the module-side drift accumulator first, so the findings describe
 * this pass and not whatever a previous tool call in the same long-lived
 * process (the MCP server, the VS Code extension) happened to price. Callers
 * that also add up the costs do it on their own read — the `estimateCost`
 * calls here are for the `known` flag only.
 */
export function collectPricingDrift(
  totals: readonly MessageTotalRow[],
  overrides?: RateOverrides,
): PricingDriftReport {
  clearPricingDriftFindings();
  const unpriced = new Map<string, number>();
  for (const mt of totals) {
    const r = estimateCost(
      mt.model,
      mt.input_tokens,
      mt.output_tokens,
      mt.cache_read_tokens,
      mt.cache_creation_tokens,
      overrides,
      { ephemeral5mCacheTokens: mt.ephemeral_5m_cache_tokens, ephemeral1hCacheTokens: mt.ephemeral_1h_cache_tokens },
    );
    if (r.known) continue;
    const tokens = mt.input_tokens + mt.output_tokens + mt.cache_read_tokens + mt.cache_creation_tokens;
    unpriced.set(mt.model, (unpriced.get(mt.model) ?? 0) + tokens);
  }
  if (unpriced.size === 0 && getPricingDriftFindings().length === 0) return EMPTY_DRIFT;
  const unpricedModels = [...unpriced.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return {
    unpricedModels,
    unpricedTokens: unpricedModels.reduce((n, m) => n + m.tokens, 0),
    findings: getPricingDriftFindings(),
  };
}

/** The drift report for a filtered window, read through the store. */
export function pricingDriftFor(store: Store, filters: MessageFilter = {}): PricingDriftReport {
  return collectPricingDrift(store.getMessageTotals(filters));
}

/** True when there is anything to say. */
export function hasPricingDrift(report: PricingDriftReport): boolean {
  return report.unpricedModels.length > 0 || report.findings.length > 0;
}

/**
 * The one-line caveat that accompanies a cost total: "N model ids unpriced
 * (X tokens excluded): a, b". `null` when every row priced.
 */
export function unpricedCaveat(
  report: PricingDriftReport,
  t: BasisTranslate,
  formatTokens: (n: number) => string,
  ns: "cli" | "dashboard" = "cli",
): string | null {
  if (report.unpricedModels.length === 0) return null;
  return t(`${ns}:pricingDrift.unpricedCaveat`, {
    count: report.unpricedModels.length,
    tokens: formatTokens(report.unpricedTokens),
    models: report.unpricedModels.map((m) => m.model).join(", "),
  });
}

/**
 * One line per drift finding, for `diagnose` / `status`. The finding's
 * `reason` and `table` are closed tokens and are printed as-is; only the
 * sentence around them is localised.
 */
export function renderPricingDriftLines(report: PricingDriftReport, t: BasisTranslate): string[] {
  const lines: string[] = [];
  for (const m of report.unpricedModels) {
    lines.push(t("cli:pricingDrift.unpricedModel", { model: m.model, tokens: m.tokens }));
  }
  for (const f of report.findings) {
    lines.push(
      t("cli:pricingDrift.finding", {
        model: f.modelId,
        matchedKey: f.matchedKey,
        reason: f.reason,
        table: f.table,
      }),
    );
  }
  return lines;
}
