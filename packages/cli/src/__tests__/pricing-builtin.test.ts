import { describe, it, expect, beforeAll } from "vitest";
import {
  applyPricingCache,
  estimateCost,
  lookupPricing,
  PRICING_VERIFIED_DATE,
} from "@claude-stats/core/pricing";

/**
 * These tests run with the live pricing cache absent: `applyPricingCache({})`
 * leaves only the built-in table in place, which is the state a first run, an
 * offline machine or a failed fetch is in. Same reset pattern as
 * `pricing-cache.test.ts` and `pricing-ttl.test.ts`.
 */
const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

beforeAll(() => {
  applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
});

describe("built-in rows for Sonnet 5.5 and Haiku 5.5 (no live cache)", () => {
  it("resolves claude-sonnet-5-5 with known:true and the published rates", () => {
    const p = lookupPricing("claude-sonnet-5-5");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(2);
    expect(p!.outputPerMillion).toBe(10);
    expect(p!.cacheReadPerMillion).toBe(0.10);
    expect(p!.cacheWritePerMillion).toBe(2.50);
    expect(p!.cacheWrite1hPerMillion).toBe(4);

    const c = estimateCost("claude-sonnet-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(c.known).toBe(true);
    // 2 in + 10 out + 0.10 cache read + 2.50 cache write (5m, no TTL split)
    expect(c.cost).toBeCloseTo(14.6, 10);
  });

  it("resolves claude-haiku-5-5 with known:true and the published rates", () => {
    const p = lookupPricing("claude-haiku-5-5");
    expect(p).not.toBeNull();
    expect(p!.inputPerMillion).toBe(0.10);
    expect(p!.outputPerMillion).toBe(0.50);
    expect(p!.cacheReadPerMillion).toBe(0.01);
    expect(p!.cacheWritePerMillion).toBe(0.125);
    expect(p!.cacheWrite1hPerMillion).toBe(0.20);

    const c = estimateCost("claude-haiku-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(c.known).toBe(true);
    // 0.10 in + 0.50 out + 0.01 cache read + 0.125 cache write (5m, no TTL split)
    expect(c.cost).toBeCloseTo(0.735, 10);
  });

  it("prices the 1h cache write at the 1h rate when a TTL split is given", () => {
    const c = estimateCost("claude-haiku-5-5", 0, 0, 0, 1_000_000, undefined, {
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 1_000_000,
    });
    expect(c.known).toBe(true);
    expect(c.cost).toBeCloseTo(0.20, 10);
  });
});

/**
 * Every model id that a test fixture under `packages/cli/src/__tests__/fixtures/`
 * uses as a `model` value and that starts with `claude-`. Source (grep, 2026-10-27):
 *   - fixtures/golden-dashboard.ts: claude-opus-4-5, claude-sonnet-4-5, claude-opus-4-6
 *   - fixtures/synthetic.ts MODELS: claude-opus-4-6, claude-sonnet-5, claude-opus-4-5@20251101
 * Re-run `grep -n 'claude-' packages/cli/src/__tests__/fixtures/*.ts` when fixtures change.
 *
 * Deliberately NOT in this list: the Bedrock-prefixed `anthropic.claude-opus-5` and
 * `us.anthropic.claude-3-5-sonnet-20241022-v2:0` (they do not start with `claude-`),
 * and `claude-vscode`/`claude-cli`/`claude-stats`, which are client or project
 * names, not model ids.
 */
const FIXTURE_MODEL_IDS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-opus-4-5@20251101",
] as const;

describe("fixture model ids all resolve to a known rate (no live cache)", () => {
  it.each(FIXTURE_MODEL_IDS)("%s resolves with known:true", (model) => {
    const c = estimateCost(model, 1_000, 1_000, 1_000, 1_000);
    expect(c.known).toBe(true);
    expect(c.cost).toBeGreaterThan(0);
  });
});
