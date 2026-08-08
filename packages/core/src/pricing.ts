/**
 * Cost estimation from token usage and model pricing.
 * Prices represent equivalent API cost — not what subscription plans actually charge.
 */
import type { PricingSource } from "./types/insight.js";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

// Default pricing table — used as fallback when auto-fetched cache is unavailable.
// Verified against https://platform.claude.com/docs/en/about-claude/pricing
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Fable 5 / Mythos 5 — the top capability tier, priced above Opus.
  "claude-fable-5":    { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50 },
  "claude-mythos-5":   { inputPerMillion: 10,   outputPerMillion: 50, cacheReadPerMillion: 1.00, cacheWritePerMillion: 12.50 },
  // Claude Opus 5 — same rates as Opus 4.8. Missing this row meant current-
  // generation Opus usage costed zero with `known: true` nowhere to be seen.
  "claude-opus-5":     { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-8":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-6":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-5":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-1":   { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75 },
  "claude-opus-4":     { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75 },
  // Introductory pricing through 2026-08-31; standard rate ($3/$15, matching
  // Sonnet 4.6) takes effect 2026-09-01 — bump this row then.
  "claude-sonnet-5":   { inputPerMillion: 2,    outputPerMillion: 10, cacheReadPerMillion: 0.20, cacheWritePerMillion: 2.50 },
  "claude-sonnet-4-6": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75 },
  "claude-sonnet-4-5": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75 },
  "claude-sonnet-4":   { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75 },
  "claude-haiku-4-5":  { inputPerMillion: 1,    outputPerMillion: 5,  cacheReadPerMillion: 0.10, cacheWritePerMillion: 1.25 },
  "claude-3-5-haiku":  { inputPerMillion: 0.80, outputPerMillion: 4,  cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  "claude-3-5-sonnet": { inputPerMillion: 3,    outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75 },
};

/**
 * Live pricing table — starts as DEFAULT_PRICING, overwritten by cached data
 * when `applyPricingCache()` is called at startup.
 */
export let PRICING: Record<string, ModelPricing> = { ...DEFAULT_PRICING };

/** ISO date string when the active pricing data was last verified / fetched. */
export let PRICING_VERIFIED_DATE = "2026-07-03";

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
  PRICING = { ...DEFAULT_PRICING, ...models };
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
 * Estimate the equivalent API cost in dollars for a given token usage.
 * Returns { cost, known } where known=false means the model wasn't in the pricing table.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  overrides?: RateOverrides,
): { cost: number; known: boolean; source: PricingSource; rateBasis: RateBasis } {
  const { pricing, source, rateBasis } = resolvePricing(model, overrides);
  if (!pricing) {
    // Unknown model: report zero AND `known: false`. Callers must surface the
    // unknown share rather than letting it vanish into a total — a silently
    // zero-costed model is indistinguishable from free usage.
    return { cost: 0, known: false, source, rateBasis };
  }
  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion;
  return { cost, known: true, source, rateBasis };
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
