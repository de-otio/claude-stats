/**
 * Context carry cost — glue between the store and the pure `computeContextCarry`
 * engine in `@claude-stats/core/contextCarry`.
 *
 * Mirrors the shape of `../ttlFit/index.ts` exactly: fetches the rows the pure
 * module needs (one `getMessagesForHygiene` seek — the same store query
 * `buildHygieneReport`/`computeTtlFitForWindow` use, so a window's context-carry
 * fit, its hygiene digest, and its TTL fit are all computed from the same
 * message set), maps store snake_case to the core camelCase row shape, and
 * hands the result to `computeContextCarry`.
 *
 * Design: `plans/context-carry-cost/plan.md`,
 * `plans/context-carry-cost/IMPLEMENTATION.md` §4/B1. `computeContextCarry`
 * itself is Phase B2's — until that lands this module's own function throws
 * whatever `computeContextCarry` throws (see its stub in
 * `core/src/contextCarry.ts`). The glue here is written and tested against the
 * frozen contract Phase A1 established, independent of B2's completion.
 */
import {
  computeContextCarry,
  type ContextCarryOptions,
  type ContextCarryResult,
} from "@claude-stats/core/contextCarry";
import type { HygieneMessageRow } from "@claude-stats/core/hygiene";
import { nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import type { HygieneMessageStoreRow, Store } from "../store/index.js";

export type { ContextCarryResult, ContextCarryOptions } from "@claude-stats/core/contextCarry";

export interface ContextCarryFilters {
  since?: number;
  until?: number;
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Explicit `false` excludes non-interactive (CI) sessions. Mirrors `MessageFilter`. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. Mirrors `MessageFilter`. */
  includeDeleted?: boolean;
  /** Knobs, passed straight through to `computeContextCarry`. */
  resetDropRatio?: number;
  resetMinBeforeTokens?: number;
  capsTokens?: readonly number[];
  sizeBandEdges?: readonly number[];
  rateOverrides?: RateOverrides;
}

// Same guarded parse every `toHygieneMessageRow` mapper carries
// (context-carry-cost B1/review F11) — this is the FOURTH copy, deliberately
// duplicated rather than shared (see `hygiene/index.ts`, `constraintImpact/
// index.ts`, `ttlFit/index.ts` for the identical shape). `messages.tools` is a
// JSON array of `block.name` values with no runtime check at write time
// (`ContentBlock.name` is `name?: string`), so a hand-edited JSONL or a synced
// shard can carry a non-string element or malformed JSON. Parsing at the store
// boundary means one bad row degrades to `[]` rather than taking down the
// whole window's fit.
function parseTools(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

// Same mapping the other three store-glue modules carry — each keeps its own
// copy rather than importing another module's private function.
function toHygieneMessageRow(row: HygieneMessageStoreRow): HygieneMessageRow {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    uuid: row.uuid,
    timestamp: row.timestamp,
    model: row.model,
    // Coerced here (review F1): `computeContextCarry` SUBTRACTS these across
    // consecutive turns (increments) and MULTIPLIES them by a remaining-request
    // count (carry cost) — operations nothing before this build performed on
    // these columns — so an unvalidated negative or NaN from a hand-edited
    // JSONL or a synced shard would otherwise fabricate a reset or an
    // unbounded dollar figure that reaches the justification pack.
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
 * Compute the context-carry fit over a window. Pure store-query + mapping
 * glue; `computeContextCarry` (Phase B2) does all of the actual arithmetic.
 *
 * `filters.since`/`until` are passed straight to the store query — same
 * convention as `computeTtlFitForWindow`/`buildHygieneReport` (undefined means
 * "no bound", i.e. the whole history).
 */
export function computeContextCarryForWindow(store: Store, filters: ContextCarryFilters = {}): ContextCarryResult {
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

  const options: ContextCarryOptions = {
    resetDropRatio: filters.resetDropRatio,
    resetMinBeforeTokens: filters.resetMinBeforeTokens,
    capsTokens: filters.capsTokens,
    sizeBandEdges: filters.sizeBandEdges,
    rateOverrides: filters.rateOverrides,
  };
  return computeContextCarry(rows, options);
}
