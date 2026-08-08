# 05 — The justification pack: the artifact that reaches the manager

Everything else in this folder (and in
[constraint-impact/](../constraint-impact/) and
[efficiency-hygiene/](../efficiency-hygiene/)) produces data. This file
designs the **deliverable**: the periodic, self-contained document a
developer hands to a manager who does not run claude-stats and never will.
Without it, the tool answers questions but the developer still assembles the
argument by hand every month — and hand-assembled arguments drift, omit, and
get discredited.

## 5.1 Audience and form

The reader is a manager or finance stakeholder with fifteen minutes, no
claude-stats installation, and an active suspicion that the numbers are
advocacy. That dictates the form:

- **Self-contained HTML** (printable to PDF): opens anywhere, attaches to
  email, survives being forwarded. No server, no login, no live data — a
  snapshot with a generation timestamp and period stamp.
- **A CSV bundle alongside** for the reader who wants to check the math or
  feed a BI tool — the same `ticketKey, period, cost, tokens, confidence`
  rows the exports already define ([04 §4.1](04-reporting-and-roi.md)).
- **One page of headline, then appendices.** The fifteen-minute reader gets
  the argument on page one; every number on it links (within the document)
  to the table that produced it.

## 5.2 Contents — in argument order

1. **Headline**: total spend for the period; the salary-denominator framing
   ("≈ N dev-days at the configured rate",
   [constraint-impact/01 §1.3](../constraint-impact/01-what-constraints-cost.md));
   coverage ("X% ticket-attributable"); and — metered accounts only — the
   **reconciliation statement** ([04 §4.3](04-reporting-and-roi.md)):
   bottom-up sum vs invoice, residual named.
2. **Per-ticket table**: confidence-tiered, per [04 §4.2](04-reporting-and-roi.md),
   with the ambiguity markers intact.
3. **Non-ticket work breakdown**: the explained remainder — review,
   debugging, exploration — framed as work no ticket captures.
4. **Hygiene trend**: self-audited waste as % of spend, trending
   ([efficiency-hygiene/](../efficiency-hygiene/README.md)) — the
   credibility section; included by the developer's choice, like every
   section here.
5. **Constraint impact** (conditional — present only when a policy event is
   configured): the before/after table and, where the data supports it, the
   costed tiered-access proposal
   ([constraint-impact/02 §2.4](../constraint-impact/02-model-policy-impact.md)).
6. **Calibration footnote**: outcome-detection agreement with manual labels,
   with n ([constraint-impact/03 §3.2 Gap 5](../constraint-impact/03-measurement-mechanics.md)).
7. **Methodology appendix, auto-generated**: pricing-table version and
   verification date (`packages/core/src/pricing.ts:39`), confidence-tier
   definitions, task-class definitions and classifier version, policy-event
   list, and the estimate-vs-actual language mode in effect. The appendix is
   generated from the same config/code that produced the numbers — it cannot
   drift from them.

Sections 1–3 alone are a complete monthly pack for a team with no policy
events; 4–6 attach as the corresponding features are enabled.

## 5.3 Rules

- **No number without provenance.** Every figure traces to a table in the
  document or the CSV bundle; the deep evidence (branch names, session
  detail) stays on the developer's machine — the pack carries ticket keys
  and aggregates, respecting the same boundary as the org plane
  ([03 §3.2](03-org-plane-and-backend.md)). The pack is an *outward-facing
  artifact*: generation runs the same sensitivity rules as sync, not the
  looser rules of the local dashboard.
- **Deterministic**: same store, same period, same config → identical pack.
  A regenerated pack that silently differs is a credibility incident.
- **The developer assembles it, section by section.** Each section is
  opt-in at generation time; the tool never produces a pack the developer
  hasn't reviewed. This is the two-plane principle applied to paper.
- **Estimate/actual language discipline**: plan accounts say "equivalent API
  cost" throughout; metered accounts say cost and show the reconciliation.
  Mixed-account teams get both, labeled.

## 5.4 Team packs

A single developer's pack is often statistically thin (small n per task
class). Two aggregation paths, in order of availability:

1. **Pooled exports, no backend**: each dev generates a machine-readable
   pack (`--json`); a local merge command combines them into a team pack —
   n improves, individual attribution dissolves into team totals unless every
   contributor opts into per-dev rows. This is the stepping stone that works
   today-shaped, before any org plane exists
   ([constraint-impact/03 §3.3](../constraint-impact/03-measurement-mechanics.md)).
2. **Org-plane data**, where ticket sync is enabled
   ([03](03-org-plane-and-backend.md)): the team dashboard renders the same
   sections continuously; the pack becomes its periodic snapshot export.

## 5.5 Surfaces and sequencing

CLI: `claude-stats pack --period 2026-07 [--sections ...] [--json]`.
MCP: `generate_justification_pack` with the same parameters, returning the
document path. Dashboard: a "Generate report" card that walks the section
opt-ins.

The pack slots into the roadmap after ticket-attribution phase 1 (it needs
the per-ticket table) and grows a section per feature phase — it is the
integration point, so each new analysis (hygiene, constraint impact,
[pricing-model comparison](../constraint-impact/04-pricing-model-comparison.md))
lands as "a new section in the pack" rather than a new artifact the
developer must discover.
