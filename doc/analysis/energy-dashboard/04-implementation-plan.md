# 04 — Implementation Plan

## Phase 1: Core Engine (packages/core)

**Goal:** Pure computation module with no side effects.

### New file: `packages/core/src/energy.ts`

```typescript
// ~200 lines — model class mapping, energy coefficients, estimation, equivalents

// Model class mapping (new abstraction — see 01-estimation-model.md)
export type ModelClass = "haiku" | "sonnet" | "opus";
export function modelClass(modelName: string): ModelClass;

// Energy coefficients per model class
export const MODEL_ENERGY: Record<ModelClass, { inputWhPer1K: number; outputWhPer1K: number }>;

// Region grid intensity presets
export const REGIONS: Record<string, { name: string; gridIntensity: number }>;

// Inference geo → region mapping
export function inferenceGeoToRegion(geo: string): string | null;

// Config and result types
export interface EnergyConfig { pue: number; gridIntensity: number; region?: string; }
export interface EnergyEstimate {
  energyWh: number; totalEnergyWh: number; co2Grams: number;
  equivalents: EnvironmentalEquivalents; detectedRegion?: string;
}

// Core functions — message-level, not session-level (sessions have multiple models)
export function estimateEnergy(usage: TokenUsage, config?: EnergyConfig): EnergyEstimate;
export function aggregateEnergy(estimates: EnergyEstimate[]): EnergyEstimate;
```

### New file: `packages/core/src/energy.test.ts`

Test cases:
- Known token counts produce expected Wh within tolerance
- Cache reads contribute near-zero energy
- Ephemeral cache tokens (5m, 1h) treated same as cache reads
- Different models produce proportional energy differences (Opus >> Sonnet >> Haiku)
- `modelClass()` maps known model strings correctly, unknowns fall back to "sonnet"
- Aggregation sums correctly
- Default config produces reasonable values
- Equivalents math is correct
- `inferenceGeoToRegion()` maps known geo strings to regions

**Files changed:** 2 new files, update `packages/core/src/index.ts` to add `export * from "./energy.js";`.

---

## Phase 2: Dashboard Data (packages/cli)

**Goal:** Energy data flows through the existing dashboard pipeline.

### Modify: `packages/cli/src/dashboard/index.ts`

- Import `estimateEnergy`, `aggregateEnergy` from core
- In the existing message iteration loop, compute energy per message (not per session — sessions have multiple models)
- Aggregate into `energy` section of `DashboardData` return value
- Track `inference_geo` distribution and `thinking_blocks` context
- ~60 lines of new code in an existing function

### Modify: `packages/cli/src/reporter/index.ts`

- Add energy summary section to terminal output
- ~30 lines: format Wh, grams, equivalents, region label

### Modify: `packages/cli/src/cli/index.ts`

- Add `--region` and `--pue` CLI flags to the `report` command
- ~10 lines

**Files changed:** 3 modified

---

## Phase 3: Frontend Page (packages/frontend)

**Goal:** Full energy dashboard page in the web app.

### New file: `packages/frontend/src/pages/EnergyDashboard.tsx`

- KPI cards, area chart, donut chart, equivalents, cache savings, by-project bar chart
- Thinking impact card, inference geo distribution
- Region selector dropdown
- Disclaimer callout
- ~250 lines using existing Tremor components

### Modify: `packages/frontend/src/App.tsx`

- Add `/dashboard/energy` route (following existing `/dashboard/*` pattern)
- ~8 lines (import + ProtectedRoute wrapper, same pattern as `/dashboard/sessions`)

### Modify: `packages/frontend/src/pages/Dashboard.tsx`

- Add "Energy" link/card to main dashboard page (no separate nav component exists — pages link inline)
- ~5 lines

### Modify i18n files:

- `packages/core/src/locales/en/frontend.json` — add `energy.*` keys
- `packages/core/src/locales/de/frontend.json` — German translations
- `packages/core/src/locales/en/dashboard.json` — add `tabs.energy` and `energy.*` keys
- `packages/core/src/locales/de/dashboard.json` — German translations
- ~30 keys each language

**Files changed:** 1 new page, 2 modified tsx, 4 i18n files updated

---

## Phase 4: Extension Integration

**Goal:** Energy in status bar and sidebar.

### Modify: `packages/cli/src/extension/statusBar.ts`

- Add optional energy display
- ~15 lines

### Modify: `packages/cli/src/extension/sidebar.ts`

- Add `"energy"` to `TAB_IDS` array (line 12)
- Add energy summary card to sidebar webview
- ~30 lines

### Modify: `extension/package.json`

- Add `claude-stats.energyRegion` and `claude-stats.energyPue` settings
- Add `claude-stats.showEnergyInStatusBar` setting
- ~15 lines in contributes.configuration

### Modify i18n: `packages/core/src/locales/{en,de}/extension.json`

- Add `tabHelp.energy.title` and `tabHelp.energy.sections` keys
- ~5 lines each language

**Files changed:** 3 modified ts/json, 2 i18n files updated

---

## Phase 5: CLI HTML Dashboard

**Goal:** Energy tab in the self-contained HTML dashboard.

### Modify: `packages/cli/src/server/template.ts`

- Add "Energy" tab with Chart.js visualizations
- ~100 lines of HTML/JS template additions

**Files changed:** 1 modified

---

## Summary

| Phase | New Files | Modified Files | Est. Lines | Dependencies |
|-------|-----------|----------------|------------|-------------|
| 1. Core Engine | 2 | 1 | ~250 | None |
| 2. Dashboard Data | 0 | 3 | ~100 | Phase 1 |
| 3. Frontend Page | 1 | 6 | ~320 | Phase 2 |
| 4. Extension | 0 | 5 | ~70 | Phase 2 |
| 5. CLI HTML | 0 | 1 | ~120 | Phase 2 |
| **Total** | **3** | **16** | **~860** | |

Phases 3, 4, and 5 are independent of each other and can be done in parallel after Phase 2.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Energy coefficients are wrong | Calibrated against Google Gemini first-party data (0.24 Wh); coefficients configurable; ±55% uncertainty displayed per GHG Protocol methodology |
| Users take numbers as ground truth | Prominent disclaimers on every surface; show ranges not point estimates; link to methodology and references |
| Anthropic changes model architecture | Coefficients are in a lookup table, trivially updated; unknown models fall back to Sonnet-class defaults |
| Performance overhead | `estimateEnergy()` is ~5 arithmetic operations per message; negligible even for 100K messages |
| Feature bloat | Energy is opt-in visibility (status bar toggle); dashboard page is one route among many |
| Grid intensity data becomes stale | Carbon intensity values change yearly; include `ENERGY_DATA_VERIFIED_DATE` (like existing `PRICING_VERIFIED_DATE`) and log a warning when >12 months old |
| US-centric defaults alienate non-US users | Auto-detect region from locale; fall back to Global Average (436), not US Average; 30+ regions across 3 continents |

## Open Questions

1. **Should energy data be persisted in SQLite or computed on-the-fly?** Recommendation: compute on-the-fly. The calculation is trivial and keeping it derived means config changes (region, PUE) apply retroactively without re-processing.

2. **Should we offer time-of-day grid intensity?** Nice-to-have for v2 — grid carbon intensity varies by hour (solar peaks reduce afternoon intensity). Could use Electricity Maps API (average intensity, not marginal — per GHG Protocol and Electricity Maps' own recommendation). Note: WattTime marginal signals have known methodological issues and are not recommended for impact estimation.

3. **Team dashboard integration?** Phase 2 can surface per-account energy in the team dashboard. Same aggregation, just grouped differently.

4. **How to map `inference_geo` strings to grid regions?** The format of `inference_geo` values needs investigation — examine actual data in the SQLite database to determine the format (likely AWS region codes like `us-east-1`). The mapping to grid carbon intensity regions can be approximate.

5. **Should thinking token volume be tracked separately?** Currently only `thinking_blocks` (count) is stored. If Anthropic's API starts exposing thinking token counts separately from output tokens, a schema migration would be needed. For now, thinking tokens are included in `output_tokens` and no change is required.

6. **How to keep grid intensity data current?** National grid data changes yearly as energy mixes shift (e.g., Germany's coal phase-out, EU renewables growth). Options: (a) hardcode with `ENERGY_DATA_VERIFIED_DATE` and warn when stale, like the existing pricing cache pattern; (b) fetch from a public API. Recommendation: start with (a), add (b) in v2.

7. **Should equivalents adapt to locale?** "Car km driven" uses different baselines in EU (120 gCO2/km) vs US (170 gCO2/km). "Train km" is meaningful in EU but less so in US. The equivalents card should adapt based on the user's region setting.
