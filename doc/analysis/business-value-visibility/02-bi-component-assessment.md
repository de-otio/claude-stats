# 02 — Would a "business intelligence" component make sense?

"BI component" can mean three different products. They fare very differently against the constraints established in [01](01-the-visibility-gap.md).

## 2.1 Interpretation A — claude-stats becomes a BI tool

An in-product analytics suite: team dashboards, slice-and-dice charts, OLAP-style exploration over org usage, maybe a hosted multi-team web app. This is what "add a BI component" most naturally suggests, and it is the wrong investment, for five independent reasons:

1. **It sits on the wrong side of the join.** Business value data — story points, cycle times, OKRs, client revenue, invoices — lives in Jira, the tracker, the ERP, the finance warehouse. It will never live inside claude-stats, and the repo has ratified that it must not (no Jira API, no value computation — [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md)). A BI tool that can only see the cost half of the join cannot show business value, no matter how good its charts are. The join has to happen where the value data is.
2. **The competition already owns that ground.** Anthropic's Console ships org usage, spend limits, per-member CSV export, accept-rate metrics for Team/Enterprise ([differentiation/01](../differentiation/01-landscape.md)); Faros, Jellyfish, LinearB and the other engineering-intelligence platforms sell exactly "AI spend joined to delivery metrics" at org scale ([value-per-cost/05](../value-per-cost/05-prior-art-and-whitespace.md)). The differentiation analysis rated "team dashboard (multi-user)" **Hard / Low value — "enterprise users already have Anthropic Console"** ([differentiation/03](../differentiation/03-gaps-and-opportunities.md)). claude-stats' whitespace is the local, per-unit, coverage-honest layer those platforms can't reach — not a fourth org dashboard.
3. **The privacy invariants forbid the grain BI wants.** Interactive BI lives on drill-down; the org plane is built to make drill-down to an individual structurally impossible (per-user/day aggregates with no content-capable field, k-anonymity gates, consent-tiered ticket visibility — [data-planes/](../data-planes/README.md), [ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md)). An org-side BI component would be under permanent pressure to widen the wire shape — the exact thing the design forbids ("widening the aggregate wire shape with free text is off the table").
4. **The implementation evidence points the same way.** The team webapp half of the codebase — the one BI-shaped thing ever attempted — is the least-finished part of the product: undeployed dashboard Lambda, mock-driven SPA pages, placeholder prod config ([01 §1.4](01-the-visibility-gap.md)). That is not an accident of time; it is the low-pull feature confirming the differentiation call.
5. **Verification-theatre risk.** A BI surface invites composite tiles ("AI ROI: 87/100"), which the repo explicitly bans ([gui-redesign/02](../gui-redesign/02-answer-first-ia.md): "five honest sentences beat one manufactured number").

**Verdict: no.** Do not build charts for managers inside claude-stats, and do not revive the hosted team analytics app for this purpose.

## 2.2 Interpretation B — a BI *bridge*: claude-stats as a first-class data source

Everything a BI ecosystem needs from a data *source*: stable, versioned, documented metric contracts; business-grain exports with cost materialized; scheduled generation; clean semantics (every number carrying its confidence/coverage columns). The manager's own spreadsheet, Power-BI-alike, or an MCP-connected agent does the join to value data.

This is **already the repo's implicit strategy**, stated in fragments and never consolidated:

- "The join runs on the user's side: a spreadsheet, a BI tool, or an MCP client also connected to Atlassian" — [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md).
- The pack's CSV bundle exists "for the reader who wants to check the math or **feed a BI tool**" — [ticket-attribution/05](../ticket-attribution/05-justification-pack.md).
- The backend export query `ticketCostExport(teamId, period)` is specced "shaped for the Jira join" — [ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md).
- License-advisor's company path is an **export-and-collate** flow producing a standalone HTML report, backend explicitly sequenced last ([license-advisor/07](../license-advisor/07-rollout-plan.md)).

What's missing is treating this as a product surface with a contract, rather than a by-product of the pack ([01 §1.4](01-the-visibility-gap.md) lists the concrete shortfalls: cost-less export CSV, TypeScript-only pricing, no schedule, prose-only MCP shapes).

**Verdict: yes — this is the BI component that makes sense.** Design in [03](03-bi-bridge-design.md).

## 2.3 Interpretation C — opinionated management artifacts (reports as product)

Not interactive BI, but generated documents aimed at a named reader and decision: the justification pack (monthly, finance-skeptic reader), the license-advisor HTML (procurement, plan decision), the constraint-impact report (policy owner, tiering decision). This is where claude-stats is genuinely differentiated: no competitor produces a coverage-honest, invoice-reconciled, caveat-carrying budget-defense document ([differentiation/02](../differentiation/02-feature-matrix.md)).

**Verdict: yes — keep investing; this is the "surface" half of visibility.** The marginal improvements are cadence (scheduled generation) and completeness (the four value panels of [01 §1.2](01-the-visibility-gap.md) in one document), not new document types. Covered in [03](03-bi-bridge-design.md) §3.4.

## 2.4 The shape of the answer

```
                    ┌────────────────────────────────────────────┐
                    │  MANAGEMENT'S OWN SURFACES                 │
                    │  spreadsheet · BI tool · Jira dashboards   │
                    │  review meeting · finance systems          │
                    │        ▲ join to value data happens HERE   │
                    └────────┬───────────────────┬───────────────┘
      artifacts (push, C)    │                   │   joinable rows (pull, B)
   pack.html · advisor.html  │                   │   tickets.csv · summary.csv
   scheduled, dev-generated  │                   │   bi views / stable MCP shapes
                    ┌────────┴───────────────────┴───────────────┐
                    │  claude-stats: the credible cost half      │
                    │  attribution · outcomes · hygiene ·        │
                    │  constraint impact · reconciliation        │
                    └────────────────────────────────────────────┘
```

A BI **component** (Interpretation A) would try to move the top box inside the bottom box. The bridge (B) + artifacts (C) accept the boundary and invest in the arrows — which is where the visibility gap actually is.
