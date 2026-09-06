# Business-value visibility — making the value side as visible as the invoice

## The one-paragraph conclusion

As AI spend grows, the pressure to justify it grows with it — and the structural problem is an **asymmetry of visibility**: cost is visible to management by default (the invoice arrives monthly, in their tools, at their cadence, in currency), while what the spend *bought* is invisible unless someone does work to surface it. claude-stats cannot close this gap by computing business value itself — that was examined and rejected twice ([value-per-cost/](../value-per-cost/): machine owns cost, user owns value; [human-time-saved/](../human-time-saved/): even the honest FTE join declined). What it *can* do is make its half of the value story land where management already looks, at the cadence management operates, in a form management can trust: spend attributed to business objects (tickets, projects, kinds of work) with honest uncertainty, the efficiency/clean-hands posture, and the cost of policy constraints. The right vehicle is a **BI bridge, not a BI component**: versioned metric contracts, business-grain exports with cost materialized, scheduled generation of the justification pack, and consent-preserving team rollups — feeding the spreadsheets, BI tools, and review meetings where value data (Jira, OKRs, finance) already lives. Building an in-product BI/analytics suite would put claude-stats on the wrong side of the join, in competition with Anthropic's Console and org-scale engineering-intelligence platforms, and against its own privacy invariants. The current export surfaces are not yet up to even the bridge job — the flagship CSV export has no cost column and nothing generates on a schedule — so the gap is real and cheap to close.

## Relationship to existing analysis

- [value-per-cost/](../value-per-cost/) supplies the governing split (machine-owned cost/efficiency vs user-owned value) and the five business questions; this folder is about *distribution*: getting those answers in front of management, not changing them.
- [ticket-attribution/](../ticket-attribution/) defined the join contract ("the join runs on the user's side: a spreadsheet, a BI tool, or an MCP client") and the justification pack; this folder generalizes that stance into the product's reporting strategy.
- [human-time-saved/](../human-time-saved/) (not pursued) is the boundary marker: visibility must not become fabrication.
- [gui-redesign/](../gui-redesign/) owns the in-tool Insights surface; the rule "the pack is the export of the Insights layer — the GUI and the pack must not drift" becomes the metric-catalog requirement here.
- [data-planes/](../data-planes/), [team-app/](../team-app/), [license-advisor/](../license-advisor/) set the privacy and consent constraints any manager-facing rollup must satisfy — k-anonymity, consent-gated ticket grain, anti-surveillance as a structural guarantee.
- [efficiency-hygiene/](../efficiency-hygiene/) and [constraint-impact/](../constraint-impact/) supply the "we run it clean" and "here is what your policy costs" halves of the budget-defense narrative.

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-the-visibility-gap.md](01-the-visibility-gap.md) | The cost/value visibility asymmetry, the three management personas and their decisions, and where today's surfaces fall short |
| 02 | [02-bi-component-assessment.md](02-bi-component-assessment.md) | Would a "business intelligence" component make sense? Three interpretations assessed; verdict: bridge, not component |
| 03 | [03-bi-bridge-design.md](03-bi-bridge-design.md) | The bridge: metric catalog, business-grain exports, scheduled generation, consent-preserving delivery paths |
| 04 | [04-recommendation-and-rollout.md](04-recommendation-and-rollout.md) | What to build in what order; explicit non-goals; open questions |
| 05 | [05-superset-integration.md](05-superset-integration.md) | Apache Superset as the reference BI consumer: DuckDB snapshot warehouse + catalog-generated asset bundle + deployment recipe — no custom connector needed |
