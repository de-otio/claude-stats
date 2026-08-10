/**
 * Auto-compact window fit — "what should `autoCompactWindow` be set to?"
 *
 * Pure module, functional-core style: one `ContextCarryResult` in (never rows —
 * decision D1: the CLI and dashboard already compute the carry result once, and
 * every input this needs is on that interface), an `AutoCompactFitResult` out.
 * No store, no clock, no `Date.now()`, no I/O, **no `process.env`** (§7/SR-9 —
 * reading the configured window from disk or the environment is deferred, and
 * an environment-derived value must not reach a result that crosses MCP). Same
 * input, same output, always.
 *
 * Design: `plans/autocompact-window-fit/plan.md`, corrected per
 * `plans/autocompact-window-fit/IMPLEMENTATION.md` §0/§3 (rev 2). The
 * corrections C6/C7/C8/C9/C10/C11 are load-bearing and each is named at the
 * line that implements it — rev 1 of the plan was arithmetically wrong at every
 * one of them, in ways that still produced plausible-looking output.
 *
 * The three things a reader should know before trusting a number from here:
 *
 *  1. **Capping does not clip the sawtooth, it wraps it.** A smaller window does
 *     not truncate the context and continue — it resets to the floor and climbs
 *     again, so the same increments happen across more, shorter cycles. That is
 *     why this module SIMULATES (D2) instead of reading `aboveCap` out loud:
 *     `aboveCap` understates the volume a window at `C` would remove.
 *  2. **The saving is an upper bound.** The identical-work assumption — that the
 *     same work gets done with less context in front of the model — cannot be
 *     tested from token counts. The gap is rework, and rework is not measured
 *     anywhere in this tool. See `savingCaveat`, which every surface renders on
 *     the same line as any dollar figure (D5).
 *  3. **This is not an argmax** (D3). `netSaving` is monotone decreasing in `C`
 *     over the range that matters, so an optimiser recommends 100K on any real
 *     workload — arithmetically correct, practically wrong. The headline is the
 *     CONSERVATIVE end of a range, and the decision variable handed to the
 *     reader is the resulting median cycle length in requests, not the dollars.
 */
import { normalizeModelId, resolvePricing, type RateOverrides } from "./pricing.js";
import type { ContextCarryResult, ContextCarryTurn } from "./contextCarry.js";

/** Tunable knobs. Every field optional; see `computeAutoCompactFit`'s JSDoc for
 *  the defaults each falls back to when omitted. */
export interface AutoCompactFitOptions {
  /** Candidate windows, in tokens. An explicitly empty list is honoured (no
   *  candidates); only `undefined` falls back to the default grid — the same
   *  convention `ContextCarryOptions.capsTokens` uses. Normalised (finite,
   *  de-duplicated, ascending) and then CAPPED at 64 entries (SR-8): there are
   *  900,001 integers in the settable range and the simulation is
   *  O(candidates × turns). Entries past the cap are recorded as
   *  `out-of-range` drops rather than silently discarded. */
  candidatesTokens?: readonly number[];
  /** REQUIRED in practice (CR-4). This module calls `resolvePricing` itself —
   *  `turns[].carryCost` CANNOT be inverted to recover a rate (it is
   *  `increment × remaining × rate / 1e6` PLUS `resetRequestCost` on each closed
   *  cycle's last turn, and `increment` may be `0` or negative) — so the caller
   *  MUST pass the same overrides it gave `computeContextCarry`, or the two
   *  blocks in one CLI output disagree on dollars. */
  rateOverrides?: RateOverrides;
  /** D13: the `resetMinBeforeTokens` floor the caller passed to
   *  `computeContextCarry` when producing `carry`. Reported verbatim as
   *  `resetFloorUsed` so a reader can see why this block's reset count differs
   *  from the one the same screen shows above it. Purely descriptive — nothing
   *  in this module recomputes resets. Defaults to
   *  `hygiene/util.ts`'s 150,000 when omitted or non-finite. */
  resetFloorUsed?: number;
}

/** Why a candidate window was dropped from the grid before it was simulated. */
export type AutoCompactFitDropReason = "below-floor" | "at-or-above-peak" | "out-of-range";

export interface AutoCompactFitDroppedCandidate {
  windowTokens: number;
  reason: AutoCompactFitDropReason;
}

/** One simulated window. Token figures are always real; the dollar figure
 *  degrades to `null`, never `0` (D6). */
export interface AutoCompactFitCandidate {
  windowTokens: number;
  /** `closedCycleCarriedTokens` − Σ simulated carried volume. Non-increasing in
   *  `windowTokens`. Real tokens including unpriced models' — only the dollar
   *  half degrades. */
  savedTokens: number;
  /** Σ simulated cuts (C7). **Not** net of the observed reset count: each
   *  closed cycle already ended in an observed reset that the simulation
   *  re-assumes by restarting from the floor, so subtracting the observed count
   *  yields `Σ cuts − #closedCycles`, which goes NEGATIVE whenever `C` exceeds
   *  every peak and inflates `netSaving` by `#closedCycles × meanResetCost`. */
  extraResets: number;
  /** `Σ (saved tokens × that turn's model's cache-read rate)` −
   *  `extraResets × meanResetCost`. `null` — never `0` — when no closed-cycle
   *  turn resolves to a rate, or when cuts must be priced and no reset in the
   *  window was priced. Never `NaN`. */
  netSaving: number | null;
  /** Median SEGMENT length in requests across the closed cycles under this
   *  window (CR-13) — the decision variable. A cycle cut `k` times yields
   *  `k + 1` segments, and every segment length enters the median. Compare
   *  against `observedMedianCycleRequests`, which is a median too (never a
   *  simulated median against an observed mean). `0` when there is no closed
   *  cycle to segment. */
  medianCycleRequests: number;
}

/**
 * The verdict and the numbers that decided it.
 *
 * `reason` is STRUCTURED (`reasonCode` + numeric `reasonFacts`), never free text
 * — SR-2/D14. `ttlFit.ts`'s English prose crosses MCP verbatim, lands in
 * `--json` output users paste into tickets, and is un-renderable on the
 * dashboard for being untranslated. Worse, the model-mix limitation (C4) makes
 * NAMING THE MODELS inside such a string the obvious implementation, which puts
 * raw model ids — a Bedrock ARN carries an AWS account id; a gateway alias is in
 * practice named after the team, product or client that provisioned it — into a
 * string no key-name assertion can inspect. **`reasonFacts` values are NUMBERS
 * ONLY**, and every one of them is finite.
 */
export interface AutoCompactFitRecommendation {
  verdict: "recommend-window" | "already-tuned" | "too-close-to-call" | "insufficient-data";
  /** The value to actually set — the CONSERVATIVE end of `range`. `null`
   *  whenever `range` is `null` (C10). */
  recommendedTokens: number | null;
  /** `[conservative, aggressive]` — plan.md §4.4's stated order, so
   *  `range[0] === recommendedTokens` and `range[0] >= range[1]`. Both ends are
   *  defensible and the reader picks; surfaces render the pair accordingly
   *  (largest first), never as an ascending interval.
   *
   * Computed **only** when the aggressive end's `netSaving` is non-null AND
   * strictly positive (C10). A zero threshold would make every candidate
   * qualify and recommend the top of the grid; a negative one would do the same;
   * a null one is undefined. And `netSaving` is **not** monotone (`savedTokens`
   * and `extraResets` are each non-increasing in `C`, but their weighted
   * difference is neither), so the conservative end is found by scanning ALL
   * candidates, not the top of a contiguous prefix. */
  range: [number, number] | null;
  reasonCode:
    | "no-sawtooth"
    | "too-few-rows"
    | "partition-invalid"
    | "non-finite-input"
    | "nothing-priced"
    | "grid-empty-below-floor"
    | "peaks-below-smallest-window"
    | "peak-at-candidate"
    | "saving-under-margin"
    | "recommended";
  reasonFacts: Readonly<Record<string, number>>;
}

export interface AutoCompactFitResult {
  /** Surviving candidates, ascending by `windowTokens`. */
  candidates: AutoCompactFitCandidate[];
  droppedCandidates: AutoCompactFitDroppedCandidate[];
  recommendation: AutoCompactFitRecommendation;
  /**
   * The baseline the saving is measured against: `Σ increment ×
   * remainingRequestsInCycle` over the CLOSED cycles' turns (D10). That is the
   * module's own exact partition identity (`contextCarry.ts`'s implementation
   * notes; pinned as an equality by the suite), not a re-derived running
   * context.
   *
   * `carry.carriedTokens` is NOT this number and must never stand in for it: it
   * sums `totalContext` over EVERY row, so subtracting a closed-cycles-only
   * simulation from it credits every open cycle's whole volume — and every
   * null-timestamp row's — to the saving (C3). The three components below sum to
   * `carry.carriedTokens`, so a reader can reconcile the denominator.
   */
  closedCycleCarriedTokens: number;
  /** Same identity over the OPEN cycles — excluded from every figure above.
   *  An open cycle's turn list is truncated by the window edge, so simulating it
   *  would model a cycle that has not finished happening. */
  openCycleCarriedTokens: number;
  /** `carry.carriedTokens − closedCycleCarriedTokens − openCycleCarriedTokens`
   *  — the volume on rows that sit in no cycle at all (null-timestamp rows,
   *  `carry.excludedRows`). Reported rather than folded into either side. */
  excludedRowCarriedTokens: number;
  openCyclesExcluded: number;
  /** `sawtooth.floorTokens` — the observed post-reset floor, and the level a
   *  simulated cut restarts from. An earlier compaction summarises a shorter
   *  conversation and would plausibly land LOWER, so using the observed floor
   *  understates savings. Stated, not modelled. */
  observedFloorTokens: number | null;
  /** `sawtooth.peakTokens` — the MEAN of `resets[].beforeTokens`
   *  (`contextCarry.ts`'s own definition). Reported for the reader; NOT what the
   *  candidate filter uses. */
  observedPeakTokens: number | null;
  /** `max(resets[].beforeTokens)` — what the `at-or-above-peak` filter and the
   *  `already-tuned` proximity test use (C9). Dropping candidates at the MEAN
   *  peak discards windows that would still cut every cycle whose own peak
   *  exceeded them — on a wide spread, roughly half of them, and a large real
   *  saving. */
  observedMaxPeakTokens: number | null;
  /** Median requests per CLOSED cycle as observed (CR-13) — a median, so it is
   *  comparable with each candidate's `medianCycleRequests`. `null` when there
   *  is no closed cycle. Deliberately not `sawtooth.requestsPerCycle`, which is
   *  a mean. */
  observedMedianCycleRequests: number | null;
  /** D13 — the adaptive reset floor this fit was computed at, and the default,
   *  so a reader can see why this block's reset count differs from the one the
   *  screen above it shows. Descriptive only: passed in by the caller that ran
   *  the second `computeContextCarry` pass. */
  resetFloorUsed: number;
  resetFloorDefault: number;
  /**
   * C4 + SR-3. **The models are NORMALISED here, in core, so all three surfaces
   * inherit it.** `ContextCarryTurn.model` is the RAW transcript string and
   * `normalizeModelId` passes unrecognised ids through UNCHANGED
   * (`pricing.ts`): a raw id can be a Bedrock ARN (AWS account id + region), a
   * gateway alias (in practice named after the team, product or client that
   * provisioned it), or a self-hosted alias encoding an internal hostname. So
   * `models` lists ONLY ids present in the resolved pricing table; everything
   * else — including `null` models — collapses into `unknownModels` as a COUNT
   * of distinct ids, never echoed. (Scope honesty: raw ids already reach MCP via
   * `byModel` and the org plane via `AggregateSyncInput.models`. This module does
   * not fix those; it declines to become a third site.)
   *
   * **`uniform` is not a clamp.** Claude Code caps the auto-compact window at
   * the model's own context window, and core has no context-window column, so
   * this build CANNOT detect that clamp (C4/CR-10) — a 1M recommendation on a
   * 200K-context session is a UNIFORM window, and `uniform === false` never
   * fires there. Surfaces state the limitation plainly rather than presenting
   * `modelMix` as the mitigation.
   */
  modelMix: { uniform: boolean; models: string[]; unknownModels: number };
  /** Fixed caveat. Surfaces MUST render it on the same line as any dollar
   *  figure, never in a footnote (D5). The CLI and MCP carry it verbatim; the
   *  dashboard renders its own locale key instead, because `template.ts` forbids
   *  rendering core-composed English raw. */
  savingCaveat: string;
  /** `[100_000, 1_000_000]` — Claude Code's settable range for
   *  `autoCompactWindow`, verified against
   *  <https://code.claude.com/docs/en/context-window> on 2026-08-10. */
  settableRange: readonly [number, number];
}

/**
 * Compute the auto-compact window fit from an already-computed context-carry
 * result.
 *
 * Contract:
 *
 *  - **Pure.** No store, no clock, no `Date.now()`, no I/O, no `process.env`.
 *  - **Simulate, never approximate** (D2). For each CLOSED cycle, replay its
 *    `turns[].increment` sequence and cut whenever the running context would
 *    exceed the candidate; see `simulateSlice` for the three corrections the
 *    replay embodies (C6 first-increment guard, C6 floor-after-cut seating, C11
 *    signed-increment clamp).
 *  - **The `turns`/`cycles` correspondence is reconstructed and checked, not
 *    assumed** (C1/D11). It is an undocumented implementation invariant of
 *    `computeContextCarry`, now written down on `ContextCarryResult.turns`. A
 *    partition this module cannot verify must not be priced.
 *  - **Every consumed numeric field must be finite** (SR-4), `cycles[].requests`
 *    a non-negative safe integer, and the reconstructed slice offsets must end
 *    exactly at `turns.length`. This module takes a PLAIN OBJECT — the glue's
 *    row-level sanitising ends at the row boundary and anything round-tripping a
 *    result through JSON can poison it. A `NaN` floor makes every `>` comparison
 *    `false`, so the guards silently no-op; and `JSON.stringify` emits `NaN` as
 *    `null`, which is indistinguishable from D6's "nothing was priced".
 *    Violation ⇒ `insufficient-data`, `reasonCode: "non-finite-input"`.
 *    **This function never emits `NaN` or `Infinity`.**
 *  - **Pricing** resolves from `turns[].model` via `resolvePricing`;
 *    `turns[].carryCost` cannot be inverted (see `AutoCompactFitOptions`).
 *    `meanResetCost` EXCLUDES unpriced resets — `messageCost` returns `0` for an
 *    unpriced model, which would otherwise drag the mean down silently, contrary
 *    to the honest-degrade convention everywhere else.
 *  - **Verdict ladder, in this order:** `insufficient-data` → `already-tuned` →
 *    `too-close-to-call` → `recommend-window`. See `§3.4` of the implementation
 *    plan; each rung's trigger is named on `reasonCode`.
 *  - Defaults: `candidatesTokens` = `[100K, 150K, 200K, 250K, 300K, 400K, 500K,
 *    750K, 1M]`, `resetFloorUsed` = 150,000.
 */
export function computeAutoCompactFit(
  carry: ContextCarryResult,
  options?: AutoCompactFitOptions,
): AutoCompactFitResult {
  const rateOf = makeRateResolver(options?.rateOverrides);
  const resetFloorUsed =
    typeof options?.resetFloorUsed === "number" && Number.isFinite(options.resetFloorUsed) && options.resetFloorUsed > 0
      ? options.resetFloorUsed
      : DEFAULT_RESET_FLOOR_TOKENS;

  const shell: ResultShell = {
    modelMix: buildModelMix(carry.turns, rateOf),
    resetFloorUsed,
    resetFloorDefault: DEFAULT_RESET_FLOOR_TOKENS,
  };

  // ── Ladder rung 1: insufficient-data, structural. Each of these returns a
  // result with an EMPTY candidate list — there is nothing to simulate against.
  // ──────────────────────────────────────────────────────────────────────────
  const sawtooth = carry.sawtooth;
  if (sawtooth === null) {
    return degraded(shell, "no-sawtooth", { resets: carry.resets.length, minResets: MIN_RESETS_FOR_SAWTOOTH });
  }
  if (carry.turns.length < MIN_TURNS) {
    return degraded(
      shell,
      "too-few-rows",
      { turns: carry.turns.length, minTurns: MIN_TURNS },
      { floor: finiteOrNull(sawtooth.floorTokens), peak: finiteOrNull(sawtooth.peakTokens) },
    );
  }
  // SR-4 runs BEFORE the partition check on purpose: `cycles: [{requests: -5},
  // {requests: N + 5}]` is a numeric-domain violation that would otherwise be
  // reported as a partition failure, hiding which invariant the input broke.
  const nonFinite = firstNonFiniteField(carry, sawtooth);
  if (nonFinite !== null) {
    return degraded(shell, "non-finite-input", nonFinite);
  }
  const slices = reconstructSlices(carry);
  if (slices === null) {
    return degraded(
      shell,
      "partition-invalid",
      { turns: carry.turns.length, cycles: carry.cycles.length },
      { floor: sawtooth.floorTokens, peak: sawtooth.peakTokens },
    );
  }

  // ── Observed baseline, via the module's own partition identity (C3/D10). ───
  const floorTokens = sawtooth.floorTokens;
  const maxPeakTokens = Math.max(...carry.resets.map((r) => r.beforeTokens));
  let closedCycleCarriedTokens = 0;
  let openCycleCarriedTokens = 0;
  let openCyclesExcluded = 0;
  const closed: PricedSlice[] = [];
  const closedCycleRequests: number[] = [];
  for (const slice of slices) {
    let volume = 0;
    for (const turn of slice.turns) volume += turn.increment * turn.remainingRequestsInCycle;
    if (slice.open) {
      openCycleCarriedTokens += volume;
      openCyclesExcluded++;
      continue;
    }
    closedCycleCarriedTokens += volume;
    closedCycleRequests.push(slice.turns.length);
    closed.push({
      increments: slice.turns.map((t) => t.increment),
      // Resolved ONCE here rather than inside the per-candidate loop.
      rates: slice.turns.map((t) => rateOf(t.model)),
    });
  }
  const anyPricedTurn = closed.some((s) => s.rates.some((r) => r !== null));
  const meanResetCost = meanPricedResetCost(carry);

  // ── The grid (§3.2). ──────────────────────────────────────────────────────
  const { surviving, dropped } = buildGrid(options?.candidatesTokens, floorTokens, maxPeakTokens);

  const candidates: AutoCompactFitCandidate[] = surviving.map((windowTokens) => {
    let savedTokens = 0;
    let pricedSaving = 0;
    let extraResets = 0;
    const segments: number[] = [];
    for (const slice of closed) {
      const sim = simulateSlice(slice, windowTokens, floorTokens, segments);
      savedTokens += sim.savedTokens;
      pricedSaving += sim.pricedSaving;
      extraResets += sim.cuts;
    }
    // The cut term is only needed when there ARE cuts to price; an unpriced
    // reset population must not null a candidate that never cuts.
    const resetCost = extraResets === 0 ? 0 : meanResetCost === null ? null : extraResets * meanResetCost;
    const net = !anyPricedTurn || resetCost === null ? null : pricedSaving - resetCost;
    return {
      windowTokens,
      savedTokens,
      extraResets,
      netSaving: net !== null && Number.isFinite(net) ? net : null,
      medianCycleRequests: median(segments) ?? 0,
    };
  });

  const observed: Observed = {
    closedCycleCarriedTokens,
    openCycleCarriedTokens,
    excludedRowCarriedTokens: carry.carriedTokens - closedCycleCarriedTokens - openCycleCarriedTokens,
    openCyclesExcluded,
    observedFloorTokens: floorTokens,
    observedPeakTokens: sawtooth.peakTokens,
    observedMaxPeakTokens: maxPeakTokens,
    observedMedianCycleRequests: median(closedCycleRequests),
  };

  return {
    ...shellOut(shell),
    ...observed,
    candidates,
    droppedCandidates: dropped,
    recommendation: recommend({
      candidates,
      dropped,
      maxPeakTokens,
      totalCarryCost: carry.totalCarryCost,
    }),
  };
}

// ─── Internals ───────────────────────────────────────────────────────────────

const DEFAULT_CANDIDATES_TOKENS: readonly number[] = [
  100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
];
/** Claude Code's settable range for `autoCompactWindow` — verified against
 *  <https://code.claude.com/docs/en/context-window>, 2026-08-10. */
const SETTABLE_RANGE: readonly [number, number] = [100_000, 1_000_000];
/** SR-8: 900,001 integers are settable and the simulation is O(candidates ×
 *  turns). A caller-supplied list longer than this is truncated, and the
 *  overflow is RECORDED (as `out-of-range`) rather than silently dropped. */
const MAX_CANDIDATES = 64;
/** CR-14: the same 50-request floor `ttlFit.ts` keeps. Rev 1 of the plan dropped
 *  it silently. */
const MIN_TURNS = 50;
/** Mirrors `contextCarry.ts`'s own threshold — reported as a fact on the
 *  `no-sawtooth` reason so the reader knows how many resets were short. */
const MIN_RESETS_FOR_SAWTOOTH = 3;
/** A window that leaves under half a cycle of headroom above the observed floor
 *  is not a configuration, it is a crash loop. */
const FLOOR_HEADROOM_MULTIPLE = 1.5;
/** C5: a max peak within this fraction of a surviving candidate means the
 *  workload is already compacting about where a window would put it. Peak
 *  PROXIMITY, not savings — the savings test can never fire, because
 *  `savedTokens` is monotone decreasing and therefore always points BELOW the
 *  current peak, so a savings-based `already-tuned` has no fixed point. */
const ALREADY_TUNED_FRACTION = 0.15;
/** `ttlFit.ts`'s margin, against a different denominator — see `SAVING_CAVEAT`. */
const TOO_CLOSE_COST_FRACTION = 0.05;
/**
 * `hygiene/util.ts`'s `DEFAULT_RESET_MIN_BEFORE_TOKENS`, which is module-private
 * there and so cannot be imported. Duplicated deliberately and only as a
 * REPORTED value (`resetFloorDefault`) — nothing here recomputes resets, so a
 * drift between the two constants changes a displayed number, never an
 * arithmetic result. Keep in sync with `hygiene/util.ts`.
 */
const DEFAULT_RESET_FLOOR_TOKENS = 150_000;

/** Distinct key for a `null` model in the mix. Never emitted. */
const NULL_MODEL_KEY = "\u0000null";

/**
 * Rendered on the same line as any dollar figure from this module (D5).
 *
 * Names all three honesty problems at once, because a reader who takes the
 * headline for a forecast has been misled by a number this tool cannot produce:
 * the token arithmetic is a LOWER bound (capping wraps the sawtooth rather than
 * clipping it, and this simulation restarts from the OBSERVED floor, which an
 * earlier compaction would plausibly beat); the realisable saving is an UPPER
 * bound (identical work is assumed; rework is the gap and is unmeasured); and
 * the margin that gates the verdict is taken against `totalCarryCost`, which is
 * itself a lower bound on carried cost (C8).
 */
const SAVING_CAVEAT =
  "Upper bound. This assumes the same work gets done with less context in front of the model; what that rework costs " +
  "is not measured here. The token arithmetic underneath it is a lower bound — a smaller window wraps the context " +
  "rather than truncating it, and every cut is modelled as restarting from the floor already observed, which an " +
  "earlier compaction would plausibly beat. The margin this verdict clears is measured against the carry cost, which " +
  "prices every carried token at the cache-read rate and is itself a lower bound — so the margin is easier to clear " +
  "than against the window's true cost, and the threshold is biased toward recommending a change.";

/** Fields carried into every return path, degraded or not. */
interface ResultShell {
  modelMix: AutoCompactFitResult["modelMix"];
  resetFloorUsed: number;
  resetFloorDefault: number;
}

interface Observed {
  closedCycleCarriedTokens: number;
  openCycleCarriedTokens: number;
  excludedRowCarriedTokens: number;
  openCyclesExcluded: number;
  observedFloorTokens: number | null;
  observedPeakTokens: number | null;
  observedMaxPeakTokens: number | null;
  observedMedianCycleRequests: number | null;
}

interface Slice {
  turns: ContextCarryTurn[];
  open: boolean;
}

interface PricedSlice {
  increments: number[];
  rates: Array<number | null>;
}

function shellOut(shell: ResultShell): ResultShell & { savingCaveat: string; settableRange: readonly [number, number] } {
  return { ...shell, savingCaveat: SAVING_CAVEAT, settableRange: SETTABLE_RANGE };
}

/** An `insufficient-data` result with no candidates — the structural failures.
 *  Observed figures are reported when they are known and finite, `null`
 *  otherwise; volumes are `0` because nothing was partitioned (they are token
 *  counts, not dollar figures — D6 governs the latter). */
function degraded(
  shell: ResultShell,
  reasonCode: AutoCompactFitRecommendation["reasonCode"],
  reasonFacts: Readonly<Record<string, number>>,
  known?: { floor: number | null; peak: number | null },
): AutoCompactFitResult {
  return {
    ...shellOut(shell),
    candidates: [],
    droppedCandidates: [],
    recommendation: { verdict: "insufficient-data", recommendedTokens: null, range: null, reasonCode, reasonFacts },
    closedCycleCarriedTokens: 0,
    openCycleCarriedTokens: 0,
    excludedRowCarriedTokens: 0,
    openCyclesExcluded: 0,
    observedFloorTokens: known?.floor ?? null,
    observedPeakTokens: known?.peak ?? null,
    observedMaxPeakTokens: null,
    observedMedianCycleRequests: null,
  };
}

/**
 * SR-4. Returns the offending field as a single numeric fact (never the value
 * itself, which may be `NaN` and would serialise as `null`), or `null` when
 * every consumed field is in domain.
 *
 * `floorTokens: NaN` is the motivating case: it makes every `>` comparison
 * `false`, so the cut guard and the below-floor filter both silently no-op and
 * the module returns a confident answer computed from nothing.
 */
function firstNonFiniteField(
  carry: ContextCarryResult,
  sawtooth: NonNullable<ContextCarryResult["sawtooth"]>,
): Readonly<Record<string, number>> | null {
  if (!Number.isFinite(carry.carriedTokens)) return { field: FIELD_CARRIED_TOKENS };
  if (!Number.isFinite(sawtooth.floorTokens) || sawtooth.floorTokens < 0) return { field: FIELD_FLOOR_TOKENS };
  if (!Number.isFinite(sawtooth.peakTokens)) return { field: FIELD_PEAK_TOKENS };
  if (carry.totalCarryCost !== null && !Number.isFinite(carry.totalCarryCost)) return { field: FIELD_TOTAL_CARRY_COST };
  for (let i = 0; i < carry.turns.length; i++) {
    const turn = carry.turns[i]!;
    if (!Number.isFinite(turn.increment)) return { field: FIELD_INCREMENT, index: i };
    if (!Number.isSafeInteger(turn.remainingRequestsInCycle) || turn.remainingRequestsInCycle < 1) {
      return { field: FIELD_REMAINING, index: i };
    }
  }
  for (let i = 0; i < carry.cycles.length; i++) {
    const requests = carry.cycles[i]!.requests;
    if (!Number.isSafeInteger(requests) || requests < 0) return { field: FIELD_CYCLE_REQUESTS, index: i };
  }
  for (let i = 0; i < carry.resets.length; i++) {
    const reset = carry.resets[i]!;
    if (!Number.isFinite(reset.beforeTokens)) return { field: FIELD_BEFORE_TOKENS, index: i };
    if (!Number.isFinite(reset.resetRequestCost)) return { field: FIELD_RESET_COST, index: i };
  }
  return null;
}

// Numeric field tags — `reasonFacts` values are numbers only (SR-2), so the
// offending field is reported as a stable code rather than a name.
const FIELD_CARRIED_TOKENS = 1;
const FIELD_FLOOR_TOKENS = 2;
const FIELD_PEAK_TOKENS = 3;
const FIELD_TOTAL_CARRY_COST = 4;
const FIELD_INCREMENT = 5;
const FIELD_REMAINING = 6;
const FIELD_CYCLE_REQUESTS = 7;
const FIELD_BEFORE_TOKENS = 8;
const FIELD_RESET_COST = 9;

/**
 * C1/D11. `turns` is the concatenation of each cycle's turn list, in `cycles`
 * order — an undocumented implementation invariant of `computeContextCarry`
 * (now written down on `ContextCarryResult.turns`), not a typed relationship.
 *
 * `turns` is SELF-DELIMITING: `remainingRequestsInCycle` runs `n…1` within a
 * cycle, so a cycle's last turn is exactly the one carrying `1`. Reconstruct the
 * slices from `turns` alone, then zip against `cycles[]` and check per-slice
 * length, the descending-by-one `remaining` sequence, and single-session-ness.
 *
 * A count check (`Σ cycles[].requests === turns.length`) was the earlier
 * proposal and was theatre against its own justification: it is invariant under
 * any permutation of either array, which is the one failure a reordering
 * refactor WILL produce. This detects reordering; the count check did not.
 *
 * `null` ⇒ the partition could not be verified, and a partition this module
 * cannot verify must not be priced.
 */
function reconstructSlices(carry: ContextCarryResult): Slice[] | null {
  const slices: Slice[] = [];
  let start = 0;
  for (let i = 0; i < carry.turns.length; i++) {
    if (carry.turns[i]!.remainingRequestsInCycle !== 1) continue;
    slices.push({ turns: carry.turns.slice(start, i + 1), open: false });
    start = i + 1;
  }
  // A trailing run with no `remaining === 1` terminator is an unterminated
  // cycle: the offsets do not end exactly at `turns.length`.
  if (start !== carry.turns.length) return null;
  if (slices.length !== carry.cycles.length) return null;

  for (let j = 0; j < slices.length; j++) {
    const slice = slices[j]!;
    const cycle = carry.cycles[j]!;
    const n = slice.turns.length;
    if (n !== cycle.requests) return null;
    for (let i = 0; i < n; i++) {
      const turn = slice.turns[i]!;
      if (turn.remainingRequestsInCycle !== n - i) return null;
      if (turn.sessionId !== cycle.sessionId) return null;
    }
    slice.open = cycle.open;
  }
  return slices;
}

/**
 * The counterfactual replay of one closed cycle (D2 — simulate, never use the
 * closed form). Three corrections are embedded here and each one, wrong, still
 * produces plausible-looking output:
 *
 *  - **C6, the first-increment guard.** `carryIncrementOf` returns the row's
 *    WHOLE `totalContext` when a turn starts a cycle, so a cycle's first
 *    increment IS the post-compaction baseline. Cutting on it thrashes: at small
 *    `C` the very first comparison trips and `cuts` explodes — garbage at exactly
 *    the candidates that matter.
 *  - **C6, the floor seating.** `ctx` starts at `0`, not at the floor; the first
 *    increment supplies the baseline. Starting at the floor seats turn 1 at
 *    ≈ 2 × floor and inflates `carried` by ≈ floor per turn, so `savedTokens`
 *    understates and can go negative.
 *  - **C11, the signed clamp.** `carryIncrement` is signed and shrink turns are
 *    deliberately negative. After a cut seats `ctx` at the floor, a run of
 *    negative increments can drive it below zero, at which point `carried += ctx`
 *    SUBTRACTS volume and inflates `savedTokens`.
 *
 * `obs` is the observed context, telescoped from `0` — deliberately NOT clamped,
 * because `Σ_t obs_t === Σ_k increment_k × remaining_k` is the exact partition
 * identity the baseline is computed from, and clamping would break it.
 */
function simulateSlice(
  slice: PricedSlice,
  windowTokens: number,
  floorTokens: number,
  segments: number[],
): { savedTokens: number; pricedSaving: number; cuts: number } {
  let ctx = 0;
  let obs = 0;
  let cuts = 0;
  let first = true;
  let segmentLength = 0;
  let savedTokens = 0;
  let pricedSaving = 0;

  for (let i = 0; i < slice.increments.length; i++) {
    const inc = slice.increments[i]!;
    if (!first && ctx + inc > windowTokens) {
      cuts++;
      ctx = floorTokens;
      segments.push(segmentLength);
      segmentLength = 0;
    }
    ctx = Math.max(0, ctx + inc);
    obs += inc;
    const saved = obs - ctx;
    savedTokens += saved;
    const rate = slice.rates[i];
    if (rate !== null && rate !== undefined) pricedSaving += (saved * rate) / 1e6;
    segmentLength++;
    first = false;
  }
  if (segmentLength > 0) segments.push(segmentLength);
  return { savedTokens, pricedSaving, cuts };
}

/**
 * The candidate grid (§3.2), with a recorded reason per drop (C2 — an
 * unrecorded drop makes the success case indistinguishable from an empty grid).
 */
function buildGrid(
  candidatesTokens: readonly number[] | undefined,
  floorTokens: number,
  maxPeakTokens: number,
): { surviving: number[]; dropped: AutoCompactFitDroppedCandidate[] } {
  // An explicitly empty list is honoured; only `undefined` falls back.
  const raw = candidatesTokens === undefined ? DEFAULT_CANDIDATES_TOKENS : candidatesTokens;
  // Non-finite entries are discarded before anything can record them: a
  // `windowTokens: NaN` row in `droppedCandidates` would serialise as `null`.
  const normalized = [...new Set(raw.filter((c) => typeof c === "number" && Number.isFinite(c)))].sort((a, b) => a - b);

  const dropped: AutoCompactFitDroppedCandidate[] = [];
  const surviving: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const windowTokens = normalized[i]!;
    if (i >= MAX_CANDIDATES) {
      dropped.push({ windowTokens, reason: "out-of-range" });
      continue;
    }
    // Out of range is DROPPED, never rounded in: a caller who asked for 50K did
    // not ask for 100K.
    if (windowTokens < SETTABLE_RANGE[0] || windowTokens > SETTABLE_RANGE[1]) {
      dropped.push({ windowTokens, reason: "out-of-range" });
      continue;
    }
    if (windowTokens <= floorTokens * FLOOR_HEADROOM_MULTIPLE) {
      dropped.push({ windowTokens, reason: "below-floor" });
      continue;
    }
    // C9: the MAX peak, not `sawtooth.peakTokens`, which is a MEAN. A candidate
    // at the mean peak still cuts every cycle whose own peak exceeded it.
    if (windowTokens >= maxPeakTokens) {
      dropped.push({ windowTokens, reason: "at-or-above-peak" });
      continue;
    }
    surviving.push(windowTokens);
  }
  return { surviving, dropped };
}

/**
 * Mean cost of one reset, over the resets this build could actually price.
 *
 * `ContextReset.resetRequestCost` is `messageCost(afterRow)`, and `messageCost`
 * returns `0` for a `null` or unpriced model — so averaging over every reset
 * would drag the mean toward zero and quietly overstate `netSaving` at exactly
 * the candidates that cut most. `ContextReset` carries no model, so a positive
 * cost is the only available evidence that a reset was priced at all; resets at
 * `0` are EXCLUDED rather than counted, which is the conservative direction (a
 * genuinely free reset, if one existed, would only lower the mean).
 *
 * `null` when no reset in the window was priced.
 */
function meanPricedResetCost(carry: ContextCarryResult): number | null {
  const priced = carry.resets.map((r) => r.resetRequestCost).filter((c) => Number.isFinite(c) && c > 0);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => a + b, 0) / priced.length;
}

/** Resolver for one call: one `resolvePricing` per distinct raw model id, and
 *  no state outliving the call (a module-level cache keyed only by model id
 *  would break purity the moment two callers passed different `rateOverrides`).
 *  `null` for a `null` model, a model absent from the resolved table, or a
 *  non-finite rate. */
type RateResolver = (model: string | null) => number | null;
function makeRateResolver(overrides: RateOverrides | undefined): RateResolver {
  const cache = new Map<string, number | null>();
  return (model) => {
    if (model === null || typeof model !== "string") return null;
    const hit = cache.get(model);
    if (hit !== undefined) return hit;
    const { pricing } = resolvePricing(model, overrides);
    const rate = pricing === null || !Number.isFinite(pricing.cacheReadPerMillion) ? null : pricing.cacheReadPerMillion;
    cache.set(model, rate);
    return rate;
  };
}

/**
 * SR-3. Only ids present in the resolved pricing table are NAMED; everything
 * else is a count. See `AutoCompactFitResult.modelMix` for why a raw transcript
 * model id must not leave this module.
 */
function buildModelMix(turns: readonly ContextCarryTurn[], rateOf: RateResolver): AutoCompactFitResult["modelMix"] {
  const distinct = new Set<string>();
  const known = new Set<string>();
  const unknown = new Set<string>();
  for (const turn of turns) {
    if (turn.model === null || typeof turn.model !== "string") {
      distinct.add(NULL_MODEL_KEY);
      unknown.add(NULL_MODEL_KEY);
      continue;
    }
    const { canonical } = normalizeModelId(turn.model);
    distinct.add(canonical);
    if (rateOf(turn.model) === null) unknown.add(canonical);
    else known.add(canonical);
  }
  return { uniform: distinct.size === 1, models: [...known].sort(), unknownModels: unknown.size };
}

/**
 * The verdict ladder (§3.4), checked in order: `insufficient-data` →
 * `already-tuned` → `too-close-to-call` → `recommend-window`.
 *
 * `already-tuned` and `too-close-to-call` are deliberately distinct: the first
 * says the workload is fine, the second says this tool cannot tell. Collapsing
 * them would hide the difference between a good configuration and a weak
 * measurement.
 */
function recommend(input: {
  candidates: readonly AutoCompactFitCandidate[];
  dropped: readonly AutoCompactFitDroppedCandidate[];
  maxPeakTokens: number;
  totalCarryCost: number | null;
}): AutoCompactFitRecommendation {
  const { candidates, dropped, maxPeakTokens, totalCarryCost } = input;

  if (totalCarryCost === null) {
    return insufficient("nothing-priced", { candidates: candidates.length });
  }

  if (candidates.length === 0) {
    // Every drop was `at-or-above-peak` ⇒ the peaks already sit below the
    // smallest window anyone could set: the workload is compacting on its own
    // terms. Reachable only via caller-supplied `candidatesTokens` or a
    // caller-supplied reset floor — under defaults `beforeTokens > 150_000`
    // always, so the max peak always exceeds the 100K bottom of the grid. Stated
    // rather than presented as a default-path branch.
    // An EMPTY caller-supplied list drops nothing, and "already tuned" inferred
    // from an empty list would be a fabrication — so a non-empty drop set is
    // required.
    if (dropped.length > 0 && dropped.every((d) => d.reason === "at-or-above-peak")) {
      return {
        verdict: "already-tuned",
        recommendedTokens: null,
        range: null,
        reasonCode: "peaks-below-smallest-window",
        reasonFacts: { maxPeakTokens, dropped: dropped.length },
      };
    }
    return insufficient("grid-empty-below-floor", { dropped: dropped.length });
  }

  // Ascending by construction, so the smallest surviving candidate is the
  // aggressive end.
  const aggressive = candidates[0]!;
  if (aggressive.netSaving === null) {
    // `totalCarryCost` can be non-null on a window whose only priced turns sit
    // in an OPEN cycle — which this module excludes. The token half is real; the
    // dollar half is not guessed at.
    return insufficient("nothing-priced", { candidates: candidates.length });
  }

  // C5: peak PROXIMITY. A developer who applied a window sees their peaks
  // cluster at it on the next run, and this is the rung that reports that.
  const nearest = candidates.find((c) => Math.abs(c.windowTokens - maxPeakTokens) <= ALREADY_TUNED_FRACTION * maxPeakTokens);
  if (nearest !== undefined) {
    return {
      verdict: "already-tuned",
      recommendedTokens: null,
      range: null,
      reasonCode: "peak-at-candidate",
      reasonFacts: {
        maxPeakTokens,
        nearestWindowTokens: nearest.windowTokens,
        toleranceFraction: ALREADY_TUNED_FRACTION,
      },
    };
  }

  // C8: the denominator is `totalCarryCost` — `ContextCarryResult` carries no
  // window-cost field, D1 forbids passing rows, and `contextCarry.ts`'s header
  // forbids adding one. `totalCarryCost` is ITSELF a lower bound (every carried
  // token priced at the cache-read rate), so this margin is EASIER to clear than
  // against the window's true cost: the threshold is biased toward recommending.
  // Said here, on `savingCaveat`, and in the docs.
  const best = candidates.reduce<number | null>(
    (acc, c) => (c.netSaving === null ? acc : acc === null || c.netSaving > acc ? c.netSaving : acc),
    null,
  );
  const margin = TOO_CLOSE_COST_FRACTION * totalCarryCost;
  // `best <= 0` short-circuits here rather than falling through: a zero or
  // negative best saving must never be recommended, and on a window whose
  // `totalCarryCost` is itself `≤ 0` the margin comparison alone would let it.
  if (best === null || best <= 0 || best < margin) {
    return {
      verdict: "too-close-to-call",
      recommendedTokens: null,
      range: null,
      reasonCode: "saving-under-margin",
      reasonFacts: { bestNetSaving: best ?? 0, totalCarryCost, marginFraction: TOO_CLOSE_COST_FRACTION },
    };
  }

  // C10. The range exists only because the aggressive end's `netSaving` is
  // non-null and strictly positive (both checked above): a zero threshold makes
  // every candidate qualify and recommends the TOP of the grid; a negative one
  // does the same. And because `netSaving` is not monotone, the qualifying set
  // need not be a contiguous prefix — so scan ALL candidates for the largest
  // that qualifies, never the top of a prefix.
  const threshold = CONSERVATIVE_CAPTURE_FRACTION * aggressive.netSaving;
  let conservative = aggressive.windowTokens;
  for (const c of candidates) {
    if (c.netSaving === null) continue;
    if (c.netSaving >= threshold && c.windowTokens > conservative) conservative = c.windowTokens;
  }
  return {
    verdict: "recommend-window",
    recommendedTokens: conservative,
    range: [conservative, aggressive.windowTokens],
    reasonCode: "recommended",
    reasonFacts: {
      recommendedTokens: conservative,
      aggressiveTokens: aggressive.windowTokens,
      aggressiveNetSaving: aggressive.netSaving,
      bestNetSaving: best,
      totalCarryCost,
    },
  };
}

/** D3/§3.3: the conservative end is the largest candidate capturing at least
 *  this share of the aggressive end's `netSaving`. Diminishing returns are steep
 *  here, so it is usually one or two steps up the grid and gives away little —
 *  and a tool that recommends the aggressive end and costs someone a day of
 *  rework does not get a second hearing. */
const CONSERVATIVE_CAPTURE_FRACTION = 0.5;

function insufficient(
  reasonCode: AutoCompactFitRecommendation["reasonCode"],
  reasonFacts: Readonly<Record<string, number>>,
): AutoCompactFitRecommendation {
  return { verdict: "insufficient-data", recommendedTokens: null, range: null, reasonCode, reasonFacts };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Median of a finite sample; `null` on an empty one. Even counts take the
 *  midpoint of the two central values. */
function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
