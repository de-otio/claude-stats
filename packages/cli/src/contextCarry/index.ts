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
import { computeAutoCompactFit, type AutoCompactFitResult } from "@claude-stats/core/autoCompactFit";
import { totalContext, type HygieneMessageRow } from "@claude-stats/core/hygiene";
import { nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import type { HygieneMessageStoreRow, Store } from "../store/index.js";

export type { ContextCarryResult, ContextCarryOptions } from "@claude-stats/core/contextCarry";
export type { AutoCompactFitResult } from "@claude-stats/core/autoCompactFit";

/**
 * D13 (`plans/autocompact-window-fit/IMPLEMENTATION.md` §0/C5, §4/B1) — the
 * primary `ContextCarryResult`, with the auto-compact window fit ATTACHED
 * under `autoCompactFit`. The primary result's own fields are byte-identical
 * to what `computeContextCarry` alone would have produced (same rows, same
 * options) — nothing above this glue moves. `autoCompactFit` is computed from
 * a SECOND, adaptive-floor pass (`computeAdaptiveResetFloor` below) that
 * exists only to feed `computeAutoCompactFit`; that second pass's own
 * `ContextCarryResult` is discarded once the fit is computed; only the
 * primary carries forward.
 */
export interface ContextCarryWithFit extends ContextCarryResult {
  autoCompactFit: AutoCompactFitResult;
}

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
 * `hygiene/util.ts`'s `DEFAULT_RESET_MIN_BEFORE_TOKENS` is module-private
 * there and cannot be imported. Duplicated deliberately — this is the THIRD
 * copy (`autoCompactFit.ts`'s `DEFAULT_RESET_FLOOR_TOKENS` is the second) —
 * and used only as the ceiling term of the adaptive-floor formula below, per
 * `IMPLEMENTATION.md` §0/C5: `min(DEFAULT_RESET_MIN_BEFORE_TOKENS, 0.5 ×
 * p95(...))`. A drift between the copies changes where the adaptive floor
 * caps out, never an arithmetic identity — same reasoning `autoCompactFit.ts`
 * gives for its own copy.
 */
const DEFAULT_RESET_FLOOR_TOKENS = 150_000;

/**
 * The adaptive floor never reaches 0 (§0/C5: "clamped to a stated minimum").
 * Chosen conservatively — well below any realistic post-reset floor, but high
 * enough that `detectResets` isn't tripped by ordinary per-turn token noise
 * (a few hundred to a few thousand tokens of tool output) being misread as a
 * qualifying "before" context. Recorded in `assumptions.md` as an explicit
 * ambiguity resolution: the plan states the clamp must exist, not its value.
 */
const MIN_RESET_FLOOR_TOKENS = 20_000;

/**
 * D13 (§0/C5) — the reset-detection floor used ONLY by the auto-compact fit's
 * second `computeContextCarry` pass, derived from the ROW DISTRIBUTION
 * already fetched for the primary pass (never from `sawtooth.peakTokens`,
 * which comes from the DEFAULT-floor run and is `null` in exactly the case
 * this exists to fix — a developer who follows this tool's advice down to a
 * small window stops producing contexts above the default 150K floor).
 *
 * `min(DEFAULT_RESET_FLOOR_TOKENS, 0.5 × p95(totalContext over rows))`,
 * clamped to `MIN_RESET_FLOOR_TOKENS` so it can never reach (or go below) a
 * floor that would make every turn look like a post-reset baseline.
 */
function computeAdaptiveResetFloor(rows: readonly HygieneMessageRow[]): number {
  const contexts = rows.map(totalContext).filter((c) => Number.isFinite(c));
  const p95 = percentile95(contexts);
  const candidate = p95 === null ? DEFAULT_RESET_FLOOR_TOKENS : Math.min(DEFAULT_RESET_FLOOR_TOKENS, 0.5 * p95);
  return Math.max(MIN_RESET_FLOOR_TOKENS, candidate);
}

/** 95th percentile via nearest-rank on a sorted copy; `null` on an empty
 *  sample. Not interpolated — the adaptive floor only needs an order-of-
 *  magnitude ceiling, not a precise statistic. */
function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Compute the context-carry fit over a window. Pure store-query + mapping
 * glue; `computeContextCarry` (Phase B2) does all of the actual arithmetic.
 *
 * `filters.since`/`until` are passed straight to the store query — same
 * convention as `computeTtlFitForWindow`/`buildHygieneReport` (undefined means
 * "no bound", i.e. the whole history).
 *
 * D13 — runs a SECOND `computeContextCarry` pass over the SAME rows (no extra
 * store query), at an adaptive reset floor (`computeAdaptiveResetFloor`), and
 * attaches `computeAutoCompactFit`'s result under `autoCompactFit`. The
 * PRIMARY `ContextCarryResult` — everything but `autoCompactFit` on the
 * returned object — is computed exactly as before and is unaffected: every
 * existing surface (context-bloat, the hygiene ratio, the dashboard's
 * compaction events, the caps table) renders it and does not move.
 */
export function computeContextCarryForWindow(store: Store, filters: ContextCarryFilters = {}): ContextCarryWithFit {
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
  const primary = computeContextCarry(rows, options);

  // D13's second pass — same rows, same rate overrides and drop ratio, only
  // the reset floor differs. Its own `ContextCarryResult` is discarded once
  // the fit is computed; only `resetFloorUsed` and the fit itself carry
  // forward.
  const resetFloorUsed = computeAdaptiveResetFloor(rows);
  const adaptive = computeContextCarry(rows, {
    resetDropRatio: filters.resetDropRatio,
    resetMinBeforeTokens: resetFloorUsed,
    rateOverrides: filters.rateOverrides,
  });
  // CR-4: the SAME rateOverrides given to `computeContextCarry`, or the fit's
  // dollar figures disagree with the primary block's on the same screen.
  const autoCompactFit = computeAutoCompactFit(adaptive, { resetFloorUsed, rateOverrides: filters.rateOverrides });

  return { ...primary, autoCompactFit };
}
