import { describe, it, expect } from "vitest";
import {
  modelClass,
  inferenceGeoToRegion,
  localeToRegion,
  estimateEnergy,
  aggregateEnergy,
  formatEnergy,
  formatCO2,
  REGIONS,
  MODEL_ENERGY,
  DEFAULT_ENERGY_CONFIG,
} from "@claude-stats/core/energy";

describe("modelClass", () => {
  it("maps haiku models", () => {
    expect(modelClass("claude-haiku-3")).toBe("haiku");
    expect(modelClass("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(modelClass("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("maps sonnet models", () => {
    expect(modelClass("claude-sonnet-4-20250514")).toBe("sonnet");
    expect(modelClass("claude-3-5-sonnet-20241022")).toBe("sonnet");
    expect(modelClass("claude-3-sonnet-20240229")).toBe("sonnet");
  });

  it("maps opus models", () => {
    expect(modelClass("claude-opus-4-20250514")).toBe("opus");
    expect(modelClass("claude-3-opus-20240229")).toBe("opus");
  });

  it("falls back to sonnet for unknown models", () => {
    expect(modelClass("unknown-model-xyz")).toBe("sonnet");
    expect(modelClass("gpt-4")).toBe("sonnet");
  });
});

describe("inferenceGeoToRegion", () => {
  it("returns null for empty string", () => {
    expect(inferenceGeoToRegion("")).toBeNull();
  });

  it("returns null for unrecognized region", () => {
    expect(inferenceGeoToRegion("xx-unknown-99")).toBeNull();
  });

  it("maps known AWS regions directly", () => {
    expect(inferenceGeoToRegion("us-east-1")).toBe("us-east");
    expect(inferenceGeoToRegion("eu-west-2")).toBe("gb");
    expect(inferenceGeoToRegion("ap-northeast-1")).toBe("jp");
  });

  it("handles case insensitivity", () => {
    expect(inferenceGeoToRegion("US-EAST-1")).toBe("us-east");
  });

  it("matches via prefix (availability zone suffix)", () => {
    // "us-east-1a" should match "us-east-1" prefix → "us-east"
    expect(inferenceGeoToRegion("us-east-1a")).toBe("us-east");
  });
});

describe("localeToRegion", () => {
  it("maps country-specific locales", () => {
    expect(localeToRegion("de-DE")).toBe("de");
    expect(localeToRegion("fr-FR")).toBe("fr");
    expect(localeToRegion("en-GB")).toBe("gb");
    expect(localeToRegion("en-AU")).toBe("au");
  });

  it("maps language-only codes", () => {
    expect(localeToRegion("de")).toBe("de");
    expect(localeToRegion("ja")).toBe("jp");
    expect(localeToRegion("ko")).toBe("kr");
    expect(localeToRegion("zh")).toBe("cn");
  });

  it("returns global for unknown locales", () => {
    expect(localeToRegion("xx")).toBe("global");
    expect(localeToRegion("zz-ZZ")).toBe("global");
  });

  it("maps en to us-average", () => {
    expect(localeToRegion("en")).toBe("us-average");
    expect(localeToRegion("en-US")).toBe("us-average");
  });
});

describe("estimateEnergy", () => {
  const basicUsage = {
    model: "claude-sonnet-4-20250514",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
  };

  it("returns positive energy and CO2 for non-zero tokens", () => {
    const result = estimateEnergy(basicUsage);
    expect(result.energyWh).toBeGreaterThan(0);
    expect(result.totalEnergyWh).toBeGreaterThan(result.energyWh); // PUE > 1
    expect(result.co2Grams).toBeGreaterThan(0);
  });

  it("applies PUE of 1.2 by default", () => {
    const result = estimateEnergy(basicUsage);
    expect(result.totalEnergyWh).toBeCloseTo(result.energyWh * 1.2, 5);
  });

  it("sets confidence interval bounds correctly", () => {
    const result = estimateEnergy(basicUsage);
    expect(result.co2GramsLow).toBeCloseTo(result.co2Grams * 0.45, 5);
    expect(result.co2GramsHigh).toBeCloseTo(result.co2Grams * 1.55, 5);
  });

  it("detects region from inferenceGeo", () => {
    const result = estimateEnergy({ ...basicUsage, inferenceGeo: "us-east-1" });
    expect(result.detectedRegion).toBe("us-east");
    expect(result.config.region).toBe("us-east");
  });

  it("does not override explicit region config with inferenceGeo", () => {
    const result = estimateEnergy(
      { ...basicUsage, inferenceGeo: "us-east-1" },
      { region: "fr" },
    );
    // Explicit region config wins
    expect(result.config.region).toBe("fr");
  });

  it("computes cache read at 3% of output rate", () => {
    const withCache = estimateEnergy({
      ...basicUsage,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    const expected = (1000 / 1000) * MODEL_ENERGY.sonnet.outputWhPer1K * 0.03;
    expect(withCache.energyWh).toBeCloseTo(expected, 5);
  });

  it("computes cache creation at 1.15x input rate", () => {
    const withCacheCreate = estimateEnergy({
      ...basicUsage,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1000,
    });
    const expected = (1000 / 1000) * MODEL_ENERGY.sonnet.inputWhPer1K * 1.15;
    expect(withCacheCreate.energyWh).toBeCloseTo(expected, 5);
  });

  it("returns zero energy for all-zero tokens", () => {
    const result = estimateEnergy({
      ...basicUsage,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result.energyWh).toBe(0);
    expect(result.co2Grams).toBe(0);
  });

  it("includes environmental equivalents", () => {
    const result = estimateEnergy(basicUsage);
    expect(result.equivalents.googleSearches).toBeGreaterThan(0);
    expect(result.equivalents.ledBulbHours).toBeGreaterThan(0);
  });

  it("uses custom PUE from config", () => {
    const r1 = estimateEnergy(basicUsage, { pue: 1.0 });
    const r2 = estimateEnergy(basicUsage, { pue: 2.0 });
    expect(r2.totalEnergyWh).toBeCloseTo(r1.energyWh * 2.0, 5);
  });

  it("uses custom region from config", () => {
    const r_fr = estimateEnergy(basicUsage, { region: "fr" });
    const r_pl = estimateEnergy(basicUsage, { region: "pl" });
    // Poland has much higher grid intensity than France
    expect(r_pl.co2Grams).toBeGreaterThan(r_fr.co2Grams);
  });

  it("uses custom gridIntensity directly", () => {
    const result = estimateEnergy(basicUsage, { gridIntensity: 0 });
    expect(result.co2Grams).toBe(0);
  });
});

describe("aggregateEnergy", () => {
  it("returns zero estimate for empty array", () => {
    const result = aggregateEnergy([]);
    expect(result.totalEnergyWh).toBe(0);
    expect(result.co2Grams).toBe(0);
  });

  it("sums energy and CO2 from multiple estimates", () => {
    const usage = {
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
    };
    const e1 = estimateEnergy(usage);
    const e2 = estimateEnergy(usage);
    const agg = aggregateEnergy([e1, e2]);
    expect(agg.totalEnergyWh).toBeCloseTo(e1.totalEnergyWh + e2.totalEnergyWh, 5);
    expect(agg.co2Grams).toBeCloseTo(e1.co2Grams + e2.co2Grams, 5);
  });

  it("picks detectedRegion from first estimate that has one", () => {
    const base = estimateEnergy({
      model: "claude-sonnet",
      inputTokens: 100, outputTokens: 50,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    });
    const withGeo = estimateEnergy({
      model: "claude-sonnet",
      inputTokens: 100, outputTokens: 50,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
      inferenceGeo: "eu-west-1",
    });
    const agg = aggregateEnergy([base, withGeo]);
    expect(agg.detectedRegion).toBe("ie"); // eu-west-1 → Ireland
  });
});

describe("formatEnergy", () => {
  it("formats milliwatt-hours for very small values", () => {
    expect(formatEnergy(0.001)).toBe("1.0 mWh");
    expect(formatEnergy(0.5)).toBe("500.0 mWh");
  });

  it("formats watt-hours for medium values", () => {
    expect(formatEnergy(1.5)).toBe("1.50 Wh");
    expect(formatEnergy(10)).toBe("10.0 Wh");
    expect(formatEnergy(99.9)).toBe("99.9 Wh");
  });

  it("formats kilowatt-hours for large values", () => {
    expect(formatEnergy(1000)).toBe("1.00 kWh");
    expect(formatEnergy(2500)).toBe("2.50 kWh");
  });
});

describe("formatCO2", () => {
  it("formats grams for small values", () => {
    expect(formatCO2(0.5)).toBe("0.50 g");
    expect(formatCO2(5)).toBe("5.00 g");
  });

  it("formats larger values with one decimal", () => {
    expect(formatCO2(15.5)).toBe("15.5 g");
    expect(formatCO2(100)).toBe("100.0 g");
  });

  it("formats kilograms for large values", () => {
    expect(formatCO2(1000)).toBe("1.00 kg");
    expect(formatCO2(2500)).toBe("2.50 kg");
  });
});

describe("REGIONS and DEFAULT_ENERGY_CONFIG", () => {
  it("global region has correct default values", () => {
    expect(REGIONS["global"]).toBeDefined();
    expect(REGIONS["global"]!.gridIntensity).toBe(436);
    expect(DEFAULT_ENERGY_CONFIG.gridIntensity).toBe(436);
    expect(DEFAULT_ENERGY_CONFIG.pue).toBe(1.2);
    expect(DEFAULT_ENERGY_CONFIG.region).toBe("global");
  });

  it("has reasonable grid intensity values", () => {
    // Norway should have low intensity (hydro)
    expect(REGIONS["no"]!.gridIntensity).toBeLessThan(50);
    // Poland should have high intensity (coal)
    expect(REGIONS["pl"]!.gridIntensity).toBeGreaterThan(500);
  });
});
