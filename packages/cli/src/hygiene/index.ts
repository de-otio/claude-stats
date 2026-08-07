/**
 * Efficiency-hygiene — glue between the store and the pure detectors in
 * `@claude-stats/core/hygiene`.
 *
 * Mirrors the shape of `../ticketing/index.ts`: fetches the rows the pure
 * module needs, maps store snake_case to the core camelCase row shape, runs
 * the detectors, and reduces the result to the weekly-digest surface the
 * `get_efficiency_hints` MCP tool and (later) the Insights card render.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 */
import { estimateCost, type RateOverrides } from "@claude-stats/core/pricing";
import {
  runHygieneDetectors,
  buildHygieneDigest,
  type HygieneDigest,
  type HygieneMessageRow,
  type HygieneThresholds,
  type RunHygieneDetectorsOptions,
} from "@claude-stats/core/hygiene";
import type { HygieneMessageStoreRow, Store } from "../store/index.js";

export type { HygieneDigest, HygieneDetectorResult, HygieneFinding, HygieneDetectorId } from "@claude-stats/core/hygiene";

export interface HygieneReportFilters {
  since?: number;
  until?: number;
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Explicit `false` excludes non-interactive (CI) sessions. Mirrors `MessageFilter`. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. Mirrors `MessageFilter`. */
  includeDeleted?: boolean;
  thresholds?: Partial<{ [K in keyof HygieneThresholds]: Partial<HygieneThresholds[K]> }>;
  suppressions?: readonly string[];
  rateOverrides?: RateOverrides;
}

export interface HygieneReport {
  since: number | null;
  until: number | null;
  /** Total equivalent-API cost across the window (the denominator for
   *  `hygieneRatio` — the same "waste as a share of spend" figure
   *  `insight.ts#answerEfficiency` renders). */
  totalCost: number;
  digest: HygieneDigest;
  /** `digest.totalEstimatedWaste / totalCost`, or null when there was no spend
   *  to divide by (never a bare 0 that reads as "no waste" — see I1). */
  hygieneRatio: number | null;
  /** Same ratio over the immediately-preceding window of equal length, for
   *  the trend line ("self-audited waste down from 14% to 6%"). Null when
   *  `since`/`until` weren't both given (nothing to compare against) or the
   *  prior window had no spend. */
  previousHygieneRatio: number | null;
}

function toHygieneMessageRow(row: HygieneMessageStoreRow): HygieneMessageRow {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    uuid: row.uuid,
    timestamp: row.timestamp,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    toolErrorCount: row.tool_error_count,
  };
}

function totalCostOf(rows: readonly HygieneMessageRow[], overrides?: RateOverrides): number {
  let total = 0;
  for (const r of rows) {
    if (!r.model) continue;
    total += estimateCost(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, overrides).cost;
  }
  return total;
}

function runFor(rows: HygieneMessageRow[], opts: HygieneReportFilters): ReturnType<typeof buildHygieneDigest> {
  const runOpts: RunHygieneDetectorsOptions = {
    thresholds: opts.thresholds,
    suppressions: opts.suppressions,
    rateOverrides: opts.rateOverrides,
  };
  return buildHygieneDigest(runHygieneDetectors(rows, runOpts));
}

/**
 * Build the efficiency-hygiene digest for a window. `filters.since`/`until`
 * are passed straight to the store query (undefined means "no bound", i.e.
 * the whole history) — same convention as `getTicketCostReport`.
 */
export function buildHygieneReport(store: Store, filters: HygieneReportFilters = {}): HygieneReport {
  const storeRows = store.getMessagesForHygiene({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    since: filters.since,
    until: filters.until,
    includeCI: filters.includeCI,
    includeDeleted: filters.includeDeleted,
  });
  const rows = storeRows.map(toHygieneMessageRow);
  const totalCost = totalCostOf(rows, filters.rateOverrides);
  const digest = runFor(rows, filters);
  const hygieneRatio = totalCost > 0 ? digest.totalEstimatedWaste / totalCost : null;

  let previousHygieneRatio: number | null = null;
  if (filters.since !== undefined && filters.until !== undefined) {
    const span = filters.until - filters.since;
    if (span > 0) {
      const prevRows = store
        .getMessagesForHygiene({
          projectPath: filters.projectPath,
          repoUrl: filters.repoUrl,
          accountUuid: filters.accountUuid,
          since: filters.since - span,
          until: filters.since,
          includeCI: filters.includeCI,
          includeDeleted: filters.includeDeleted,
        })
        .map(toHygieneMessageRow);
      const prevTotalCost = totalCostOf(prevRows, filters.rateOverrides);
      if (prevTotalCost > 0) {
        const prevDigest = runFor(prevRows, filters);
        previousHygieneRatio = prevDigest.totalEstimatedWaste / prevTotalCost;
      }
    }
  }

  return {
    since: filters.since ?? null,
    until: filters.until ?? null,
    totalCost,
    digest,
    hygieneRatio,
    previousHygieneRatio,
  };
}
