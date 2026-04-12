/**
 * Energy and CO₂ estimation for Claude inference requests.
 *
 * Coefficients derived from:
 * - TokenPowerBench (arxiv 2512.03024, Dec 2025) — scaling relationships
 * - "From Prompts to Power" (arxiv 2511.05597, Nov 2025) — per-token measurements
 * - Google Gemini whitepaper (arxiv 2508.15734, Aug 2025) — calibration anchor (0.24 Wh median)
 *
 * These are estimates with ±55% uncertainty. Anthropic does not publish per-request
 * energy metrics. Not suitable for regulatory compliance or carbon offsetting.
 *
 * ISO date when energy data (grid intensities, coefficients) was last verified:
 */
export const ENERGY_DATA_VERIFIED_DATE = "2026-04-11";

// ─── Model class mapping ────────────────────────────────────────────────────

export type ModelClass = "haiku" | "sonnet" | "opus";

/** Longest-first prefix map — same strategy as pricing.ts. */
const MODEL_CLASS_PREFIXES: Array<[string, ModelClass]> = [
  ["claude-opus",        "opus"],
  ["claude-sonnet",      "sonnet"],
  ["claude-haiku",       "haiku"],
  ["claude-3-5-sonnet",  "sonnet"],
  ["claude-3-5-haiku",   "haiku"],
  ["claude-3-haiku",     "haiku"],
  ["claude-3-sonnet",    "sonnet"],
  ["claude-3-opus",      "opus"],
];

/**
 * Map a model name to its energy class.
 * Falls back to "sonnet" (conservative middle-ground) for unknown models.
 */
export function modelClass(modelName: string): ModelClass {
  const lower = modelName.toLowerCase();
  for (const [prefix, cls] of MODEL_CLASS_PREFIXES) {
    if (lower.startsWith(prefix)) return cls;
  }
  return "sonnet"; // conservative fallback
}

// ─── Per-model energy coefficients ─────────────────────────────────────────

/**
 * Energy per 1K tokens by model class, in Wh (watt-hours), raw inference only.
 *
 * Calibration: Sonnet at (200 input + 500 output) ≈ 0.17 Wh raw → ~0.20 Wh with PUE 1.2,
 * consistent with Google Gemini 0.24 Wh median and Epoch AI / OpenAI ~0.3 Wh estimates.
 * Haiku: ~7x smaller, Opus: ~3x larger (TokenPowerBench sublinear scaling).
 */
export const MODEL_ENERGY: Record<ModelClass, { inputWhPer1K: number; outputWhPer1K: number }> = {
  haiku:  { inputWhPer1K: 0.010, outputWhPer1K: 0.040 },
  sonnet: { inputWhPer1K: 0.075, outputWhPer1K: 0.300 },
  opus:   { inputWhPer1K: 0.225, outputWhPer1K: 0.900 },
};

// ─── Grid carbon intensity ──────────────────────────────────────────────────

export interface RegionInfo {
  name: string;
  /** gCO₂eq per kWh. Sources: EPA eGRID2022, EEA 2024, IEA 2024, national agencies. */
  gridIntensity: number;
  /** Annual solar panel yield in kWh/m²/year (≈GHI × 20% efficiency × 0.75 performance ratio). */
  solarYield: number;
}

/** Grid carbon intensities and solar yields by region key. gCO₂eq/kWh and kWh/m²/yr. */
export const REGIONS: Record<string, RegionInfo> = {
  // Americas
  "us-average":   { name: "US Average",          gridIntensity: 368, solarYield: 230 },
  "us-west":      { name: "US West (WECC)",       gridIntensity: 260, solarYield: 280 },
  "us-east":      { name: "US East (SERC)",       gridIntensity: 420, solarYield: 200 },
  "us-midwest":   { name: "US Midwest (MROW)",    gridIntensity: 470, solarYield: 220 },
  "us-ca":        { name: "US California (CAMX)", gridIntensity: 210, solarYield: 300 },
  "us-nw":        { name: "US Pacific NW (NWPP)", gridIntensity: 170, solarYield: 180 },
  "ca":           { name: "Canada",               gridIntensity: 110, solarYield: 180 },
  "br":           { name: "Brazil",               gridIntensity: 60,  solarYield: 280 },
  // Europe
  "eu-average":   { name: "EU Average",           gridIntensity: 230, solarYield: 180 },
  "fr":           { name: "France",               gridIntensity: 57,  solarYield: 200 },
  "de":           { name: "Germany",              gridIntensity: 350, solarYield: 165 },
  "gb":           { name: "UK",                   gridIntensity: 200, solarYield: 150 },
  "es":           { name: "Spain",                gridIntensity: 150, solarYield: 270 },
  "it":           { name: "Italy",                gridIntensity: 260, solarYield: 230 },
  "nl":           { name: "Netherlands",          gridIntensity: 300, solarYield: 170 },
  "pl":           { name: "Poland",               gridIntensity: 620, solarYield: 170 },
  "se":           { name: "Sweden",               gridIntensity: 25,  solarYield: 140 },
  "no":           { name: "Norway",               gridIntensity: 10,  solarYield: 130 },
  "dk":           { name: "Denmark",              gridIntensity: 100, solarYield: 155 },
  "at":           { name: "Austria",              gridIntensity: 90,  solarYield: 180 },
  "fi":           { name: "Finland",              gridIntensity: 70,  solarYield: 130 },
  "ie":           { name: "Ireland",              gridIntensity: 270, solarYield: 145 },
  "ch":           { name: "Switzerland",          gridIntensity: 30,  solarYield: 190 },
  "be":           { name: "Belgium",              gridIntensity: 140, solarYield: 165 },
  "pt":           { name: "Portugal",             gridIntensity: 130, solarYield: 275 },
  "cz":           { name: "Czech Republic",       gridIntensity: 370, solarYield: 175 },
  "gr":           { name: "Greece",               gridIntensity: 280, solarYield: 250 },
  // Asia-Pacific
  "au":           { name: "Australia",            gridIntensity: 530, solarYield: 285 },
  "jp":           { name: "Japan",                gridIntensity: 430, solarYield: 195 },
  "kr":           { name: "South Korea",          gridIntensity: 390, solarYield: 190 },
  "in":           { name: "India",                gridIntensity: 680, solarYield: 280 },
  "cn":           { name: "China",                gridIntensity: 530, solarYield: 210 },
  "sg":           { name: "Singapore",            gridIntensity: 370, solarYield: 220 },
  "nz":           { name: "New Zealand",          gridIntensity: 80,  solarYield: 200 },
  // Global fallback
  "global":       { name: "Global Average",       gridIntensity: 436, solarYield: 210 },
};

/** Inference geo (AWS/GCP region codes) → region key mapping. */
const INFERENCE_GEO_MAP: Record<string, string> = {
  // AWS US regions
  "us-east-1":    "us-east",
  "us-east-2":    "us-midwest",
  "us-west-1":    "us-ca",
  "us-west-2":    "us-nw",
  // AWS Europe
  "eu-west-1":    "ie",
  "eu-west-2":    "gb",
  "eu-west-3":    "fr",
  "eu-central-1": "de",
  "eu-north-1":   "se",
  "eu-south-1":   "it",
  // AWS Asia-Pacific
  "ap-southeast-1": "sg",
  "ap-southeast-2": "au",
  "ap-northeast-1": "jp",
  "ap-northeast-2": "kr",
  "ap-south-1":     "in",
  "ap-east-1":      "cn",
  "ap-southeast-3": "sg",
  // GCP
  "us-central1":    "us-midwest",
  "us-east1":       "us-east",
  "us-east4":       "us-east",
  "us-west1":       "us-nw",
  "us-west2":       "us-ca",
  "europe-west1":   "be",
  "europe-west2":   "gb",
  "europe-west3":   "de",
  "europe-west4":   "nl",
  "europe-north1":  "fi",
  "asia-east1":     "cn",
  "asia-northeast1":"jp",
  "asia-southeast1":"sg",
  "australia-southeast1": "au",
};

/**
 * Map an inference_geo string (AWS/GCP region code) to a REGIONS key.
 * Returns null when the geo is unrecognized.
 */
export function inferenceGeoToRegion(geo: string): string | null {
  if (!geo) return null;
  const lower = geo.toLowerCase().trim();
  // Direct lookup
  if (INFERENCE_GEO_MAP[lower]) return INFERENCE_GEO_MAP[lower]!;
  // Prefix match (e.g. "us-east-1a" → "us-east-1")
  for (const [key, region] of Object.entries(INFERENCE_GEO_MAP)) {
    if (lower.startsWith(key)) return region;
  }
  return null;
}

/**
 * Detect a locale code (e.g. "de", "de-DE", "fr-FR") → REGIONS key.
 * Falls back to "global" when no mapping exists.
 */
export function localeToRegion(locale: string): string {
  const lang = locale.split("-")[0]!.toLowerCase();
  const country = locale.includes("-") ? locale.split("-")[1]!.toLowerCase() : lang;

  // Country-specific mappings first
  const countryMap: Record<string, string> = {
    fr: "fr", de: "de", gb: "gb", uk: "gb",
    es: "es", it: "it", nl: "nl", pl: "pl",
    se: "se", no: "no", dk: "dk", at: "at",
    fi: "fi", ie: "ie", ch: "ch", be: "be",
    pt: "pt", cz: "cz", gr: "gr",
    au: "au", jp: "jp", kr: "kr", in: "in",
    cn: "cn", sg: "sg", nz: "nz", br: "br",
    ca: "ca", us: "us-average",
  };
  if (countryMap[country]) return countryMap[country]!;

  // Language fallbacks
  const langMap: Record<string, string> = {
    en: "us-average",
    fr: "fr", de: "de", es: "es", it: "it",
    pt: "br", ja: "jp", ko: "kr", zh: "cn",
    sv: "se", nb: "no", da: "dk", fi: "fi",
    nl: "nl", pl: "pl",
  };
  return langMap[lang] ?? "global";
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface EnergyConfig {
  /** Power Usage Effectiveness (default: 1.2 for hyperscale cloud). */
  pue: number;
  /** Grid carbon intensity in gCO₂eq/kWh (default: auto from locale, fallback Global Average 436). */
  gridIntensity: number;
  /** Region preset key (sets gridIntensity automatically). */
  region?: string;
}

export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  pue: 1.2,
  gridIntensity: 436, // Global Average
  region: "global",
};

// ─── Token usage input ───────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  ephemeral5mCacheTokens: number;
  ephemeral1hCacheTokens: number;
  thinkingBlocks?: number;
  inferenceGeo?: string | null;
}

// ─── Output types ────────────────────────────────────────────────────────────

export interface EnvironmentalEquivalents {
  /** Fraction of a tree's annual CO₂ absorption. */
  treesYears: number;
  /** EU-average car km driven. */
  carKm: number;
  /** Passenger-km by local mass transit — urban bus + subway/metro + tram weighted average (30 gCO₂/pkm). */
  transitKm: number;
  /** Solar panel area (m²) that, in the detected region, would take one year to generate this much energy. */
  solarPanelM2: number;
  /** Region key whose solar yield was used for solarPanelM2 (falls back to "global"). */
  solarRegionKey: string;
  /** Liters of gasoline burned (2.31 kgCO₂/L). */
  gasolineLiters: number;
  /** Cups of coffee produced (0.3 kgCO₂/cup, farm-to-cup). */
  coffeeCups: number;
  /** EU train km (6 gCO₂/pkm). */
  trainKm: number;
  /** Milligrams of spent nuclear fuel if the same energy came from 100% nuclear (3 mg/kWh, OECD NEA). */
  nuclearWasteMg: number;
}

/** Canonical journeys ordered by distance, used to anchor a period's carKm to a relatable trip. */
export interface JourneyAnchor {
  /** Locale key (e.g. "berlinHamburg"). */
  key: string;
  /** Anchor distance in km. */
  km: number;
}

export const JOURNEY_ANCHORS: readonly JourneyAnchor[] = [
  { key: "coffeeWalk", km: 1 },
  { key: "bikeCrossTown", km: 5 },
  { key: "crosstownCommute", km: 20 },
  { key: "shortIntercity", km: 85 },
  { key: "berlinHamburg", km: 286 },
  { key: "berlinMunich", km: 585 },
  { key: "parisBerlin", km: 1000 },
  { key: "coastToCoast", km: 4500 },
  { key: "halfEarth", km: 20000 },
] as const;

/** Snap a driving distance (km) to the nearest anchor in log space. */
export function nearestJourneyAnchor(carKm: number): JourneyAnchor {
  if (!(carKm > 0)) return JOURNEY_ANCHORS[0]!;
  const logKm = Math.log(carKm);
  let best = JOURNEY_ANCHORS[0]!;
  let bestDist = Math.abs(logKm - Math.log(best.km));
  for (const a of JOURNEY_ANCHORS) {
    const d = Math.abs(logKm - Math.log(a.km));
    if (d < bestDist) { best = a; bestDist = d; }
  }
  return best;
}

export interface EnergyEstimate {
  /** Raw inference energy (before PUE), in Wh. */
  energyWh: number;
  /** Total energy including data-center overhead (energyWh × PUE), in Wh. */
  totalEnergyWh: number;
  /** CO₂ emissions in grams. */
  co2Grams: number;
  /** Low end of ±55% confidence interval (co2Grams × 0.45). */
  co2GramsLow: number;
  /** High end of ±55% confidence interval (co2Grams × 1.55). */
  co2GramsHigh: number;
  /** Environmental equivalents for display. */
  equivalents: EnvironmentalEquivalents;
  /** Region key detected from inferenceGeo (if provided). */
  detectedRegion: string | null;
  /** Config actually used for this estimate. */
  config: EnergyConfig;
}

// ─── Core estimation ─────────────────────────────────────────────────────────

/**
 * Estimate energy and CO₂ for a single inference request.
 *
 * Formula (per design doc 01-estimation-model.md):
 *   energy_wh = (output_tokens / 1K) * outputRate
 *             + (input_tokens / 1K)  * inputRate
 *             + (cache_creation / 1K) * inputRate * 1.15
 *             + (cache_read + ephemeral_5m + ephemeral_1h) / 1K * outputRate * 0.03
 */
export function estimateEnergy(usage: TokenUsage, config: Partial<EnergyConfig> = {}): EnergyEstimate {
  // Resolve config: detect region from inferenceGeo, then apply
  let resolvedConfig: EnergyConfig = { ...DEFAULT_ENERGY_CONFIG, ...config };
  let detectedRegion: string | null = null;

  if (usage.inferenceGeo) {
    const geoRegion = inferenceGeoToRegion(usage.inferenceGeo);
    if (geoRegion) {
      detectedRegion = geoRegion;
      const regionInfo = REGIONS[geoRegion];
      if (regionInfo && !config.gridIntensity && !config.region) {
        resolvedConfig = { ...resolvedConfig, gridIntensity: regionInfo.gridIntensity, region: geoRegion };
      }
    }
  }

  if (config.region && REGIONS[config.region] && !config.gridIntensity) {
    resolvedConfig.gridIntensity = REGIONS[config.region]!.gridIntensity;
  }

  const cls = modelClass(usage.model);
  const rates = MODEL_ENERGY[cls];

  const energyWh =
    (usage.outputTokens / 1000) * rates.outputWhPer1K +
    (usage.inputTokens / 1000) * rates.inputWhPer1K +
    (usage.cacheCreationTokens / 1000) * rates.inputWhPer1K * 1.15 +
    ((usage.cacheReadTokens + usage.ephemeral5mCacheTokens + usage.ephemeral1hCacheTokens) / 1000) *
      rates.outputWhPer1K * 0.03;

  const totalEnergyWh = energyWh * resolvedConfig.pue;
  const co2Grams = (totalEnergyWh / 1000) * resolvedConfig.gridIntensity;

  return {
    energyWh,
    totalEnergyWh,
    co2Grams,
    co2GramsLow: co2Grams * 0.45,
    co2GramsHigh: co2Grams * 1.55,
    equivalents: computeEquivalents(totalEnergyWh, co2Grams, detectedRegion ?? resolvedConfig.region ?? null),
    detectedRegion,
    config: resolvedConfig,
  };
}

/**
 * Aggregate multiple EnergyEstimate values into one.
 * Sums energy/CO₂ and recomputes equivalents.
 */
export function aggregateEnergy(estimates: EnergyEstimate[]): EnergyEstimate {
  if (estimates.length === 0) {
    return estimateEnergy(
      { model: "claude-sonnet", inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0,
        ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0 },
    );
  }

  const totalEnergyWh = estimates.reduce((s, e) => s + e.totalEnergyWh, 0);
  const energyWh = estimates.reduce((s, e) => s + e.energyWh, 0);
  const co2Grams = estimates.reduce((s, e) => s + e.co2Grams, 0);

  const config = estimates[0]!.config; // use first estimate's config (they share a period)

  return {
    energyWh,
    totalEnergyWh,
    co2Grams,
    co2GramsLow: co2Grams * 0.45,
    co2GramsHigh: co2Grams * 1.55,
    equivalents: computeEquivalents(totalEnergyWh, co2Grams, estimates.find(e => e.detectedRegion)?.detectedRegion ?? config.region ?? null),
    detectedRegion: estimates.find(e => e.detectedRegion)?.detectedRegion ?? null,
    config,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeEquivalents(totalEnergyWh: number, co2Grams: number, regionKey: string | null): EnvironmentalEquivalents {
  const co2Kg = co2Grams / 1000;
  const solarRegionKey = (regionKey && REGIONS[regionKey]) ? regionKey : "global";
  const solarYield = REGIONS[solarRegionKey]!.solarYield;
  return {
    treesYears: co2Kg / 21,
    carKm: co2Kg / 0.12,
    transitKm: co2Kg / 0.030,
    solarPanelM2: (totalEnergyWh / 1000) / solarYield,
    solarRegionKey,
    gasolineLiters: co2Kg / 2.31,
    coffeeCups: co2Kg / 0.3,
    trainKm: co2Kg / 0.006,
    nuclearWasteMg: totalEnergyWh * 0.003,
  };
}

/**
 * Format energy for display: "12.4 Wh" or "1.2 kWh".
 */
export function formatEnergy(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  if (wh >= 10) return `${wh.toFixed(1)} Wh`;
  if (wh >= 1) return `${wh.toFixed(2)} Wh`;
  return `${(wh * 1000).toFixed(1)} mWh`;
}

/**
 * Format CO₂ for display: "4.6 g" or "1.2 kg".
 */
export function formatCO2(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg`;
  if (grams >= 10) return `${grams.toFixed(1)} g`;
  return `${grams.toFixed(2)} g`;
}
