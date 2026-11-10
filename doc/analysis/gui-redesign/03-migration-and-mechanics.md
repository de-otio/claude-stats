# 03 — Migration and mechanics: getting there without a rewrite

## 3.1 What does not change

The load-bearing architecture survives intact ([01 §1.6](01-diagnosis.md)):
one query layer (`buildDashboard`, `packages/cli/src/dashboard/index.ts:477`)
feeding every surface; one HTML renderer serving two hosts (served page +
webview bridge, `packages/cli/src/extension/panel.ts:526-660`); Chart.js;
no build step, no framework. The redesign is a re-layering of the renderer,
not a platform decision — reopening the frontend-framework option study
would burn the budget the IA work needs.

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
  as a future option in the earlier frontend option study): nothing in the Insights
  layer needs it; revisit only if a domain view demands a visual Chart.js
  cannot draw.
- **TUI/CLI redesign**: the CLI report gains the five sentences as its
  header (cheap, shared formatters); its table body is fine as is.
