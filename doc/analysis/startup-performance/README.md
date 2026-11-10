# Dashboard startup performance

Why the VS Code dashboard takes seconds to paint after the
"Crunching your Claude Code history…" splash, why that time grows with
accumulated history, and the structural design that addresses it.

This is a **performance** analysis, not a product or feature analysis.

## TL;DR

- The "Crunching…" splash wraps `DashboardPanel.refresh()`
  ([panel.ts:82](../../../packages/cli/src/extension/panel.ts)) — it is
  shown on **every** dashboard open and **every** period change, not just
  the first run. The "first time" wording in the splash copy is
  misleading; ingestion is already incremental, the recompute is not.
- The panel historically defaulted to `period = "all"`, so every open
  paid the **full-history worst case**. Defaulting to a short period removes
  the dominant term on the common path but does not fix the underlying
  architecture.
- `buildDashboard()` re-derives all analytics from the **raw `messages`
  table** on each open, via **four-plus independent full-table passes**
  that each materialise every message row into JS and iterate. Cost is
  **O(total lifetime messages)** and there is **no cache of derived
  aggregates** between opens.
- Even when a period filter *is* applied, the message queries filter on
  `sessions.first_timestamp` (the session's start), which the message
  indexes cannot prune — so SQLite scans the **entire** `messages`
  timestamp index regardless of period. There is a hard per-query floor that
  grows linearly with lifetime message count.

## Shape of the cost

Illustrative: on a store of a few hundred thousand messages, a `day` refresh
is a fraction of a second, a `week` and a `month` refresh take progressively
longer, and an `all` refresh takes several times the `day` figure. This climbs
forever: every dashboard open re-reads the entire message history from scratch.

## The structural fix

The fix is **in-DB aggregation**, not (first) a maintained rollup table. A SQL
`GROUP BY` over the entire history computes the additive metrics in far less
time than merely fetching the raw rows for one of the four current JS passes,
with no maintenance surface and no fixed group-by lock-in. A persisted rollup is
deferred until that scan is the wall. The arbitrary-period feature reinforces
this: lead with in-DB aggregation, constrain the picker to date granularity,
and — if a rollup is ever needed — use an hourly UTC grain (the only grain exact
across timezones and arbitrary ranges). Metrics that are not additive (turn
classification, per-session token trajectory) move to ingest-time derived tables
instead.

## Documents

- [`02-root-cause-architecture.md`](02-root-cause-architecture.md)
  — why it is slow and why it scales badly: the multi-pass recompute, the
  un-prunable scan, the missing aggregate layer.
- [`05-rollup-design.md`](05-rollup-design.md)
  — the persisted hourly rollup for additive metrics: schema, maintenance
  strategy, read path, correctness gate, and the period-axis decision.
- [`06-ingest-derived-tables-design.md`](06-ingest-derived-tables-design.md)
  — non-additive metrics computed once at ingest into per-session derived
  tables, and the constraints that make that correctness-sensitive.

## Reproducing

Timings of this kind come from `tsx` micro-benchmarks run against a real
`~/.claude-stats/stats.db` with a warm OS page cache, steady-state (post-JIT)
iterations. Numbers are illustrative of the *shape* of the cost (linear in
lifetime messages); absolute values track your own history size.
