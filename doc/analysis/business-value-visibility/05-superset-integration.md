# 05 — Apache Superset as the reference BI consumer

Superset is the natural first concrete target for the bridge of [03](03-bi-bridge-design.md): open-source, self-hosted, no SaaS data egress — the same posture as the self-hosted org plane, and the BI tool a team that already deploys claude-stats' CDK stacks would plausibly run. This note pins down what "a Superset integration" should and should not mean.

## 5.1 A connector is not the missing piece

Superset connects to anything with a SQLAlchemy dialect; it does not have (or need) per-product "connectors" the way SaaS BI tools do. Writing a Superset plugin/connector for claude-stats would be solving the wrong side: **the missing piece is on our side** — a SQL-queryable artifact with a stable schema and cost materialized ([01 §1.4](01-the-visibility-gap.md): pricing lives only in TypeScript today). Once that exists, Superset needs zero claude-stats-specific code to *connect*. What claude-stats can usefully ship on top is pre-built semantics (datasets, metric definitions, dashboards) so the first dashboard a team sees is a caveat-carrying one, not a hand-rolled uncaveated chart.

## 5.2 Verified constraints (2026-08-12)

- **SQLite data connections are blocked by Superset by default.** `PREVENT_UNSAFE_DB_CONNECTIONS` (default true) rejects sqlite URIs because a file-path connection can read the server's local files — including Superset's own metadata DB; bypasses of exactly this guard were CVE-2023-39265. Consequence: **"point Superset at `~/.claude-stats/stats.db`" is not a shippable recipe**, and disabling the guard must never be our documented advice. ([Superset security docs](https://superset.apache.org/admin-docs/security/), [CVE-2023-39265](https://www.sentinelone.com/vulnerability-database/cve-2023-39265/), [discussion #29551](https://github.com/apache/superset/discussions/29551))
- **DuckDB is the supported file-based path.** Superset carries an official DuckDB engine spec ([`db_engine_specs/duckdb.py`](https://github.com/apache/superset/blob/master/superset/db_engine_specs/duckdb.py)); connection is `duckdb:///path/to/file.duckdb` after adding `duckdb` + `duckdb-engine` to the Superset image. DuckDB is also simply the better analytics engine for this shape of data (columnar, painless aggregation over exports, reads Parquet/CSV natively).
- Superset dashboards/datasets/metrics are exportable/importable as a versioned asset bundle (ZIP of YAML) via UI, CLI, and API — the vehicle for shipping pre-built semantics.

## 5.3 The design: warehouse + bundle + recipe

Three deliverables, all downstream of the metric catalog ([03 §3.1](03-bi-bridge-design.md)):

1. **The snapshot warehouse, in DuckDB format.** This resolves [04 open question 2](04-recommendation-and-rollout.md) in favour of *snapshot*: the scheduled monthly run ([03 §3.3](03-bi-bridge-design.md)) additionally writes `~/.claude-stats/reports/<YYYY-MM>/claude-stats.duckdb`, containing the `bi_` views' contents at business grain (ticket / project / task-class / day) **with cost, confidence, coverage, and `metric_version` as columns**. For the team case, the warehouse builder runs over a directory of handed-over redacted exports (the `pack --merge` input of [03 §3.5](03-bi-bridge-design.md)) — the warehouse is built *from consented artifacts*, never by reaching into anyone's live DB.
2. **A Superset asset bundle, generated from the metric catalog.** Datasets = the warehouse tables; Superset metric definitions = catalog entries (same names, same definitions, `metric_version` surfaced); one pre-built dashboard per management persona of [01 §1.3](01-the-visibility-gap.md) (budget-defense view, project/client allocation view, plan-fit view), each chart carrying its caveat (coverage %, confidence mix, calibration state) as a subheader — so the path of least resistance is the honest chart. Generated, not hand-maintained: the bundle is another catalog renderer, alongside the pack and `METRICS.md`.
3. **A deployment recipe, not a deployment.** Documented docker-compose extension (official Superset image + `duckdb-engine`, warehouse file mounted read-only) for the team lead who wants it. claude-stats does not host, embed, or manage Superset.

## 5.4 Boundaries

- **The flow direction is unchanged:** exports are generated and handed over by developers; the warehouse aggregates what was consented; Superset reads the warehouse. No live connection from an org Superset to an individual's machine or DB — that would be the surveillance inversion the org plane exists to prevent ([01 §1.3](01-the-visibility-gap.md)).
- **Tool-agnostic core, one reference target.** The warehouse serves Metabase, Grafana, Excel/Power Query, or a pandas notebook identically; only deliverable 2 is Superset-specific, chosen because Superset's open-source/self-hosted posture matches the product's. If bundle maintenance proves costly (asset-format churn across Superset versions), the fallback is documented SQL + screenshots, and deliverables 1 and 3 stand alone.
- **Pin and test, don't chase:** the bundle declares the Superset version it was generated for; a CI job that imports the bundle into that pinned version catches format drift. Supporting "whatever Superset the org runs" is explicitly out of scope.
- The join to business value still happens in Superset *on the org's side*: they connect their Jira/finance data as further Superset datasets and join on `ticketKey`/project — claude-stats ships its half joinable and stops there, per [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md).

## 5.5 Sequencing

Deliverable 1 folds into Phase 5 of [04](04-recommendation-and-rollout.md) (it *is* the snapshot-DB option, format now chosen); deliverables 2–3 form a new **Phase 5b**, gated on the metric catalog (Phase 2) existing — generating Superset metrics from prose-defined metrics would freeze today's drift into an external contract. Nothing here needs the org plane; it works entirely on the file-based collation path.
