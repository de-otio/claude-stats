# 03 — Dashboard Design

## Design Principles

1. **Awareness, not guilt** — present energy data as informative context, not a scolding
2. **Actionable insight** — highlight what the user can influence (cache efficiency, model choice)
3. **Honest uncertainty** — always show that these are estimates with ranges
4. **Consistent with existing UI** — use the same Tremor components, Tailwind theme, and layout patterns

## Relationship to Existing Efficiency Tab

The CLI HTML dashboard and extension sidebar already have an "Efficiency" tab/view (`dashboard:tabs.efficiency` i18n key, `packages/cli/src/server/template.ts` line 191, `packages/cli/src/extension/sidebar.ts` line 12) focused on **model efficiency** — whether the right model tier was used for each task's complexity.

Energy is a distinct concern: _how much compute was consumed_, not _whether the right model was chosen_. However, there is natural overlap — the efficiency tab's "could have used Haiku instead of Opus" insight directly implies energy savings.

**Decision:** Energy gets its own page/tab in all surfaces. The efficiency tab gains a one-line link: "See energy impact of model choices →" pointing to the energy view. This keeps each view focused while connecting the narratives.

## Frontend Dashboard Page

### Route: `/dashboard/energy`

New page following the existing `/dashboard/*` route pattern (`/dashboard/sessions`, `/dashboard/projects`). The frontend has no dedicated navigation sidebar component — pages link to each other inline (e.g., `SessionDetailPage.tsx` links back to `/dashboard/sessions`). The main `Dashboard.tsx` page should gain an "Energy" link card or a navigation row alongside existing sections.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  Energy Impact                        [Region ▾] ⚙  │
│  Estimated environmental footprint of your AI usage  │
├──────────┬──────────┬──────────┬────────────────────┤
│  12.4 Wh │  4.6g    │  20%     │  3.1 Wh            │
│  Energy   │  CO₂     │  Cache   │  Energy Saved       │
│  ▲ 15%   │  ▲ 15%   │  ▲ 3%   │  by caching         │
├──────────┴──────────┴──────────┴────────────────────┤
│                                                      │
│  Energy Over Time (Area Chart)                       │
│  ┌──────────────────────────────────────────────┐   │
│  │  ████                                         │   │
│  │  ██████████                                   │   │
│  │  ████████████████                             │   │
│  │  Mon  Tue  Wed  Thu  Fri  Sat  Sun           │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
├────────────────────────┬─────────────────────────────┤
│  By Model (Donut)      │  Environmental Equivalents   │
│  ┌────────────┐        │                              │
│  │   ╭───╮    │        │  🌳 0.0002 trees/year       │
│  │  │Opus │   │        │  🚗 0.04 km driven           │
│  │  │ 72% │   │        │  📱 0.4 phone charges        │
│  │   ╰───╯    │        │  💡 1.2 LED bulb hours       │
│  │  Sonnet 25%│        │  🔍 41 Google searches       │
│  │  Haiku  3% │        │  📺 0.3 Netflix hours        │
│  └────────────┘        │                              │
├────────────────────────┴─────────────────────────────┤
│  Cache Energy Savings                                 │
│  ┌──────────────────────────────────────────────┐   │
│  │  Fresh compute  ████████████████  80%         │   │
│  │  Cache savings   ████             20%         │   │
│  └──────────────────────────────────────────────┘   │
│  "Cache hits avoided an estimated 3.1 Wh this week" │
├──────────────────────────────────────────────────────┤
│  Energy by Project (Bar Chart)                        │
│  ┌──────────────────────────────────────────────┐   │
│  │  claude-stats    ████████████████  65%         │   │
│  │  my-app          ██████            25%         │   │
│  │  other           ███               10%         │   │
│  └──────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────┤
│  Thinking Impact                                      │
│  "72% of energy from sessions with extended thinking" │
│  Sessions with thinking: 45 / 120                     │
├──────────────────────────────────────────────────────┤
│  Data Center Regions (from inference_geo)             │
│  ┌──────────────────────────────────────────────┐   │
│  │  us-east-1    ████████████████  60%           │   │
│  │  eu-west-1    ████████          30%           │   │
│  │  unknown      ███               10%           │   │
│  └──────────────────────────────────────────────┘   │
│  "60% of requests served from US East (420 gCO₂/kWh)"│
├──────────────────────────────────────────────────────┤
│  ⓘ Estimates based on published LLM inference        │
│  benchmarks. Actual values depend on Anthropic's     │
│  infrastructure. See methodology →                   │
└──────────────────────────────────────────────────────┘
```

### Components

| Component | Tremor Widget | Data Source |
|-----------|--------------|-------------|
| KPI Cards (top row) | `Card` + `Metric` + `BadgeDelta` | `energy.summary` |
| Energy Over Time | `AreaChart` | `energy.byDay` |
| By Model | `DonutChart` | `energy.byModel` |
| Equivalents | Custom card with icon list | `energy.summary.equivalents` |
| Cache Savings | `BarChart` (horizontal) | `energy.cacheImpact` |
| By Project | `BarChart` | `energy.byProject` |
| Thinking Impact | `Card` + `Text` | `energy.thinkingImpact` |
| Data Center Regions | `BarChart` (horizontal) | `energy.inferenceGeo` |
| Disclaimer | `Callout` (info variant) | Static text |
| Region Selector | `Select` dropdown | `energy.config.region` |

### Period Selector

Reuse the existing period selector component (day / week / month / all) already used on the main dashboard.

## CLI HTML Dashboard

Add an "Energy" tab to the existing tab-based HTML dashboard in `packages/cli/src/server/template.ts`. Current tabs are: Overview, Spending, Models, Projects, Sessions, Plan, Context, Efficiency, Settings. The new tab slots between Efficiency and Settings:

```
[Overview] [Spending] [Models] [Projects] [Sessions] [Plan] [Context] [Efficiency] [Energy] [Settings]
```

The Energy tab renders the same data using Chart.js (consistent with existing tabs). Like the Spending and Context tabs, it should be conditionally rendered — only shown when energy data is present in `DashboardData`.

## Extension Sidebar

Add an energy summary card to the existing VS Code sidebar panel:

```
┌─ Energy Impact (±55%) ─────┐
│  Today:  2.1 Wh  |  0.5g   │
│  Week:  12.4 Wh  |  2.9g   │
│  Cache saved: 3.1 Wh (20%) │
│  Region: EU Average (auto)  │
└─────────────────────────────┘
```

## Settings Page

Region selection dropdown with presets, grouped by continent. Default auto-detected from user locale (fallback: Global Average). See 01-estimation-model.md for full region list and sources.

```
Energy Settings
───────────────
Region: [Auto-detect (EU Average) ▾]
  ── Auto ──
  Auto-detect from locale
  ── Americas ──
  US Average (368 gCO₂/kWh)
  US West (260 gCO₂/kWh)
  US East (420 gCO₂/kWh)
  US Midwest (470 gCO₂/kWh)
  US California (210 gCO₂/kWh)
  US Pacific NW (170 gCO₂/kWh)
  Canada (110 gCO₂/kWh)
  Brazil (60 gCO₂/kWh)
  ── Europe ──
  EU Average (230 gCO₂/kWh)
  France (57 gCO₂/kWh)
  Germany (350 gCO₂/kWh)
  UK (200 gCO₂/kWh)
  Spain (150 gCO₂/kWh)
  Italy (260 gCO₂/kWh)
  Netherlands (300 gCO₂/kWh)
  Poland (620 gCO₂/kWh)
  Sweden (25 gCO₂/kWh)
  Norway (10 gCO₂/kWh)
  Denmark (100 gCO₂/kWh)
  Austria (90 gCO₂/kWh)
  Finland (70 gCO₂/kWh)
  Ireland (270 gCO₂/kWh)
  Switzerland (30 gCO₂/kWh)
  Belgium (140 gCO₂/kWh)
  Portugal (130 gCO₂/kWh)
  Czech Republic (370 gCO₂/kWh)
  Greece (280 gCO₂/kWh)
  ── Asia-Pacific ──
  Australia (530 gCO₂/kWh)
  Japan (430 gCO₂/kWh)
  South Korea (390 gCO₂/kWh)
  India (680 gCO₂/kWh)
  China (530 gCO₂/kWh)
  Singapore (370 gCO₂/kWh)
  New Zealand (80 gCO₂/kWh)
  ── Other ──
  Global Average (436 gCO₂/kWh)
  Custom...

PUE: [1.2] (Power Usage Effectiveness)

[i] These settings affect CO₂ estimates only.
    Energy consumption estimates are independent of region.
```

## Internationalization

Add i18n keys following the existing namespaced convention (`namespace:path.to.key`). Translation files are in `packages/core/src/locales/{en,de}/`. Each surface has its own namespace file:

**`dashboard.json`** (CLI HTML dashboard):
```json
{
  "tabs": {
    "energy": "Energy"
  },
  "energy": {
    "title": "Energy Impact",
    "totalEnergy": "Total Energy",
    "co2": "CO₂ Emissions",
    "cacheSavings": "Cache Energy Savings",
    "thinkingImpact": "Thinking Impact",
    "inferenceRegions": "Data Center Regions",
    "disclaimer": "Estimates based on published LLM inference benchmarks..."
  }
}
```

**`extension.json`** (VS Code extension sidebar help):
```json
{
  "tabHelp": {
    "energy": {
      "title": "Energy Impact",
      "sections": ["Estimated energy consumption and CO₂ footprint of your AI usage"]
    }
  }
}
```

**`frontend.json`** (React web app):
```json
{
  "energy": {
    "title": "Energy Impact",
    "subtitle": "Estimated environmental footprint of your AI usage",
    "regionSelector": "Region",
    "disclaimer": "Estimates based on published LLM inference benchmarks..."
  }
}
```

## Accessibility

- All charts must have aria-labels and text alternatives
- Color choices must meet WCAG AA contrast ratios
- Equivalents section uses text, not just icons
- Uncertainty ranges communicated in text, not just visually
