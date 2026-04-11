# 01 — Energy Estimation Model

## Approach

Estimate energy per inference request from token counts, model size class, and token type. This is necessarily an approximation — Anthropic does not publish per-request energy metrics — but we can ground estimates in peer-reviewed measurements and calibrate against the only first-party production data available (Google Gemini, August 2025).

**No Claude-specific energy data exists.** All Anthropic/Claude estimates in the literature are derived from external analysis (Epoch AI, Couch 2026), not from Anthropic disclosures. This is a fundamental limitation that must be communicated clearly.

## Calibration Anchor: Google Gemini (First-Party Measured)

The only first-party production measurement published by a frontier AI provider:

> Median Gemini Apps text prompt: **0.24 Wh** energy, **0.03 gCO2e**, 0.26 mL water
> — Google, "Measuring the Environmental Impacts of Generative AI" (arxiv 2508.15734, August 2025)

This is a full-stack measurement (accelerator + host + idle capacity + PUE overhead) on custom TPU hardware with fleet-wide PUE of 1.09. It provides a reality check for our estimates: a typical Claude query to a Sonnet-class model should land in the same order of magnitude (~0.2–0.5 Wh).

Other converging data points:
- **Epoch AI (Feb 2025):** GPT-4o typical query ~0.3 Wh (derived estimate, 500 output tokens)
- **OpenAI (Altman, 2025):** ~0.34 Wh per standard text query

## Per-Token Energy by Model Class

### Evidence Base

| Source | What it measured | Key finding |
|--------|-----------------|-------------|
| **TokenPowerBench** (arxiv 2512.03024, Dec 2025) | LLaMA 1B–405B, Mistral, Qwen, Falcon on 8-node H100 cluster | 1B→70B = 7.3x energy (sublinear vs 70x params); FP8 vs FP16 cuts energy ~30% |
| **"From Prompts to Power"** (arxiv 2511.05597, Nov 2025) | 32,500+ measurements, 155 architectures, 21 GPU configs (V100/T4/L4/A100/H100) | OPT-30B on A100: 100in+100out = 0.014 Wh; 100in+900out = 0.30 Wh |
| **Muxup analysis** (2026, InferenceMAX benchmarks) | DeepSeek-R1 671B on GB200 NVL72 | 8Kin+1Kout = 0.96 Wh; 1Kin+8Kout = 15–16 Wh |
| **Luccioni et al.** (ACM FAccT 2024, arxiv 2311.16863) | 88 models on A100 cluster, per-1K-inference energy | BLOOMz-7B: 0.104 kWh/1K inferences. Methodology contribution; absolute values outdated for 2025+ hardware |
| **AI Energy Score** (Hugging Face, 2025) | 166+ models on H100 across 10 tasks | Current successor to Luccioni 2023; standardized benchmarks |

**Note:** IEA (2024/2025) publishes macro data center energy trends but **not** per-token or per-query inference figures. MLCommons measures throughput and system power but does not publish consumer-friendly per-token energy tables. Neither should be cited for per-token values.

### Derived Coefficients

Based on TokenPowerBench scaling relationships, "From Prompts to Power" measurements, and calibration against the Google 0.24 Wh anchor:

| Model Class | Approx Params | Energy per 1K output tokens | Energy per 1K input tokens |
|-------------|---------------|----------------------------|---------------------------|
| Haiku       | ~8B           | 0.04 Wh                   | 0.010 Wh                 |
| Sonnet      | ~70B          | 0.30 Wh                   | 0.075 Wh                 |
| Opus        | ~200B+        | 0.90 Wh                   | 0.225 Wh                 |

**Derivation:**
- Sonnet is calibrated so a typical query (~200 input + ~500 output tokens) ≈ 0.17 Wh raw inference, which with PUE 1.2 ≈ 0.20 Wh — consistent with the Google/Epoch/OpenAI range of 0.2–0.4 Wh.
- Haiku scales down ~7x from Sonnet (TokenPowerBench: 1B→70B = 7.3x; Haiku is smaller but more optimized).
- Opus scales up ~3x from Sonnet (sublinear scaling from TokenPowerBench; 200B/70B ≈ 2.9x raw params, but inference optimizations dampen the ratio).

**These are estimates with ±50% uncertainty.** Claude model architectures are not public; MoE vs dense, quantization level, and hardware all affect actual energy.

### Output vs Input Token Energy Ratio

**The ratio is approximately 3–5x, not 15–20x** as commonly assumed.

| Source | Measured ratio (output:input per token) |
|--------|----------------------------------------|
| "From Prompts to Power" (OPT-30B, A100) | ~3–4x (derived from 100in+900out vs 900in+100out measurements) |
| Muxup (DeepSeek-R1 671B, GB200) | ~2x (derived from 8Kin+1Kout vs 1Kin+8Kout) |
| API pricing across providers | 3–5x (DeepSeek ~1.6x, Claude/GPT ~3–5x) |

The confusion likely arises from comparing total energy of long-output vs short-output queries (where ratios can be 10–15x), but that reflects output *length* differences, not per-token cost differences. We use **4x** as the default ratio, yielding the coefficients above.

### Model Name → Class Mapping

The codebase has no explicit model-to-class mapping — `packages/core/src/pricing.ts` uses longest-first `startsWith` matching on full model name strings (e.g., `"claude-opus-4-6"` before `"claude-opus-4"`). The energy module needs a similar approach:

```typescript
// Model class lookup — same startsWith strategy as pricing.ts
const MODEL_CLASS_MAP: Array<[string, ModelClass]> = [
  ["claude-opus",   "opus"],
  ["claude-sonnet", "sonnet"],
  ["claude-haiku",  "haiku"],
  ["claude-3-5-sonnet", "sonnet"],   // legacy naming
  ["claude-3-5-haiku",  "haiku"],
];

function modelClass(modelName: string): ModelClass {
  for (const [prefix, cls] of MODEL_CLASS_MAP) {
    if (modelName.startsWith(prefix)) return cls;
  }
  return "sonnet"; // Conservative fallback for unknown models
}
```

This is a **new abstraction** not currently in the codebase. It should live in `packages/core/src/energy.ts` alongside the energy coefficients.

### Token Type Weights

Not all tokens are equal in energy terms:

| Token Type | DB Column (messages) | Relative Energy Weight | Rationale |
|------------|---------------------|----------------------|-----------|
| Output tokens | `output_tokens` | 1.0x (baseline) | Full autoregressive decode per token |
| Input tokens (fresh) | `input_tokens` | 0.25x | Batched prefill — parallelized, cheaper per token (3–5x ratio) |
| Cache write tokens | `cache_creation_tokens` | 0.29x | Prefill + KV-cache serialization overhead (~15% over fresh input) |
| Cache read tokens | `cache_read_tokens` | 0.01x | Near-zero: memory read, minimal GPU compute |
| Ephemeral 5m cache tokens | `ephemeral_5m_cache_tokens` | 0.01x | Same as cache reads — memory lookup |
| Ephemeral 1h cache tokens | `ephemeral_1h_cache_tokens` | 0.01x | Same as cache reads — memory lookup |
| Thinking tokens | (see below) | 1.0x | Full decode passes, same cost as output |

### Thinking Tokens

Extended thinking (used heavily by Opus and Sonnet) involves the model generating internal reasoning tokens before producing the visible response. These tokens require full autoregressive decoding — energetically identical to output tokens.

**Current codebase state:** The `messages` and `sessions` tables track `thinking_blocks` (count of thinking blocks), but do **not** store thinking token volume. Thinking tokens are included in `output_tokens` by the Anthropic API, so they are already captured in the energy calculation via output tokens. No separate handling is needed.

However, the `thinking_blocks` count is useful as a **reporting signal** — sessions with high thinking block counts are disproportionately energy-intensive. The dashboard should surface this as context (e.g., "72% of energy from extended thinking sessions").

### Formula

```
energy_wh = (output_tokens / 1000) * model_output_rate
          + (input_tokens / 1000)  * model_input_rate
          + (cache_creation_tokens / 1000) * model_input_rate * 1.15
          + (cache_read_tokens / 1000)  * model_output_rate * 0.03
          + (ephemeral_5m_cache_tokens / 1000) * model_output_rate * 0.03
          + (ephemeral_1h_cache_tokens / 1000) * model_output_rate * 0.03
```

Where `model_output_rate` and `model_input_rate` are looked up from the model class table above using `modelClass(model)`.

## Data Center Overhead (PUE)

Data centers consume additional energy for cooling, networking, and infrastructure. This is captured by the Power Usage Effectiveness (PUE) multiplier:

| Provider / Scenario | PUE | Source |
|---------------------|-----|--------|
| Google (fleet-wide) | 1.09 | Google Data Centers, 2024 |
| AWS (global average) | 1.15 | AWS Sustainability Report; best sites 1.04–1.07 |
| Microsoft Azure (global average) | 1.16 | Microsoft Sustainability Report 2024 |
| Uptime Institute industry average | 1.56 | Uptime Institute Global Survey 2024 |
| IEA industry estimate | 1.41 | IEA Energy and AI 2025 |
| Enterprise data centers | 1.5–1.8 | Industry reports |
| **Default** | **1.2** | Appropriate for hyperscale cloud (where Claude runs); slightly conservative vs Google/AWS/Azure actuals |

Anthropic uses AWS and GCP infrastructure, so a PUE in the 1.09–1.15 range is likely. **1.2 is a defensible default** — slightly conservative for hyperscale, which is appropriate given our uncertainty.

```
total_energy_wh = energy_wh * PUE
```

## Carbon Intensity

Convert energy to CO2 using regional **average** grid carbon intensity. Per GHG Protocol Scope 2 guidance, average (not marginal) emissions are the correct basis for carbon accounting and impact estimation.

### Americas

| Region | gCO2eq/kWh | Source |
|--------|-----------|--------|
| US Average | 368 | EIA 2023 data (0.81 lbs/kWh) |
| US West (WECC) | 260 | EPA eGRID2022, hydro/renewables |
| US East (SERC) | 420 | EPA eGRID2022, coal-heavy |
| US Midwest (MROW) | 470 | EPA eGRID2022, coal/natural gas |
| US California (CAMX) | 210 | EPA eGRID2022, renewables + gas |
| US Pacific NW (NWPP) | 170 | EPA eGRID2022, hydro-dominant |
| Canada Average | 110 | Canada NIR 2024, hydro-dominant |
| Brazil | 60 | IEA 2024, hydro-dominant |

### Europe

| Region | gCO2eq/kWh | Source |
|--------|-----------|--------|
| EU Average | 230 | EEA 2024 (between 2023: 242 and 2024 est: ~220) |
| France | 57 | RTE 2024, nuclear-dominant (~70% nuclear) |
| Germany | 350 | UBA 2024, transitioning from coal |
| UK | 200 | DESNZ 2024, offshore wind + gas |
| Spain | 150 | REE 2024, growing solar/wind |
| Italy | 260 | ISPRA 2024, gas + growing renewables |
| Netherlands | 300 | CBS 2024, gas-heavy |
| Poland | 620 | KOBiZE 2024, coal-dominant |
| Sweden | 25 | Energimyndigheten 2024, hydro + nuclear |
| Norway | 10 | NVE 2024, nearly 100% hydro |
| Denmark | 100 | Energistyrelsen 2024, wind-dominant |
| Austria | 90 | UBA.at 2024, hydro-dominant |
| Finland | 70 | Statistics Finland 2024, nuclear + hydro |
| Ireland | 270 | SEAI 2024, gas + growing wind |
| Switzerland | 30 | BFE 2024, hydro + nuclear |
| Belgium | 140 | Elia 2024, nuclear + gas |
| Portugal | 130 | DGEG 2024, growing renewables |
| Czech Republic | 370 | ERU 2024, coal + nuclear |
| Greece | 280 | ADMIE 2024, transitioning from lignite |

### Asia-Pacific & Other

| Region | gCO2eq/kWh | Source |
|--------|-----------|--------|
| Australia | 530 | CER 2024, coal-dominant |
| Japan | 430 | METI 2024, gas + coal |
| South Korea | 390 | KEEI 2024, coal + nuclear |
| India | 680 | CEA 2024, coal-dominant |
| China | 530 | IEA 2024, coal + growing renewables |
| Singapore | 370 | EMA 2024, gas-dominant |
| New Zealand | 80 | MBIE 2024, geothermal + hydro |
| Global Average | 436 | IEA 2024 |

### Default Region

```
co2_grams = (total_energy_wh / 1000) * grid_intensity_gCO2_per_kWh
```

**Default:** Use user's locale to auto-select a region preset. If locale detection is unavailable, fall back to **Global Average (436 gCO2/kWh)** rather than US Average — this avoids US-centric bias and is more conservative, which is appropriate given the uncertainty in both energy estimation and data center location.

### Data Source Notes

- **EPA eGRID** (eGRID2022, published 2024): US subregional emission factors. Free via eGRID Explorer. Updated roughly every 2 years.
- **EEA Emission Intensity Indicator**: EU country-level and aggregate. Updated annually. Free.
- **IEA Emissions Factors**: Global coverage, published annually. Paid product; we use publicly reported summary figures.
- **Electricity Maps / WattTime**: Real-time carbon intensity APIs. Out of scope for v1 (see Open Questions in 04-implementation-plan.md) but could enable time-of-day adjustments in v2. Note: Electricity Maps recommends average (not marginal) for impact estimation. WattTime marginal signals have known methodological challenges.

## Environmental Equivalents

Make the numbers tangible:

| Equivalent | Formula | Source |
|------------|---------|--------|
| Trees (1-year absorption) | co2_kg / 21 | EPA (US), mature tree absorbs ~21 kg CO2/year |
| Car km driven | co2_kg / 0.12 | Average EU passenger car: 120 gCO2/km (EEA 2023 new car avg); US: ~170 gCO2/km. Use 120 as lower bound |
| Smartphone charges | co2_kg / 0.011 | ~8.22 Wh per charge |
| LED bulb hours (10W) | energy_wh / 10 | Direct energy comparison |
| Google searches | energy_wh / 0.24 | Google Gemini whitepaper: median text prompt = 0.24 Wh (2025) |
| Netflix streaming hours | energy_wh / 36 | ~36 Wh per hour (IEA) |
| Train km (EU average) | co2_kg / 0.006 | Average EU rail: 6 gCO2/pkm (EEA 2024) |

**Note:** Car emissions vary significantly — EU average new cars emit ~120 gCO2/km vs US ~170 gCO2/km. We use the EU figure as it's the more conservative (smaller) divisor, producing larger km equivalents. The UI should label this as "EU avg" or "US avg" based on the user's region setting.

## Configuration

Users should be able to override:

```typescript
interface EnergyConfig {
  /** Power Usage Effectiveness multiplier (default: 1.2) */
  pue: number;
  /** Grid carbon intensity in gCO2eq/kWh (default: auto from locale, fallback 436) */
  gridIntensity: number;
  /** Region preset — sets gridIntensity automatically */
  region?: string;
  /** Custom per-model energy rates (advanced) */
  modelOverrides?: Record<string, { inputWh: number; outputWh: number }>;
}
```

## Inference Geo — Auto-Detecting Data Center Region

The `messages` table has an `inference_geo` column (nullable string) populated from Claude Code telemetry. When present, this gives the actual data center region serving the request, enabling automatic grid carbon intensity lookup instead of relying on user configuration.

**Strategy:**
1. If `inference_geo` is available on a message, map it to the nearest grid region
2. Fall back to user-configured region when `inference_geo` is null
3. Display the detected region in the dashboard for transparency

This is a significant accuracy improvement over the Carbon Tracker's static approach and should be surfaced as a "detected vs configured" indicator.

## Comparison with Claude Carbon Tracker

| Aspect | Carbon Tracker | Our Approach |
|--------|---------------|--------------|
| Granularity | All tokens treated equally | Input/output/cache/ephemeral distinguished |
| Model awareness | Single emission factor | Per-model-class coefficients |
| Output/input ratio | Implicit 1:1 | 4:1 based on literature |
| Cache handling | Counted but not differentiated | Cache reads ~100x cheaper than fresh output |
| Thinking tokens | Not addressed | Tracked via output tokens + thinking_blocks context |
| Data center region | Static user config | Auto-detect via `inference_geo` + user fallback |
| PUE | Implicit in emission factor | Explicit, configurable, based on provider-reported values |
| Grid intensity | Baked into single factor | Separate, region-selectable, auto-detectable |
| Regional coverage | US-centric | 30+ regions across Americas, Europe, Asia-Pacific |
| Calibration | No anchor | Calibrated against Google Gemini 0.24 Wh measurement |
| Uncertainty | Not addressed | ±50% range displayed; GHG Protocol methodology |
| Accuracy | Order-of-magnitude | Within 2–5x (still an estimate) |

## Uncertainty & Honesty

### Methodology

Follow the GHG Protocol's quantitative uncertainty guidance:
- Estimate ±50% confidence interval on the final CO2 number
- Primary uncertainty sources: model energy coefficients (unknown architecture), PUE (known within ~10%), grid intensity (known within ~15%)
- Use error propagation: relative CI of product ≈ √(sum of squares of component relative CIs)
- Display low/mid/high estimates, not a single point value

### Uncertainty Budget

| Factor | Uncertainty | Source |
|--------|------------|--------|
| Model energy per token | ±50% | Unknown architecture, MoE vs dense, quantization |
| PUE | ±10% | Provider-reported values are reliable |
| Grid carbon intensity | ±15% | Published national averages; actual DC location unknown |
| **Combined** | **±55%** | √(50² + 10² + 15²) ≈ 53%, rounded up |

### Disclaimers

All estimates must be displayed with clear context:

> **Estimates only.** Based on published LLM inference benchmarks (TokenPowerBench 2025, Google Gemini whitepaper 2025) and regional grid averages. Actual energy depends on Anthropic's hardware, model architecture, data center location, and infrastructure — none of which are publicly disclosed. Not suitable for regulatory compliance or carbon offsetting calculations.

Display uncertainty ranges rather than false precision. Show "~0.2 Wh (0.1–0.3)" not "0.2134 Wh".

## References

1. Luccioni, A.S. et al. "Power Hungry Processing: Watts Driving the Cost of AI Deployment?" ACM FAccT 2024. arxiv:2311.16863
2. "TokenPowerBench: A Comprehensive Energy Benchmarking Framework." Dec 2025. arxiv:2512.03024
3. "From Prompts to Power: Benchmarking the Energy Consumption of LLMs." Nov 2025. arxiv:2511.05597
4. Google. "Measuring the Environmental Impacts of Generative AI Usage." Aug 2025. arxiv:2508.15734
5. De Vries, A. "The growing energy footprint of artificial intelligence." Joule 7(10), Oct 2023
6. Patterson, D. et al. "The Carbon Footprint of Machine Learning Training Will Plateau, Then Shrink." IEEE Computer, 2022. arxiv:2204.05149
7. Epoch AI. "How Much Energy Does ChatGPT Use?" Feb 2025
8. IEA. "Energy and AI." 2025
9. EPA eGRID2022. US subregional emission factors. 2024
10. EEA. "Greenhouse gas emission intensity of electricity generation in Europe." 2024
11. GHG Protocol. "Guidance on Uncertainty Assessment in GHG Inventories." 2003
12. AI Energy Score Leaderboard. Hugging Face, 2025. huggingface.co/spaces/AIEnergyScore/Leaderboard
