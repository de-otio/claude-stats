/**
 * Cost estimation from token usage and model pricing.
 * Prices represent equivalent API cost — not what subscription plans actually charge.
 */
import type { PricingSource } from "./types/insight.js";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  /**
   * 5-minute TTL cache-write rate (1.25× input on the shipped table). The
   * meaning of this field is unchanged: it is what every cache write was priced
   * at before the 1-hour rate existed, and it is still the fallback rate for any
   * write whose TTL the source did not report.
   */
  cacheWritePerMillion: number;
  /** 1-hour TTL cache-write rate (2× input on the shipped table). */
  cacheWrite1hPerMillion: number;
  /**
   * Where `cacheWrite1hPerMillion` came from. `"parsed"` — a published/fetched/
   * configured rate. `"synthesized"` — filled as `2 × inputPerMillion` because
   * the source carried no 1-hour column at all.
   *
   * TTL analysis must NOT price a synthesized row: a signed dollar figure
   * derived from a guessed premium is exactly the uncalibrated confidence this
   * tool exists to avoid. `estimateCost` still uses the synthesized rate so a
   * missing column degrades to an approximation rather than to `NaN`.
   */
  ttlRateBasis: "parsed" | "synthesized";
  /**
   * Long-context tier, for the models that have one (today only Haiku 5.5).
   * A request whose prompt (`input + cache_read + cache_creation`) is STRICTLY
   * greater than `thresholdTokens` is priced at `rates` for the WHOLE request,
   * output included; exactly the threshold is the base tier. Absent means the
   * model has no tier. Applied only when `estimateCost` is passed
   * `{ longContext: true }`, which callers derive from `isLongContextRequest`
   * (per message) or `longContextSqlExpr` (aggregated rows).
   */
  longContext?: {
    thresholdTokens: number;
    rates: Omit<ModelPricing, "longContext" | "ttlRateBasis" | "fastMultiplier" | "usGeoMultiplier">;
  };
  /**
   * Fast-mode multiplier, on the rows whose model has a PUBLISHED fast-mode
   * rate only (Fable 5.2, Mythos 5.2, Opus 5.5, Opus 5, Opus 4.8: 2×). It scales
   * all five rates: the pricing page states that the prompt-caching multipliers
   * apply on top of fast-mode input pricing, which makes every cache rate
   * 2× the standard one. Absent means the model has NO published fast rate, and
   * `estimateCost` REFUSES a `speed = "fast"` request on it (cost 0,
   * `known: false`, `reason: "fast-unpriced"`) rather than price it at standard.
   */
  fastMultiplier?: number;
  /**
   * Multiplier for US-only inference (`inference_geo: "us"`), 1.1× on every
   * token category, on the rows the pricing page says it applies to ("Claude 4.6
   * and later models"). Absent means × 1.
   */
  usGeoMultiplier?: number;
}

/**
 * TTL breakdown of one row's `cache_creation_tokens`, when the source reported
 * it. Both fields are coerced at the `estimateCost` boundary — see
 * `nonNegativeFiniteInt`.
 */
export interface CacheWriteSplit {
  ephemeral5mCacheTokens: number;
  ephemeral1hCacheTokens: number;
}

/** Published fast-mode multiplier (every rate 2× standard). */
const FAST_2X = 2;
/** Published US-only inference multiplier (`inference_geo: "us"`). */
const US_GEO = 1.1;

// Default pricing table — used as fallback when auto-fetched cache is unavailable.
// Verified against https://platform.claude.com/docs/en/about-claude/pricing
// `cacheWrite1hPerMillion` is `2 × inputPerMillion` on every row — that is the
// published multiplier, not a guess, hence `ttlRateBasis: "parsed"` throughout.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Fable 5.2 / Mythos 5.2 (2026-11-09) — $8 / $40, cache read 0.025× input
  // (0.20), 5-minute write 1.25× (10), 1-hour write 2× (16). Read off the
  // pricing page 2026-11-10. Without these rows the ids prefix-match
  // `claude-fable-5` / `claude-mythos-5`, the `-2` remainder is a point-release
  // suffix, and the model costs $0 with `known: false`. Fast mode is published
  // for both at 2× ($16 / $80); cache rates stack on top of it.
  "claude-fable-5-2":  { inputPerMillion: 8,    outputPerMillion: 40, cacheReadPerMillion: 0.20, cacheWritePerMillion: 10,    cacheWrite1hPerMillion: 16,   ttlRateBasis: "parsed", fastMultiplier: FAST_2X, usGeoMultiplier: US_GEO },
  "claude-mythos-5-2": { inputPerMillion: 8,    outputPerMillion: 40, cacheReadPerMillion: 0.20, cacheWritePerMillion: 10,    cacheWrite1hPerMillion: 16,   ttlRateBasis: "parsed", fastMultiplier: FAST_2X, usGeoMultiplier: US_GEO },
  // Fable 5.1 / Mythos 5.1 — identical to their predecessors on four of five
  // rates. The exception is `cacheReadPerMillion`, which DROPPED from 1.00 to
  // 0.25. It is not derivable from the other four and it is not a typo; cache
  // reads are ~99.6% of input volume, so that one cell is a 4× error on the
  // dominant term. Without these rows the ids prefix-match the 5.0 rows and
  // inherit 1.00 with `known: true`.
  "claude-fable-5-1":  { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-mythos-5-1": { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 0.25, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  // Fable 5 / Mythos 5 — the top capability tier, priced above Opus.
  "claude-fable-5":    { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-mythos-5":   { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  // Claude Opus 5.5 — CHEAPER than Opus 5 on every rate, and its cache read is
  // 0.05× input (0.20), not the standard 0.1×. Verified against the published
  // page 2026-09-26. Without this row `claude-opus-5-5` hits the point-release
  // refusal on `claude-opus-5` and costs $0 with `known: false` — which, as the
  // default Claude Code model, zeroed almost the entire dashboard.
  "claude-opus-5-5":   { inputPerMillion: 4,    outputPerMillion: 20, cacheReadPerMillion: 0.20, cacheWritePerMillion: 5,     cacheWrite1hPerMillion: 8,    ttlRateBasis: "parsed", fastMultiplier: FAST_2X, usGeoMultiplier: US_GEO },
  // Claude Sonnet 5.5 and Haiku 5.5 — built-in rows so a first run, an offline
  // machine or a failed pricing fetch does not cost them at $0 with
  // `known: false`. Rates match the live pricing cache and the launch
  // changelog (2026-10-27). Sonnet 5.5's cache read is 0.10× input.
  "claude-sonnet-5-5": { inputPerMillion: 2,    outputPerMillion: 10, cacheReadPerMillion: 0.10, cacheWritePerMillion: 2.50,  cacheWrite1hPerMillion: 4,    ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  // Haiku 5.5 is the one model with a long-context tier: a request whose prompt
  // is over 100,000 tokens is priced at 5x every column, whole request (V6).
  "claude-haiku-5-5":  {
    inputPerMillion: 0.10, outputPerMillion: 0.50, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125, cacheWrite1hPerMillion: 0.20, ttlRateBasis: "parsed",
    // The US multiplier also applies to the over-100K tier prices (pricing page).
    usGeoMultiplier: US_GEO,
    longContext: {
      thresholdTokens: 100_000,
      rates: { inputPerMillion: 0.50, outputPerMillion: 2.50, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625, cacheWrite1hPerMillion: 1 },
    },
  },
  // Claude Opus 5 — same rates as Opus 4.8. Missing this row meant current-
  // generation Opus usage costed zero with `known: true` nowhere to be seen.
  "claude-opus-5":     { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed", fastMultiplier: FAST_2X, usGeoMultiplier: US_GEO },
  "claude-opus-4-8":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed", fastMultiplier: FAST_2X, usGeoMultiplier: US_GEO },
  // Opus 4.7 was absent and prefix-matched the RETIRED `claude-opus-4` row at
  // 15/18.75/30/1.50/75 — a 3× over-charge, the largest single correction in
  // this release. Current-generation Opus rates, same as 4.8 and 4.6.
  "claude-opus-4-7":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-opus-4-6":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-opus-4-5":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed" },
  "claude-opus-4-1":   { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75, cacheWrite1hPerMillion: 30,   ttlRateBasis: "parsed" },
  "claude-opus-4":     { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75, cacheWrite1hPerMillion: 30,   ttlRateBasis: "parsed" },
  // The comment that used to stand here predicted a 2026-09-01 increase to
  // $3/$15 and instructed a future reader to bump the row. THE INCREASE DID NOT
  // HAPPEN: the published pricing page still lists Claude Sonnet 5 at $2 input
  // / $10 output (re-read 2026-09-12, eleven days after the supposed effective
  // date), and the fetched pricing cache agrees. Making that edit would have
  // introduced a 50% over-report on every Sonnet 5 request. Rates below are
  // verified 2026-09-12 — do not bump them from a prediction; re-read the page.
  "claude-sonnet-5":   { inputPerMillion: 2,    outputPerMillion: 10, cacheReadPerMillion: 0.20, cacheWritePerMillion: 2.50,  cacheWrite1hPerMillion: 4,    ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-sonnet-4-6": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,  cacheWrite1hPerMillion: 6,    ttlRateBasis: "parsed", usGeoMultiplier: US_GEO },
  "claude-sonnet-4-5": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,  cacheWrite1hPerMillion: 6,    ttlRateBasis: "parsed" },
  "claude-sonnet-4":   { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,  cacheWrite1hPerMillion: 6,    ttlRateBasis: "parsed" },
  "claude-haiku-4-5":  { inputPerMillion: 1,    outputPerMillion: 5,  cacheReadPerMillion: 0.10, cacheWritePerMillion: 1.25,  cacheWrite1hPerMillion: 2,    ttlRateBasis: "parsed" },
  "claude-3-5-haiku":  { inputPerMillion: 0.80, outputPerMillion: 4,  cacheReadPerMillion: 0.08, cacheWritePerMillion: 1,     cacheWrite1hPerMillion: 1.60, ttlRateBasis: "parsed" },
  "claude-3-5-sonnet": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,  cacheWrite1hPerMillion: 6,    ttlRateBasis: "parsed" },
};

/**
 * Live pricing table — starts as DEFAULT_PRICING, overwritten by cached data
 * when `applyPricingCache()` is called at startup.
 */
export let PRICING: Record<string, ModelPricing> = { ...DEFAULT_PRICING };

/**
 * ISO date string when the active pricing data was last verified / fetched.
 *
 * NOTE — this constant is the date `DEFAULT_PRICING` was verified against the
 * published pricing page, and it is **not what most users see**:
 * `applyPricingCache()` overwrites it with the cache's `fetchedAt` at startup
 * (see below), so on any machine that has ever fetched, surfaces render the
 * fetch date instead. Bumping this value is therefore a statement about the
 * shipped table only. Do not "fix" the overwrite — a fetched table verified
 * later than the shipped one should say so.
 */
export let PRICING_VERIFIED_DATE = "2026-11-10";

/**
 * Fill a rate row's TTL fields when the source did not carry them.
 *
 * This runs PER ROW, before the merge — the merge is whole-row
 * (`{...DEFAULT_PRICING, ...models}`), so a fetched row missing the 1-hour rate
 * replaces a complete default row with an incomplete one and every cache write
 * on that model goes `NaN`. `loadCachedPricing` does an unchecked
 * `JSON.parse(raw) as PricingCacheData`, so every `pricing.json` written before
 * the field existed reaches this function with it absent.
 */
function withTtlRates(row: ModelPricing, fallback?: ModelPricing): ModelPricing {
  const raw = (row as Partial<ModelPricing>).cacheWrite1hPerMillion;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // A source that supplied the rate keeps its own basis; only a source that
    // already declared "synthesized" (the HTML parser, when the page had no 1h
    // column) stays synthesized.
    return { ...row, cacheWrite1hPerMillion: raw, ttlRateBasis: row.ttlRateBasis === "synthesized" ? "synthesized" : "parsed" };
  }

  // The source had no 1-hour rate — but `DEFAULT_PRICING` may already hold a
  // VERIFIED one for this exact model, and discarding it in favour of a
  // synthesized guess throws away data we have.
  //
  // This is not hypothetical: every `pricing.json` written before the 1-hour
  // field existed lacks it, so on any machine that has ever run the CLI the
  // fetched cache used to overwrite all 15 verified rows with "synthesized"
  // ones. `ttlFit`'s D10 guard then withheld pricing on every model and the
  // verdict was permanently `insufficient-data` — the feature was dead on
  // arrival for existing users, which only surfaced when the command was
  // actually run against a real store.
  //
  // Inherit only when the two tables AGREE on the base input rate. If the
  // fetched row reprices the model, the default's absolute 1-hour figure may
  // no longer correspond to it, and a stale absolute rate is exactly the
  // wrong-but-plausible number this build guards against — so that case still
  // synthesizes from the fetched input rate and is still marked synthesized.
  if (
    fallback &&
    fallback.ttlRateBasis === "parsed" &&
    fallback.inputPerMillion === row.inputPerMillion
  ) {
    return { ...row, cacheWrite1hPerMillion: fallback.cacheWrite1hPerMillion, ttlRateBasis: "parsed" };
  }

  return { ...row, cacheWrite1hPerMillion: row.inputPerMillion * 2, ttlRateBasis: "synthesized" };
}

/**
 * Validate a row's long-context tier, and carry the shipped tier over when the
 * source row has none.
 *
 * `pricing.json` files written before the tier existed hold a base-only
 * Haiku 5.5 row, and the merge is whole-row, so without the inheritance a cache
 * refresh would silently delete the tier. Inherit only when the base input rate
 * agrees (same reasoning as the 1-hour rate in `withTtlRates`). A tier that is
 * malformed is dropped: the base rates stay, tier rates never become base.
 */
function withLongContext(row: ModelPricing, fallback?: ModelPricing): ModelPricing {
  const lc = row.longContext;
  const valid =
    !!lc &&
    typeof lc === "object" &&
    Number.isFinite(lc.thresholdTokens) &&
    lc.thresholdTokens > 0 &&
    !!lc.rates &&
    [
      lc.rates.inputPerMillion,
      lc.rates.outputPerMillion,
      lc.rates.cacheReadPerMillion,
      lc.rates.cacheWritePerMillion,
      lc.rates.cacheWrite1hPerMillion,
    ].every((r) => typeof r === "number" && Number.isFinite(r) && r > 0);
  if (valid) return row;
  const { longContext: _drop, ...rest } = row;
  if (fallback?.longContext && fallback.inputPerMillion === row.inputPerMillion) {
    return { ...rest, longContext: fallback.longContext };
  }
  return rest;
}

/** A usable multiplier: finite and at least 1 (neither fast mode nor the US premium is a discount). */
function validMultiplier(m: unknown): m is number {
  return typeof m === "number" && Number.isFinite(m) && m >= 1;
}

/**
 * Validate a row's fast-mode and US-geo multipliers, and carry the shipped ones
 * over when the source row has none.
 *
 * `pricing.json` carries no multiplier fields (the cache parser reads only the
 * base table), and the merge is whole-row, so without the inheritance every
 * cache refresh would delete them: fast mode would be refused on every model
 * and the US premium would vanish. Inherit only when the base input rate agrees
 * (same reasoning as `withLongContext`): a multiplier published against an old
 * price is not evidence about a repriced one, and a refused fast row is a
 * visible gap while a stale multiplier is a wrong number. A malformed value is
 * dropped, never defaulted.
 */
function withMultipliers(row: ModelPricing, fallback?: ModelPricing): ModelPricing {
  const { fastMultiplier: fm, usGeoMultiplier: gm, ...rest } = row;
  const inherit = !!fallback && fallback.inputPerMillion === row.inputPerMillion;
  const fast = validMultiplier(fm) ? fm : inherit ? fallback!.fastMultiplier : undefined;
  const geo = validMultiplier(gm) ? gm : inherit ? fallback!.usGeoMultiplier : undefined;
  return {
    ...rest,
    ...(validMultiplier(fast) ? { fastMultiplier: fast } : {}),
    ...(validMultiplier(geo) ? { usGeoMultiplier: geo } : {}),
  };
}

/**
 * Rate-coherence bound for a parsed or fetched row.
 *
 * The fetch path picks its columns by heuristic over remote HTML. Without a
 * bound, a docs restructure silently doubles a wrong number into every cache
 * write, and the only visible symptom is a cost step that users have already
 * been told to expect. A row that fails this keeps its `DEFAULT_PRICING` entry
 * rather than merging.
 *
 * Deliberately NOT applied to a user-configured `rateOverrides` row: a value the
 * user explicitly supplied is not ours to second-guess (see
 * `validatePricingConfig`, which rejects rather than substitutes).
 */
export function isCoherentPricing(p: ModelPricing): boolean {
  const rates = [
    p.inputPerMillion,
    p.outputPerMillion,
    p.cacheReadPerMillion,
    p.cacheWritePerMillion,
    p.cacheWrite1hPerMillion,
  ];
  if (!rates.every((r) => typeof r === "number" && Number.isFinite(r) && r > 0)) return false;
  // Reads are cheaper than writes; the long TTL never costs less than the short.
  if (!(p.cacheReadPerMillion < p.cacheWritePerMillion)) return false;
  if (!(p.cacheWritePerMillion <= p.cacheWrite1hPerMillion)) return false;
  const ratio = p.cacheWrite1hPerMillion / p.inputPerMillion;
  return ratio >= 1 && ratio <= 4;
}

/**
 * Replace the live pricing table with fetched data.
 * Called by the pricing cache module after a successful fetch or cache load.
 */
export function applyPricingCache(
  models: Record<string, ModelPricing>,
  fetchedAt: string,
): void {
  // Merge: cached entries override defaults, but keep defaults for any models
  // not present in the fetched data (future-proofing).
  const merged: Record<string, ModelPricing> = { ...DEFAULT_PRICING };
  for (const [key, row] of Object.entries(models)) {
    // A model id arrives from remote HTML; never let one reach the prototype.
    if (key === "__proto__") continue;
    if (!row || typeof row !== "object") continue;
    const filled = withMultipliers(withLongContext(withTtlRates(row, DEFAULT_PRICING[key]), DEFAULT_PRICING[key]), DEFAULT_PRICING[key]);
    // Incoherent → leave whatever `DEFAULT_PRICING` had for this key in place.
    // A key with no default is simply dropped, which surfaces as `known: false`
    // rather than as a confident figure from a rate we do not believe.
    if (!isCoherentPricing(filled)) continue;
    merged[key] = filled;
  }
  PRICING = merged;
  PRICING_VERIFIED_DATE = fetchedAt;
  // Rebuild sorted keys
  _sortedKeys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
}

// Keys sorted longest-first so "claude-opus-4-6" matches before "claude-opus-4"
let _sortedKeys = Object.keys(PRICING).sort((a, b) => b.length - a.length);

// ─── Long-context classification (one source of truth for TS and SQL) ────────

/** Escape a string for a single-quoted SQL literal. */
function sqlLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * SQL that yields 1 when a request is in its model's long-context tier, else 0.
 * Generated from the live rate table so a new tiered model or a changed
 * threshold flows into every query and into the rollup watermark
 * (`longContextSqlExprHash`).
 *
 * Models whose tiers share a threshold are grouped. A model matches when its
 * key occurs in the id (`instr`), which covers first-party, dated, `[1m]`,
 * Bedrock and Vertex forms. That is a superset of `resolvePricing`'s
 * suffix-shape rule: an id the rule refuses (a point-release such as
 * `...-5-5-1`) is flagged here but prices at $0 / `known: false` either way, so
 * the two classifiers can disagree only on a request that costs nothing.
 *
 * With no tiered model it returns `"0"`.
 */
export function longContextSqlExpr(cols: {
  model: string;
  input: string;
  cacheRead: string;
  cacheCreation: string;
}): string {
  const byThreshold = new Map<number, string[]>();
  for (const key of Object.keys(PRICING).sort()) {
    const lc = PRICING[key]?.longContext;
    if (!lc) continue;
    const keys = byThreshold.get(lc.thresholdTokens) ?? [];
    keys.push(key);
    byThreshold.set(lc.thresholdTokens, keys);
  }
  if (byThreshold.size === 0) return "0";
  const prompt = `(COALESCE(${cols.input},0) + COALESCE(${cols.cacheRead},0) + COALESCE(${cols.cacheCreation},0))`;
  const arms = [...byThreshold.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([threshold, keys]) => {
      const match = keys.map((k) => `instr(${cols.model}, ${sqlLiteral(k)}) > 0`).join(" OR ");
      return `WHEN (${match}) AND ${prompt} > ${Math.trunc(threshold)} THEN 1`;
    });
  return `CASE ${arms.join(" ")} ELSE 0 END`;
}

/**
 * Stable hash of the generated expression (over fixed column names). Stored in
 * the rollup watermark: a rate-table change that alters the classification
 * changes this value and forces a rebuild. FNV-1a, 32-bit, hex.
 */
export function longContextSqlExprHash(): string {
  const expr = longContextSqlExpr({ model: "model", input: "i", cacheRead: "cr", cacheCreation: "cc" });
  let h = 0x811c9dc5;
  for (let i = 0; i < expr.length; i++) {
    h ^= expr.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * True when this single request is in its model's long-context tier: the model
 * has a tier and `input + cacheRead + cacheCreation` is strictly greater than
 * its threshold. Exactly at the threshold is the base tier.
 *
 * Matches a tiered model by the key occurring in the id, exactly as
 * `longContextSqlExpr` does (`instr`), so the per-message and aggregated
 * classifications cannot disagree on any id, including one the suffix-shape
 * rule refuses (a point-release such as `...-5-5-1`): that id is flagged by
 * both, and prices at $0 / `known: false` either way.
 */
export function isLongContextRequest(
  model: string,
  input: number,
  cacheRead: number,
  cacheCreation: number,
): boolean {
  if (typeof model !== "string") return false;
  const prompt = nonNegativeFiniteInt(input) + nonNegativeFiniteInt(cacheRead) + nonNegativeFiniteInt(cacheCreation);
  for (const [key, row] of Object.entries(PRICING)) {
    const lc = row.longContext;
    if (lc && prompt > lc.thresholdTokens && model.includes(key)) return true;
  }
  return false;
}

// ─── Model-id normalization (first-party / Bedrock / Vertex) ─────────────────

/**
 * A model id split into the canonical first-party id used for rate lookup and
 * the platform that served it.
 */
export interface NormalizedModel {
  /** Canonical first-party id, e.g. `claude-opus-5`. */
  canonical: string;
  source: PricingSource;
  /** The input string, unchanged. */
  raw: string;
}

/** Cross-region inference-profile prefixes on Bedrock (`us.`, `eu.`, `apac.`, …). */
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|us-gov|ca|sa|jp|au)\./;
/** Legacy Bedrock InvokeModel version suffix, e.g. `-v1:0`, `-v2:0`. */
const BEDROCK_VERSION_SUFFIX = /-v\d+:\d+$/;
/** Vertex dated-snapshot separator, e.g. `claude-opus-4-5@20251101`. */
const VERTEX_SNAPSHOT_SUFFIX = /@\d{8}$/;

/**
 * Reduce any served model id to the canonical first-party id, and report which
 * platform it came from.
 *
 * Four id families reach this function, and before this existed only the first
 * one priced at all — `lookupPricing` matches `startsWith("claude-…")`, so every
 * Bedrock and Vertex id fell through to "unknown model" and silently costed
 * nothing. That is the single highest-impact defect for metered/Enterprise
 * users, who are exactly the audience for whom these figures are real money.
 *
 *   first-party      `claude-opus-5`, `claude-haiku-4-5-20251001`
 *   Bedrock (Mantle) `anthropic.claude-opus-5`
 *   Bedrock (legacy) `us.anthropic.claude-3-5-sonnet-20241022-v2:0`
 *   Vertex           `claude-opus-4-5@20251101`
 *
 * Unrecognised strings pass through unchanged as `first_party`; the caller still
 * gets `known: false` from `estimateCost` rather than a silent zero.
 */
export function normalizeModelId(raw: string): NormalizedModel {
  let id = raw.trim();
  let source: PricingSource = "first_party";

  if (BEDROCK_REGION_PREFIX.test(id)) {
    id = id.replace(BEDROCK_REGION_PREFIX, "");
    source = "bedrock";
  }
  if (id.startsWith("anthropic.")) {
    id = id.slice("anthropic.".length);
    source = "bedrock";
  }
  if (BEDROCK_VERSION_SUFFIX.test(id)) {
    id = id.replace(BEDROCK_VERSION_SUFFIX, "");
    source = "bedrock";
  }
  if (VERTEX_SNAPSHOT_SUFFIX.test(id)) {
    id = id.replace(VERTEX_SNAPSHOT_SUFFIX, "");
    // A region prefix already proved Bedrock; a bare `@date` means Vertex.
    if (source === "first_party") source = "vertex";
  }

  return { canonical: id, source, raw };
}

/**
 * Coarse capability tier for a served model id: frontier (Fable/Mythos), top
 * (Opus), mid (Sonnet), low (Haiku), or unknown (unrecognized id). Independent
 * of the rate table: a model this build has never priced can still be tiered
 * from its name, which is all the tier-mismatch detector
 * (`hygiene/tierMismatch.ts`) needs — it compares OUTCOMES across a tier
 * boundary, not dollars per tier.
 *
 * `frontier` is split from `top` because the two differ by 2× in price (Opus 5.5
 * $4 / $20, Fable 5.2 $8 / $40): lumped together, the most expensive routing
 * choice a developer makes (Opus or Fable) was invisible to the detector.
 */
export type ModelTier = "frontier" | "top" | "mid" | "low" | "unknown";

export function modelTier(raw: string): ModelTier {
  const { canonical } = normalizeModelId(raw);
  const id = canonical.toLowerCase();
  if (id.includes("fable") || id.includes("mythos")) return "frontier";
  if (id.includes("opus")) return "top";
  if (id.includes("sonnet")) return "mid";
  if (id.includes("haiku")) return "low";
  return "unknown";
}

/**
 * Per-source rate overrides, keyed by canonical model-id prefix (same
 * longest-prefix matching as the built-in table).
 *
 * Bedrock and Vertex are partner-operated and priced SEPARATELY from
 * first-party rates — and Bedrock rates additionally vary by region. We ship no
 * partner rate table (it would go stale silently and we cannot verify it per
 * region), so a metered partner account prices at first-party rates and the
 * result is flagged `rateBasis: "first_party_fallback"`. Surfaces must render
 * that as an estimate and point at this config; a reconciliation report must
 * treat it as the likely residual cause before blaming anything else.
 */
export type RateOverrides = Partial<Record<PricingSource, Record<string, ModelPricing>>>;

/** How a rate was arrived at — carried into every cost figure. */
export type RateBasis = "first_party" | "configured" | "first_party_fallback";

// ─── The suffix-shape rule ───────────────────────────────────────────────────
//
// Longest-prefix matching is load-bearing: a dated snapshot id
// (`claude-haiku-4-5-20251001`) MUST inherit its base row's rates, and so must
// a context-window tier id (`claude-opus-5[1m]` — 4.6-and-later models include
// the full 1M window at standard pricing, confirmed both against the published
// pricing page and by repricing against Claude Code's own `cost-state` rollup).
// The exception is Haiku 5.5: a `claude-haiku-5-5[1m]` id resolves to the same
// entry, long-context tier included, and a request over 100,000 prompt tokens
// is priced at the tier rates (see `ModelPricing.longContext`).
//
// But a point-release id is also a string prefix extension of its predecessor's
// (`claude-fable-5-1` starts with `claude-fable-5`), so plain prefix matching
// resolves a NEW model to an OLD rate row and reports `known: true` while doing
// it. That is how Fable 5.1 came to be priced at Fable 5's 1.00 cache-read rate
// (4×) and Opus 4.7 at retired Opus 4 rates (3×).
//
// The two cases are told apart by the SHAPE of the remainder after the matched
// key. Refusing yields the `{cost: 0, known: false}` path this module was
// designed around — a visibly missing number rather than a confidently wrong
// one — plus a drift finding naming the model so the row gets added.

/** Dated snapshot of the same model, e.g. `-20251001`. */
const DATED_SNAPSHOT_REMAINDER = /^-\d{8}$/;
/** Context-window tier, e.g. `[1m]`, `[200k]`. */
const CONTEXT_TIER_REMAINDER = /^\[\d+[mk]\]$/;
/** Point-release successor, e.g. `-1`, `-11`. */
const POINT_RELEASE_REMAINDER = /^-\d{1,2}$/;

/**
 * How the text after a matched rate-table key is to be read. The first three
 * inherit the matched row; the last two refuse it.
 */
export type ModelIdSuffixShape =
  | "exact"
  | "dated-snapshot"
  | "context-tier"
  | "point-release-suffix"
  | "unknown-suffix-shape";

/**
 * Classify the remainder of a model id after its matched rate-table key.
 *
 * Pure and total — every string maps to exactly one shape, and it never throws.
 * Exported so the rule can be tested directly rather than only through the
 * resolver.
 */
export function classifyModelIdSuffix(remainder: string): ModelIdSuffixShape {
  if (remainder === "") return "exact";
  if (DATED_SNAPSHOT_REMAINDER.test(remainder)) return "dated-snapshot";
  if (CONTEXT_TIER_REMAINDER.test(remainder)) return "context-tier";
  if (POINT_RELEASE_REMAINDER.test(remainder)) return "point-release-suffix";
  return "unknown-suffix-shape";
}

/** The shapes that may inherit the matched row's rates. */
export type InheritingSuffixShape = "exact" | "dated-snapshot" | "context-tier";

/**
 * True when a remainder of this shape may inherit the matched row's rates.
 *
 * A type predicate rather than a plain boolean so the complement — the two
 * refusing shapes — is the compiler's own narrowing, not a second hand-written
 * list that could drift out of step with this one.
 */
export function suffixShapeInherits(shape: ModelIdSuffixShape): shape is InheritingSuffixShape {
  return shape === "exact" || shape === "dated-snapshot" || shape === "context-tier";
}

/**
 * A model id that prefix-matched a rate row but was refused it.
 *
 * This is the API Lane C renders. All four fields are machine values, not
 * prose: `reason` and `table` are CLOSED token sets (render them unlocalised,
 * or map them to i18n keys), and `modelId` / `matchedKey` are model ids, not
 * user text. Nothing here is localisable and nothing here is free text.
 */
export interface PricingDriftFinding {
  kind: "unpriced-model-variant";
  /** Canonical (normalized) model id that was refused a rate. */
  modelId: string;
  /** The rate-table key it would have silently inherited from. */
  matchedKey: string;
  /** Why it was refused — closed set. */
  reason: "point-release-suffix" | "unknown-suffix-shape";
  /** Which matcher refused it: the shipped table, or a configured override. */
  table: "built-in" | "override";
}

/** Outcome of one prefix match, including the refusal case. */
export interface PricingTableMatch {
  /** The key that matched, or `null` when no key is a prefix of the id. */
  matchedKey: string | null;
  /** The row to use, or `null` when the match was refused or absent. */
  pricing: ModelPricing | null;
  /** Shape of the remainder, or `null` when no key matched at all. */
  shape: ModelIdSuffixShape | null;
  /** Set exactly when a key matched but the shape refused it. */
  drift: PricingDriftFinding | null;
}

/**
 * Longest-prefix lookup over an arbitrary rate table, with the suffix-shape
 * rule applied.
 *
 * Pure: it reads only its arguments and returns the finding rather than
 * recording it. `resolvePricing` is the impure wrapper that accumulates.
 *
 * A refused match does NOT fall through to a shorter key. A shorter key's
 * remainder is strictly longer and would land in `unknown-suffix-shape`
 * anyway, so falling through could only ever turn one refusal into another —
 * while making the reported `matchedKey` less informative.
 */
export function matchPricingTable(
  table: Record<string, ModelPricing>,
  canonical: string,
  which: "built-in" | "override",
  sortedKeys?: readonly string[],
): PricingTableMatch {
  const keys = sortedKeys ?? Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!canonical.startsWith(key)) continue;
    const row = table[key];
    if (!row) continue;
    const shape = classifyModelIdSuffix(canonical.slice(key.length));
    if (suffixShapeInherits(shape)) {
      return { matchedKey: key, pricing: row, shape, drift: null };
    }
    return {
      matchedKey: key,
      pricing: null,
      shape,
      drift: {
        kind: "unpriced-model-variant",
        modelId: canonical,
        matchedKey: key,
        reason: shape,
        table: which,
      },
    };
  }
  return { matchedKey: null, pricing: null, shape: null, drift: null };
}

/**
 * Deduplicated drift findings seen since the last clear.
 *
 * `resolvePricing` runs once per priced message row — millions of calls over a
 * full history — so this is keyed and capped rather than appended to. The cap
 * bounds memory against a corpus full of junk model ids; the surface only ever
 * needs the distinct list.
 */
const _driftFindings = new Map<string, PricingDriftFinding>();
const MAX_DRIFT_FINDINGS = 100;

function recordPricingDrift(f: PricingDriftFinding): void {
  // JSON-encoded tuple rather than a joined string: model ids arrive from
  // transcript data, so no separator character can be assumed absent from them.
  const key = JSON.stringify([f.table, f.modelId, f.matchedKey]);
  if (_driftFindings.has(key) || _driftFindings.size >= MAX_DRIFT_FINDINGS) return;
  _driftFindings.set(key, f);
}

/**
 * Snapshot of the distinct drift findings accumulated so far, in a stable
 * order. Returns copies; mutating the result cannot corrupt the accumulator.
 *
 * Lane C reads this after a cost pass to render the unpriced-model surface.
 * Pair it with `clearPricingDriftFindings()` at the start of a pass so the
 * findings belong to that pass.
 */
export function getPricingDriftFindings(): PricingDriftFinding[] {
  return [..._driftFindings.values()]
    .map((f) => ({ ...f }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId) || a.table.localeCompare(b.table));
}

/** Drop every accumulated finding. Call before a pass whose findings you want. */
export function clearPricingDriftFindings(): void {
  _driftFindings.clear();
}

/**
 * Look up pricing for a model name using startsWith matching, longest key first.
 *
 * Accepts any of the four id families (normalizes first). Pass `overrides` to
 * consult a configured partner rate table before the built-in first-party one.
 */
export function lookupPricing(modelName: string, overrides?: RateOverrides): ModelPricing | null {
  return resolvePricing(modelName, overrides).pricing;
}

/** Pricing plus the provenance of the rate that was used. */
export interface ResolvedPricing {
  pricing: ModelPricing | null;
  source: PricingSource;
  rateBasis: RateBasis;
  canonical: string;
  /**
   * Present exactly when a rate-table key prefix-matched this id but the
   * suffix-shape rule refused it. When `pricing` is `null` this is the reason
   * for it; when `pricing` is set it means a *configured override* was refused
   * and the figure fell back to the built-in table.
   *
   * The same finding is also accumulated module-side — see
   * `getPricingDriftFindings()`, which is what surfaces read, since the 19
   * `estimateCost` call sites cannot thread a return value out.
   */
  drift?: PricingDriftFinding;
}

/**
 * Resolve a rate and say where it came from. The provenance is not decoration:
 * a metered figure priced from a fallback rate must not be presented with the
 * same confidence as one priced from a configured partner rate.
 */
export function resolvePricing(modelName: string, overrides?: RateOverrides): ResolvedPricing {
  const { canonical, source } = normalizeModelId(modelName);

  // The override table gets the SAME shape rule. Without it a user override for
  // `claude-fable-5` silently captures `claude-fable-5-1` — the identical defect
  // one layer up, and the one the built-in fix would otherwise mask.
  let overrideDrift: PricingDriftFinding | null = null;
  const configured = overrides?.[source];
  if (configured) {
    const m = matchPricingTable(configured, canonical, "override");
    overrideDrift = m.drift;
    if (m.drift) recordPricingDrift(m.drift);
    if (m.pricing) return { pricing: m.pricing, source, rateBasis: "configured", canonical };
    // A refused override falls through to the built-in table, which is the
    // documented `first_party_fallback` path: an honest first-party estimate
    // beats a partner rate we have positive reason to believe is the wrong row.
  }

  const b = matchPricingTable(PRICING, canonical, "built-in", _sortedKeys);
  if (b.drift) recordPricingDrift(b.drift);
  // Prefer the finding that explains the outcome the caller actually got.
  const drift = b.drift ?? overrideDrift;

  if (b.pricing) {
    return {
      pricing: b.pricing,
      source,
      rateBasis: source === "first_party" ? "first_party" : "first_party_fallback",
      canonical,
      ...(drift ? { drift } : {}),
    };
  }
  return { pricing: null, source, rateBasis: "first_party", canonical, ...(drift ? { drift } : {}) };
}

/**
 * Coerce an untrusted token count to a non-negative finite integer.
 *
 * The ephemeral TTL columns become cost-bearing here for the first time.
 * `parser/session.ts` copies them out of JSONL with no validation and
 * `sync-merge/apply.ts` copies them from another device's shard, so a
 * non-numeric value that is inert today would become `NaN` in `totalCost`,
 * `hygieneRatio`, the dashboard summary and the MCP payload. Non-number / `NaN`
 * / `Infinity` / negative all collapse to `0`, which costs the row as
 * unattributed rather than poisoning every total that contains it.
 */
export function nonNegativeFiniteInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** A cost figure plus how much of its cache-write volume was actually attributed. */
export interface CostEstimate {
  cost: number;
  known: boolean;
  source: PricingSource;
  rateBasis: RateBasis;
  /** Creation tokens priced at the 5-minute rate for want of a TTL split. */
  unattributedWriteTokens: number;
  /** Split tokens exceeding `cacheCreationTokens` — an inconsistent source. */
  overAttributedWriteTokens: number;
  /**
   * Present exactly when a KNOWN model was refused a price because of the
   * request's `speed`: `"fast-unpriced"` (fast mode on a model with no published
   * fast rate) or `"speed-unknown"` (a `speed` value other than `standard` /
   * `fast`). The estimate is then `{cost: 0, known: false}`, the same visibly
   * missing number as an unknown model; this field lets a surface say why.
   * Absent for an unknown model and for every priced request.
   */
  reason?: CostRefusalReason;
}

/** Why `estimateCost` refused to price a request of a model it otherwise knows. */
export type CostRefusalReason = "fast-unpriced" | "speed-unknown";

/** Per-request pricing modifiers. Every field is optional; omitted = base rates. */
export interface CostOptions {
  /** The request is in the model's long-context tier (see `isLongContextRequest`). */
  longContext?: boolean;
  /**
   * `usage.speed` of the request: `standard`, `fast`, absent or null. `fast`
   * multiplies every rate by the row's `fastMultiplier`, or REFUSES the request
   * if the row has none. Any other value is refused as `speed-unknown`.
   */
  speed?: string | null;
  /** `usage.inference_geo`. Exactly `"us"` applies the row's `usGeoMultiplier`; anything else is × 1. */
  inferenceGeo?: string | null;
}

/** Scale all five rates; every other field is carried over unchanged. */
function scaleRates(p: ModelPricing, m: number): ModelPricing {
  return {
    ...p,
    inputPerMillion: p.inputPerMillion * m,
    outputPerMillion: p.outputPerMillion * m,
    cacheReadPerMillion: p.cacheReadPerMillion * m,
    cacheWritePerMillion: p.cacheWritePerMillion * m,
    cacheWrite1hPerMillion: p.cacheWrite1hPerMillion * m,
  };
}

/** The rate row one request is priced at, with how it got there. */
export interface RequestPricing {
  /** Provenance of the base row (source, rate basis, canonical id, drift). */
  resolved: ResolvedPricing;
  /**
   * The rates to price this request at: the matched row, replaced by its
   * long-context tier when `opts.longContext` and the model has one, then every
   * rate multiplied by the fast-mode and US-geo multipliers that apply. `null`
   * for an unknown model AND for a refused request (see `reason`).
   */
  pricing: ModelPricing | null;
  /** Set exactly when a known model was refused because of `opts.speed`. */
  reason?: CostRefusalReason;
}

/**
 * Resolve a model and a request's pricing modifiers to one rate row. The single
 * implementation of the long-context × fast × geo composition: `estimateCost`
 * prices dollars from it, and the analytics that read a rate directly (cache-TTL
 * fit, context carry, context bloat, auto-compact fit) call it per request so
 * they price a long-context, fast or US-pinned row at the rate it was billed at.
 *
 * Composition: tier rates (long context) × fast multiplier × US-geo multiplier,
 * applied to all five rates. The pricing page says the cache multipliers and the
 * data-residency multiplier apply on top of fast-mode pricing, and that the US
 * multiplier also applies to Haiku 5.5's over-100K tier prices.
 *
 * Refusals (a visibly missing number, never a wrong one): `speed = "fast"` on a
 * row with no `fastMultiplier` is `fast-unpriced`; any `speed` other than
 * standard/fast/absent is `speed-unknown`. Absent, null or `standard` speed and
 * any non-`us` geo leave the rates exactly as they were: bit-identical to the
 * pre-modifier result.
 */
export function resolveRequestPricing(model: string, opts?: CostOptions, overrides?: RateOverrides): RequestPricing {
  const resolved = resolvePricing(model, overrides);
  // A long-context request is priced at the tier rates in every column. A model
  // with no tier ignores the flag (base rates, not an error).
  const tier = opts?.longContext ? resolved.pricing?.longContext : undefined;
  let pricing: ModelPricing | null = resolved.pricing && tier ? { ...resolved.pricing, ...tier.rates } : resolved.pricing;
  if (!pricing) return { resolved, pricing: null };

  const speed = opts?.speed;
  let multiplier = 1;
  let reason: CostRefusalReason | undefined;
  if (speed === undefined || speed === null || speed === "standard") {
    // Unchanged: standard and absent speed price at the row's own rates.
  } else if (speed === "fast") {
    if (validMultiplier(pricing.fastMultiplier)) multiplier *= pricing.fastMultiplier;
    else reason = "fast-unpriced";
  } else {
    reason = "speed-unknown";
  }
  if (reason) return { resolved, pricing: null, reason };
  if (opts?.inferenceGeo === "us" && validMultiplier(pricing.usGeoMultiplier)) multiplier *= pricing.usGeoMultiplier;
  if (multiplier !== 1) pricing = scaleRates(pricing, multiplier);
  return { resolved, pricing };
}

/**
 * Stable string key of the pricing modifiers, for per-call rate caches that used
 * to be keyed by model id alone. Two requests with the same model and the same
 * key resolve to the same rate row.
 */
export function costOptionsKey(opts?: CostOptions): string {
  return `${opts?.longContext ? 1 : 0}|${opts?.inferenceGeo === "us" ? "us" : ""}|${opts?.speed ?? ""}`;
}

/**
 * Estimate the equivalent API cost in dollars for a given token usage.
 * Returns { cost, known } where known=false means the model wasn't in the pricing table.
 *
 * Cache writes are priced by TTL, in this order:
 *
 *  1. **No `ttlSplit`** → the whole `cacheCreationTokens` at
 *     `cacheWritePerMillion`, and `unattributedWriteTokens = cacheCreationTokens`.
 *     Byte-identical to the pre-TTL behaviour — that is what lets the split be
 *     wired into shared aggregates without re-auditing every downstream figure.
 *  2. **With a split** → `5m × cacheWritePerMillion + 1h × cacheWrite1hPerMillion`,
 *     plus the residual `max(0, creation − 5m − 1h)` at the 5-minute rate,
 *     reported as `unattributedWriteTokens`.
 *  3. **Split exceeds `cacheCreationTokens`** → price the split as given, residual
 *     `0`, and report the excess in `overAttributedWriteTokens`. Visible, not
 *     clamped into silence and not thrown.
 *  4. **Unknown model** → `{cost: 0, known: false}` with
 *     `unattributedWriteTokens = cacheCreationTokens`: nothing was attributed, and
 *     a `0` there would read as "fully attributed".
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  overrides?: RateOverrides,
  ttlSplit?: CacheWriteSplit,
  opts?: CostOptions,
): CostEstimate {
  const { resolved, pricing, reason: refusal } = resolveRequestPricing(model, opts, overrides);
  const { source, rateBasis } = resolved;
  if (!pricing) {
    // Unknown model: report zero AND `known: false`. Callers must surface the
    // unknown share rather than letting it vanish into a total — a silently
    // zero-costed model is indistinguishable from free usage.
    return {
      cost: 0,
      known: false,
      source,
      rateBasis,
      unattributedWriteTokens: cacheCreationTokens,
      overAttributedWriteTokens: 0,
      ...(refusal ? { reason: refusal } : {}),
    };
  }

  // Everything but the cache-write term. Kept as its own left-associated sum so
  // rules 1 and 2 — which are different code paths — add the write term to an
  // identical value and agree to the last bit.
  const base =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;

  // Rule 1.
  if (!ttlSplit) {
    return {
      cost: base + (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion,
      known: true,
      source,
      rateBasis,
      unattributedWriteTokens: cacheCreationTokens,
      overAttributedWriteTokens: 0,
    };
  }

  const write5m = nonNegativeFiniteInt(ttlSplit.ephemeral5mCacheTokens);
  const write1h = nonNegativeFiniteInt(ttlSplit.ephemeral1hCacheTokens);
  const attributed = write5m + write1h;
  // Rules 2 and 3 — exactly one of these is non-zero for any given row.
  const residual = Math.max(0, cacheCreationTokens - attributed);
  const excess = Math.max(0, attributed - cacheCreationTokens);

  const writeCost =
    (write5m / 1_000_000) * pricing.cacheWritePerMillion +
    (write1h / 1_000_000) * pricing.cacheWrite1hPerMillion +
    (residual / 1_000_000) * pricing.cacheWritePerMillion;

  return {
    cost: base + writeCost,
    known: true,
    source,
    rateBasis,
    unattributedWriteTokens: residual,
    overAttributedWriteTokens: excess,
  };
}

/**
 * Known subscription types → monthly plan fee (USD).
 * Values come from Anthropic telemetry's subscriptionType field.
 * Falls back to null for unknown types.
 */
export const PLAN_FEES: Record<string, number> = {
  pro: 20,
  max_5x: 100,
  max_20x: 200,
  team_standard: 25,
  team_premium: 125,
  // Ultra: $200 / month, as listed on claude.com/pricing (read 2026-11-10 through
  // a summarising fetch, not verbatim: re-check before relying on it). The
  // `subscription_type` string Claude Code reports for Ultra has NOT been
  // observed, so this key matches only a literal "ultra" and the string-to-plan
  // map in cli/src/config.ts is deliberately left alone (PlanType is not widened).
  // P1-DECISION: fee added here only; config.ts PLAN_FEES / PlanType follow-up.
  ultra: 200,
  // Bare "team" prefix — conservative fallback to standard seat price
  team: 25,
};

/**
 * Look up the monthly plan fee for a subscription type string.
 * Tries exact match first, then case-insensitive, then prefix matching.
 */
export function lookupPlanFee(subscriptionType: string | null): number | null {
  if (!subscriptionType) return null;
  const lower = subscriptionType.toLowerCase().replace(/[- ]/g, "_");
  if (PLAN_FEES[lower] !== undefined) return PLAN_FEES[lower]!;
  // Try prefix matching for variants like "pro_annual", "max_5x_monthly"
  for (const [key, fee] of Object.entries(PLAN_FEES)) {
    if (lower.startsWith(key)) return fee;
  }
  return null;
}

/**
 * Format a dollar amount as $X.XX or $X,XXX.XX.
 */
export function formatCost(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
