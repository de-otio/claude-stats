# 01 — The visibility gap

## 1.1 Cost is visible by default; value is visible only on purpose

The invoice is a push artifact: it arrives monthly, in finance's own systems, denominated in currency, requiring zero effort from its reader. Everything on the value side — which tickets the spend landed in, what a successful task costs, how clean the usage is, what a policy restriction cost — exists only inside a developer tool, on the developer's machine, rendered on demand. When budget pressure rises, the side that is visible by default wins the argument by default. [ticket-attribution/README](../ticket-attribution/README.md) already names the downstream effect: managers under ROI pressure pass it down as cut token budgets.

So "make business value as visible as possible" decomposes into four properties, none of which is a new metric:

| Property | Meaning | Today |
|---|---|---|
| **Surface** | The numbers appear in tools management already uses (spreadsheet, BI, Jira dashboards, a document in a review meeting) — not in a developer's VS Code panel | Pack HTML/CSVs exist but are hand-carried |
| **Cadence** | Value evidence arrives on the same rhythm as the invoice, without a human remembering to produce it | Nothing is scheduled ([§1.4](#14-where-todays-surfaces-fall-short)) |
| **Credibility** | A skeptical reader can check the math: confidence tiers, coverage denominators, invoice reconciliation | Strong — the pack's house style ([ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md): "why do you claim PROJ-123 cost €41?" must be answerable on screen) |
| **Grain** | Numbers keyed to business objects (ticket, project, kind of work, team), not tokens and cache hits | Strong locally (tickets, task classes, project fees); absent on the org plane (`projectId` hardcoded `null` — `packages/cli/src/org/aggregate.ts:228-230`) |

Credibility and grain are largely solved by the existing analysis stack. **Surface and cadence are the gap.**

## 1.2 What "value" can honestly mean here

The tool's defensible value story has four panels, all machine-owned, none fabricated:

1. **What the money bought** — spend attributed to tickets/projects/task classes with confidence and coverage (`get_cost_per_ticket`, the Tickets & Value tab, [project-fee-attribution/](../project-fee-attribution/) for client billing).
2. **What an outcome costs and its trend** — cost per successful task per model/class ([cost-per-successful-task/](../cost-per-successful-task/)); trends answer "is this getting more efficient?" without claiming a counterfactual.
3. **That it runs clean** — the hygiene ratio and its trend ([efficiency-hygiene/](../efficiency-hygiene/)): self-audited waste is the strongest credibility signal a budget defense can carry.
4. **What constraints cost** — [constraint-impact/](../constraint-impact/) makes the *other* side of a cut visible before it happens; two-sided by construction.

The fifth panel — business value proper (story points delivered, revenue, client outcomes) — lives in Jira/OKR/finance systems and **must stay there**; claude-stats supplies the join key (ticket) and the joinable rows, per the ratified stance in [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md).

## 1.3 Who "management" is, and what each actually decides

Three personas, already characterized across the design corpus, each with a different decision and therefore a different artifact:

| Persona | Decision | Artifact shape | Grain & consent regime |
|---|---|---|---|
| **Team lead / EM** | Renew or trim the team's usage; defend the line item; set internal policy (model tiers, budgets) | Monthly pack per dev (bottom-up, dev-generated) + team-level ticket sums | Per-ticket rows are one person's work — consent-gated by share level, never k-anonymized into pseudo-safety ([ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md)) |
| **Finance / controlling** | Reconcile spend, allocate to projects/clients, approve budgets | CSV rows that load into their spreadsheet/BI; invoice reconciliation as a first-class column | Cohort/team aggregates only; the pack reader is "a finance stakeholder with fifteen minutes… and an active suspicion that the numbers are advocacy" ([ticket-attribution/05](../ticket-attribution/05-justification-pack.md)) |
| **IT / procurement / founder** | "What should we buy" — plan, seats, tiers, spend limits | License-advisor standalone HTML from aggregated exports; percentile *distributions*, not means ([license-advisor/05](../license-advisor/05-reusing-the-team-backend.md)) | Cohort aggregates, min-cohort-size gates, separate consent from leaderboards ([license-advisor/06](../license-advisor/06-staleness-trust-and-privacy.md)) |

One invariant crosses all three, and it is the repo's sharpest design stance: the visibility flow is **bottom-up** — the developer generates and hands over the evidence — never a manager pointing a query at an individual's usage. The org plane makes this "technically impossible, not just policy-discouraged" ([license-advisor/06](../license-advisor/06-staleness-trust-and-privacy.md); the wire shape has no field capable of carrying content, [team-sync.md](../../user-doc/team-sync.md)). Any BI answer must preserve this direction.

## 1.4 Where today's surfaces fall short

Inventory from direct code inspection (2026-08):

- **The flagship export isn't BI-ready.** `claude-stats export --format csv` (`packages/cli/src/cli/index.ts:802`) emits session-grain rows with **no cost column**, no models/tools, stdout-only (no `--out`), and naive CSV quoting that a quote character in a project path would break (`cli/index.ts:831-840`). A finance stakeholder cannot load this and answer anything about money.
- **Cost exists only in TypeScript.** Pricing lives in `@claude-stats/core/pricing`, not in the SQLite DB — anyone querying `~/.claude-stats/stats.db` directly (the natural BI path; 16 well-shaped tables in `packages/cli/src/store/index.ts`) must reimplement the cost model, including the cache-TTL correction. Guaranteed divergence.
- **Nothing runs on a schedule.** `precompute --install-cron` only prints a crontab snippet and only warms the recap cache (`cli/index.ts:1374-1409`). No monthly pack, no export, no delivery. Cadence — the property the invoice has and value evidence lacks — is entirely manual today.
- **MCP is an agent API, not a BI contract.** All 18 tools return JSON-stringified text blocks with no `outputSchema`/`structuredContent` (`packages/cli/src/mcp/index.ts:90-94`); shapes are documented in prose. Fine for Claude-as-analyst; not a contract an external tool can bind to.
- **The org plane carries too little grain for team-level value.** Live sync is one row per user per UTC day, all projects summed, `projectId: null` hardcoded (`org/aggregate.ts:260,317-333`); the cohort-shaped projection with k-anonymity fields exists but is dead code (`org/aggregate.ts:119`, referenced only by its test). The ticket-sum sync specced in [ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md) is design-only.
- **The team webapp is not a management surface.** The rich team-dashboard Lambda (leaderboard, team aggregate, k-anon gate, share-level filter — `packages/infra/lambda/api/team-dashboard.ts`) is written but has **no resolver wired** (absent from `infra/lib/stacks/api-stack.ts` resolver tables), and roughly half the SPA's hooks return hardcoded mock data (`packages/frontend/src/hooks/useApi.ts`). What a deployed instance actually shows a team lead: a member roster with weekly prompts/cost/velocity/streak per member, honoring share level. Gamification-adjacent, not budget-defense.
- **Report/GUI/export drift is unguarded.** [gui-redesign/README](../gui-redesign/README.md) states the pack "is the export of the Insights layer… must not drift", but the numbers are defined in three places (insight cards, pack builder, CSV renderers) with no single metric definition they all consume.

[02](02-bi-component-assessment.md) evaluates the "BI component" idea against this backdrop; [03](03-bi-bridge-design.md) designs what should exist instead.
