# 02 — The answer-first information architecture

## 2.1 Two modes, stated honestly

```
┌──────────────────────────────────────────────────────────────┐
│  [Insights]  [Explore ▾]                    period ▾  acct ▾ │
├──────────────────────────────────────────────────────────────┤
│  ⚠ alerts strip (only when something needs action)           │
│                                                              │
│  Q1 Cost      Q2 Bought     Q3 Efficiency                    │
│  Q4 Setup     Q5 Change     [Generate report]                │
│                                                              │
│  (each card: one sentence · one number · trend · caveat ·    │
│   "see evidence →" into the matching domain view)            │
└──────────────────────────────────────────────────────────────┘
```

**Insights** is the default and fits on one screen without scrolling.
**Explore** is a mode, not a demotion euphemism: it contains four
question-shaped domain views (§2.4) plus the guru surfaces exactly as they
are today. The persona split the owner described — controllers who need
fifteen seconds, gurus who enjoy 28 charts — becomes an explicit, persistent
choice instead of one page trying to be both. The mode is remembered per
host; deep links from Insights cards land *inside* Explore, which is how the
guru surface stops being a front door and becomes a destination.

## 2.2 The five question cards

Every card is a **sentence with a number**, never a number alone — the
mentor voice from [deep-analysis/](../deep-analysis/README.md). Data sources
are existing `DashboardData` fields unless marked *(new)*.

| Card | The sentence it renders | Sources |
|---|---|---|
| **Q1 — What did AI cost?** | "€312 this month — ≈ 0.8 dev-days at your configured rate — and it reconciles with the invoice (98.7%)." / plans: "…$540 of API-equivalent value against your $100 plan (5.4×)." | `summary.estimatedCost`, `planMultiplier`, `planFee`; hourly rate & reconciliation *(new — [ticket-attribution/04 §4.3](../ticket-attribution/04-reporting-and-roi.md))*; metered/plan language mode |
| **Q2 — What did it buy?** | "41 tasks completed, 83% of spend attributed to 17 tickets. Biggest: PROJ-123 (€41)." | `costPerTask.*`; ticket coverage + top tickets *(new — [ticket-attribution/](../ticket-attribution/README.md))* |
| **Q3 — Was it efficient?** | "Realised cost is 12% above your frontier — €38 recoverable. Self-audited waste trending down (14% → 6%)." | `costPerTask.efficiency.recoverableWaste` (the value-per-cost headline, finally leading); hygiene trend *(new — [efficiency-hygiene/](../efficiency-hygiene/README.md))* |
| **Q4 — Is the setup right?** | "Your usage fits Max 5× with headroom — switching would save €80/mo." / "Since the Opus policy (May 1), cost per successful task in 3 classes is up 28%." | `planUtilization.currentPlanVerdict`, `recommendedPlan`; pricing-model comparison + policy-boundary deltas *(new — [constraint-impact/04](../constraint-impact/04-pricing-model-comparison.md), [02](../constraint-impact/02-model-policy-impact.md))* |
| **Q5 — What should change?** | Top 2–3 recommendations with impact badges, plus one "doing well" line. | `recommendations[]` (`dashboard/index.ts:1495`) — promoted from footnote to card |

Card grammar, uniform across all five: **answer sentence → number →
trend arrow vs previous period → caveat chip → evidence link.** The caveat
chip is load-bearing, not decoration: it carries the honesty obligations the
analyses impose (confidence tier mix on Q2, calibration figure on Q2/Q3
per [constraint-impact/03 Gap 5](../constraint-impact/03-measurement-mechanics.md),
"estimate" vs "actual" language per account mode, "uncalibrated" and
"coverage low" states). A card that cannot honestly answer yet says so in
its own voice: "Value not declared → ROI unknown" (the
[value-per-cost](../value-per-cost/06-what-to-build.md) contract), "No
tickets linked yet — enable branch extraction", never an empty widget.

## 2.3 The alerts strip

Rendered only when non-empty — absence is information. Alert sources:
cost-alert thresholds (already configurable in Settings), reconciliation
drift beyond tolerance, calibration below minimum n, a policy event with
measurable damage crossing a threshold, plan verdict "wrong plan", hygiene
detector findings above a size floor. Each alert is one line + one action
link. This replaces the current pattern where such conditions are findable
only by the reader who already knows which tab to study.

## 2.4 The four domain views (Explore's first level)

The 10 data-shaped tabs regroup into four question-shaped views; each view
is where its Insights card's evidence lives, and each absorbs the new
analyses as **sections, not tabs**:

| View | Absorbs (today) | Gains (new) |
|---|---|---|
| **Cost & Controlling** | Spending tab's cost charts/tables, fee attribution from Projects, expensive prompts/sessions | Reconciliation panel; per-ticket cost table with confidence tiers; justification-pack generator ([ticket-attribution/05](../ticket-attribution/05-justification-pack.md)) |
| **Tickets & Value** | cost-per-task card + outcome labelling, Nature of Work | Ticket links per session (link/negate UI, [ticket-attribution/02 §2.6](../ticket-attribution/02-local-data-model.md)); coverage trend; the value-tag surface value-per-cost calls for |
| **Efficiency & Hygiene** | efficiency frontier + calibration cards, cache/context analysis (Context tab), model-tier analysis (Efficiency tab) | Hygiene digest cards with dismissals ([efficiency-hygiene/](../efficiency-hygiene/README.md)) |
| **Plan & Policy** | Plan tab, usage windows (Sessions tab) | Policy-event timeline with annotated before/after ([constraint-impact/03 §3.3](../constraint-impact/03-measurement-mechanics.md)); pricing-model scenario table; metered-mode quota/429 view |

Remaining surfaces: **Sessions** (top conversations, entrypoints) survives
as the guru's raw-material view inside Explore; **Energy** stays as an
optional Explore view (94 i18n keys for a niche interest must not tax the
default path); **Classify** becomes a guided action launched from where its
output matters (Projects/Tickets sections) rather than a permanent tab;
**Settings** unifies with the VS Code-settings overlap explicitly resolved
([03 §3.4](03-migration-and-mechanics.md)). Net: the always-visible
navigation drops from 10 tabs to Insights + 4 views + 2 utility surfaces.

## 2.5 Drill-down: the missing guru feature

The paradox of the current GUI: overwhelming breadth, yet the guru cannot
filter by project or model at all (one global period/account bar,
`template.ts:507-533`). The redesign owes the guru **more** depth, not less:
domain views get local filters (project, model, ticket, task class) that
compose with the global period — and because every consumer shares
`buildDashboard`, filter parity lands in MCP/CLI too (the
[filter-symmetry contract](../ticket-attribution/02-local-data-model.md)
generalizes). Every Insights number must be reachable in ≤2 clicks from its
card to the row-level evidence (ticket → sessions → messages), matching the
"why do you claim PROJ-123 cost €41?" test from
[ticket-attribution/01 §1.5](../ticket-attribution/01-attribution-signals.md).

## 2.6 What the Insights layer refuses to do

- **No composite score.** A single "AI ROI: 87/100" tile would be
  verification theatre ([deep-analysis](../deep-analysis/README.md) rule);
  five honest sentences beat one manufactured number.
- **No raw token counts** above the fold — they are evidence, and live one
  click down. (The status bar keeps its today-tokens/cost readout —
  glanceability of a different kind.)
- **No chart for its own sake**: each card gets at most a sparkline; the 28
  canvases live in Explore where they are wanted.
- **No silent emptiness**: every unavailable answer states its enablement
  path — this is also the feature-discovery mechanism for the new analyses.
