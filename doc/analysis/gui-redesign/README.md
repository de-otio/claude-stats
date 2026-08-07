# GUI redesign — business insights at a glance, depth on demand

> The GUI has grown organically over time and is now complex, even
> overwhelming. While fun for statistics gurus, it requires some study to get
> the actionable insights. Redesign it to focus on business-critical insights
> (cost / controlling / value / ROI) at a glance — yet keep the option to
> dive into detail for the statistics gurus.

This folder diagnoses how the dashboard got here, designs an answer-first
information architecture with two explicit modes (**Insights** for the
fifteen-second read, **Explore** for the guru), and plans the migration —
including where the new analyses
([ticket-attribution/](../ticket-attribution/),
[constraint-impact/](../constraint-impact/),
[efficiency-hygiene/](../efficiency-hygiene/)) surface in the GUI without
adding an eleventh tab.

## The one-paragraph conclusion

The dashboard's problem is not too much data but the wrong first layer: the
IA is a 1:1 mirror of the data model (10 tabs = 10 nullable `DashboardData`
blocks), so cost/ROI answers are scattered across four tabs while raw token
tiles dominate the landing view. The fix is not a rewrite — the query layer
(`buildDashboard`) is shared by every surface and needs no change, and the
redesign thesis is already written in
[value-per-cost/06](../value-per-cost/06-what-to-build.md) ("reframe, don't
cut — change what leads") and
[deep-analysis/](../deep-analysis/README.md) ("a mentor, not a dashboard").
The fix is a new default **Insights layer**: five answer-shaped cards, one
per business question (what did it cost · what did it buy · was it efficient
· is the setup right · what should change), each a sentence with a number, a
trend, a caveat, and a drill-down link — plus an alerts strip and the
justification-pack button. Every existing tab survives, demoted into an
**Explore** mode; nothing the guru has today is deleted, it is re-homed.
Ticket coverage, constraint timelines, hygiene digests, and the pricing
comparison land as sections of four question-shaped domain views, not as new
tabs.

## The core design choices (decide these first)

| # | Choice | Recommendation | Where argued |
|---|--------|----------------|--------------|
| 1 | The unit of the first layer | Answers to questions, not metrics — a sentence with a number, never a number alone | [02](02-answer-first-ia.md) |
| 2 | Mode structure | Two explicit modes: Insights (default) and Explore (everything current, re-homed) — a toggle, not a redesign of every view | [02](02-answer-first-ia.md) |
| 3 | Question set for the glance layer | Five: cost · bought · efficiency · setup · change — mapped to existing `DashboardData` fields plus the new analyses | [02](02-answer-first-ia.md) |
| 4 | New-feature surfacing | Sections inside four domain views (Cost & Controlling, Tickets & Value, Efficiency & Hygiene, Plan & Policy) — the tab count goes down, not up | [02](02-answer-first-ia.md) |
| 5 | Migration strategy | Additive first (new Insights tab becomes default), then consolidate; keep the single-renderer/two-host architecture; no framework rewrite | [03](03-migration-and-mechanics.md) |
| 6 | The three competing cost-quality cards | Consolidate per value-per-cost's layer model: efficiency frontier leads, cost-per-task demoted inside it, calibration becomes a footnote badge | [03](03-migration-and-mechanics.md) |
| 7 | Styling debt | Design tokens + VS Code theme variables while componentizing cards — done opportunistically per touched card, not as a big bang | [03](03-migration-and-mechanics.md) |
| 8 | Hosted SPA | Out of scope — it is a mock-driven shell; team insights land there only after the org-plane features ship | [01](01-diagnosis.md), [03](03-migration-and-mechanics.md) |

## Documents

| # | File | Contents |
|---|------|----------|
| 01 | [01-diagnosis.md](01-diagnosis.md) | How 6 charts became 28: the growth audit, the three structural findings, what "overwhelming" is concretely |
| 02 | [02-answer-first-ia.md](02-answer-first-ia.md) | The Insights layer: five question cards, alerts strip, the four domain views, Explore mode |
| 03 | [03-migration-and-mechanics.md](03-migration-and-mechanics.md) | Getting there without a rewrite: sequencing, consolidations, parity gaps, success criteria |

## Relationship to existing analysis

- **[value-per-cost/06-what-to-build.md](../value-per-cost/06-what-to-build.md)
  is the unimplemented spec this folder promotes to the front page**: lead
  with the efficiency frontier, demote cost-per-successful-task, value as an
  optional user-owned layer. The mechanism was built (Spending tab) but never
  promoted; this redesign is largely that promotion.
- **[deep-analysis/README.md](../deep-analysis/README.md)** supplies the
  voice: "a mentor, not a dashboard" — observes, notices, compares, advises.
  The recommendations engine is the seed of the Insights layer.
- **[frontend/](../frontend/)** is the original option study (server +
  webview, Chart.js, shared HTML) — its architecture decisions stand; its
  IA spec ("a top summary bar and six canvases") is what organic growth
  outgrew, unrevised until now.
- **[ticket-attribution/05](../ticket-attribution/05-justification-pack.md)**:
  the pack is the *export* of the Insights layer — same questions, same
  numbers, generated as a document. The GUI and the pack must not drift.
- **[sessions/session-analysis.md](../sessions/session-analysis.md)** §
  "Visualization Improvements" lists proposed controlling visuals (budget
  forecast line, session-cost histogram) that were never built while
  lower-signal charts shipped — inputs to the domain views.
