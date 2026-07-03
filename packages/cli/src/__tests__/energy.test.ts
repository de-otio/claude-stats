import { describe, it, expect, afterEach, vi } from "vitest";
import {
  modelClass,
  inferenceGeoToRegion,
  localeToRegion,
  estimateEnergy,
  aggregateEnergy,
  formatEnergy,
  formatCO2,
  nearestJourneyAnchor,
  JOURNEY_ANCHORS,
  REGIONS,
  MODEL_ENERGY,
  DEFAULT_ENERGY_CONFIG,
} from "@claude-stats/core/energy";
import { Store } from "../store/index.js";
import { buildEnergySection } from "../dashboard/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import os from "os";
import path from "path";
import fs from "fs";

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

  it("excludes ephemeral cache tokens from the energy calc (they are a TTL breakdown of cache_creation, not additional tokens)", () => {
    const withOnlyCreation = estimateEnergy({
      ...basicUsage,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1000,
      ephemeral5mCacheTokens: 0,
      ephemeral1hCacheTokens: 0,
    });
    const withCreationAndEphemerals = estimateEnergy({
      ...basicUsage,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1000,
      ephemeral5mCacheTokens: 600,
      ephemeral1hCacheTokens: 400,
    });
    expect(withCreationAndEphemerals.energyWh).toBeCloseTo(withOnlyCreation.energyWh, 10);
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
    expect(result.equivalents.naturalGasM3).toBeGreaterThan(0);
    expect(result.equivalents.naturalGasM3).toBeCloseTo((result.totalEnergyWh / 1000) / (0.55 * 9.94), 10);
    expect(result.equivalents.solarPanelM2).toBeGreaterThan(0);
    expect(result.equivalents.solarRegionKey).toBeTruthy();
    expect(result.equivalents.transitKm).toBeGreaterThan(0);
    expect(result.equivalents.nuclearWasteMl).toBeGreaterThan(0);
    expect(result.equivalents.nuclearWasteMl).toBeCloseTo(result.totalEnergyWh * 0.004, 10);
    expect(result.equivalents.windRotations).toBeGreaterThan(0);
    expect(result.equivalents.windRotations).toBeCloseTo(result.totalEnergyWh / 1170, 8);
    expect(result.equivalents.hydroTurbineLiters).toBeGreaterThan(0);
    expect(result.equivalents.hydroTurbineLiters).toBeCloseTo((result.totalEnergyWh / 1000) * 4077, 6);
  });

  it("nearestJourneyAnchor snaps to the log-nearest anchor", () => {
    expect(nearestJourneyAnchor(250).key).toBe("berlinHamburg");
    expect(nearestJourneyAnchor(2).key).toBe("coffeeWalk");
    expect(nearestJourneyAnchor(6).key).toBe("bikeCrossTown");
    expect(nearestJourneyAnchor(7000).key).toBe("coastToCoast");
    expect(nearestJourneyAnchor(50000).key).toBe("halfEarth");
    expect(nearestJourneyAnchor(0).key).toBe(JOURNEY_ANCHORS[0]!.key);
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

// ─── Energy section: GROUP-BY aggregation parity (Phase A / #3) ──────────────
//
// buildEnergySection was refactored from a per-message estimateEnergy loop to
// SQL GROUP BY rollups (Store.getEnergyAggregates). This suite is the parity
// gate: it asserts the section's output, over rich synthetic fixtures (synthetic
// ONLY — never the live ~/.claude-stats DB), exactly matches reference values
// that were captured from the legacy per-message implementation during the
// refactor (verified byte-identical via expect(new).toEqual(legacy) before the
// legacy code was removed). Integer-offset timezones (UTC, Europe/Vienna) keep
// byDay parity exact; the fixtures cross a local-day boundary so the UTC and
// Vienna byDay splits differ, exercising the hour→local-day re-bucketing.

function tmpEnergyDb(): string {
  return path.join(os.tmpdir(), `cs-energy-parity-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function eSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "e-sess",
    projectPath: "/Users/alice/repos/proj-a",
    sourceFile: "/Users/alice/.claude/projects/proj-a/e-sess.jsonl",
    firstTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_300_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 5,
    assistantMessageCount: 5,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...overrides,
  };
}

function eMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid: "e-msg",
    sessionId: "e-sess",
    timestamp: 1_700_000_000_000,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "end_turn",
    inputTokens: 5_000,
    outputTokens: 1_000,
    cacheCreationTokens: 250,
    cacheReadTokens: 4_000,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    ...overrides,
  };
}

/**
 * Build a rich synthetic store covering: multi-day sessions spanning a local-
 * day boundary, opus/sonnet/haiku, multiple projects, thinking_blocks>0, varied
 * inference_geo (incl. null), and (in a sibling test) an empty period.
 */
function seedRichStore(store: Store): void {
  // Anchor: 2026-06-20 00:00:00 UTC. Vienna is UTC+2 in June (integer offset),
  // so the local-day boundary still lands on a whole UTC hour.
  const base = Date.UTC(2026, 5, 20, 0, 0, 0);
  const H = 3_600_000;
  const D = 24 * H;

  // Session 1 — proj-a, sonnet, spans the 2026-06-20→21 boundary, US geo.
  store.upsertSession(eSession({ sessionId: "s1", projectPath: "/Users/alice/repos/proj-a", firstTimestamp: base }));
  store.upsertMessages([
    eMessage({ uuid: "s1-m1", sessionId: "s1", timestamp: base + 2 * H, model: "claude-sonnet-4-20250514", inputTokens: 8_000, outputTokens: 1_500, cacheCreationTokens: 300, cacheReadTokens: 12_000, inferenceGeo: "us-east-1" }),
    eMessage({ uuid: "s1-m2", sessionId: "s1", timestamp: base + 23 * H, model: "claude-sonnet-4-20250514", inputTokens: 3_000, outputTokens: 900, cacheCreationTokens: 0, cacheReadTokens: 5_000, inferenceGeo: "us-east-1" }),
    // crosses into 2026-06-21 (UTC) — and into the next Vienna local day too.
    eMessage({ uuid: "s1-m3", sessionId: "s1", timestamp: base + 25 * H, model: "claude-sonnet-4-20250514", inputTokens: 2_000, outputTokens: 400, cacheCreationTokens: 100, cacheReadTokens: 1_000, inferenceGeo: null, thinkingBlocks: 2 }),
  ]);

  // Session 2 — proj-b, opus + haiku, EU geo, thinking.
  store.upsertSession(eSession({ sessionId: "s2", projectPath: "/Users/alice/repos/proj-b", firstTimestamp: base + 3 * H }));
  store.upsertMessages([
    eMessage({ uuid: "s2-m1", sessionId: "s2", timestamp: base + 3 * H, model: "claude-opus-4-20250514", inputTokens: 6_000, outputTokens: 2_500, cacheCreationTokens: 800, cacheReadTokens: 0, inferenceGeo: "eu-central-1", thinkingBlocks: 5 }),
    eMessage({ uuid: "s2-m2", sessionId: "s2", timestamp: base + 4 * H, model: "claude-haiku-4-20250514", inputTokens: 1_200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 2_000, inferenceGeo: "eu-west-3" }),
    eMessage({ uuid: "s2-m3", sessionId: "s2", timestamp: base + 5 * H, model: "claude-opus-4-20250514", inputTokens: 4_000, outputTokens: 1_800, cacheCreationTokens: 200, cacheReadTokens: 600, inferenceGeo: null }),
  ]);

  // Session 3 — proj-a again (second day), sonnet + haiku, mixed geo + null.
  store.upsertSession(eSession({ sessionId: "s3", projectPath: "/Users/alice/repos/proj-a", firstTimestamp: base + D + 6 * H }));
  store.upsertMessages([
    eMessage({ uuid: "s3-m1", sessionId: "s3", timestamp: base + D + 6 * H, model: "claude-sonnet-4-20250514", inputTokens: 10_000, outputTokens: 3_000, cacheCreationTokens: 500, cacheReadTokens: 20_000, inferenceGeo: "us-east-1" }),
    eMessage({ uuid: "s3-m2", sessionId: "s3", timestamp: base + D + 7 * H, model: "claude-haiku-4-20250514", inputTokens: 500, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, inferenceGeo: null }),
    eMessage({ uuid: "s3-m3", sessionId: "s3", timestamp: base + D + 8 * H, model: "claude-sonnet-4-20250514", inputTokens: 7_000, outputTokens: 2_200, cacheCreationTokens: 1_000, cacheReadTokens: 9_000, inferenceGeo: "eu-central-1", thinkingBlocks: 1 }),
  ]);
}

// Reference outputs captured from the legacy per-message implementation
// (parity-verified before legacy removal). FIXED_NOW = 2026-06-25 12:00 UTC;
// earliest message = 2026-06-20 02:00 UTC → periodDays = round(5.4) = 5.
const FIXED_NOW = Date.UTC(2026, 5, 25, 12, 0, 0);

const EXPECTED_ALL = {
  totalEnergyWh: 14.0007,
  totalCO2Grams: 5.88,
  co2GramsLow: 2.646,
  co2GramsHigh: 9.114,
  equivalents: {
    treesYears: 0.0003, carKm: 0.05, transitKm: 0.2, solarPanelM2: 0.0047,
    solarRegionKey: "us-east", naturalGasM3: 0.00256, trainKm: 0.98,
    nuclearWasteMl: 0.056, windRotations: 0, hydroTurbineLiters: 57.08,
  },
  journeyAnchor: { key: "coffeeWalk", km: 1 },
  periodStartIso: "2026-06-20", periodEndIso: "2026-06-25", periodDays: 5,
  byDay: [
    { date: "2026-06-20", energyWh: 9.7743, co2Grams: 4.105 },
    { date: "2026-06-21", energyWh: 4.2264, co2Grams: 1.775 },
  ],
  byModel: [
    { model: "claude-opus-4-20250514", energyWh: 7.6739, co2Grams: 3.223, pct: 54.8 },
    { model: "claude-sonnet-4-20250514", energyWh: 6.2843, co2Grams: 2.639, pct: 44.9 },
    { model: "claude-haiku-4-20250514", energyWh: 0.0425, co2Grams: 0.018, pct: 0.3 },
  ],
  byProject: [
    { project: "/Users/alice/repos/proj-b", energyWh: 7.7056, co2Grams: 3.236 },
    { project: "/Users/alice/repos/proj-a", energyWh: 6.2951, co2Grams: 2.644 },
  ],
  cacheImpact: { energySavedWh: 3.9283, co2SavedGrams: 1.65, cacheEfficiencyPct: 54.3 },
  thinkingImpact: { sessionsWithThinking: 3, pctEnergyFromThinking: 14 },
  inferenceGeo: { detected: { "us-east-1": 3, "eu-central-1": 2, "eu-west-3": 1 }, coveragePct: 66.7 },
  region: "us-east", gridIntensity: 420, pue: 1.2,
  byClass: [
    { cls: "opus", msgs: 2, inputTokens: 10000, outputTokens: 4300, cacheWriteTokens: 1000, cacheReadTokens: 600, rawEnergyWh: 6.39, inputWhPer1K: 0.225, outputWhPer1K: 0.9 },
    { cls: "sonnet", msgs: 5, inputTokens: 30000, outputTokens: 8000, cacheWriteTokens: 1900, cacheReadTokens: 47000, rawEnergyWh: 5.24, inputWhPer1K: 0.075, outputWhPer1K: 0.3 },
    { cls: "haiku", msgs: 2, inputTokens: 1700, outputTokens: 400, cacheWriteTokens: 0, cacheReadTokens: 2000, rawEnergyWh: 0.04, inputWhPer1K: 0.01, outputWhPer1K: 0.04 },
  ],
};

// Vienna (UTC+2 in June) differs ONLY in byDay: the 23:00-UTC message falls on
// 2026-06-21 local, shifting energy from day 20 to day 21 vs UTC. All other
// fields are timezone-independent.
const EXPECTED_VIENNA = {
  ...EXPECTED_ALL,
  byDay: [
    { date: "2026-06-20", energyWh: 9.1263, co2Grams: 3.833 },
    { date: "2026-06-21", energyWh: 4.8744, co2Grams: 2.047 },
  ],
};

const EXPECTED_PROJA = {
  totalEnergyWh: 6.2951,
  totalCO2Grams: 2.644,
  co2GramsLow: 1.19,
  co2GramsHigh: 4.098,
  equivalents: {
    treesYears: 0.0001, carKm: 0.02, transitKm: 0.09, solarPanelM2: 0.0021,
    solarRegionKey: "us-east", naturalGasM3: 0.00115, trainKm: 0.44,
    nuclearWasteMl: 0.0252, windRotations: 0, hydroTurbineLiters: 25.66,
  },
  journeyAnchor: { key: "coffeeWalk", km: 1 },
  periodStartIso: "2026-06-20", periodEndIso: "2026-06-25", periodDays: 5,
  byDay: [
    { date: "2026-06-20", energyWh: 2.0687, co2Grams: 0.869 },
    { date: "2026-06-21", energyWh: 4.2264, co2Grams: 1.775 },
  ],
  byModel: [
    { model: "claude-sonnet-4-20250514", energyWh: 6.2843, co2Grams: 2.639, pct: 99.8 },
    { model: "claude-haiku-4-20250514", energyWh: 0.0108, co2Grams: 0.005, pct: 0.2 },
  ],
  byProject: [
    { project: "/Users/alice/repos/proj-a", energyWh: 6.2951, co2Grams: 2.644 },
  ],
  cacheImpact: { energySavedWh: 3.7224, co2SavedGrams: 1.563, cacheEfficiencyPct: 60.6 },
  thinkingImpact: { sessionsWithThinking: 2, pctEnergyFromThinking: 9.4 },
  inferenceGeo: { detected: { "us-east-1": 3, "eu-central-1": 1 }, coveragePct: 66.7 },
  region: "us-east", gridIntensity: 420, pue: 1.2,
  byClass: [
    { cls: "sonnet", msgs: 5, inputTokens: 30000, outputTokens: 8000, cacheWriteTokens: 1900, cacheReadTokens: 47000, rawEnergyWh: 5.24, inputWhPer1K: 0.075, outputWhPer1K: 0.3 },
    { cls: "haiku", msgs: 1, inputTokens: 500, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, rawEnergyWh: 0.01, inputWhPer1K: 0.01, outputWhPer1K: 0.04 },
  ],
};

describe("buildEnergySection — GROUP BY aggregation parity", () => {
  const dbs: { store: Store; path: string }[] = [];
  function freshStore(): Store {
    const p = tmpEnergyDb();
    const store = new Store(p);
    dbs.push({ store, path: p });
    return store;
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const { store, path: p } of dbs.splice(0)) {
      store.close();
      try { fs.unlinkSync(p); } catch { /* ok */ }
    }
  });

  // Fake the system clock so BOTH date sources used by the section —
  // Date.now() (periodDays, solarPanelM2) and new Date() (periodEndIso) —
  // resolve to FIXED_NOW, making the period-duration fields deterministic
  // against the captured reference.
  function pinNow(): void {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  }

  it("matches the reference output (UTC, all time)", () => {
    const store = freshStore();
    seedRichStore(store);
    pinNow();
    expect(buildEnergySection(store, { timezone: "UTC" })).toEqual(EXPECTED_ALL);
  });

  it("matches the reference output (Europe/Vienna, all time — byDay re-bucketed)", () => {
    const store = freshStore();
    seedRichStore(store);
    pinNow();
    expect(buildEnergySection(store, { timezone: "Europe/Vienna" })).toEqual(EXPECTED_VIENNA);
  });

  it("matches the reference output filtered to one project (UTC)", () => {
    const store = freshStore();
    seedRichStore(store);
    pinNow();
    expect(buildEnergySection(store, { timezone: "UTC", projectPath: "/Users/alice/repos/proj-a" })).toEqual(EXPECTED_PROJA);
  });

  it("returns null for an empty period (since in the future)", () => {
    const store = freshStore();
    seedRichStore(store);
    expect(buildEnergySection(store, { timezone: "UTC", since: Date.UTC(2099, 0, 1) })).toBeNull();
  });

  it("returns null for an empty period (until before all messages)", () => {
    const store = freshStore();
    seedRichStore(store);
    // Regression test for the custom-date-range feature: buildEnergySection
    // (via Store.getEnergyAggregates) previously had no `until` bound at all,
    // so a past custom range's energy totals could silently include messages
    // after the requested end — this and the next test would have failed
    // under the old (since-only) behavior.
    expect(buildEnergySection(store, { timezone: "UTC", until: Date.UTC(2020, 0, 1) })).toBeNull();
  });

  it("excludes messages at/after `until` (day-2 messages dropped, day-1 kept)", () => {
    const store = freshStore();
    seedRichStore(store);
    pinNow();
    const all = buildEnergySection(store, { timezone: "UTC" });
    // `until` = day-2 start (2026-06-21 00:00 UTC = seedRichStore's `base` +
    // 24h). All of s3's messages land on day 2 (at/after base+D+6H); s1-m3 at
    // base+25H is also on/after day 2 and excluded too.
    const dayTwoStart = Date.UTC(2026, 5, 21, 0, 0, 0);
    const bounded = buildEnergySection(store, { timezone: "UTC", until: dayTwoStart });
    expect(all).not.toBeNull();
    expect(bounded).not.toBeNull();
    expect(bounded!.totalEnergyWh).toBeLessThan(all!.totalEnergyWh);
    expect(bounded!.totalCO2Grams).toBeLessThan(all!.totalCO2Grams);
  });

  it("returns null on a completely empty store", () => {
    const store = freshStore();
    expect(buildEnergySection(store, { timezone: "UTC" })).toBeNull();
  });
});
