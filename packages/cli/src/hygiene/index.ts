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
import { estimateCost, nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import {
  runHygieneDetectors,
  buildHygieneDigest,
  type HygieneDigest,
  type HygieneMessageRow,
  type HygieneThresholds,
  type RunHygieneDetectorsOptions,
  type TierMismatchClassification,
} from "@claude-stats/core/hygiene";
import type { TaskClass, CoarseTaskClass, Confidence } from "@claude-stats/core/types/insight";
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

// Same guarded parse every `toHygieneMessageRow` mapper carries (context-carry-
// cost B1/review F11): `messages.tools` is a JSON array of `block.name` values
// with no runtime check at write time (`ContentBlock.name` is `name?: string`),
// so a hand-edited JSONL or a synced shard can carry a non-string element or
// malformed JSON. Parsing at the store boundary — not inside the
// pure `hygiene/` detectors — means one bad row degrades to `[]` rather than
// taking down `get_efficiency_hints` for the whole window.
function parseTools(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function toHygieneMessageRow(row: HygieneMessageStoreRow): HygieneMessageRow {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    uuid: row.uuid,
    timestamp: row.timestamp,
    model: row.model,
    // Coerced here, not just at `estimateCost`/`computeTtlFit`'s call sites
    // (review F1): increments, resets, and carry cost SUBTRACT and MULTIPLY
    // these counts, which nothing previously did, so an unvalidated negative
    // or NaN from a hand-edited JSONL or synced shard would otherwise
    // fabricate a reset or an unbounded dollar figure downstream.
    inputTokens: nonNegativeFiniteInt(row.input_tokens),
    outputTokens: nonNegativeFiniteInt(row.output_tokens),
    cacheReadTokens: nonNegativeFiniteInt(row.cache_read_tokens),
    cacheCreationTokens: nonNegativeFiniteInt(row.cache_creation_tokens),
    ephemeral5mCacheTokens: row.ephemeral_5m_cache_tokens,
    ephemeral1hCacheTokens: row.ephemeral_1h_cache_tokens,
    toolErrorCount: row.tool_error_count,
    tools: parseTools(row.tools),
  };
}

// Prices each row at the TTL it was actually written at (its own split),
// exactly like `messageCost`/`sumCost` (`@claude-stats/core/hygiene`) — so
// `totalCost` (the hygieneRatio denominator) and `digest.totalEstimatedWaste`
// (computed via those helpers) price cache writes on the SAME basis. A row
// with both split fields at 0 (pre-column schema) still takes estimateCost's
// rule-2 path, which is byte-identical to rule-1's (see pricing.ts's test),
// so this is not a behavior change for fixtures that predate the split.
function totalCostOf(rows: readonly HygieneMessageRow[], overrides?: RateOverrides): number {
  let total = 0;
  for (const r of rows) {
    if (!r.model) continue;
    total += estimateCost(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, overrides, {
      ephemeral5mCacheTokens: r.ephemeral5mCacheTokens,
      ephemeral1hCacheTokens: r.ephemeral1hCacheTokens,
    }).cost;
  }
  return total;
}

/**
 * Build the sessionId → classification map the tier-mismatch detector needs
 * (D2). One `getTaskClass` lookup per DISTINCT session in the window — bounded
 * by the window's session count, same cost class as the rest of a local
 * report over a machine's own history. A session with no stored row (never
 * classified) is simply absent from the map, which `runHygieneDetectors`
 * treats as "excluded from the comparison", not a guess.
 *
 * Returns `undefined` — not an empty map — when the classifier has NEVER run
 * (`session_task_class` has no rows at all, checked store-wide via
 * `getTaskClassVersions()`, independent of this window). That distinction is
 * what lets `runHygieneDetectors` report tier-mismatch as `computed: false`
 * ("nothing to compare yet") instead of quietly returning zero findings,
 * which would be indistinguishable from "no tier mismatch found" (D2-2).
 * A classifier that HAS run, even if none of ITS rows fall in this window,
 * still returns a (possibly empty) map — that is a real computed result.
 */
function buildTaskClassMap(
  store: Store,
  rows: readonly HygieneMessageRow[],
): ReadonlyMap<string, TierMismatchClassification> | undefined {
  if (store.getTaskClassVersions().length === 0) return undefined;

  const map = new Map<string, TierMismatchClassification>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sessionId)) continue;
    seen.add(r.sessionId);
    const stored = store.getTaskClass(r.sessionId);
    if (!stored) continue;
    map.set(r.sessionId, {
      fine: stored.task_class as TaskClass,
      coarse: stored.coarse_class as CoarseTaskClass,
      confidence: stored.confidence as Confidence,
    });
  }
  return map;
}

function runFor(store: Store, rows: HygieneMessageRow[], opts: HygieneReportFilters): ReturnType<typeof buildHygieneDigest> {
  const runOpts: RunHygieneDetectorsOptions = {
    thresholds: opts.thresholds,
    suppressions: opts.suppressions,
    rateOverrides: opts.rateOverrides,
    taskClassBySession: buildTaskClassMap(store, rows),
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
  const digest = runFor(store, rows, filters);
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
        const prevDigest = runFor(store, prevRows, filters);
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
