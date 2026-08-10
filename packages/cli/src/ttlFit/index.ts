/**
 * Cache-TTL fit — glue between the store and the pure `computeTtlFit` engine
 * in `@claude-stats/core/ttlFit`.
 *
 * Mirrors the shape of `../hygiene/index.ts` and `../ticketing/index.ts`:
 * fetches the rows the pure module needs (one `getMessagesForHygiene` seek —
 * the same store query `buildHygieneReport` uses, so a window's TTL fit and
 * its hygiene digest are computed from the same message set), maps store
 * snake_case to the core camelCase row shape, and hands the result to
 * `computeTtlFit`.
 *
 * Design: `plans/cache-ttl-fit/plan.md`, `plans/cache-ttl-fit/IMPLEMENTATION.md`
 * §3/B1. `computeTtlFit` itself is Phase B2's — until that lands this module's
 * own function throws whatever `computeTtlFit` throws (see its stub in
 * `core/src/ttlFit.ts`). The glue here is written and tested against the
 * frozen contract Phase A2 established, independent of B2's completion.
 */
import {
  computeTtlFit,
  type TtlFitOptions,
  type TtlFitResult,
} from "@claude-stats/core/ttlFit";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";
import { nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import type { HygieneMessageStoreRow, Store } from "../store/index.js";

export type { TtlFitResult, TtlFitOptions } from "@claude-stats/core/ttlFit";

export interface TtlFitFilters {
  since?: number;
  until?: number;
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Explicit `false` excludes non-interactive (CI) sessions. Mirrors `MessageFilter`. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. Mirrors `MessageFilter`. */
  includeDeleted?: boolean;
  /** Gap-bucket knobs, passed straight through to `computeTtlFit`. */
  shortTtlMs?: number;
  longTtlMs?: number;
  rateOverrides?: RateOverrides;
}

// Same guarded parse every `toHygieneMessageRow` mapper carries (context-carry-
// cost B1/review F11, C-2 — this is the THIRD copy of the mapper, deliberately
// duplicated rather than shared): `messages.tools` is a JSON array of
// `block.name` values with no runtime check at write time (`ContentBlock.name`
// is `name?: string`), so a hand-edited JSONL or a synced shard can carry a
// non-string element or malformed JSON. Parsing at the store boundary means one
// bad row degrades to `[]` rather than taking down the whole window's fit.
function parseTools(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

// Same mapping `hygiene/index.ts` and `constraintImpact/index.ts` carry —
// each store-glue module keeps its own copy rather than importing another
// module's private function (see those two files for the identical shape).
function toHygieneMessageRow(row: HygieneMessageStoreRow): HygieneMessageRow {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    uuid: row.uuid,
    timestamp: row.timestamp,
    model: row.model,
    // Coerced here (review F1) — `computeTtlFit` also coerces the ephemeral
    // pair internally, but nothing previously validated these four before this
    // build; the fit's cost arithmetic multiplies and subtracts them.
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

/**
 * Compute the cache-TTL fit over a window. Pure store-query + mapping glue;
 * `computeTtlFit` (Phase B2) does all of the actual arithmetic.
 *
 * `filters.since`/`until` are passed straight to the store query — same
 * convention as `buildHygieneReport`/`getTicketCostReport` (undefined means
 * "no bound", i.e. the whole history).
 */
export function computeTtlFitForWindow(store: Store, filters: TtlFitFilters = {}): TtlFitResult {
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

  const options: TtlFitOptions = {
    shortTtlMs: filters.shortTtlMs,
    longTtlMs: filters.longTtlMs,
    rateOverrides: filters.rateOverrides,
  };
  return computeTtlFit(rows, options);
}
