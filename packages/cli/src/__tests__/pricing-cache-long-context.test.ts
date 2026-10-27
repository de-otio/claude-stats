/**
 * C2 — the pricing page carries two "Claude Haiku 5.5" rows (prompts up to /
 * over 100,000 tokens). The parser must read the low row as the base rates and
 * the high row as `longContext`, in either order, and never let the tier row
 * become the base (V6 discrepancies 4 and 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePricingTable, longContextRowThreshold } from "../pricing-cache.js";
import {
  applyPricingCache,
  estimateCost,
  lookupPricing,
  PRICING_VERIFIED_DATE,
} from "@claude-stats/core/pricing";

const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

const HEAD =
  "<tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>1h Cache Writes</th><th>Cache Hits &amp; Refreshes</th><th>Output Tokens</th></tr>";
const row = (name: string, i: string, w5: string, w1: string, r: string, o: string): string =>
  `<tr><td>${name}</td><td>${i}</td><td>${w5}</td><td>${w1}</td><td>${r}</td><td>${o}</td></tr>`;

const LOW = row("Claude Haiku 5.5 (for prompts up to 100,000 tokens)", "$0.10 / MTok", "$0.125 / MTok", "$0.20 / MTok", "$0.01 / MTok", "$0.50 / MTok");
const HIGH = row("Claude Haiku 5.5 (for prompts over 100,000 tokens)", "$0.50 / MTok", "$0.625 / MTok", "$1 / MTok", "$0.05 / MTok", "$2.50 / MTok");
const OPUS = row("Claude Opus 5.5", "$4 / MTok", "$5 / MTok", "$8 / MTok", "$0.20 / MTok", "$20 / MTok");

const page = (...rows: string[]): string => `<table><thead>${HEAD}</thead><tbody>${rows.join("")}</tbody></table>`;

const BASE = { inputPerMillion: 0.10, outputPerMillion: 0.50, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125, cacheWrite1hPerMillion: 0.20 };
const TIER = { inputPerMillion: 0.50, outputPerMillion: 2.50, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625, cacheWrite1hPerMillion: 1 };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
});

describe("test 6: duplicate Haiku 5.5 rows", () => {
  it.each([
    ["low row first", [LOW, HIGH]],
    ["high row first", [HIGH, LOW]],
  ])("%s: base = low tier, longContext = high tier", (_name, rows) => {
    const models = parsePricingTable(page(OPUS, ...rows));
    const h = models["claude-haiku-5-5"]!;
    expect(h).toBeDefined();
    expect(h).toMatchObject(BASE);
    expect(h.ttlRateBasis).toBe("parsed");
    expect(h.longContext).toEqual({ thresholdTokens: 100_000, rates: TIER });
    // Other rows are untouched, and carry no tier.
    expect(models["claude-opus-5-5"]).toMatchObject({ inputPerMillion: 4, outputPerMillion: 20 });
    expect(models["claude-opus-5-5"]!.longContext).toBeUndefined();
    expect(Object.keys(models).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a parsed page prices end to end: base below the threshold, tier above", () => {
    applyPricingCache(parsePricingTable(page(HIGH, LOW)), "2026-10-27");
    expect(estimateCost("claude-haiku-5-5", 0, 1_000_000, 0, 0).cost).toBeCloseTo(0.5, 12);
    expect(estimateCost("claude-haiku-5-5", 0, 1_000_000, 0, 0, undefined, undefined, { longContext: true }).cost).toBeCloseTo(2.5, 12);
  });

  it("reads the threshold from the label when it is not 100,000", () => {
    const high = row("Claude Haiku 5.5 (for prompts over 200K)", "$0.50 / MTok", "$0.625 / MTok", "$1 / MTok", "$0.05 / MTok", "$2.50 / MTok");
    expect(parsePricingTable(page(LOW, high))["claude-haiku-5-5"]!.longContext!.thresholdTokens).toBe(200_000);
  });

  it("defaults the threshold to 100,000 when a tier label carries no number", () => {
    const high = row("Claude Haiku 5.5 (for prompts over the limit)", "$0.50 / MTok", "$0.625 / MTok", "$1 / MTok", "$0.05 / MTok", "$2.50 / MTok");
    expect(parsePricingTable(page(LOW, high))["claude-haiku-5-5"]!.longContext!.thresholdTokens).toBe(100_000);
  });

  it("label classification: up-to and plain names are base, over/above/> are tiers", () => {
    expect(longContextRowThreshold("Claude Haiku 5.5")).toBeNull();
    expect(longContextRowThreshold("Claude Haiku 5.5 (for prompts up to 100,000 tokens)")).toBeNull();
    expect(longContextRowThreshold("Claude Haiku 5.5 (for prompts over 100,000 tokens)")).toBe(100_000);
    expect(longContextRowThreshold("Claude Haiku 5.5 (&gt; 128K)".replace("&gt;", ">"))).toBe(128_000);
    expect(longContextRowThreshold("Claude Haiku 5.5 <span>(above 1M)</span>")).toBe(1_000_000);
  });
});

describe("a tier row the parser cannot read never becomes the base", () => {
  it("tier row with unreadable prices: base kept, logged", () => {
    const bad = row("Claude Haiku 5.5 (for prompts over 100,000 tokens)", "contact sales", "n/a", "n/a", "n/a", "contact sales");
    for (const rows of [[LOW, bad], [bad, LOW]]) {
      warn.mockClear();
      const h = parsePricingTable(page(...rows))["claude-haiku-5-5"]!;
      expect(h).toMatchObject(BASE);
      expect(h.longContext).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it("tier row missing a cache column: no synthesized tier, base kept, logged", () => {
    const partial = row("Claude Haiku 5.5 (for prompts over 100,000 tokens)", "$0.50 / MTok", "$0.625 / MTok", "n/a", "$0.05 / MTok", "$2.50 / MTok");
    const h = parsePricingTable(page(LOW, partial))["claude-haiku-5-5"]!;
    expect(h).toMatchObject(BASE);
    expect(h.longContext).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a page with only the tier row yields no Haiku 5.5 entry at all (never tier-as-base)", () => {
    const models = parsePricingTable(page(OPUS, HIGH));
    expect(models["claude-haiku-5-5"]).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("applying a cache to the built-in table", () => {
  it("a cache row that has no tier (written before C2) keeps the built-in tier", () => {
    const old = { ...BASE, ttlRateBasis: "parsed" as const };
    applyPricingCache({ "claude-haiku-5-5": old }, "2026-10-27");
    expect(lookupPricing("claude-haiku-5-5")?.longContext?.thresholdTokens).toBe(100_000);
    expect(estimateCost("claude-haiku-5-5", 0, 1_000_000, 0, 0, undefined, undefined, { longContext: true }).cost).toBeCloseTo(2.5, 12);
  });

  it("a repriced model does not inherit the built-in tier (input rate disagrees)", () => {
    const repriced = { ...BASE, inputPerMillion: 0.2, cacheWritePerMillion: 0.25, cacheWrite1hPerMillion: 0.4, ttlRateBasis: "parsed" as const };
    applyPricingCache({ "claude-haiku-5-5": repriced }, "2026-10-27");
    expect(lookupPricing("claude-haiku-5-5")?.longContext).toBeUndefined();
  });

  it("a malformed tier in a cache file is dropped, not applied", () => {
    const broken = { ...BASE, ttlRateBasis: "parsed" as const, longContext: { thresholdTokens: 100_000, rates: { ...TIER, outputPerMillion: Number.NaN } } };
    applyPricingCache({ "claude-haiku-5-5": broken }, "2026-10-27");
    // The base input rate agrees with the built-in row, so the SHIPPED tier is carried over, not the broken one.
    expect(lookupPricing("claude-haiku-5-5")?.longContext?.rates.outputPerMillion).toBe(2.5);
  });
});
