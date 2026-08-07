# Ticket attribution — token cost per Jira ticket

> AI costs in orgs are rising and managers are under pressure to measure ROI.
> That pressure is passed down to developers — sometimes as cut token budgets —
> because the value of the investment is not visible. Attributing token usage to
> a ticket is one step toward better analysis and toward developers being able
> to justify their usage to management. The more accurate, the better.

This folder designs that feature end to end: how a session's spend gets
attributed to a ticket key locally (the accuracy ladder), what changes in the
local store, what changes in the org plane and backend so teams can automate
the reporting, and what an honest report looks like — including the parts of
spend that legitimately map to no ticket.

## Who this is acute for

The problem is mild on flat-rate seat plans (Team/Max), where the marginal
token costs nothing and "cost" is a counterfactual API-equivalent
(`packages/core/src/pricing.ts:1-4` says so explicitly). It is acute in larger
organizations on **Claude Enterprise pricing or the Bedrock Claude API**, where
every token is a metered dollar on a real invoice — on Bedrock, a line item in
the AWS bill, inside orgs with FinOps tooling and a cost-cutting reflex. Two
consequences shape the design:

- **For metered accounts, the numbers here are actual money, not estimates** —
  which makes them *reconcilable*: the bottom-up per-ticket sum should match
  the invoice (Cost Explorer for Bedrock), and a report that reconciles
  against the bill is un-dismissable. AWS-side decomposition (application
  inference profiles, cost-allocation tags) stops at team/app granularity;
  this feature is the layer beneath it.
- **Prerequisite gap**: `lookupPricing` matches `startsWith("claude-…")`
  (`pricing.ts:63`), so Bedrock model ids (`us.anthropic.claude-…-v1:0`) price
  as unknown/zero today. Model-id normalization for Bedrock/Vertex, and a
  metered-vs-plan account mode (plan-fee logic off, "actual cost" language
  on), come before everything else for this audience.

## The one-paragraph conclusion

Cost per ticket is achievable with mostly-existing machinery: cost is already
computable for any arbitrary message set, git branch and sanitized prompt text
are already captured, and a tagging substrate already exists. The feature is an
**attribution layer** — extract ticket keys from branch names, commit subjects,
and prompts; grade every attribution by evidence; and expose a coverage figure
("83% of this month's spend is ticket-attributable") alongside the per-ticket
numbers, because a report that force-maps everything is a report that gets
discredited by its first wrong row. On the org side, the ticket dimension must
travel as a **new, separate narrow aggregate shape** (never a widening of the
existing one — the "no free text crosses the wire" guarantee is structural and
stated in four places), it lands in a **new DynamoDB table** (the deployed
`UserAggregates` key `(userId, period)` cannot hold a second grain), and we
must be honest that per-ticket data is per-developer data: k-anonymity is
meaningless at ticket granularity, so the gate is explicit developer opt-in
plus team share-level, not cohort thresholds.

## The core design choices (decide these first)

| # | Choice | Recommendation | Where argued |
|---|--------|----------------|--------------|
| 1 | Attribution unit | Message ranges within a session, graded by evidence; session-level as the fallback grain | [01](01-attribution-signals.md) |
| 2 | Where ticket links live locally | New `ticket_links` table, not `session_tags` (tags lack source/confidence and lowercase-validate) | [02](02-local-data-model.md) |
| 3 | Branch fidelity | Add per-message `git_branch`; today branch is captured once per session and mis-attributes after a switch | [02](02-local-data-model.md) |
| 4 | Wire shape to the org plane | New `TicketAggregateSyncInput` + mutation; pattern-validated key, no free text; never widen `AggregateSyncInput` | [03](03-org-plane-and-backend.md) |
| 5 | Backend storage | New `UserTicketAggregates` table `(userId, period#ticketKey)`; do not overload `UserAggregates` | [03](03-org-plane-and-backend.md) |
| 6 | Ticket-key visibility server-side | Readable keys, as an explicit team-policy + per-user opt-in (hashing defeats the Jira join, which is the point) | [03](03-org-plane-and-backend.md) |
| 7 | Privacy gate | Developer opt-in + `ShareLevel`, not k-anonymity — a ticket is usually one developer's work | [03](03-org-plane-and-backend.md) |
| 8 | The Jira join | claude-stats owns cost keyed by ticket; value data (story points, cycle time) joins on the user's side — no Jira calls from store or backend | [04](04-reporting-and-roi.md) |
| 9 | Report shape | Confidence-tiered totals + coverage % + a non-ticket-work breakdown, never a single unqualified number | [04](04-reporting-and-roi.md) |

## How the pieces relate

```
 local machine                                        org backend
┌─────────────────────────────────────────┐          ┌──────────────────────────┐
│ transcripts → parser → stats.db         │          │ AppSync + DynamoDB       │
│                          │              │          │                          │
│   extraction pass        ▼              │  opt-in  │ UserAggregates (today)   │
│   (branch/commit/prompt) ticket_links ──┼──────────► UserTicketAggregates(new)│
│                          │              │  sync    │        │                 │
│   messages × pricing ────┴─► cost per   │          │        ▼                 │
│                             ticket +    │          │ team rollup + dashboard  │
│                             coverage    │          │ export for Jira join     │
└─────────────────────────────────────────┘          └──────────────────────────┘
```

## Documents

| # | File | Contents |
|---|------|----------|
| 01 | [01-attribution-signals.md](01-attribution-signals.md) | The accuracy ladder: which signals exist, how they rank, the coverage/denominator problem |
| 02 | [02-local-data-model.md](02-local-data-model.md) | Store schema changes, extraction pass, per-message branch, MCP surface, migration mechanics |
| 03 | [03-org-plane-and-backend.md](03-org-plane-and-backend.md) | Sync wire shape, backend tables/resolvers/rollups, the privacy analysis for per-ticket org data |
| 04 | [04-reporting-and-roi.md](04-reporting-and-roi.md) | What the report must look like to be believed; the Jira-side value join; invoice reconciliation; sequencing |
| 05 | [05-justification-pack.md](05-justification-pack.md) | The self-contained periodic artifact for managers who don't run the tool — the integration point for all the reporting features |

## Relationship to existing analysis

- **[value-per-cost/](../value-per-cost/) is the parent.** Its thesis — the
  machine owns the unit of cost, the user owns the unit of value — is exactly
  this feature's contract. Its `02-defining-business-result.md` marks "tickets
  close" as computable only via "an external signal the user wires in"; the
  ticket key **is** that signal, and the "frictionless value-tagging surface"
  its `06-what-to-build.md` calls for is naturally implemented as ticket
  linkage. Nothing of that surface is implemented yet.
- **[project-fee-attribution/](../project-fee-attribution/)** is the closest
  structural analogue (attribute a cost pool to user-declared units); its
  "join quality is the ceiling on accuracy" argument recurs here as the
  accuracy ladder.
- **[daily-recap/02-data-sources.md](../daily-recap/02-data-sources.md)**
  listed "Linear/Jira (task linkage)" as deferred; this folder un-defers the
  *linkage-by-key* part while keeping actual Jira API access out of scope.
- **[data-planes/](../data-planes/)** and
  **[05-privacy-security.md](../05-privacy-security.md)** bind the org-plane
  design; [03](03-org-plane-and-backend.md) works within their constraints and
  lists the required amendments to 05.
- `plans/10-session-tagging.md` built the tagging substrate this feature
  extends; `get_cost_per_task` (topic clusters) is a cousin, not a substitute —
  its "task" has no stable external identity.
