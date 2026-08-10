/**
 * Context carry cost — "how much of the bill is carrying context forward,
 * and where does it concentrate?"
 *
 * Pure module, functional-core style: one flat, timestamp-ordered
 * `HygieneMessageRow` array in (the same row shape and `groupBySession`
 * grouping the hygiene detectors and `ttlFit.ts` use — no second
 * implementation), a `ContextCarryResult` out. No store, no clock, no
 * `Date.now()`, no I/O. The store query and CLI/MCP glue live in
 * `packages/cli/src/contextCarry/`.
 *
 * Design: `plans/context-carry-cost/plan.md` §4, corrected per
 * `plans/context-carry-cost/IMPLEMENTATION.md` §1 (decisions D2/D8/D9/D10/D11/
 * D12 are load-bearing for the shape below — read them before changing a
 * field name here) and §4/B2.
 *
 * THIS FILE IS SPLIT ACROSS TWO BUILD PHASES:
 *  - Phase A1 declares every exported interface below plus
 *    `computeContextCarry`'s signature and contract, so Phase B (store glue,
 *    the implementation, the context-bloat rewrite, the CLI/MCP/dashboard
 *    surfaces) can all build against a fixed shape in parallel.
 *  - Phase B2 fills in `computeContextCarry`'s body. Until then it throws.
 * Do not narrow, rename, or add fields to the interfaces below outside that
 * handoff — B1/B3/C1/C2 are typed against this exact contract.
 */
import { resolvePricing, type RateOverrides } from "./pricing.js";
import {
  contextIncrements,
  detectResets,
  firstRequestContext,
  groupBySession,
  messageCost,
  sumCost,
  totalContext,
  type ContextIncrement,
  type ContextResetEvent as ResetEvent,
  type SessionGroup,
} from "./hygiene/util.js";
import type { HygieneMessageRow } from "./hygiene/types.js";

// `ContextResetEvent`, `contextIncrements`, `detectResets`, `totalContext`, and
// `firstRequestContext` are owned by `hygiene/util.ts` (A1) and re-exported by
// `hygiene/index.ts` for the detectors that also consume them. This module's
// body (B2) MUST reuse them rather than reimplementing the walk — see
// `hygiene/util.ts`'s "one implementation of every shared quantity" doc on
// `walkSessionChains`.
export type { ContextResetEvent } from "./hygiene/util.js";

/** Tunable knobs. Every field optional; see `computeContextCarry`'s JSDoc for
 *  the defaults each falls back to when omitted. */
export interface ContextCarryOptions {
  /** Passed through to `detectResets` (the FLOORED sibling rule — see
   *  `hygiene/util.ts`). Default 0.4 (a >40% drop). */
  resetDropRatio?: number;
  /** Passed through to `detectResets`. Default 150,000. */
  resetMinBeforeTokens?: number;
  /** Token caps to report `aboveCap` for. Default `[100_000, 200_000,
   *  300_000, 500_000]`. */
  capsTokens?: readonly number[];
  /** Context-size band edges for `sizeBands` (tokens). Default
   *  `[0, 20_000, 50_000, 100_000, 200_000, 500_000]`, producing one open-ended
   *  top band above the last edge. */
  sizeBandEdges?: readonly number[];
  rateOverrides?: RateOverrides;
}

/** One context-size band: how many requests fell in it, and what they cost. */
export interface ContextSizeBand {
  /** Human-readable label, e.g. `"200K-500K"`. The top band's label ends in
   *  `"+"` (e.g. `"500K+"`). */
  label: string;
  minTokens: number;
  /** `null` for the open-ended top band. */
  maxTokens: number | null;
  requests: number;
  /** Share (0-1) of `carriedTokens` this band accounts for. `null` when
   *  `carriedTokens` is `0` (nothing to take a share of). */
  shareOfVolume: number | null;
  /** Share (0-1) of the priced window's total cost this band accounts for.
   *  `null` under the same empty-denominator rule. */
  shareOfCost: number | null;
  /** This band's total cost divided by its request count. `null` when
   *  `requests === 0` (nothing to divide by — never a fabricated `0`). */
  costPerRequest: number | null;
}

/** Carried tokens above one cap — the model-free "what would a ceiling be
 *  worth" table (spec §1.1/§4.6). `cost` prices every above-cap token at the
 *  cache-READ rate, the same LOWER-BOUND convention `carryCost` uses below —
 *  it is NOT the cost of capping context at this level (that would require
 *  knowing what the work would have looked like without the carried tokens,
 *  which this tool cannot measure; see `capCaveat`). */
export interface ContextAboveCapRow {
  capTokens: number;
  /** Sum, over every row whose `totalContext` exceeds `capTokens`, of the
   *  excess above the cap. `0` (never `undefined`) when no observed context
   *  exceeds this cap. */
  tokensAbove: number;
  /** Share (0-1) of `carriedTokens` this represents. `null` when
   *  `carriedTokens` is `0`. */
  share: number | null;
  /** `tokensAbove` priced at the cache-read rate, per model, summed. `0` when
   *  `tokensAbove` is `0`; excludes unpriced-model rows' contribution to
   *  `tokensAbove` from the dollar figure (their tokens still count in
   *  `tokensAbove` itself — same honest-degrade split `ttlFit.ts` uses). */
  cost: number;
}

/** One session's carry cost, ranked by carried volume — the "cost
 *  concentrates in a handful of sessions" finding (spec §1.1 consequence 1).
 *
 * D3 (context-carry-cost review): the MCP tool (`get_context_carry`) MUST
 * OMIT this array entirely, mirroring `get_cache_ttl_fit`'s deliberate
 * omission of session ids — a session id leaving the machine over MCP is a
 * different exposure than one rendered in a local CLI/dashboard view. The CLI
 * and the local dashboard MAY render it.
 */
export interface ContextConcentrationRow {
  sessionId: string;
  requests: number;
  /** `carriedTokensForSession / requests`. `null` when `requests === 0`
   *  (should not occur for a session that appears here at all, but never a
   *  fabricated `0` if it somehow did). */
  meanContext: number | null;
  /** Share (0-1) of the window's total `carriedTokens` this session
   *  accounts for. `null` when `carriedTokens` is `0`. */
  share: number | null;
}

/** Mean floor/peak/cycle-length across `ContextCarryResult.resets` — the
 *  sawtooth shape (spec §1.1 consequence 2). `null` on fewer than 3 resets
 *  (spec §4.6: `insufficient-data` over averaging two events) — NEVER
 *  silently averaged from 1 or 2. */
export interface ContextSawtooth {
  floorTokens: number;
  peakTokens: number;
  /** Mean requests between one reset and the next, across every CLOSED cycle
   *  (an open final cycle — see `ContextCycle.open` — is excluded from this
   *  mean; it has no "next reset" to measure to). */
  requestsPerCycle: number;
}

/** One reset, carrying everything Phase 4's counterfactual (deferred, D5)
 *  would need as inputs (context-carry-cost §4.4) so building it later never
 *  requires walking the rows a second time. */
export interface ContextReset {
  sessionId: string;
  beforeTokens: number;
  afterTokens: number;
  /** Requests in the cycle this reset CLOSED (i.e. ending at `afterRow`'s
   *  predecessor — the reset's own request starts the NEXT cycle). */
  requestsInCycle: number;
  /** Equivalent-API cost of the reset's own request (`afterRow` in
   *  `hygiene/util.ts#ContextResetEvent` terms) — priced normally, not at the
   *  carry-cost lower bound, because this is a real request with a real
   *  input/output/cache split, not a carried token. */
  resetRequestCost: number;
}

/** One priced turn's carry-cost attribution — `remainingRequestsInCycle` is
 *  INCLUSIVE of the adding turn itself (context-carry-cost review A-5): the
 *  increment is measured ON turn `n`'s own context, so turn `n` already pays
 *  it once. This is what makes
 *  `Σ_k increment(k) × (N − k + 1) = Σ_n totalContext(n)` hold within a closed
 *  cycle of `N` turns — an EXACT partition of the cycle's carried volume, not
 *  an approximation. An EXCLUSIVE count would undercount by the whole
 *  distinct volume added on every turn.
 *
 * `carryCost` is a LOWER BOUND (review A-3): every carried token is priced at
 * the cache-READ rate (≈0.1× input), but a carried token is re-WRITTEN at
 * 1.25–2× on every cache-expiry boundary within its cycle. On the motivating
 * window this understated the true carried cost by roughly 50% (reads
 * $9,232 vs writes $4,632 in that breakdown). Never rank findings by
 * `carryCost` alone without saying so — see `rule` fields built from this.
 */
export interface ContextCarryTurn {
  sessionId: string;
  uuid: string;
  model: string | null;
  increment: number;
  /** Inclusive of this turn (see doc above). */
  remainingRequestsInCycle: number;
  /** `increment × remainingRequestsInCycle × cacheReadRate(model)`, plus (for
   *  the increment immediately preceding a reset — review A-4) the reset's
   *  own `resetRequestCost`: pricing that increment at ~zero carry cost would
   *  otherwise invert the case where the LARGE addition is what FORCED the
   *  reset (auto-compaction). `null` when `model` is unpriced — the token
   *  volume still counts toward `distinctTokensEstimate`, but no dollar
   *  figure is guessed at (same honest-degrade convention `ttlFit.ts` uses). */
  carryCost: number | null;
}

/** One cycle (session-start-or-reset to the next reset, or to the end of the
 *  session) — the unit `remainingRequestsInCycle` is computed within. */
export interface ContextCycle {
  sessionId: string;
  requests: number;
  /** `true` when this cycle has no following reset — it ran to the end of
   *  the session and was still open when the window ended. An open cycle's
   *  carry cost is a LOWER bound on its own total (review, §4.3): a session
   *  that is merely PAUSED will keep charging after the window closes.
   *  Never silently mixed with closed cycles in an aggregate that implies
   *  completeness. */
  open: boolean;
}

/**
 * The fit computed over one window's messages.
 *
 * Every ratio/share field is `number | null` (review F2): `null` with a
 * stated reason when its denominator is `≤ 0` or non-finite. `0/0` on an
 * empty or all-zero window otherwise yields `NaN`, which `JSON.stringify`
 * silently emits as `null` anyway — indistinguishable from "not computed" at
 * the very moment it matters most. Never let a caller confuse the two by
 * omission; every such field's doc says when it is `null`.
 */
export interface ContextCarryResult {
  /** `SUM(totalContext(row))` over the window — what is billed. */
  carriedTokens: number;

  /**
   * Sum of positive (`"growth"`) increments, plus each session's
   * `"session-start"` increment, plus each `"post-reset"` baseline
   * (`hygiene/util.ts#contextIncrements`, D9's three qualifying kinds;
   * `"shrink"` never contributes). This is a lower-bound ESTIMATE, not a
   * measurement, in BOTH directions at once (D10 — neither a lower nor an
   * upper bound claim alone is true, so the field is named for neither):
   *
   *  - biased DOWN: a turn that both drops content and adds content nets to
   *    one positive `"growth"` increment (or a `"shrink"`, or a
   *    `"post-reset"` baseline) — whichever it lands as, the dropped-and-
   *    replaced content is never counted twice, understating real distinct
   *    content.
   *  - biased UP: a `"post-reset"` baseline is counted in full as distinct
   *    (D8 — this tool cannot see whether a compaction summary is new text
   *    or a restatement of what was dropped), and content that gets DROPPED
   *    then RE-READ later in the same session is counted as distinct again
   *    at the point it re-enters, overstating real distinct content.
   *
   * Named `distinctTokensEstimate`, not `...LowerBound`/`...UpperBound` —
   * either bound name would be mathematically false given both biases exist
   * simultaneously. State both biases wherever this number is surfaced; do
   * not let a formatter reduce it to a bound claim.
   */
  distinctTokensEstimate: number;
  /** `carriedTokens / distinctTokensEstimate`. `null` when
   *  `distinctTokensEstimate` is `≤ 0` or non-finite. NOT a bound (D10, same
   *  reasoning as `distinctTokensEstimate` — its denominator is biased in
   *  both directions, so this ratio is biased in both directions too). Never
   *  printed as a bare ratio by a formatter (review D4/C1): every surface
   *  states the estimate's own honesty caveat on the same line. State the
   *  arithmetic as "the average request carried X tokens of context to
   *  produce Y of new content" (review E2/D12), never as "every distinct
   *  token was re-sent N times" (that reads a per-token lifetime into an
   *  aggregate ratio it does not support). */
  amplificationEstimate: number | null;

  /** Context-size bands: requests, share of volume, share of cost,
   *  $/request. */
  sizeBands: ContextSizeBand[];
  /** Carried tokens above each configured cap. */
  aboveCap: ContextAboveCapRow[];
  /** Fixed caveat string attached to every `aboveCap` row's cost — the gap
   *  between "tokens above a cap" and "cost of actually capping there" is
   *  rework, and rework cost is not measured here (spec §4.6). Surfaces MUST
   *  render this on the same line as any `aboveCap` figure, never in a
   *  footnote a reader can miss. */
  capCaveat: string;

  /** Every detected reset, with the cycle it closed. */
  resets: ContextReset[];
  /** Every cycle (closed or open) the window's resets partition each session
   *  into — the basis `carryCost` is computed within.
   *
   * **Positionally aligned with `turns`** — `cycles[j]` describes the j-th
   * slice of `turns`, and `cycles[j].requests` is that slice's length. See
   * `turns`' doc for the full contract and for what a consumer must check
   * before relying on it. `open` is the field `turns` cannot supply. */
  cycles: ContextCycle[];
  /** Mean floor/peak/cycle-length across `resets`. `null` on fewer than 3
   *  resets (spec §4.6 — `insufficient-data` over averaging two events). */
  sawtooth: ContextSawtooth | null;

  /** Mean total context on each session's first request (median across
   *  sessions — review A-8, NOT a mean: the motivating window's single most
   *  extreme first-request total, 175.9K, was a legitimately RESUMED
   *  session, i.e. a restored conversation rather than a fresh prelude, and a
   *  mean lets one such session move the figure; a median does not), and
   *  what it costs re-sent across every request in the window. */
  prelude: {
    medianFirstRequestTokens: number;
    /** Share (0-1) of `carriedTokens` this prelude accounts for
     *  (`medianFirstRequestTokens × sessions / carriedTokens`). `null` when
     *  `carriedTokens` is `0`. */
    shareOfCarriedVolume: number | null;
    /** `medianFirstRequestTokens × sessions`, priced per model across the
     *  window (accumulated the same way `carryCost` is), NOT a bare token ×
     *  rate — a mixed-model window prices each session's contribution at its
     *  own model's cache-read rate. */
    cost: number;
    sessions: number;
  };
  /**
   * Phase 3's data source (review C-3): per-project session-start baseline,
   * so the CLI/dashboard's trend line and step-change alert (D6) never
   * recompute from raw rows — `packages/cli/src/server/insights.ts` receives
   * no `Store` and its contract forbids recomputation. One row per project
   * that has at least one session in the window; `firstRequestTokens` is
   * this session's own value (NOT the project's median — the caller derives
   * a trend/median across the array itself), ordered by `startedAt`
   * ascending so a caller can walk it directly for a step-change check.
   */
  preludeByProject: Array<{
    projectPath: string;
    sessions: Array<{ startedAt: number; firstRequestTokens: number }>;
  }>;

  /** Sessions ranked by carried volume, most first — the concentration
   *  finding (spec §1.1 consequence 1). D3: the MCP tool MUST omit this
   *  field entirely; the CLI and local dashboard may render it. */
  concentration: ContextConcentrationRow[];

  /** Every priced turn's carry-cost attribution (see `ContextCarryTurn`'s
   *  doc). Exposed so a caller can rank/filter without recomputing the
   *  formula — e.g. `context-bloat`'s (B3) `estimatedWaste`.
   *
   * **The `turns`/`cycles` correspondence (autocompact-window-fit C1/D11).**
   * There is no field linking a turn to its cycle, and none is being added.
   * What the implementation guarantees — written down here because a consumer
   * (`computeAutoCompactFit`) now depends on it, and an undocumented invariant
   * is one refactor away from silently changing:
   *
   *  - `turns` is the CONCATENATION of each cycle's turn list, in `cycles`
   *    order: the loop over `cycleAccs` pushes one `cycles[]` entry and then
   *    that cycle's turns, in order.
   *  - Within a cycle of `n` turns, `remainingRequestsInCycle` runs `n…1`
   *    (`remaining = n - i`), so the array is SELF-DELIMITING: a cycle's last
   *    turn is exactly the one carrying `1`, and no earlier turn in that slice
   *    carries it.
   *  - Every turn in a slice carries the same `sessionId` as its `cycles[j]`.
   *
   * A consumer must RECONSTRUCT the slices from `turns` alone (split after each
   * `remainingRequestsInCycle === 1`) and then verify each slice's length
   * against `cycles[j].requests`, the descending-by-one `remaining` sequence,
   * and single-session-ness. A bare `Σ cycles[].requests === turns.length`
   * check is not a substitute: it is invariant under any permutation of either
   * array, which is precisely the failure a reordering refactor produces.
   * `packages/cli/src/__tests__/context-carry.test.ts` pins all of the above. */
  turns: ContextCarryTurn[];

  /** `SUM(carryCost)` over `turns` where it is non-null. `null` when EVERY
   *  turn's `carryCost` is null (no priced model anywhere in the window) —
   *  never a partial sum silently standing in for the whole. */
  totalCarryCost: number | null;

  /** Rows with `timestamp === null` — excluded from every order-sensitive
   *  computation above (there is no ordering to place them in) but counted
   *  here rather than silently dropped. Matches `ttlFit.ts`/
   *  `reEntryBurn.ts`'s convention. */
  excludedRows: number;
  /** Rows whose `model` is `null`, or whose model is not in the resolved
   *  pricing table (`resolvePricing(...).pricing === null`) — real token
   *  volume that still contributes to `carriedTokens`/`distinctTokensEstimate`/
   *  size bands, but is excluded from any per-model cost figure and from
   *  `totalCarryCost`. Same honest-degrade convention `ttlFit.ts#unpricedRows`
   *  uses. These rows still count toward `remainingRequestsInCycle` for any
   *  cycle they fall in (the context really was carried) but contribute no
   *  dollars — decision recorded in `computeContextCarry`'s contract below. */
  unpricedRows: number;
  /** Carried tokens (`totalContext`) on `unpricedRows`. */
  unpricedTokens: number;
}

/**
 * Compute the context-carry fit over one window's messages.
 *
 * Contract (binding on the Phase B2 implementation):
 *
 *  - **Pure.** No store access, no wall clock, no `Date.now()`, no I/O. Same
 *    input, same output, always.
 *  - **Reuse, never reimplement, `hygiene/util.ts`'s helpers**: `groupBySession`,
 *    `totalContext`, `contextIncrements`, `detectResets`, `firstRequestContext`.
 *    A second implementation of any of these is how the detector and this
 *    report start disagreeing (context-carry-cost §6).
 *  - **`distinctTokensEstimate`** sums `contextIncrements(rows)` filtered to
 *    `kind !== "shrink"` (i.e. `"growth" | "session-start" | "post-reset"`) —
 *    see that field's doc for the two-directional bias and D9's exclusion
 *    rule.
 *  - **`resets`/`cycles`/`sawtooth`** come from `detectResets(rows, {
 *    dropRatio: options?.resetDropRatio, minBeforeTokens:
 *    options?.resetMinBeforeTokens })` (the FLOORED rule — see
 *    `hygiene/util.ts#detectResets`'s doc for why it differs from
 *    `distinctTokensEstimate`'s floorless one). `sawtooth` is `null` on fewer
 *    than 3 resets.
 *  - **`remainingRequestsInCycle` is INCLUSIVE of the adding turn** (see
 *    `ContextCarryTurn`'s doc) and runs to the NEXT reset, not the end of the
 *    session. Where no reset follows, the cycle runs to the end of the
 *    session and is marked `open: true` in `cycles` — never silently mixed
 *    with closed cycles in a total that implies completeness.
 *  - **`carryCost` prices every carried token at the cache-READ rate** — a
 *    LOWER bound (see `ContextCarryTurn`'s doc for the ~50% understatement
 *    this implies against actual re-write cost). The increment immediately
 *    preceding a reset additionally carries that reset's own
 *    `resetRequestCost` (review A-4) — pricing it at ~zero would invert the
 *    auto-compaction case where that large addition is what FORCED the
 *    reset. Never rank findings by `carryCost` alone.
 *  - **Unpriced/null-model rows** (`row.model === null`, or
 *    `resolvePricing(...).pricing === null`) DO count toward
 *    `remainingRequestsInCycle` for whichever cycle they fall in — the
 *    context really was carried on that request — but contribute no dollar
 *    figure anywhere; counted in `unpricedRows`/`unpricedTokens` instead of
 *    silently vanishing (decision recorded in IMPLEMENTATION.md §4/B2).
 *  - **A cycle spanning multiple models** accumulates carry cost per model,
 *    the same way `ttlFit.ts` accumulates per model across a window.
 *  - **Every ratio/share field is `number | null`**, returning `null` with a
 *    stated reason when its denominator is `≤ 0` or non-finite —
 *    `amplificationEstimate`, every `share`/`shareOf*` field, and every
 *    `sizeBands[]`/`aboveCap[]` per-request/derived figure. Never a bare
 *    `NaN` (which `JSON.stringify` would silently emit as `null` anyway,
 *    indistinguishable from "not computed" — the whole reason this rule
 *    exists).
 *  - **`prelude`/`preludeByProject`** use `firstRequestContext` per session
 *    (`hygiene/util.ts`), and `prelude.medianFirstRequestTokens` is a MEDIAN
 *    across sessions, never a mean (review A-8 — see `prelude`'s doc).
 *  - **`aboveCap`** at a cap above every observed context yields `tokensAbove:
 *    0`, never `undefined`.
 *  - Defaults: `resetDropRatio` = 0.4, `resetMinBeforeTokens` = 150,000,
 *    `capsTokens` = `[100_000, 200_000, 300_000, 500_000]`, `sizeBandEdges` =
 *    `[0, 20_000, 50_000, 100_000, 200_000, 500_000]`.
 *
 * Phase A1 (this file's author) only declares the contract above so
 * B1/B3/C1/C2 can build against it in parallel; Phase B2 implements the body.
 *
 * ── Implementation notes (Phase B2) ─────────────────────────────────────────
 *
 * **The carry increment telescopes; `contextIncrements`' does not always.**
 * `ContextCarryTurn.increment` is the increment measured against THIS module's
 * cycle structure (`detectResets`, FLOORED), while `contextIncrements` uses the
 * FLOORLESS drop rule for its `"post-reset"` kind. The two disagree on exactly
 * one class of row: a drop steep enough to be `"post-reset"` but from a
 * starting point below `resetMinBeforeTokens`. `contextIncrements` reports that
 * row's WHOLE `totalContext`; this module reports the signed difference,
 * because that row does NOT start a cycle here and a whole-total increment
 * there would break the partition identity below. `distinctTokensEstimate` is
 * unaffected — it consumes `contextIncrements`' own numbers, per the contract
 * above. Neither number is wrong; they answer different questions, which is the
 * same reason `hygiene/util.ts` keeps the two drop rules separate.
 *
 * The resulting property, which the suite pins as an equality rather than a
 * tolerance: within each cycle the carry increments telescope from `0`, so
 *
 *     Σ_turns increment × remainingRequestsInCycle
 *       === Σ_timestamped-rows totalContext(row)
 *
 * exactly — `remainingRequestsInCycle` being INCLUSIVE is what makes it an
 * exact partition rather than an approximation. (`carriedTokens` counts
 * null-timestamp rows too, which have no cycle to sit in; the identity is
 * against the timestamped subset.)
 *
 * **A shrink turn's carry cost is negative, deliberately.** A turn that drops
 * more than it adds reduced the volume every later turn in the cycle carried,
 * and the exact partition credits it for that. Callers ranking "expensive
 * turns" filter to positive increments (`context-bloat` filters to
 * `contextIncrements`' `"growth"` kind before it ever reaches this array).
 *
 * **Unpriced turns still hold their slot.** `remainingRequestsInCycle` counts
 * every request in the cycle, priced or not — the context really was carried on
 * an unpriced request. Only the dollar half degrades (`carryCost: null`).
 */
export function computeContextCarry(
  rows: readonly HygieneMessageRow[],
  options?: ContextCarryOptions,
): ContextCarryResult {
  const overrides = options?.rateOverrides;
  const caps = normalizeCaps(options?.capsTokens);
  const edges = normalizeBandEdges(options?.sizeBandEdges);

  // ── Shared helpers, never reimplemented (contract above / §6). ────────────
  const increments = contextIncrements(rows);
  const resetEvents = detectResets(rows, {
    dropRatio: options?.resetDropRatio,
    minBeforeTokens: options?.resetMinBeforeTokens,
  });
  const groups = groupBySession(rows);

  // Keyed by row IDENTITY, not `uuid`: `detectResets` and `contextIncrements`
  // walk the same array and yield the same objects, and a duplicated uuid in a
  // malformed window must not merge two distinct turns.
  const resetAfterRows = new Set<HygieneMessageRow>(resetEvents.map((e) => e.afterRow));
  const resetByBeforeRow = new Map<HygieneMessageRow, ResetEvent>(resetEvents.map((e) => [e.beforeRow, e]));

  /** One `resolvePricing` per distinct raw model id, not per row. */
  const rateCache = new Map<string, number | null>();
  const cacheReadRate = (model: string | null): number | null => {
    if (model === null) return null;
    if (rateCache.has(model)) return rateCache.get(model) ?? null;
    const { pricing } = resolvePricing(model, overrides);
    const rate =
      pricing === null || !Number.isFinite(pricing.cacheReadPerMillion) ? null : pricing.cacheReadPerMillion;
    rateCache.set(model, rate);
    return rate;
  };

  // ── Pass 1: volume totals, size bands, caps, unpriced share, per-session
  // carried volume. Order-insensitive, so EVERY row counts here — including
  // null-timestamp ones, which really were billed. ──────────────────────────
  const bands = edges.map((min, i) => ({
    min,
    max: i + 1 < edges.length ? edges[i + 1]! : null,
    tokens: 0,
    requests: 0,
    cost: 0,
  }));
  const capAccs = caps.map((capTokens) => ({ capTokens, tokensAbove: 0, cost: 0 }));
  const sessionCarried = new Map<string, { tokens: number; requests: number }>();

  let carriedTokens = 0;
  let excludedRows = 0;
  let unpricedRows = 0;
  let unpricedTokens = 0;

  for (const row of rows) {
    const total = totalContext(row);
    carriedTokens += total;
    if (row.timestamp === null) excludedRows++;

    const rate = cacheReadRate(row.model);
    if (rate === null) {
      unpricedRows++;
      unpricedTokens += total;
    }

    const band = bands[bandIndexFor(total, edges)]!;
    band.tokens += total;
    band.requests += 1;
    band.cost += messageCost(row, overrides);

    for (const cap of capAccs) {
      const excess = total - cap.capTokens;
      if (excess > 0) {
        cap.tokensAbove += excess;
        if (rate !== null) cap.cost += (excess * rate) / 1e6;
      }
    }

    const acc = sessionCarried.get(row.sessionId);
    if (acc === undefined) sessionCarried.set(row.sessionId, { tokens: total, requests: 1 });
    else {
      acc.tokens += total;
      acc.requests += 1;
    }
  }

  const windowCost = sumCost(rows, overrides);

  // ── Pass 2: cycles. A cycle starts at a session's first chain step (which
  // includes the first step after a null-timestamp break — the chain was cut,
  // so there is no carried volume to measure against) or at a reset's
  // `afterRow`, and runs to the step before the next such start. ────────────
  const cycleAccs: CycleAccumulator[] = [];
  let current: CycleAccumulator | null = null;
  for (const inc of increments) {
    const startsCycle =
      inc.prev === null || resetAfterRows.has(inc.row) || current === null || current.sessionId !== inc.row.sessionId;
    if (startsCycle || current === null) current = { sessionId: inc.row.sessionId, steps: [] };
    if (current.steps.length === 0) cycleAccs.push(current);
    current.steps.push({ inc, carryIncrement: carryIncrementOf(inc, startsCycle) });
  }

  const cycles: ContextCycle[] = [];
  const turns: ContextCarryTurn[] = [];
  const requestsInClosedCycle = new Map<ResetEvent, number>();
  const resetCosts = new Map<ResetEvent, number>(resetEvents.map((e) => [e, messageCost(e.afterRow, overrides)]));

  for (const cyc of cycleAccs) {
    const n = cyc.steps.length;
    const lastRow = cyc.steps[n - 1]!.inc.row;
    // A cycle is CLOSED exactly when a reset was measured across its last row:
    // `detectResets` pairs `beforeRow` (the closing cycle's last step) with
    // `afterRow` (the next cycle's first). No reset ⇒ the cycle ran to the end
    // of the session/chain and is still open — a lower bound on its own carry
    // cost, never mixed into an aggregate that implies completeness.
    const closingReset = resetByBeforeRow.get(lastRow) ?? null;
    cycles.push({ sessionId: cyc.sessionId, requests: n, open: closingReset === null });
    if (closingReset !== null) requestsInClosedCycle.set(closingReset, n);

    for (let i = 0; i < n; i++) {
      const { inc, carryIncrement } = cyc.steps[i]!;
      const remaining = n - i; // INCLUSIVE of this turn — see the contract above.
      const rate = cacheReadRate(inc.row.model);
      let carryCost: number | null = null;
      if (rate !== null) {
        let cost = (carryIncrement * remaining * rate) / 1e6;
        // Review A-4: the last increment of a closed cycle prices at ~zero
        // carry (it is carried exactly once), which INVERTS the auto-compaction
        // case where that addition is what forced the reset. The reset's own
        // request is the cost it caused, so it lands here.
        if (closingReset !== null && i === n - 1) cost += resetCosts.get(closingReset) ?? 0;
        carryCost = Number.isFinite(cost) ? cost : null;
      }
      turns.push({
        sessionId: inc.row.sessionId,
        uuid: inc.row.uuid,
        model: inc.row.model,
        increment: carryIncrement,
        remainingRequestsInCycle: remaining,
        carryCost,
      });
    }
  }

  const pricedCarryCosts = turns.map((t) => t.carryCost).filter((c): c is number => c !== null);
  const totalCarryCost = pricedCarryCosts.length === 0 ? null : pricedCarryCosts.reduce((a, b) => a + b, 0);

  // ── distinct content: `contextIncrements`' OWN numbers (floorless), all
  // three qualifying kinds; `"shrink"` never contributes. ───────────────────
  let distinctTokensEstimate = 0;
  for (const inc of increments) if (inc.kind !== "shrink") distinctTokensEstimate += inc.increment;

  const resets: ContextReset[] = resetEvents.map((e) => ({
    sessionId: e.sessionId,
    beforeTokens: e.beforeTokens,
    afterTokens: e.afterTokens,
    requestsInCycle: requestsInClosedCycle.get(e) ?? 0,
    resetRequestCost: resetCosts.get(e) ?? 0,
  }));

  // ── prelude: MEDIAN across sessions, never a mean (review A-8). ───────────
  const firstRequests: number[] = [];
  const preludeByProject = new Map<string, Array<{ startedAt: number; firstRequestTokens: number }>>();
  const projectOrder: string[] = [];
  // Σ of each session's own cache-read rate: the prelude is priced per session
  // at ITS model's rate, not the window's, so a mixed-model window never
  // charges one model's prelude at another's rate. Multiplied by the median
  // once it is known.
  let preludeRateSum = 0;
  for (const group of groups) {
    const first = firstRequestContext(group);
    if (first === null) continue;
    firstRequests.push(first);
    const rate = cacheReadRate(group.messages[0]!.model);
    if (rate !== null) preludeRateSum += rate;
    const startedAt = sessionStartedAt(group);
    // No usable timestamp anywhere in the session ⇒ nothing to place it on a
    // trend line with. Excluded from the per-project series rather than
    // ordered against a fabricated epoch.
    if (startedAt === null) continue;
    let series = preludeByProject.get(group.projectPath);
    if (series === undefined) {
      series = [];
      preludeByProject.set(group.projectPath, series);
      projectOrder.push(group.projectPath);
    }
    series.push({ startedAt, firstRequestTokens: first });
  }

  const medianFirstRequestTokens = median(firstRequests) ?? 0;
  const preludeSessions = firstRequests.length;
  const preludeVolume = medianFirstRequestTokens * preludeSessions;
  const preludeCost = (medianFirstRequestTokens * preludeRateSum) / 1e6;

  const concentration: ContextConcentrationRow[] = [...sessionCarried.entries()]
    // Ranked by carried volume, ties broken by session id so the order is a
    // function of the data alone (a Map's insertion order would make it a
    // function of the input row order too).
    .sort(([aId, a], [bId, b]) => b.tokens - a.tokens || (aId < bId ? -1 : aId > bId ? 1 : 0))
    .map(([sessionId, acc]) => ({
      sessionId,
      requests: acc.requests,
      meanContext: ratio(acc.tokens, acc.requests),
      share: ratio(acc.tokens, carriedTokens),
    }));

  return {
    carriedTokens,
    distinctTokensEstimate,
    amplificationEstimate: ratio(carriedTokens, distinctTokensEstimate),
    sizeBands: bands.map((b) => ({
      label: b.max === null ? `${tokensLabel(b.min)}+` : `${tokensLabel(b.min)}-${tokensLabel(b.max)}`,
      minTokens: b.min,
      maxTokens: b.max,
      requests: b.requests,
      shareOfVolume: ratio(b.tokens, carriedTokens),
      shareOfCost: ratio(b.cost, windowCost),
      costPerRequest: ratio(b.cost, b.requests),
    })),
    aboveCap: capAccs.map((c) => ({
      capTokens: c.capTokens,
      tokensAbove: c.tokensAbove,
      share: ratio(c.tokensAbove, carriedTokens),
      cost: c.cost,
    })),
    capCaveat: CAP_CAVEAT,
    resets,
    cycles,
    sawtooth: buildSawtooth(resets, cycles),
    prelude: {
      medianFirstRequestTokens,
      shareOfCarriedVolume: ratio(preludeVolume, carriedTokens),
      cost: preludeCost,
      sessions: preludeSessions,
    },
    preludeByProject: projectOrder.map((projectPath) => ({
      projectPath,
      sessions: [...preludeByProject.get(projectPath)!].sort((a, b) => a.startedAt - b.startedAt),
    })),
    concentration,
    turns,
    totalCarryCost,
    excludedRows,
    unpricedRows,
    unpricedTokens,
  };
}

// ─── Internals ───────────────────────────────────────────────────────────────

const DEFAULT_CAPS_TOKENS: readonly number[] = [100_000, 200_000, 300_000, 500_000];
const DEFAULT_SIZE_BAND_EDGES: readonly number[] = [0, 20_000, 50_000, 100_000, 200_000, 500_000];
/** Below this many resets there is no sawtooth to describe (spec §4.6). */
const MIN_RESETS_FOR_SAWTOOTH = 3;

/** Attached to every `aboveCap` row. Says what the figure is AND what it is
 *  not, on one line, because a reader who takes it for "the saving from
 *  capping here" has been misled by a number this tool cannot produce. */
const CAP_CAVEAT =
  "Tokens above a cap are priced at the cache-READ rate — the cheapest form this cost can take, and a lower bound on it. " +
  "This is not the cost of capping context at that level: capping means the same work gets done with less context in " +
  "front of the model, and what that rework costs is not measured here.";

interface CycleAccumulator {
  sessionId: string;
  steps: Array<{ inc: ContextIncrement; carryIncrement: number }>;
}

/**
 * The increment measured against THIS module's cycle structure — see
 * `computeContextCarry`'s implementation notes for why it can differ from
 * `ContextIncrement.increment` on exactly one class of row.
 *
 *  - a cycle's first step: the row's WHOLE `totalContext` (nothing was carried
 *    into it — a session/chain start has no predecessor, and a reset dropped
 *    what came before),
 *  - a `"post-reset"` step that did NOT start a cycle here (the floorless rule
 *    fired, the floored one did not): the signed difference, so the chain still
 *    telescopes,
 *  - otherwise (`"growth"`/`"shrink"`): `ContextIncrement.increment`, which IS
 *    that difference already.
 */
function carryIncrementOf(inc: ContextIncrement, startsCycle: boolean): number {
  if (startsCycle) return totalContext(inc.row);
  // `prev` is non-null here: a null `prev` is `kind === "session-start"`, which
  // always starts a cycle and returned above.
  if (inc.kind === "post-reset") return totalContext(inc.row) - totalContext(inc.prev!);
  return inc.increment;
}

/** The session's first message that carries a usable timestamp — the ordering
 *  key `preludeByProject` sorts on. `null` when no message in the session has
 *  one. */
function sessionStartedAt(group: SessionGroup): number | null {
  for (const m of group.messages) if (m.timestamp !== null) return m.timestamp;
  return null;
}

/**
 * Every ratio in this module goes through here (review F2). `null` — never
 * `NaN`, never a fabricated `0` — when the denominator is `≤ 0` or either side
 * is non-finite. `JSON.stringify` emits `NaN` as `null` anyway, which would
 * make "not computed" and "computed as nonsense" indistinguishable at exactly
 * the moment the difference matters.
 */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Median of a finite sample; `null` on an empty one. Even counts take the
 *  midpoint of the two central values. */
function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** `null` on fewer than `MIN_RESETS_FOR_SAWTOOTH` resets — two events are not a
 *  sawtooth, and averaging them would dress a coincidence as a shape. */
function buildSawtooth(resets: readonly ContextReset[], cycles: readonly ContextCycle[]): ContextSawtooth | null {
  if (resets.length < MIN_RESETS_FOR_SAWTOOTH) return null;
  // Each reset closes exactly one cycle — its `beforeRow` is the last step of
  // that cycle, and two resets in one linear chain cannot share a `beforeRow` —
  // so `closed.length === resets.length ≥ 3` wherever this line is reached.
  // No empty-`closed` guard: it would be unreachable, and an unreachable guard
  // pinned by a test is verification theatre (same reasoning `ttlFit.ts` gives
  // for omitting its `net === 0` branch).
  const closed = cycles.filter((c) => !c.open);
  return {
    floorTokens: mean(resets.map((r) => r.afterTokens)),
    peakTokens: mean(resets.map((r) => r.beforeTokens)),
    requestsPerCycle: mean(closed.map((c) => c.requests)),
  };
}

/** Sanitized, ascending, de-duplicated caps. An explicitly empty list is
 *  honoured (no `aboveCap` rows); only `undefined` falls back to the default. */
function normalizeCaps(caps: readonly number[] | undefined): number[] {
  if (caps === undefined) return [...DEFAULT_CAPS_TOKENS];
  return dedupeSorted(caps);
}

/**
 * Sanitized, ascending, de-duplicated band edges, always starting at `0` so the
 * bands partition `[0, ∞)` and every row lands in exactly one. An empty or
 * wholly-invalid list falls back to the default: unlike `capsTokens`, an empty
 * edge list would leave rows with no band at all, which is a silently dropped
 * request rather than a respected preference.
 */
function normalizeBandEdges(edges: readonly number[] | undefined): number[] {
  if (edges === undefined) return [...DEFAULT_SIZE_BAND_EDGES];
  const clean = dedupeSorted(edges);
  if (clean.length === 0) return [...DEFAULT_SIZE_BAND_EDGES];
  if (clean[0] !== 0) clean.unshift(0);
  return clean;
}

function dedupeSorted(values: readonly number[]): number[] {
  return [...new Set(values.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0))].sort((a, b) => a - b);
}

/** Index of the band `total` falls in. `edges` is ascending and starts at `0`,
 *  so the answer is the last edge at or below `total`. */
function bandIndexFor(total: number, edges: readonly number[]): number {
  let idx = 0;
  for (let i = 1; i < edges.length; i++) {
    if (total >= edges[i]!) idx = i;
    else break;
  }
  return idx;
}

/** Locale-independent token label (`"20K"`, `"500K"`). A prior CI failure in
 *  this repo came from a host-locale-formatted number reaching an assertion, so
 *  nothing here goes through `toLocaleString`. */
function tokensLabel(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const k = Math.round((tokens / 1000) * 10) / 10;
  return `${Number.isInteger(k) ? String(k) : k.toFixed(1)}K`;
}
