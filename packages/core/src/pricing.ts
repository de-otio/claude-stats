/**
 * Cost estimation from token usage and model pricing.
 * Prices represent equivalent API cost — not what subscription plans actually charge.
 */

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

// Default pricing table — used as fallback when auto-fetched cache is unavailable.
// Verified against https://platform.claude.com/docs/en/about-claude/pricing
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-5":   { inputPerMillion: 5,    outputPerMillion: 25, cacheReadPerMillion: 0.50, cacheWritePerMillion: 6.25 },
  "claude-opus-4-1":   { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75 },
  "claude-opus-4":     { inputPerMillion: 15,   outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75 },
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
export let PRICING_VERIFIED_DATE = "2026-03-10";

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

/**
 * Look up pricing for a model name using startsWith matching, longest key first.
 */
export function lookupPricing(modelName: string): ModelPricing | null {
  for (const key of _sortedKeys) {
    if (modelName.startsWith(key)) {
      return PRICING[key]!;
    }
  }
  return null;
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
): { cost: number; known: boolean } {
  const pricing = lookupPricing(model);
  if (!pricing) {
    return { cost: 0, known: false };
  }
  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMillion;
  return { cost, known: true };
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
