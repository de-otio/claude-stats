# 04 — Reporting, the ROI join, and sequencing

## 4.1 Cost per ticket is half of ROI — own that half well

Management pressure is about *value*, and value lives on the Jira side: story
points, cycle time, tickets closed per sprint. Following
[value-per-cost/](../value-per-cost/)'s split — the machine owns the unit of
cost, the user owns the unit of value — claude-stats' job is to make its half
**joinable**, not to compute ROI itself:

- The ticket key is the join key. Exports (`ticketCostExport` on the backend,
  `get_cost_per_ticket` / CSV locally) are shaped for a downstream join:
  `ticketKey, period, cost, tokens, confidence, sessionCount`.
- The join runs on the user's side: a spreadsheet, a BI tool, or an MCP client
  that is *also* connected to Atlassian and can answer "cost per story point"
  or "cost vs cycle time" across both sources. Neither the store nor the
  backend ever calls Jira ([02 §2.7](02-local-data-model.md),
  [03 §3.5](03-org-plane-and-backend.md)).
- This also implements the "value-tagging surface" that
  [value-per-cost/06-what-to-build.md](../value-per-cost/06-what-to-build.md)
  calls for: the ticket key is the value tag with the lowest possible
  friction, because for most developers it already exists in the branch name.

## 4.2 The report that survives a skeptical reader

The output format is as much of the design as the data model. Rules:

1. **Confidence tiers, always.** "€X attributed with high confidence, €Y
   medium, €Z low" — never one unqualified number. The tiers come straight
   from the ladder ([01 §1.2](01-attribution-signals.md)).
2. **Coverage headline, always.** "83% of the period's spend is
   ticket-attributable" sits above the table; its trend over time is shown.
   A per-ticket table without a denominator implies completeness it doesn't
   have.
3. **The remainder is explained, not hidden.** A "non-ticket work" breakdown
   (review, debugging, exploration, tooling — labels from the existing topic
   clustering) turns the gap from a weakness into part of the argument:
   overhead work is real work that no ticket captures.
4. **Ambiguity is visible.** Sessions with overlapping ticket evidence are
   marked, not silently split ([01 §1.3](01-attribution-signals.md)).
5. **Drill-down to evidence** (local surfaces only): ticket → sessions →
   the branch name / commit subject / tag that justified each link. The
   answer to "why do you claim PROJ-123 cost €41?" must be on screen.

The org dashboard renders the same shape one level up: team totals per
ticket, team coverage, and per-dev rows only where share levels allow
([03 §3.4](03-org-plane-and-backend.md)).

## 4.3 Reconciling against the invoice (metered accounts)

For Enterprise/Bedrock orgs the bottom-up numbers are actual money, which
makes them checkable — and a per-ticket report that visibly reconciles
against the bill is un-dismissable. The mechanics, respecting the store's
no-network posture (claude-stats never calls AWS):

1. **The invoice number enters by import**: a Cost Explorer CSV export (or a
   monthly total pasted into config) supplies the top-down figure. Where the
   org uses application inference profiles or cost-allocation tags for
   Bedrock decomposition, a small config mapping (`tag/profile → account or
   project`) aligns the two views' scopes.
2. **The comparison is scoped and tolerant**: same period, same account set,
   an explicit tolerance (default ±5%) below which the report states
   "reconciles with the invoice".
3. **The residual is named, never hidden**: non-Claude-Code API use, other
   tools sharing the Bedrock account, and pricing-table drift (the table
   carries its verification date, `packages/core/src/pricing.ts:39`) are the
   expected causes; the report lists the residual and its likely
   composition rather than absorbing it.
4. **The output is one line with a drill-down**: "bottom-up $4,150 vs
   invoice $4,205 → 98.7% reconciled" — and that line is what anchors every
   other number in the [justification pack](05-justification-pack.md).

## 4.4 What we deliberately do not build

- **No Jira API integration** in store or backend — key extraction only.
- **No LLM in the attribution path** — extraction is regex + allowlist,
  deterministic and auditable. (The LLM-judge pattern from cost-per-task
  outcomes stays where it is; attribution must be explainable row by row.)
- **No forced 100% attribution** — no "smart" splitting of ambiguous
  sessions, no assigning overhead to the nearest ticket.
- **No per-ticket data without consent** — ticket sync never rides silently
  on the existing org-sync opt-in ([03 §3.4](03-org-plane-and-backend.md)).

## 4.5 Sequencing

| Phase | Scope | Depends on |
|---|---|---|
| 0 | Bedrock/Vertex model-id normalization + metered-vs-plan account mode (actual-cost language, plan-fee logic off) | nothing — prerequisite for the acute audience ([README §Who this is acute for](README.md)) |
| 1 | `ticket_links` table + extraction pass (branch/commit/prompt) + `ticket` in both filter halves + `get_cost_per_ticket` MCP + report/CLI surface | nothing — local only, [02](02-local-data-model.md) |
| 2 | Per-message `git_branch` capture + bounded backfill + archive recommendation in setup | phase 1; moves bulk spend from medium to high confidence |
| 3 | Manual surfaces: `ticket` CLI verb, dashboard link/negate card, correction-action kind | phase 1; grows rung-1 data |
| 4 | Org plane: `TicketAggregateSyncInput` + mutation + client projection + opt-in flag | phases 1–2, [03 §3.2](03-org-plane-and-backend.md) |
| 5 | Backend: `UserTicketAggregates` + resolver + stream rollup + export query + dashboard section + 05 amendment | phase 4, [03 §3.3–3.6](03-org-plane-and-backend.md) |
| 6 | Invoice-reconciliation import (§4.3) + the [justification pack](05-justification-pack.md) as the integration artifact | phases 0–1 |

Phase 1 alone already answers the motivating question for a single developer
on a branch-per-ticket workflow; each later phase widens who can consume the
answer (the developer's manager, then the org) without ever changing what the
answer is made of: locally-computed, evidence-graded aggregates.
