# 03 — Migration and mechanics: getting there without a rewrite

## 3.1 What does not change

The load-bearing architecture survives intact ([01 §1.6](01-diagnosis.md)):
one query layer (`buildDashboard`, `packages/cli/src/dashboard/index.ts:477`)
feeding every surface; one HTML renderer serving two hosts (served page +
webview bridge, `packages/cli/src/extension/panel.ts:526-660`); Chart.js;
no build step, no framework. The redesign is a re-layering of the renderer,
not a platform decision — reopening the
[frontend/](../frontend/) option study would burn the budget the IA work
needs.

## 3.2 Sequencing — additive first, consolidation second

| Phase | Scope | Risk posture |
|---|---|---|
| 1 | **Insights tab, additive.** New default tab rendering the five cards + alerts strip from existing `DashboardData` fields (Q1 plan-mode, Q3 frontier, Q4 plan verdict, Q5 recommendations are buildable today; Q2 renders its honest-empty state until ticket-attribution phase 1). Nothing moves yet. | Zero regression risk — ten tabs become eleven, temporarily |
| 2 | **Componentize the card.** Extract `renderCard(answer, number, trend, caveat, link)` + design tokens (CSS custom properties mapped to VS Code theme variables in the webview, a neutral palette when served). New code uses tokens; old inline styles are converted only when a card is otherwise touched. | Mechanical; per-card |
| 3 | **Regroup into domain views.** Explore mode gains the four views ([02 §2.4](02-answer-first-ia.md)) as thin containers that *re-parent existing render functions*; the old tab bar collapses to Insights + 4 + Sessions/Energy/Settings. The three cost-quality cards consolidate per [value-per-cost/06](../value-per-cost/06-what-to-build.md): frontier leads, cost-per-task nests inside it, calibration shrinks to a caveat badge with a details popover. | The visible IA change; ship behind "New layout" toggle for one release |
| 4 | **Local filters** (project/model/ticket/class) in domain views, threaded through `buildDashboard` opts — the guru's missing drill-down, with MCP/CLI parity per the filter-symmetry contract. | Store-layer care ([ticket-attribution/02 §2.5](../ticket-attribution/02-local-data-model.md)) |
| 5 | **New-analysis sections** land in their domain views as their features ship (reconciliation panel, ticket table + link/negate, hygiene digest, policy timeline, pricing scenarios, pack generator). | Each is a section, never a tab |

## 3.3 Consolidations and repairs (the debt list)

1. **Three cost-quality cards → one layered card** (phase 3, above).
2. **Stale sidebar IA**: `extension/sidebar.ts:12` still lists the removed
   `models` tab and lacks `classify`. Replace the hardcoded `TAB_IDS` with a
   single navigation definition exported from the renderer module — the
   sidebar's contextual help then tracks the real IA by construction.
3. **Two settings systems**: the in-page Settings tab (CLI config) and VS
   Code `contributes.configuration` overlap confusingly. Rule: *data
   semantics* (plans, fees, thresholds, tickets allowlist, policy events,
   hourly rate) live in CLI config via the Settings view; *host concerns*
   (port, refresh cadence) stay VS Code settings; the Settings view says so.
4. **Host parity**: outcome labelling and Classify are webview-only today
   (`server/index.ts` lacks the routes; `panel.ts:153` gates
   `includeTasks`). Decide per feature: add `/api` routes (labelling —
   cheap, needed for the served controller persona) or declare webview-only
   explicitly in the UI (Classify). Silent skew is the only wrong option.
5. **Empty/conditional-tab churn**: domain views render always, with honest
   empty states ([02 §2.6](02-answer-first-ia.md)) — the mental map stops
   moving.
6. **i18n rebalance**: the five cards and alert sentences are new copy that
   must be written answer-first in `en` and land in **every locale in the
   same change** (the repo's translation-parity rule); expect the `summary`
   namespace to grow from 19 keys toward parity with what it now carries.

## 3.4 The pack and the GUI must not drift

The [justification pack](../ticket-attribution/05-justification-pack.md) is
the Insights layer serialized: same five questions, same numbers, same
caveats, generated from the same `DashboardData` + enrichers. Implement the
card sentences as **shared formatting functions** (data → sentence + caveat)
used by both the renderer and the pack generator — the pack's
"deterministic, no drift" rule then holds structurally, the same way the
narrow sync shape holds the privacy rule. The MCP layer gets the same
treatment where it overlaps (`get_stats` already promises dashboard
consistency, `mcp/index.ts:209`).

## 3.5 Success criteria — how we know it worked

- **The fifteen-second test**: a user who has never studied the tool reads
  the Insights screen and can answer "what did AI cost this period and was
  it worth it" — testable with any colleague, no telemetry needed (the tool
  is local; we do not add usage tracking to measure UX).
- **The one-home test**: every business question from the strategic goals
  (cost, per-ticket, efficiency/waste, constraint damage, plan fit) has
  exactly one place where its answer starts.
- **The guru-retention test**: every chart/table reachable today is
  reachable in Explore, plus project/model/ticket filters that do not exist
  today — the redesign must give the guru depth, not take breadth.
- **The two-click evidence test**: any Insights number to row-level evidence
  in ≤2 clicks ([02 §2.5](02-answer-first-ia.md)).
- **Copy-budget inversion**: the answer layer stops being 5% of the page's
  words ([01 §1.3](01-diagnosis.md)).
- **No new tabs**: feature growth lands as sections in the four views; the
  tab count is a regression metric from now on.

## 3.6 Out of scope, stated

- **The hosted SPA** ([01 §1.7](01-diagnosis.md)): it inherits the
  question-shaped IA when org-plane data is real; redesigning a mock-driven
  shell now would be effort spent twice.
- **A charting-library migration** (ECharts for heatmaps/treemaps was noted
  as a future option in [frontend/](../frontend/)): nothing in the Insights
  layer needs it; revisit only if a domain view demands a visual Chart.js
  cannot draw.
- **TUI/CLI redesign**: the CLI report gains the five sentences as its
  header (cheap, shared formatters); its table body is fine as is.
