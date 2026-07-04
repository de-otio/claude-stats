# License Advisor — helping a company pick the right Claude plan

Investigation into a new claude-stats use case: a company stakeholder tells
their AI agent the characteristics of their company, and the agent uses
claude-stats' MCP tools to recommend which Claude plan to buy — Team or
Enterprise, how many seats, which seat tier, what spend limits — grounded in
real usage data instead of guesswork.

This is grounded in a real Claude-licensing sizing exercise, kept in a
private notes repository. Because this repo is public, no
company-identifying detail (name, headcount, internal tooling) is reproduced
anywhere in this folder — only the generalizable shape of the decision
problem and Anthropic's own publicly documented plan mechanics, cited inline.

## TL;DR

- **The individual half of this feature is already built and tested.**
  `buildDashboard()` computes a real plan recommendation
  (`recommendedPlan`, `currentPlanVerdict`) on every dashboard build, backed
  by real tests. It's computed on every `get_stats` MCP call today and then
  discarded before the response leaves the handler
  ([03](03-current-state-and-gaps.md)). The cheapest, highest-value change
  here is exposing data that already exists, not writing new logic.
- **The company half doesn't exist at all.** claude-stats has no concept of
  a seat, a seat range, an Enterprise plan, or more than one person. Nothing
  in the schema supports merging two developers' data
  ([03](03-current-state-and-gaps.md)).
- **Don't build one opaque "recommend our plan" tool.** Split deterministic
  arithmetic (seat math, cost projections — a tool, because it's more
  reliable than an agent's in-context arithmetic) from genuine judgment calls
  (does our compliance posture require Enterprise, how loosely should spend
  limits be set — left to the user, surfaced but never resolved by the tool)
  ([04](04-proposed-tools-and-workflow.md)).
- **There's a previously-designed team backend, and it isn't the shortcut it
  looks like.** It's real, substantial, unshipped code (CI's deploy jobs are
  still `echo` stubs) built for gamification — its aggregation produces
  averages for leaderboards, not the percentile distributions a licensing
  decision needs. Reuse its privacy and identity design, not its deployment,
  and only after cheaper phases prove there's demand for it
  ([05](05-reusing-the-team-backend.md)).
- **Plan-mechanics data will go stale**, the same way token pricing does —
  and unlike token pricing, an agent consuming it can independently check the
  live truth. The design leans on that: prefer a live lookup, fall back to a
  dated cache, and make the staleness a field in the payload, not just a code
  comment ([06](06-staleness-trust-and-privacy.md)).
- **Ship in four phases, cheapest first**, and stop before the backend unless
  real demand shows up: (0) expose already-computed data via MCP, (1) add
  Enterprise-plan awareness plus a sourced plan-mechanics reference and a
  skill, (2) a manual multi-developer export/aggregation workflow, (3) a real
  backend — last, and only on demonstrated need
  ([07](07-rollout-plan.md)).
- **The GUI story splits in two, and they must not share a tab.** The
  individual case already has a shipped dashboard tab worth extending; the
  company-scale case needs a separately-generated report, not a tab bolted
  onto the shared per-developer dashboard — that would leak a company's
  aggregate spend distribution into every individual developer's personal
  view ([08](08-dashboard-surface.md)).

## Reading order

| # | File | Contents |
|---|------|----------|
| 01 | [01-problem-and-use-case.md](01-problem-and-use-case.md) | The user story, why it's genuinely hard today, what "done" looks like, non-goals |
| 02 | [02-plan-mechanics-reference.md](02-plan-mechanics-reference.md) | Anthropic's plan mechanics distilled into a reusable, dated, sourced decision framework |
| 03 | [03-current-state-and-gaps.md](03-current-state-and-gaps.md) | What claude-stats already has (more than expected) vs. what's missing, with file:line citations |
| 04 | [04-proposed-tools-and-workflow.md](04-proposed-tools-and-workflow.md) | New/changed MCP tools, CLI commands, and the agent workflow that ties them together |
| 05 | [05-reusing-the-team-backend.md](05-reusing-the-team-backend.md) | How much of the existing, unshipped team-app backend this feature can reuse |
| 06 | [06-staleness-trust-and-privacy.md](06-staleness-trust-and-privacy.md) | Keeping plan-mechanics data from being presented as more current than it is; privacy guardrails for cross-person aggregation |
| 07 | [07-rollout-plan.md](07-rollout-plan.md) | The phased build order and why the backend comes last |
| 08 | [08-dashboard-surface.md](08-dashboard-surface.md) | What changes in the dashboard GUI, and why the company-scale view is a separate report, not a shared tab |

## Relationship to existing analysis

This feature depends on, and builds on, several existing analyses rather than
starting from nothing:

- [account-attribution/](../account-attribution/) is a **hard dependency**,
  not background reading: any cross-developer usage aggregation is only
  trustworthy once personal and work-account usage are correctly separated
  on each contributing machine. It has already shipped forward attribution.
- [team-app/](../team-app/) and [team-dashboard/](../team-dashboard/) are the
  prior "server-side backend for team stats" work referenced in
  [05](05-reusing-the-team-backend.md) — assessed here for reuse, not
  duplicated.
- [cost-per-successful-task/](../cost-per-successful-task/) supplies the "no
  verification theatre" standard this analysis holds its own tool proposals
  to: label a fact as a fact, an estimate as an estimate, and never let a
  proxy pass as a measurement.
