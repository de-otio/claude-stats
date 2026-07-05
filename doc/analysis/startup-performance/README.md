# Dashboard startup performance

Why the VS Code dashboard takes seconds to paint after the
"Crunching your Claude Code history…" splash, why that time grows with
accumulated history, and what to do about it.

This is a **performance** analysis. (The sibling `../deep-analysis/`
folder is a product/feature analysis — different topic.)

## TL;DR

- The "Crunching…" splash wraps `DashboardPanel.refresh()`
  ([panel.ts:82](../../../packages/cli/src/extension/panel.ts)) — it is
  shown on **every** dashboard open and **every** period change, not just
  the first run. The "first time" wording in the splash copy is
  misleading; ingestion is already incremental, the recompute is not.
- The panel historically defaulted to `period = "all"`, so every open
  paid the **full-history worst case**.
- `buildDashboard()` re-derives all analytics from the **raw `messages`
  table** on each open, via **four-plus independent full-table passes**
  that each materialise every message row (~213k on the measured machine)
  into JS and iterate. Cost is **O(total lifetime messages)** and there is
  **no cache of derived aggregates** between opens.
- Even when a period filter *is* applied, the message queries filter on
  `sessions.first_timestamp` (the session's start), which the message
  indexes cannot prune — so SQLite scans the **entire** `messages`
  timestamp index regardless of period. There is a hard ~50 ms-per-query
  floor that grows linearly with lifetime message count.

## Measured impact (this machine, ~213k messages, 64 MB DB)

| `refresh()` period | wall time |
|---|---|
| day | **0.26 s** |
| week | 0.69 s |
| month | 1.95 s |
| all (old default) | **3.3 s** |

This climbs forever: every dashboard open re-reads your entire message
history from scratch.

## What shipped already

- **Default period changed `"all"` → `"day"`**
  ([panel.ts:27](../../../packages/cli/src/extension/panel.ts)). First
  paint drops from ~3.3 s to ~0.26 s on this machine, and — crucially —
  the cost no longer scales with the full history on the common path.
  Users widen the window on demand.

This is the cheap, high-leverage mitigation. It does **not** fix the
underlying O(lifetime) architecture; it just stops the default path from
hitting it. See `03-remediation-plan.md` for the structural fixes.

The structural fix is **in-DB aggregation**, not a maintained rollup
table. A SQL `GROUP BY` over the entire history computes the additive
metrics in ~100 ms — less than the time to merely fetch the raw rows for
one of the four current JS passes — with no maintenance surface and no
fixed group-by lock-in. A persisted rollup is deferred until that scan is
measured to be the wall. The future arbitrary-period feature reinforces
this: lead with in-DB aggregation, constrain the picker to date
granularity, and — if a rollup is ever needed — use an hourly UTC grain
(the only grain exact across timezones and arbitrary ranges). Details and
the additive-vs-non-additive split are in `03-remediation-plan.md`.

## Documents

- [`01-methodology-and-measurements.md`](01-methodology-and-measurements.md)
  — how the numbers were obtained, full per-stage attribution, raw timings.
- [`02-root-cause-architecture.md`](02-root-cause-architecture.md)
  — why it is slow and why it scales badly: the multi-pass recompute, the
  un-prunable scan, the missing aggregate layer.
- [`03-remediation-plan.md`](03-remediation-plan.md)
  — ordered fixes by ROI, from the one-line default to a materialised
  rollup table, each with expected effect and effort.

## Reproducing

All timings are from `tsx` micro-benchmarks run against the live
`~/.claude-stats/stats.db` with a warm OS page cache, steady-state
(post-JIT) iterations. Method and scripts are in
`01-methodology-and-measurements.md`. Numbers are illustrative of the
*shape* of the cost (linear in lifetime messages); absolute values track
your own history size.
