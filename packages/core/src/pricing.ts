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

// Default pricing table — used as fallback when auto-fetched cache is unavailable.
// Verified against https://platform.claude.com/docs/en/about-claude/pricing
// `cacheWrite1hPerMillion` is `2 × inputPerMillion` on every row — that is the
// published multiplier, not a guess, hence `ttlRateBasis: "parsed"` throughout.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Fable 5 / Mythos 5 — the top capability tier, priced above Opus.
  "claude-fable-5":    { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed" },
  "claude-mythos-5":   { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20,   ttlRateBasis: "parsed" },
  // Claude Opus 5 — same rates as Opus 4.8. Missing this row meant current-
  // generation Opus usage costed zero with `known: true` nowhere to be seen.
  "claude-opus-5":     { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed" },
  "claude-opus-4-8":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed" },
  "claude-opus-4-6":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed" },
  "claude-opus-4-5":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25,  cacheWrite1hPerMillion: 10,   ttlRateBasis: "parsed" },
  "claude-opus-4-1":   { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75, cacheWrite1hPerMillion: 30,   ttlRateBasis: "parsed" },
  "claude-opus-4":     { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75, cacheWrite1hPerMillion: 30,   ttlRateBasis: "parsed" },
  // Introductory pricing through 2026-08-31; standard rate ($3/$15, matching
  // Sonnet 4.6) takes effect 2026-09-01 — bump this row then.
  "claude-sonnet-5":   { inputPerMillion: 2,    outputPerMillion: 10, cacheReadPerMillion: 0.20, cacheWritePerMillion: 2.50,  cacheWrite1hPerMillion: 4,    ttlRateBasis: "parsed" },
  "claude-sonnet-4-6": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75,  cacheWrite1hPerMillion: 6,    ttlRateBasis: "parsed" },
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

/** ISO date string when the active pricing data was last verified / fetched. */
export let PRICING_VERIFIED_DATE = "2026-07-03";

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
    const filled = withTtlRates(row, DEFAULT_PRICING[key]);
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
 * Coarse capability tier for a served model id — top (Opus/Fable/Mythos),
 * mid (Sonnet), low (Haiku), or unknown (unrecognized id). Independent of the
 * rate table: a model this build has never priced can still be tiered from
 * its name, which is all the tier-mismatch detector (`hygiene/tierMismatch.ts`)
 * needs — it compares OUTCOMES across a tier boundary, not dollars per tier.
 */
export type ModelTier = "top" | "mid" | "low" | "unknown";

export function modelTier(raw: string): ModelTier {
  const { canonical } = normalizeModelId(raw);
  const id = canonical.toLowerCase();
  if (id.includes("opus") || id.includes("fable") || id.includes("mythos")) return "top";
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

/** Longest-prefix lookup over an arbitrary rate table. */
function lookupIn(table: Record<string, ModelPricing>, modelName: string): ModelPricing | null {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (modelName.startsWith(key)) return table[key]!;
  }
  return null;
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
}

/**
 * Resolve a rate and say where it came from. The provenance is not decoration:
 * a metered figure priced from a fallback rate must not be presented with the
 * same confidence as one priced from a configured partner rate.
 */
export function resolvePricing(modelName: string, overrides?: RateOverrides): ResolvedPricing {
  const { canonical, source } = normalizeModelId(modelName);

  const configured = overrides?.[source];
  if (configured) {
    const hit = lookupIn(configured, canonical);
    if (hit) return { pricing: hit, source, rateBasis: "configured", canonical };
  }

  for (const key of _sortedKeys) {
    if (canonical.startsWith(key)) {
      return {
        pricing: PRICING[key]!,
        source,
        rateBasis: source === "first_party" ? "first_party" : "first_party_fallback",
        canonical,
      };
    }
  }
  return { pricing: null, source, rateBasis: "first_party", canonical };
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
): CostEstimate {
  const { pricing, source, rateBasis } = resolvePricing(model, overrides);
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
