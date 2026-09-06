# 04 — Recommendation and rollout

## Recommendation

**Build the bridge and the cadence, not a BI product.** claude-stats' answer to rising justification pressure is to be the *credible, joinable, self-delivering cost-and-efficiency half* of the value story: catalog-governed metrics, business-grain exports with cost in them, a pack that generates itself on month close, and consent-preserving paths for team rollup — while the join to business value happens in management's own tools, where the value data lives. An in-product BI/analytics suite is rejected (wrong side of the join, competed ground, privacy-invariant conflict, and the codebase's own team-app history as evidence — [02 §2.1](02-bi-component-assessment.md)).

## Phased rollout (each phase independently useful)

### Phase 1 — Make the exports worth importing · small
- `claude-stats export`: add `estimated_cost` + pricing-basis columns, `--out`, RFC-4180 quoting ([03 §3.2](03-bi-bridge-design.md)).
- Promote pack CSVs to `export --grain ticket|project|task-class|day` with `--redacted`.
- Fix the stale `generate_justification_pack` MCP description; flip `hygiene`/`constraint` pack sections to default-on.
- i18n for any new user-facing strings across all locales (project rule).

### Phase 2 — Metric catalog · medium, unlocks everything after
- `packages/core/src/metrics/` typed catalog; migrate insight cards, pack builder, CSV renderers onto it; generate `METRICS.md` and the pack Methodology from it; `metric_version` columns in exports ([03 §3.1](03-bi-bridge-design.md)).
- Acceptance test: the same figure rendered by the GUI, the pack, and an export comes from one definition — drift becomes a type error, not a review comment.

### Phase 3 — Cadence · small-medium, highest visibility leverage
- Extension-resident month-close scheduler producing pack + exports into `~/.claude-stats/reports/<YYYY-MM>/`, notification in the extension; upgraded (consented) cron/launchd install for CLI-only users ([03 §3.3](03-bi-bridge-design.md)).
- Add the trend spine and "what would change this number" lines to the pack ([03 §3.4](03-bi-bridge-design.md)).

### Phase 4 — Team collation, file-based · medium
- `pack --merge` over handed-over redacted exports → one team pack on the lead's machine ([03 §3.5](03-bi-bridge-design.md)). No backend change; consent = handover.

### Phase 5 — Structured MCP + direct-DB surface · medium
- `outputSchema`/`structuredContent` on the value-facing MCP tools from the catalog ([03 §3.6](03-bi-bridge-design.md)).
- `bi_` SQL views over materialized cost columns as the supported direct-query surface; document everything else as unstable ([03 §3.2](03-bi-bridge-design.md)).
- The snapshot warehouse ships in **DuckDB format** (decision rationale and Superset constraints in [05](05-superset-integration.md)).

### Phase 5b — Superset reference integration · small-medium, after Phase 2
- Catalog-generated Superset asset bundle (datasets, metrics, per-persona dashboards with caveats embedded) + documented docker-compose recipe; bundle pinned to a tested Superset version with a CI import check ([05](05-superset-integration.md)).

### Phase 6 — Org-plane ticket sums · large, demand-gated
- Only on demonstrated pull from Phase-4 users: the [ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md) sync + `ticketCostExport`, share-level-gated; revive the cohort/k-anonymity projection (`org/aggregate.ts:119`) only here.

## Non-goals (standing)

- **No in-product BI suite / team analytics webapp revival** for this purpose; the undeployed team-dashboard Lambda and mock SPA pages stay parked unless the gamification product finds its own justification.
- **No automatic push of reports to managers** — generation is scheduled, delivery is a human act; the bottom-up consent flow is an invariant.
- **No composite ROI score, no fabricated value numbers, no Jira API integration** — the ratified rejections ([value-per-cost/](../value-per-cost/), [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md), [human-time-saved/](../human-time-saved/)) all bind here.
- **No widening of the org-plane wire shape with free text**, ever — new team-visible data means new pattern-validated typed fields with their own consent gate.

## Open questions

1. **Where does the catalog draw its line?** Everything in the pack must come from it; do the 28-chart guru surfaces also migrate, or are they exempt as exploratory (and marked unstable)? Leaning: pack + insights + exports mandatory, guru charts exempt but labeled.
2. ~~**Snapshot DB vs live-DB views** for the direct-query surface~~ — **resolved in [05](05-superset-integration.md)**: snapshot, in DuckDB format, produced with the scheduled monthly run (Superset blocks SQLite connections by default, and a snapshot avoids lock contention and migration-churn exposure).
3. **Fee attribution in the ticket grain** — `--grain ticket` currently implies token-cost only; should the project fee share ([project-fee-attribution/](../project-fee-attribution/)) be allocatable down to tickets, or is that false precision? Needs its own note before Phase 1 freezes columns.
4. **Anthropic Console overlap watch** — Console already exports per-member CSVs and may grow attribution features; the bridge's moat is local grain + honesty columns + the join contract. Revisit [differentiation/](../differentiation/) if Console ships ticket-level attribution.
5. **Does the extension scheduler need workspace trust / user consent UX** beyond a setting? (It writes files on a timer; probably a one-time opt-in toast is enough, but check VS Code guidelines.)
