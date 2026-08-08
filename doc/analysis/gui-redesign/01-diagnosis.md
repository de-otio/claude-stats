# 01 — Diagnosis: how six charts became twenty-eight

## 1.1 The numbers

The original frontend spec
([frontend/CHECKLIST.md](../frontend/CHECKLIST.md)) described "a top summary
bar and six canvases", estimated at ~200–400 lines. Today:

| Dimension | Spec (v1) | Now |
|---|---|---|
| Renderer | ~300 lines | `packages/cli/src/server/template.ts` — **3,379 lines, one function** |
| Data builder | — | `packages/cli/src/dashboard/index.ts` — 2,536 lines |
| Tabs | 1 page | **10** (`template.ts:534`) |
| Charts | 6 | **28** canvases |
| KPI tiles | 5 | **47+** literal `.summary-card` instances (more in loops) |
| Tables | — | 10 |
| i18n keys for the page | — | **379** |

Growth mechanics: 21 commits touch `template.ts`, each *adding* a tab or
card; exactly one ever removed anything (the Models tab — which left
`extension/sidebar.ts:12` still listing `"models"` and never learning
`"classify"`, a stale parallel IA that is itself a symptom). Layout
primitives never evolved past the skeleton: two CSS classes
(`.summary-card`, `.chart-card`, `template.ts:440-472`) and everything since
styled inline with hardcoded hex colors — no design tokens, no light theme,
no VS Code theme integration despite the webview host supporting it.

## 1.2 Finding 1 — the IA mirrors the data model, not the user's questions

`DashboardData` (`dashboard/index.ts:109`) is a flat object with nullable
sub-blocks (`spending`, `energy`, `modelEfficiency`, `contextAnalysis`,
`planUtilization`, `feeAttribution`, `costPerTask`, …) — and the tab bar is
a 1:1 mirror of those blocks: a tab exists because a data block exists, and
appears/disappears with it. The consequence for the controlling reader:
**cost/ROI answers are scattered across four tabs** — the plan-multiplier
tile on Overview, three competing cost-quality cards on Spending
(cost-per-task, efficiency frontier, calibration — each with its own
headline number and honesty caveats), the plan verdict and recommendation on
Plan, fee attribution on Projects. There is no single view that answers
"what did AI cost us and was it worth it" — the exact question the strategic
goals ([ticket-attribution/README](../ticket-attribution/README.md)) say the
tool exists to answer.

## 1.3 Finding 2 — token mechanics own the glance layer

The Overview tab's always-visible tiles are dominated by raw token counts
(input, output, cache reads, cache efficiency…); estimated cost is one tile
among up to fourteen. Meanwhile the only *interpreted* output on the page —
the recommendations panel (`dashboard/index.ts:1495-1667`, ~10 rules with
severity and impact badges) — is the seed of exactly the mentor layer the
redesign needs, but it commands about **5% of the page's copy budget**
(i18n key distribution: `energy` 94 keys, `settings` 75, `plan` 38,
`costPerTask` 32 … `summary` 19). Energy and Settings alone hold 45% of the
page's words. The at-a-glance layer is the least-invested layer of the page.

## 1.4 Finding 3 — the redesign thesis exists, implemented but never promoted

[value-per-cost/06-what-to-build.md](../value-per-cost/06-what-to-build.md)
already specifies the reframe: efficiency frontier as the headline,
cost-per-successful-task demoted to a layer inside it, value strictly as an
optional user-declared layer. The frontier card and calibration view were
*built* — and placed mid-way down the Spending tab, below the card they were
supposed to demote. [deep-analysis/README.md](../deep-analysis/README.md)
supplies the interaction model ("a mentor, not a dashboard: observes,
notices, compares, advises, follows up"). The redesign is therefore mostly
**promotion and consolidation of existing pieces**, not invention.

## 1.5 What "overwhelming" is, concretely

- **No question has one home.** The user must know which of four tabs holds
  which fragment of the cost story — the "requires some study" complaint.
- **Three headline numbers compete** for the same question on one tab, each
  with different caveats.
- **Conditional tabs teach mistrust**: tabs appear and vanish with data
  availability, so the mental map never stabilizes.
- **One global filter bar** (period/dates/account, `template.ts:507-533`) and
  no per-project or per-model filtering in the GUI at all — the drill-*down*
  path for the guru is actually missing, despite the surface abundance.
- **Two settings systems** (VS Code `contributes.configuration` vs the
  in-page Settings tab writing CLI config) with disjoint options.
- The webview/served-page **feature skew** (outcome labelling and Classify
  are webview-only; the served host silently lacks them) makes the same
  product behave differently in its two hosts.

## 1.6 What is healthy and must be preserved

- **One query layer.** Every surface — served page, webview, status bar, MCP
  tools, CLI report — calls the same `buildDashboard(store, opts)`
  (`dashboard/index.ts:477`; consumers at `server/index.ts:357`,
  `extension/panel.ts:147`, `extension/statusBar.ts:31`, `mcp/index.ts:226`,
  `cli/index.ts:184`). MCP tool descriptions explicitly promise consistency
  with the GUI. **The redesign needs zero query-layer change** — the
  Insights layer assembles from existing fields plus the new analyses'
  outputs as they land.
- **One renderer, two hosts** (served HTML + webview with a message bridge,
  `extension/panel.ts:526-660`) — cheap to maintain, no build step; the
  architecture decision from [frontend/](../frontend/) stands.
- The **recommendations engine** — the mentor seed.
- The guru surface itself: 28 charts is not a defect for the guru persona;
  its *location* (the front door) is the defect.

## 1.7 The hosted SPA is a different problem

`packages/frontend/` (27 pages) is largely a mock-driven shell
(`frontend/src/hooks/useApi.ts:9` — mock data pending backend wiring), and
half its pages are gamification (challenges, achievements, leaderboards) per
[team-dashboard/04](../team-dashboard/04-gamification.md) — orthogonal to a
cost/ROI redesign. Scope discipline: this folder redesigns the **local
dashboard**; the SPA inherits the same question-shaped IA later, when the
org-plane features ([ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md))
give it real data to show.
