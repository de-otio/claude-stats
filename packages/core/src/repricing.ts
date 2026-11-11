/**
 * Counterfactual repricing: what the SAME token counts would have cost at another
 * model's rates.
 *
 * Pure; no I/O. The store hands in grouped token sums (one group per distinct
 * pricing context) and this module prices every group twice, once at the model
 * that served it and once at the target, through `resolveRequestPricing`, so the
 * long-context tier, the fast-mode multiplier and the US-geo multiplier compose
 * exactly as they do for every other cost figure.
 *
 * This is an EQUAL-TOKEN-VOLUME figure. A model that needs fewer tokens per task
 * makes the real counterfactual cheaper than this number, so every surface
 * labels it an upper bound (`reprice.equalTokenVolumeNote` in the locales).
 *
 * Refusals, not guesses:
 *  - a model id that resolves to no rate is refused up front (`checkRepriceModel`)
 *    rather than priced at $0;
 *  - a fast-mode row on a target without a published fast rate is NOT priced at
 *    standard: it is counted as unpriced on the counterfactual side and its
 *    actual cost is reported so a like-for-like total stays computable.
 */
import {
  classifyModelIdSuffix,
  nonNegativeFiniteInt,
  normalizeModelId,
  resolvePricing,
  resolveRequestPricing,
  suffixShapeInherits,
  type RateOverrides,
} from "./pricing.js";

/** Why a group could not be priced on one side. */
export type RepriceUnpricedReason = "unknown-model" | "fast-unpriced" | "speed-unknown";

/**
 * One group of message rows that share a pricing context on BOTH sides. The
 * long-context flag is per side because the tier belongs to the model: the same
 * 150K-token request is over Haiku 5.5's threshold and under an Opus row that
 * has none.
 */
export interface RepriceGroup {
  /** The model id the rows were stored with (a dated or `[1m]` variant is fine). */
  model: string;
  /** The request is in `model`'s own long-context tier. */
  longContext: boolean;
  /** The same request is in the TARGET model's long-context tier. */
  targetLongContext: boolean;
  /** Non-standard `usage.speed` (`fast`, ...); null for standard or absent. */
  speed: string | null;
  /** `usage.inference_geo`: `"us"` for US-pinned requests, else null. */
  inferenceGeo: string | null;
  /** Stored message rows in the group. */
  rows: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** TTL breakdown of `cacheCreationTokens`; both 0 when the source gave none. */
  ephemeral5mTokens: number;
  ephemeral1hTokens: number;
}

/** Dollar amounts per token category. `total` is their sum. */
export interface RepriceCosts {
  input: number;
  output: number;
  /** 5-minute cache writes, including writes whose TTL was not reported. */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  total: number;
}

/** Token counts per category, the volume both sides are priced at. */
export interface RepriceTokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export type UnpricedByReason = Partial<Record<RepriceUnpricedReason, number>>;

export interface RepriceResult {
  model: string;
  asModel: string;
  /** Stored message rows of `model` in the window. */
  rows: number;
  /** Token volume of those rows, per category. Identical on both sides. */
  tokens: RepriceTokens;
  /**
   * Cache-creation tokens priced at the 5-minute rate for want of a TTL split;
   * they are INCLUDED in `tokens.cacheWrite5m`. Non-zero means the cache-write
   * split between the two TTL categories is approximate, not the totals.
   */
  cacheWriteUnattributedTokens: number;
  /** Cost at the rates of the model that served the rows (priced rows only). */
  actual: RepriceCosts;
  /** Cost of the same token counts at `asModel`'s rates (priced rows only). */
  counterfactual: RepriceCosts;
  /**
   * The like-for-like totals: only rows priced on BOTH sides. Equal to
   * `actual.total` / `counterfactual.total` when nothing is unpriced.
   */
  comparable: { rows: number; actualTotal: number; counterfactualTotal: number };
  unpriced: {
    /** Rows with no price at the serving model (speed refusals); not in `actual`. */
    actual: { rows: number; byReason: UnpricedByReason };
    /**
     * Rows with no price at `asModel`; not in `counterfactual`. `actualCost` is
     * what those rows cost at the serving model, so
     * `actual.total - unpriced.counterfactual.actualCost` is the comparable base.
     */
    counterfactual: { rows: number; byReason: UnpricedByReason; actualCost: number };
  };
}

const ZERO_COSTS = (): RepriceCosts => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0 });

const ZERO_TOKENS = (): RepriceTokens => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

/**
 * Shape of a model id accepted at the tool boundary: first-party ids
 * (`claude-fable-5-2`), dated snapshots, `[1m]` context tiers, Bedrock
 * (`us.anthropic.…-v1:0`) and Vertex (`…@20251101`) forms. Rejects whitespace,
 * control characters, quotes and anything else a SQL, path or prompt payload
 * would need. Shape only: whether the id has a RATE is `checkRepriceModel`.
 */
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;

export function isModelIdShape(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_SHAPE.test(value);
}

/** True when the id resolves to a rate row; false for an unknown or refused id. */
export function checkRepriceModel(model: string, overrides?: RateOverrides): boolean {
  return resolvePricing(model, overrides).pricing !== null;
}

/**
 * The prompt-token threshold above which `model` is priced at its long-context
 * tier, or null when it has none. The store turns this into a SQL predicate so a
 * grouped read can split rows by the TARGET's tier.
 */
export function longContextThresholdFor(model: string, overrides?: RateOverrides): number | null {
  return resolvePricing(model, overrides).pricing?.longContext?.thresholdTokens ?? null;
}

/**
 * Whether a stored model id is the requested model. Exact, or the requested id
 * with a suffix that inherits its rate row (dated snapshot, `[1m]`, a Bedrock or
 * Vertex wrapper). A point-release id (`claude-opus-5-5` for a request of
 * `claude-opus-5`) is a DIFFERENT model with its own rates and never matches.
 */
export function modelMatchesRequested(stored: string, requested: string): boolean {
  if (stored === requested) return true;
  const s = normalizeModelId(stored).canonical;
  const r = normalizeModelId(requested).canonical;
  if (s === r) return true;
  if (!s.startsWith(r)) return false;
  return suffixShapeInherits(classifyModelIdSuffix(s.slice(r.length)));
}

interface GroupTokens extends RepriceTokens {
  unattributedWrite: number;
}

/**
 * Split a group's tokens into the five priced categories with the same rules
 * `estimateCost` applies: the TTL split is coerced, the residual of
 * `cacheCreationTokens` over the split is priced at the 5-minute rate, and a
 * split that exceeds `cacheCreationTokens` is priced as given.
 */
function groupTokens(g: RepriceGroup): GroupTokens {
  const write5m = nonNegativeFiniteInt(g.ephemeral5mTokens);
  const write1h = nonNegativeFiniteInt(g.ephemeral1hTokens);
  const residual = Math.max(0, g.cacheCreationTokens - (write5m + write1h));
  return {
    input: g.inputTokens,
    output: g.outputTokens,
    cacheWrite5m: write5m + residual,
    cacheWrite1h: write1h,
    cacheRead: g.cacheReadTokens,
    unattributedWrite: residual,
  };
}

type SidePrice =
  | { ok: true; costs: RepriceCosts }
  | { ok: false; reason: RepriceUnpricedReason };

function priceSide(
  model: string,
  g: RepriceGroup,
  tokens: RepriceTokens,
  longContext: boolean,
  overrides?: RateOverrides,
): SidePrice {
  const { pricing, reason } = resolveRequestPricing(
    model,
    { longContext, speed: g.speed, inferenceGeo: g.inferenceGeo },
    overrides,
  );
  if (!pricing) return { ok: false, reason: reason ?? "unknown-model" };
  const input = (tokens.input / 1_000_000) * pricing.inputPerMillion;
  const output = (tokens.output / 1_000_000) * pricing.outputPerMillion;
  const cacheWrite5m = (tokens.cacheWrite5m / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheWrite1h = (tokens.cacheWrite1h / 1_000_000) * pricing.cacheWrite1hPerMillion;
  const cacheRead = (tokens.cacheRead / 1_000_000) * pricing.cacheReadPerMillion;
  return {
    ok: true,
    costs: { input, output, cacheWrite5m, cacheWrite1h, cacheRead, total: input + output + cacheWrite5m + cacheWrite1h + cacheRead },
  };
}

function addCosts(into: RepriceCosts, c: RepriceCosts): void {
  into.input += c.input;
  into.output += c.output;
  into.cacheWrite5m += c.cacheWrite5m;
  into.cacheWrite1h += c.cacheWrite1h;
  into.cacheRead += c.cacheRead;
  into.total += c.total;
}

function bump(by: UnpricedByReason, reason: RepriceUnpricedReason, rows: number): void {
  by[reason] = (by[reason] ?? 0) + rows;
}

/**
 * Price every group of `model` at its serving rates and at `asModel`'s.
 *
 * Groups whose stored model is not `model` (per `modelMatchesRequested`) are
 * ignored, so the caller can pass a window's whole grouped read. Both ids must
 * already have passed `checkRepriceModel`; an unknown id here would show up as
 * every row unpriced (reason `unknown-model`), never as $0.
 */
export function repriceGroups(
  groups: readonly RepriceGroup[],
  model: string,
  asModel: string,
  overrides?: RateOverrides,
): RepriceResult {
  const result: RepriceResult = {
    model,
    asModel,
    rows: 0,
    tokens: ZERO_TOKENS(),
    cacheWriteUnattributedTokens: 0,
    actual: ZERO_COSTS(),
    counterfactual: ZERO_COSTS(),
    comparable: { rows: 0, actualTotal: 0, counterfactualTotal: 0 },
    unpriced: {
      actual: { rows: 0, byReason: {} },
      counterfactual: { rows: 0, byReason: {}, actualCost: 0 },
    },
  };

  for (const g of groups) {
    if (!modelMatchesRequested(g.model, model)) continue;
    const t = groupTokens(g);
    result.rows += g.rows;
    result.tokens.input += t.input;
    result.tokens.output += t.output;
    result.tokens.cacheWrite5m += t.cacheWrite5m;
    result.tokens.cacheWrite1h += t.cacheWrite1h;
    result.tokens.cacheRead += t.cacheRead;
    result.cacheWriteUnattributedTokens += t.unattributedWrite;

    const actual = priceSide(g.model, g, t, g.longContext, overrides);
    const target = priceSide(asModel, g, t, g.targetLongContext, overrides);

    if (actual.ok) addCosts(result.actual, actual.costs);
    else {
      result.unpriced.actual.rows += g.rows;
      bump(result.unpriced.actual.byReason, actual.reason, g.rows);
    }
    if (target.ok) addCosts(result.counterfactual, target.costs);
    else {
      result.unpriced.counterfactual.rows += g.rows;
      bump(result.unpriced.counterfactual.byReason, target.reason, g.rows);
      if (actual.ok) result.unpriced.counterfactual.actualCost += actual.costs.total;
    }

    if (actual.ok && target.ok) {
      result.comparable.rows += g.rows;
      result.comparable.actualTotal += actual.costs.total;
      result.comparable.counterfactualTotal += target.costs.total;
    }
  }
  return result;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function roundCosts(c: RepriceCosts): RepriceCosts {
  return {
    input: round4(c.input),
    output: round4(c.output),
    cacheWrite5m: round4(c.cacheWrite5m),
    cacheWrite1h: round4(c.cacheWrite1h),
    cacheRead: round4(c.cacheRead),
    total: round4(c.total),
  };
}

/**
 * Round every dollar figure to 4 places for display. Totals are rounded from the
 * exact sums, not summed from rounded categories, so a total can differ from its
 * categories by under a hundredth of a cent.
 */
export function roundRepriceResult(r: RepriceResult): RepriceResult {
  return {
    ...r,
    actual: roundCosts(r.actual),
    counterfactual: roundCosts(r.counterfactual),
    comparable: {
      rows: r.comparable.rows,
      actualTotal: round4(r.comparable.actualTotal),
      counterfactualTotal: round4(r.comparable.counterfactualTotal),
    },
    unpriced: {
      actual: r.unpriced.actual,
      counterfactual: { ...r.unpriced.counterfactual, actualCost: round4(r.unpriced.counterfactual.actualCost) },
    },
  };
}
