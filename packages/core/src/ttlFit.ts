/**
 * Cache-TTL fit — "is this workload cheaper on the 5-minute or the 1-hour
 * ephemeral cache TTL?"
 *
 * Pure module, functional-core style: one flat, timestamp-ordered
 * `HygieneMessageRow` array in (the same row shape and `groupBySession`
 * grouping the hygiene detectors use — no second implementation), a
 * `TtlFitResult` out. No store, no clock, no `Date.now()`, no I/O. The store
 * query and CLI/MCP glue live in `packages/cli/src/ttlFit/`.
 *
 * Design: `plans/cache-ttl-fit/plan.md` §4, corrected per
 * `plans/cache-ttl-fit/IMPLEMENTATION.md` §3/B2 (review finding C-1).
 *
 * THIS FILE IS SPLIT ACROSS TWO BUILD PHASES:
 *  - Phase A2 declares every exported interface below plus `computeTtlFit`'s
 *    signature and contract, so Phase B (store glue, the implementation, the
 *    hygiene detectors) can all build against a fixed shape in parallel.
 *  - Phase B2 fills in `computeTtlFit`'s body. Until then it throws.
 * Do not narrow, rename, or add fields to the interfaces below outside that
 * handoff — B1/B3/C1/C2 are typed against this exact contract.
 */
import { resolvePricing, nonNegativeFiniteInt, type ModelPricing, type RateOverrides } from "./pricing.js";
import { groupBySession, sumCost, observedTtlOf } from "./hygiene/util.js";
import type { HygieneMessageRow } from "./hygiene/types.js";

// `observedTtlOf` is owned by `hygiene/util.ts` (A2) — re-exported here so a
// caller reasoning about TTL fit reaches for one module, not two. Do not
// reimplement it; `hygiene/index.ts` re-exports the same function for the
// hygiene detectors that also consume it (B3).
export { observedTtlOf } from "./hygiene/util.js";

/** Tunable knobs. Every field optional; see `computeTtlFit`'s JSDoc for the
 *  defaults each falls back to when omitted. */
export interface TtlFitOptions {
  /** Gaps at or above this are treated as TTL-relevant (potentially rebuilt
   *  under a 5-minute TTL, still warm under a 1-hour one). Default 5 minutes. */
  shortTtlMs?: number;
  /** Gaps at or above this are cold under EITHER TTL — the cache would have
   *  expired regardless of which one was configured. Default 60 minutes. */
  longTtlMs?: number;
  rateOverrides?: RateOverrides;
}

/** One bucket of the idle-gap distribution between consecutive messages in a
 *  session. `session-start` (a session's first message) never lands in a
 *  bucket — there is no preceding gap to measure. */
export interface TtlFitGapBucket {
  /** Human-readable label for the bucket, e.g. `"5-15 min"`. */
  label: string;
  minGapMs: number;
  /** `null` for the open-ended top bucket. */
  maxGapMs: number | null;
  /** Messages whose preceding gap falls in this bucket. */
  requests: number;
  /** Cache-read tokens on those messages. */
  readTokens: number;
  /** Cache-creation tokens on those messages — what got rebuilt, if anything. */
  creationTokens: number;
  /** Share (0-1) of `requests` in this bucket whose message shows a cache
   *  rebuild (non-zero cache-creation). The near-100% rate above `longTtlMs`
   *  is what makes the gap-as-expiry-proxy credible (plan.md D1/limitation). */
  pctRebuilt: number;
}

/** One origin category for cache-creation volume — the breakdown that lets a
 *  reader check "mid-work writes dominate" rather than take it on trust
 *  (plan.md §4.2: the same class of claim `rule`/`threshold` make checkable on
 *  a hygiene finding). */
export interface TtlFitOriginRow {
  origin: "session-start" | "mid-work" | "resume-short" | "resume-long";
  creationTokens: number;
  /** Share (0-1) of `totals.writeTokens` this origin accounts for. */
  share: number;
}

/**
 * One model's contribution to the fit, priced from
 * `resolvePricing(model, rateOverrides).pricing`.
 *
 * The four `*CostAtShortTtl`/`netCostOfShortTtl`/`breakEvenRatio` fields are
 * `null` together, never individually — the D10 guard nulls this row's WHOLE
 * pricing half (not the token counts above it, which stay real numbers) when:
 *   - `pricing.ttlRateBasis === "synthesized"` (no source ever reported this
 *     model's 1-hour rate, so any derived premium is a guess wearing a signed
 *     dollar figure), or
 *   - the resolved rates are incoherent: `write5m - read <= 0` or
 *     `write1h - write5m < 0`.
 * A row this happens to is still a row in `byModel` (its token volume is
 * real); it differs from `unpricedRows` (model is `null`, or not in the
 * pricing table at all — see `TtlFitResult`), which is excluded from
 * `byModel` entirely.
 */
export interface TtlFitModelRow {
  model: string;
  /** `R` — cache reads recovered by the 1-hour TTL: reads on requests whose
   *  preceding same-session gap falls in `[shortTtlMs, longTtlMs)` AND which
   *  were themselves recorded at the 1-hour TTL (a gap in that band under a
   *  5-minute TTL already rebuilt — its reads were never "recovered"). */
  recoveredReadTokens: number;
  /** `W` — total cache-creation tokens for this model in the window
   *  (reported for the histogram/origin breakdown; NOT the term the cost
   *  arithmetic below uses — see `writeTokens1h`). */
  writeTokens: number;
  /** `W1h` — of `writeTokens`, the volume actually written at the 1-hour TTL
   *  (`Σ ephemeral1hCacheTokens`). This is the term `savedOnWritesAtShortTtl`
   *  uses: the 1-hour premium was only ever PAID on tokens written at that
   *  TTL. Using total `writeTokens` here would overstate the 5-minute
   *  saving by `W5m × (write1h - write5m)` on any `"mixed"` window — the C-1
   *  regression this build exists to fix. On an all-1h window `W1h === W`. */
  writeTokens1h: number;
  /** `recoveredReadTokens × (write5m - read) / 1e6` — reads recovered by the
   *  1-hour TTL become writes again under a 5-minute one. `null` under the
   *  D10 guard above. */
  extraCostAtShortTtl: number | null;
  /** `writeTokens1h × (write1h - write5m) / 1e6` — the 1-hour premium no
   *  longer paid if the 5-minute TTL were used instead. `null` under D10. */
  savedOnWritesAtShortTtl: number | null;
  /** `extraCostAtShortTtl - savedOnWritesAtShortTtl`. Negative ⇒ the
   *  5-minute TTL would have been cheaper for this model. `null` under D10. */
  netCostOfShortTtl: number | null;
  /** `(write1h - write5m) / (write5m - read)` — the R/W ratio above which the
   *  1-hour TTL pays off for this model's resolved rates (0.652 on the
   *  shipped table's uniform 2×/1.25× structure; DERIVED here, not assumed,
   *  so a `rateOverrides` table or a re-fetched rate table moves it
   *  correctly). `null` under D10. */
  breakEvenRatio: number | null;
}

/** The request/read volume immediately below `shortTtlMs` — the band whose
 *  gaps this analysis assumes do NOT also expire. Reported so a reader can
 *  judge how close to that assumption's edge the answer sits (plan.md §4.3);
 *  `impliedSwing` is what a verdict compares its own margin against. */
export interface TtlFitNearBoundary {
  /** Messages whose preceding gap falls in the band just under `shortTtlMs`. */
  requests: number;
  /** Cache-read tokens on those messages. */
  readTokens: number;
  /** Width of the band, in ms (i.e. `shortTtlMs - bandFloorMs`). */
  windowMs: number;
  /** One-directional sensitivity: if gaps just under `shortTtlMs` also
   *  expired, `recoveredReadTokens` would grow by (up to) `readTokens`,
   *  pushing every model's `netCostOfShortTtl` UP (the 5-minute TTL would
   *  look worse than reported) — never down. Computed the same way
   *  `extraCostAtShortTtl` is, over this band's tokens instead of the
   *  TTL-relevant band's. */
  impliedSwing: number;
}

/** One plain-language verdict, always paired with the margin that decided it
 *  (spec: "no verdict without the margin"). */
export interface TtlFitRecommendation {
  verdict: "prefer-1h" | "prefer-5m" | "too-close-to-call" | "insufficient-data";
  /** One sentence naming the number that decided it. */
  reason: string;
}

/**
 * The fit computed over one window's messages.
 *
 * `observedTtl` states which TTL the window was actually recorded at
 * (`observedTtlOf`, re-exported above) — a `"prefer-5m"` verdict computed from
 * a window recorded at `"1h"` is a projection/counterfactual, not a
 * measurement, and callers (the CLI, the MCP tool, the dashboard card) must
 * label it as such rather than presenting it with the same confidence as a
 * same-TTL measurement (plan.md §4.5).
 */
export interface TtlFitResult {
  gapHistogram: TtlFitGapBucket[];
  writesByOrigin: TtlFitOriginRow[];
  /** One row per model actually priced — excludes null-model and
   *  unpriced-model rows (see `unpricedRows`/`unpricedWriteTokens`); does NOT
   *  exclude a model whose pricing half is `null` under D10 (see
   *  `TtlFitModelRow`'s doc). */
  byModel: TtlFitModelRow[];
  totals: {
    recoveredReadTokens: number;
    writeTokens: number;
    writeTokens1h: number;
    /** Sum of `byModel[].netCostOfShortTtl` over rows where it is non-null.
     *  `null` when EVERY priced model's pricing half is null (D10), or when
     *  `observedTtl === "unknown"` (the gap half still computes; the pricing
     *  half does not — plan.md §4.5). Never a partial sum silently standing
     *  in for the whole. */
    netCostOfShortTtl: number | null;
  };
  /** The window's total equivalent-API cost (`sumCost` over the window,
   *  respecting each row's own TTL split) — the denominator the
   *  too-close-to-call rule (`|net| < 0.05 × windowCost`) checks against.
   *  Reported so a reader can verify the margin themselves rather than trust
   *  a bare verdict (spec §5.3: "no verdict without the margin"). */
  windowCost: number;
  nearBoundary: TtlFitNearBoundary;
  /** Which TTL the window's ephemeral columns show it was actually recorded
   *  at. `"unknown"` on pre-column rows (every row's split is `0`/`0`) — the
   *  gap-based half of the result still computes; every pricing-derived field
   *  above is `null`, and `recommendation.verdict` is always
   *  `"insufficient-data"` in that case (never a guessed `prefer-*`). */
  observedTtl: "1h" | "5m" | "mixed" | "unknown";
  recommendation: TtlFitRecommendation;
  /** Rows with `timestamp === null` — excluded from gap analysis (there is no
   *  gap to measure without an ordering) but counted here rather than
   *  silently dropped. Matches `reEntryBurn.ts`'s convention: a null on
   *  either side of a pair breaks that pair's chain rather than bridging it. */
  excludedRows: number;
  /** Rows whose `model` is `null`, or whose model is not in the resolved
   *  pricing table (`resolvePricing(...).pricing === null`) — real token
   *  volume that still contributes to `gapHistogram`/`writesByOrigin`, but is
   *  excluded from `byModel` and from `totals.netCostOfShortTtl`. Same
   *  honest-degrade convention `estimateCost`'s `known: false` uses. */
  unpricedRows: number;
  /** Cache-creation tokens on `unpricedRows`. */
  unpricedWriteTokens: number;
}

/**
 * Compute the cache-TTL fit over one window's messages.
 *
 * Contract (binding on the Phase B2 implementation):
 *
 *  - **Pure.** No store access, no wall clock, no `Date.now()`, no I/O. Same
 *    input, same output, always.
 *  - **Gaps are per-session.** Group `rows` with `groupBySession` (do not
 *    reimplement); a session's FIRST message is `"session-start"`, never a
 *    gap bucket — there is no preceding message to measure a gap against.
 *  - **Null timestamps** are excluded from gap analysis and counted in
 *    `excludedRows`, never silently dropped. A `null` on either side of a
 *    would-be pair breaks that pair rather than bridging across it
 *    (`reEntryBurn.ts`'s convention, deliberately matched).
 *  - **Null-model and unpriced-model rows** still contribute their real token
 *    counts to `gapHistogram`/`writesByOrigin`, but are excluded from
 *    `byModel` and from `totals.netCostOfShortTtl`; counted in `unpricedRows`
 *    / `unpricedWriteTokens` instead of silently vanishing.
 *  - **The D10 rate-coherence guard** (see `TtlFitModelRow`) nulls a priced
 *    model's pricing-derived fields — never its token counts — when its
 *    resolved rate is `"synthesized"` or incoherent.
 *  - **`observedTtl === "unknown"`** ⇒ every pricing-derived field is `null`
 *    (not `0`) and `recommendation.verdict` is always `"insufficient-data"`,
 *    with a reason naming the missing TTL columns. A `0` would read as "the
 *    two TTLs cost the same"; that is not what an absent column means.
 *  - **`insufficient-data`** when there are fewer than 50 rows with a usable
 *    timestamp, or `totals.writeTokens1h + (5m-attributed volume) < 5e6`
 *    (fewer than 5 MTok of cache-creation volume) — too little signal to
 *    recommend anything.
 *  - **`too-close-to-call`** when `|totals.netCostOfShortTtl| < 0.05 ×
 *    windowCost`, OR `|totals.netCostOfShortTtl| < nearBoundary.impliedSwing`
 *    — the margin does not clear the stated assumption's own sensitivity
 *    band. Otherwise the sign of `totals.netCostOfShortTtl` decides:
 *    negative ⇒ `"prefer-5m"`, positive ⇒ `"prefer-1h"`.
 *  - Defaults: `shortTtlMs` = 5 × 60 × 1000, `longTtlMs` = 60 × 60 × 1000.
 *
 * Phase B2 implements the body; Phase A2 (this file's author) only declares
 * the contract above so B1/B3/C1/C2 can build against it in parallel.
 */
export function computeTtlFit(
  rows: readonly HygieneMessageRow[],
  options?: TtlFitOptions,
): TtlFitResult {
  const { shortTtlMs, longTtlMs } = resolveTtlBounds(options);
  const overrides = options?.rateOverrides;
  // The band immediately below `shortTtlMs` whose gaps this analysis assumes do
  // NOT also expire. 20% of the short TTL — 4-5 min at the 5-minute default,
  // which is the band plan.md §4.3 reports the sensitivity over.
  const nearBoundaryWindowMs = shortTtlMs * NEAR_BOUNDARY_FRACTION;
  const nearBoundaryFloorMs = shortTtlMs - nearBoundaryWindowMs;

  // Four buckets, all derived from the two thresholds so a caller-supplied pair
  // moves them coherently. Bucket 1 IS the near-boundary band, so
  // `nearBoundary.requests/readTokens` and `gapHistogram[1]` are the same
  // measurement seen twice — a reader can cross-check them.
  const buckets = [
    { label: `<${minutesLabel(nearBoundaryFloorMs)} min`, minGapMs: 0, maxGapMs: nearBoundaryFloorMs },
    { label: `${minutesLabel(nearBoundaryFloorMs)}-${minutesLabel(shortTtlMs)} min`, minGapMs: nearBoundaryFloorMs, maxGapMs: shortTtlMs },
    { label: `${minutesLabel(shortTtlMs)}-${minutesLabel(longTtlMs)} min`, minGapMs: shortTtlMs, maxGapMs: longTtlMs },
    { label: `${minutesLabel(longTtlMs)}+ min`, minGapMs: longTtlMs, maxGapMs: null as number | null },
  ].map((def) => ({ ...def, requests: 0, readTokens: 0, creationTokens: 0, rebuiltRequests: 0 }));

  const originCreation = new Map<TtlFitOrigin, number>(ORIGINS.map((o) => [o, 0]));
  const models = new Map<string, ModelAccumulator>();
  // One `resolvePricing` per distinct raw model id, not per row.
  const resolutions = new Map<string, { canonical: string; pricing: ModelPricing | null }>();

  let excludedRows = 0;
  let unpricedRows = 0;
  let unpricedWriteTokens = 0;
  let timestampedRows = 0;
  /** Σ(5m + 1h) — the volume whose TTL the source actually reported. */
  let attributedWriteTokens = 0;
  let totalWriteTokens = 0;
  let totalWriteTokens1h = 0;
  let totalRecoveredReadTokens = 0;
  let nearBoundaryRequests = 0;
  let nearBoundaryReadTokens = 0;

  const observedTtl = observedTtlOf(rows);

  for (const group of groupBySession(rows)) {
    // Fallback TTL evidence for a row that wrote nothing of its own: a warm
    // read after a 5-60 min gap has no ephemeral columns to speak for it, and
    // on the motivating window >90% of that band's requests are exactly that.
    // Row-level evidence always wins; a session that is itself `"mixed"`,
    // `"5m"` or `"unknown"` supplies no fallback rather than a guess.
    const sessionTtl = observedTtlOf(group.messages);
    let prevTimestamp: number | null = null;

    for (const row of group.messages) {
      // Coerce here as well as in `estimateCost`: these columns arrive
      // unvalidated from JSONL and from another device's sync shard, and a
      // single `NaN` would poison every total below.
      const readTokens = nonNegativeFiniteInt(row.cacheReadTokens);
      const creationTokens = nonNegativeFiniteInt(row.cacheCreationTokens);
      const write5m = nonNegativeFiniteInt(row.ephemeral5mCacheTokens);
      const write1h = nonNegativeFiniteInt(row.ephemeral1hCacheTokens);

      // Volume totals count EVERY row, including null-timestamp and unpriced
      // ones — `totals.writeTokens` is the naive Σ cache_creation_tokens over
      // the window, and `excludedRows`/`unpricedWriteTokens` are what let a
      // reader subtract. (The regression this guards is a `W` counted once per
      // gap instead of once per turn, which inverts the whole answer.)
      totalWriteTokens += creationTokens;
      totalWriteTokens1h += write1h;
      attributedWriteTokens += write5m + write1h;

      let origin: TtlFitOrigin | null = null;
      let gapMs: number | null = null;
      const ts = row.timestamp;
      if (typeof ts !== "number" || !Number.isFinite(ts)) {
        // A null on either side of a pair breaks the chain rather than
        // bridging across it (`reEntryBurn.ts`'s convention, deliberately
        // matched) — hence `prevTimestamp = null` here.
        excludedRows++;
        prevTimestamp = null;
      } else {
        timestampedRows++;
        if (prevTimestamp === null) {
          // A session's first message, or the first measurable message after a
          // chain break: no preceding activity to measure a gap against.
          origin = "session-start";
        } else {
          // Rows arrive `ORDER BY timestamp ASC`; clamp anyway so a
          // out-of-order pair cannot produce a negative gap that matches no
          // bucket.
          gapMs = Math.max(0, ts - prevTimestamp);
          origin = gapMs < shortTtlMs ? "mid-work" : gapMs < longTtlMs ? "resume-short" : "resume-long";
        }
        prevTimestamp = ts;
      }

      if (origin !== null) originCreation.set(origin, originCreation.get(origin)! + creationTokens);

      // `R` — reads recovered BY the 1-hour TTL. Both conditions matter: the
      // gap must be in the band a 1-hour TTL survives and a 5-minute one does
      // not, AND the request must actually have been recorded at 1h (under a
      // 5-minute TTL that gap had already rebuilt, so its reads were never
      // "recovered").
      const recoveredReadTokens =
        gapMs !== null && gapMs >= shortTtlMs && gapMs < longTtlMs && isOneHourRecorded(write5m, write1h, sessionTtl)
          ? readTokens
          : 0;
      totalRecoveredReadTokens += recoveredReadTokens;

      let nearBoundaryRead = 0;
      if (gapMs !== null) {
        // Indexed rather than searched: the four buckets partition [0, ∞), so
        // every clamped gap lands in exactly one and there is no unreachable
        // "no bucket matched" guard to pin. Same boundaries the origin
        // classification above uses — one definition, read twice.
        const bucket = buckets[gapMs < nearBoundaryFloorMs ? 0 : gapMs < shortTtlMs ? 1 : gapMs < longTtlMs ? 2 : 3]!;
        bucket.requests++;
        bucket.readTokens += readTokens;
        bucket.creationTokens += creationTokens;
        if (creationTokens > 0) bucket.rebuiltRequests++;
        if (gapMs >= nearBoundaryFloorMs && gapMs < shortTtlMs) {
          nearBoundaryRequests++;
          nearBoundaryReadTokens += readTokens;
          nearBoundaryRead = readTokens;
        }
      }

      const resolved = row.model === null ? null : resolveCached(resolutions, row.model, overrides);
      if (resolved === null || resolved.pricing === null) {
        // Null model, or a model this build has no rate for. The token volume
        // above is real and already counted; the cost half is not guessed at.
        unpricedRows++;
        unpricedWriteTokens += creationTokens;
        continue;
      }

      let acc = models.get(resolved.canonical);
      if (acc === undefined) {
        acc = {
          model: resolved.canonical,
          pricing: resolved.pricing,
          recoveredReadTokens: 0,
          writeTokens: 0,
          writeTokens1h: 0,
          nearBoundaryReadTokens: 0,
        };
        models.set(resolved.canonical, acc);
      }
      acc.recoveredReadTokens += recoveredReadTokens;
      acc.writeTokens += creationTokens;
      acc.writeTokens1h += write1h;
      acc.nearBoundaryReadTokens += nearBoundaryRead;
    }
  }

  const priced = [...models.values()]
    .sort((a, b) => b.writeTokens - a.writeTokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    .map((acc) => ({ acc, rates: ttlRatesOf(acc.pricing, observedTtl) }));

  const byModel: TtlFitModelRow[] = priced.map(({ acc, rates }) => {
    // `extra` and `saved` are DERIVED from the resolved table — never the
    // shipped 1.15×/0.75× constants. On the shipped uniform structure they
    // reduce to exactly those (read 0.1× input, write5m 1.25×, write1h 2×:
    // write5m-read = 1.15× input, write1h-write5m = 0.75× input, break-even
    // 0.652), but a `rateOverrides` table or a re-fetched one moves them.
    const extra = rates === null ? null : (acc.recoveredReadTokens * rates.readToWritePremium) / 1e6;
    const saved = rates === null ? null : (acc.writeTokens1h * rates.oneHourPremium) / 1e6;
    return {
      model: acc.model,
      recoveredReadTokens: acc.recoveredReadTokens,
      writeTokens: acc.writeTokens,
      writeTokens1h: acc.writeTokens1h,
      extraCostAtShortTtl: extra,
      savedOnWritesAtShortTtl: saved,
      netCostOfShortTtl: extra === null || saved === null ? null : extra - saved,
      breakEvenRatio: rates === null ? null : rates.oneHourPremium / rates.readToWritePremium,
    };
  });

  const netParts = byModel.map((r) => r.netCostOfShortTtl).filter((n): n is number => n !== null);
  const netCostOfShortTtl = netParts.length === 0 ? null : netParts.reduce((a, b) => a + b, 0);

  // Upper bound on the sensitivity, computed the same way `extraCostAtShortTtl`
  // is: if the band just under `shortTtlMs` also expired, up to all of its read
  // volume would join `R`. Unpriced and rate-guarded models contribute nothing
  // — there is no rate to price their share with.
  const impliedSwing = priced.reduce(
    (sum, { acc, rates }) => (rates === null ? sum : sum + (acc.nearBoundaryReadTokens * rates.readToWritePremium) / 1e6),
    0,
  );

  const windowCost = sumCost(rows, overrides);

  const totals = {
    recoveredReadTokens: totalRecoveredReadTokens,
    writeTokens: totalWriteTokens,
    writeTokens1h: totalWriteTokens1h,
    netCostOfShortTtl,
  };

  const nearBoundary: TtlFitNearBoundary = {
    requests: nearBoundaryRequests,
    readTokens: nearBoundaryReadTokens,
    windowMs: nearBoundaryWindowMs,
    impliedSwing,
  };

  return {
    gapHistogram: buckets.map((b) => ({
      label: b.label,
      minGapMs: b.minGapMs,
      maxGapMs: b.maxGapMs,
      requests: b.requests,
      readTokens: b.readTokens,
      creationTokens: b.creationTokens,
      pctRebuilt: b.requests === 0 ? 0 : b.rebuiltRequests / b.requests,
    })),
    writesByOrigin: ORIGINS.map((origin) => {
      const creationTokens = originCreation.get(origin)!;
      return { origin, creationTokens, share: totalWriteTokens === 0 ? 0 : creationTokens / totalWriteTokens };
    }),
    byModel,
    totals,
    windowCost,
    nearBoundary,
    observedTtl,
    recommendation: recommend({
      observedTtl,
      timestampedRows,
      totalRows: rows.length,
      attributedWriteTokens,
      totals,
      windowCost,
      nearBoundary,
      byModel,
    }),
    excludedRows,
    unpricedRows,
    unpricedWriteTokens,
  };
}

// ─── Internals ───────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const DEFAULT_SHORT_TTL_MS = 5 * MINUTE_MS;
const DEFAULT_LONG_TTL_MS = 60 * MINUTE_MS;
/** Width of the near-boundary band, as a share of `shortTtlMs`. */
const NEAR_BOUNDARY_FRACTION = 0.2;
/** Below this many timestamped requests there is no gap distribution to read. */
const MIN_TIMESTAMPED_REQUESTS = 50;
/** Below this much TTL-attributed cache-creation volume there is no signal. */
const MIN_ATTRIBUTED_WRITE_TOKENS = 5_000_000;
/** `|net|` under this share of the window's cost is not worth acting on. */
const TOO_CLOSE_COST_FRACTION = 0.05;

type TtlFitOrigin = TtlFitOriginRow["origin"];
const ORIGINS: readonly TtlFitOrigin[] = ["session-start", "mid-work", "resume-short", "resume-long"];

interface ModelAccumulator {
  model: string;
  pricing: ModelPricing;
  recoveredReadTokens: number;
  writeTokens: number;
  writeTokens1h: number;
  nearBoundaryReadTokens: number;
}

/** The two per-MTok premiums the arithmetic needs, or `null` when this model's
 *  rates must not produce a signed dollar figure (D10). */
interface TtlPremiums {
  /** `write5m - read` — what a recovered read costs once it becomes a write. */
  readToWritePremium: number;
  /** `write1h - write5m` — what the 1-hour TTL charges extra per written token. */
  oneHourPremium: number;
}

function resolveTtlBounds(options?: TtlFitOptions): { shortTtlMs: number; longTtlMs: number } {
  const short = options?.shortTtlMs;
  const long = options?.longTtlMs;
  const s = typeof short === "number" && Number.isFinite(short) && short > 0 ? short : DEFAULT_SHORT_TTL_MS;
  const l = typeof long === "number" && Number.isFinite(long) && long > 0 ? long : DEFAULT_LONG_TTL_MS;
  // An incoherent pair (long ≤ short) would silently empty the TTL-relevant
  // band and pin every verdict to `prefer-5m`. Fall back to the documented
  // defaults instead of computing a confident answer from a degenerate window.
  if (!(l > s)) return { shortTtlMs: DEFAULT_SHORT_TTL_MS, longTtlMs: DEFAULT_LONG_TTL_MS };
  return { shortTtlMs: s, longTtlMs: l };
}

/** Was this request recorded at the 1-hour TTL? Row-level evidence wins; a row
 *  that wrote nothing (so has no evidence of its own) falls back to its
 *  session's TTL only when that session is unambiguously `"1h"`. */
function isOneHourRecorded(write5m: number, write1h: number, sessionTtl: "1h" | "5m" | "mixed" | "unknown"): boolean {
  if (write1h > 0) return true;
  if (write5m > 0) return false;
  return sessionTtl === "1h";
}

/**
 * The D10 rate-coherence guard, in one place. Returns `null` — meaning "this
 * model's pricing half is `null`, its token counts stay real" — when the
 * 1-hour rate was synthesized rather than reported, when the resolved rates are
 * incoherent, or when the window carries no TTL columns at all (in which case
 * `R` and `W1h` are both structurally `0` and a `0` net would read as "the two
 * TTLs cost the same", which is not what an absent column means).
 */
function ttlRatesOf(p: ModelPricing, observedTtl: TtlFitResult["observedTtl"]): TtlPremiums | null {
  if (observedTtl === "unknown") return null;
  if (p.ttlRateBasis === "synthesized") return null;
  const read = p.cacheReadPerMillion;
  const write5m = p.cacheWritePerMillion;
  const write1h = p.cacheWrite1hPerMillion;
  if (!Number.isFinite(read) || !Number.isFinite(write5m) || !Number.isFinite(write1h)) return null;
  const readToWritePremium = write5m - read;
  const oneHourPremium = write1h - write5m;
  if (!(readToWritePremium > 0)) return null;
  if (oneHourPremium < 0) return null;
  return { readToWritePremium, oneHourPremium };
}

function resolveCached(
  cache: Map<string, { canonical: string; pricing: ModelPricing | null }>,
  model: string,
  overrides: RateOverrides | undefined,
): { canonical: string; pricing: ModelPricing | null } {
  const hit = cache.get(model);
  if (hit !== undefined) return hit;
  const { canonical, pricing } = resolvePricing(model, overrides);
  // Keyed by the CANONICAL id, so `claude-opus-5` and a Bedrock/Vertex id for
  // the same model are one row rather than three.
  const entry = { canonical, pricing };
  cache.set(model, entry);
  return entry;
}

/** Locale-independent minute label — a prior CI failure in this repo came from
 *  a host-locale-formatted number reaching an assertion. */
function minutesLabel(ms: number): string {
  const rounded = Math.round((ms / MINUTE_MS) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function recommend(input: {
  observedTtl: TtlFitResult["observedTtl"];
  timestampedRows: number;
  totalRows: number;
  attributedWriteTokens: number;
  totals: TtlFitResult["totals"];
  windowCost: number;
  nearBoundary: TtlFitNearBoundary;
  byModel: TtlFitModelRow[];
}): TtlFitRecommendation {
  const { observedTtl, timestampedRows, totalRows, attributedWriteTokens, totals, windowCost, nearBoundary } = input;

  if (observedTtl === "unknown") {
    return {
      verdict: "insufficient-data",
      reason:
        "These messages carry no cache-TTL breakdown (ephemeral_5m_cache_tokens and ephemeral_1h_cache_tokens are zero on every row), " +
        "so the cost half of this analysis cannot be computed; the gap distribution is still measured.",
    };
  }
  if (timestampedRows < MIN_TIMESTAMPED_REQUESTS) {
    return {
      verdict: "insufficient-data",
      reason: `Only ${timestampedRows} of ${totalRows} messages carry a usable timestamp; at least ${MIN_TIMESTAMPED_REQUESTS} are needed before a gap distribution says anything.`,
    };
  }
  if (attributedWriteTokens < MIN_ATTRIBUTED_WRITE_TOKENS) {
    return {
      verdict: "insufficient-data",
      reason: `Only ${attributedWriteTokens} cache-creation tokens are attributed to a TTL; at least ${MIN_ATTRIBUTED_WRITE_TOKENS} are needed before the difference between the two TTLs is worth reporting.`,
    };
  }

  const net = totals.netCostOfShortTtl;
  if (net === null) {
    return {
      verdict: "insufficient-data",
      reason:
        "No model in this window has a usable 1-hour cache-write rate (each one's rate was synthesized rather than reported, or is incoherent), " +
        "so no signed cost difference can be reported.",
    };
  }

  const magnitude = Math.abs(net);
  const costMargin = TOO_CLOSE_COST_FRACTION * windowCost;
  if (magnitude < costMargin) {
    return {
      verdict: "too-close-to-call",
      reason: `The difference between the two TTLs is ${money(magnitude)} over a window costing ${money(windowCost)} — below the ${Math.round(TOO_CLOSE_COST_FRACTION * 100)}% margin this tool requires before recommending a switch.`,
    };
  }
  if (magnitude < nearBoundary.impliedSwing) {
    return {
      verdict: "too-close-to-call",
      reason: `The difference between the two TTLs is ${money(magnitude)}, smaller than the ${money(nearBoundary.impliedSwing)} near-boundary sensitivity band (${nearBoundary.requests} requests, ${nearBoundary.readTokens} cache-read tokens in the ${minutesLabel(nearBoundary.windowMs)} min just under the short TTL).`,
    };
  }
  // No `net === 0` branch: a zero net is always below the 5% margin of a
  // priced window (a window with any attributed write volume costs something),
  // so it has already returned `too-close-to-call` above. Pinning an
  // unreachable guard here would be verification theatre.
  if (net < 0) {
    return {
      verdict: "prefer-5m",
      reason: `The 5-minute TTL would have cost ${money(magnitude)} less over this window: it gives up ${totals.recoveredReadTokens} recovered cache-read tokens but stops paying the 1-hour premium on ${totals.writeTokens1h} written tokens.`,
    };
  }
  return {
    verdict: "prefer-1h",
    reason: `The 1-hour TTL is worth ${money(magnitude)} over this window: the ${totals.recoveredReadTokens} cache-read tokens it recovers outweigh the premium it pays on ${totals.writeTokens1h} written tokens.`,
  };
}
