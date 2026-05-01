# Energy Use Dashboard — Analysis

Analysis for adding energy consumption and carbon footprint estimation to claude-stats, inspired by the [Claude Carbon Tracker](https://marketplace.visualstudio.com/items?itemName=claude-carbon-tracker-dev.claude-carbon-tracker) extension.

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-estimation-model.md](01-estimation-model.md) | Energy and CO2 estimation formulas, per-model coefficients |
| 02 | [02-data-integration.md](02-data-integration.md) | How to wire into existing token data — no new collection needed |
| 03 | [03-dashboard-design.md](03-dashboard-design.md) | UI components, visualizations, and placement |
| 04 | [04-implementation-plan.md](04-implementation-plan.md) | Concrete steps, file changes, and phasing |

## Key Insight

claude-stats already collects every piece of data needed: per-message token counts broken down by type (input, output, cache read, cache write) and model name. Energy estimation is a **pure derived metric** — it requires zero changes to parsing, collection, or storage. The entire feature is a computation layer on top of existing data plus new UI components.

## Reference: Claude Carbon Tracker

The Carbon Tracker extension uses a simplified formula:
```
CO2 (kg) = (total_tokens / 1000) * emission_factor   (default: 0.0004)
```

We can do significantly better because we already have:
- Per-model token breakdown (different models = different compute = different energy)
- Input vs output distinction (output tokens cost ~3–5x more compute than input per token, per TokenPowerBench 2025 and "From Prompts to Power" 2025)
- Cache token tracking (standard + ephemeral 5m/1h — cache reads use negligible compute)
- Thinking block counts (sessions with extended thinking are disproportionately energy-intensive)
- `inference_geo` per message (auto-detect data center region for accurate grid carbon intensity)
- Temporal data (can correlate with regional grid carbon intensity by time-of-day)

Our estimates are calibrated against the only first-party production measurement from a frontier AI provider: Google's Gemini whitepaper (arxiv 2508.15734, Aug 2025), which reports a median text prompt consumes 0.24 Wh. Energy coefficients cover 30+ grid regions across Americas, Europe, and Asia-Pacific.

## Scope

- **In scope:** Energy estimation engine, CO2 equivalents, dashboard UI (web + CLI + extension), user-configurable region/grid settings, inference_geo auto-detection, thinking impact reporting, relationship to existing efficiency tab
- **Out of scope:** Scope 2/3 emissions (training, networking, embodied carbon), regulatory compliance claims, thinking token volume tracking (not available in current schema)
