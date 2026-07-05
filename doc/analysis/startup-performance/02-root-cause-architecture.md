# Root cause: the architecture, not the data volume

The slowness is not "you have a lot of history" in the inevitable sense.
It is three compounding architectural choices, each of which makes cost
scale with **total lifetime messages** on a path that runs on **every**
dashboard open.

## 1. The recompute runs every open, and defaulted to "all"

The "Crunching your Claude Code history. This can take a few seconds the
first time." splash
([extension.json](../../../packages/core/src/locales/en/extension.json),
key `loading.subtitle`) is painted by `renderLoading()` and then replaced
once `refresh()` finishes
([panel.ts:77–79](../../../packages/cli/src/extension/panel.ts)).

`refresh()` ([panel.ts:82](../../../packages/cli/src/extension/panel.ts)):

```
const data = buildDashboard(store, dashOpts);
await attachCostPerTask(store, data, dashOpts, …);
await attachCalibration(store, data, dashOpts);
```

This is **not** the one-time ingestion the splash copy implies. Ingestion
is separate, incremental, and checkpointed (see §below). This recompute
runs:

- on first open,
- on every subsequent open (the panel is disposed when hidden),
- on every period change ([panel.ts:127](../../../packages/cli/src/extension/panel.ts)),
- on every account change, and
- after each background collection via `refreshIfVisible()`
  ([panel.ts:37](../../../packages/cli/src/extension/panel.ts)).

And it historically defaulted to `period = "all"`
([panel.ts:27](../../../packages/cli/src/extension/panel.ts)), so the
default experience paid the full-history worst case every single time.

**Ingestion, by contrast, is already well-engineered.** The `AutoCollector`
watches `~/.claude/projects/` and `collect()` uses a `collection_state`
checkpoint table (file path, size, mtime, first-KB hash, last byte offset)
to skip unchanged files and resume appended ones from the last offset
([aggregator/index.ts](../../../packages/cli/src/aggregator/index.ts)).
So "the first time" really is only the first time — for ingestion. The
recompute has no equivalent incrementality.

## 2. Analytics are re-derived from raw `messages` on every open

`buildDashboard` ([dashboard/index.ts:386](../../../packages/cli/src/dashboard/index.ts))
does not read pre-computed aggregates. It re-derives everything from the
raw message rows, through several **independent** passes that each fetch
the full message table for the period and iterate it in JS:

| pass | query | per-row JS work |
|---|---|---|
| velocity / active hours | `getMessageTimestamps` (all timestamps) | gap-merge loop |
| model efficiency | `getMessagesForEfficiency` (full rows incl. `prompt_text`, `tools`) | turn assembly, `JSON.parse(tools)`, `scoreComplexity`, `estimateCost` ×2 |
| context analysis | `getMessagesForContext` | per-row accumulation |
| spending | spending query | per-row accumulation |
| **energy** | `getMessagesForEnergy` (full rows) | `estimateEnergy` per row, `Intl` date-format per row, 213k-element array |

Nothing is shared between these passes: the same 213k rows are pulled from
SQLite and walked **four-plus times**, with separate materialisation each
time. `buildEnergySection` alone is ~1 s because it pays the largest fetch
(503 ms) plus the most expensive per-row work (`Intl.DateTimeFormat.format`
inside a 213k loop, 185 ms).

The shape of the cost:

```
cost(open) ≈ Σ_passes [ fetch(messages_in_scope) + perRow × messages_in_scope ]
```

With the default `scope = all`, `messages_in_scope` = lifetime total, which
only grows. There is no memoisation, no cache keyed on
(period, last-collection-watermark), nothing.

## 3. Period filters can't prune the message scan

Even narrowing the period only partially helps, because the message
queries filter on `sessions.first_timestamp` rather than `messages.timestamp`
(detail and query plans in
[`01-methodology-and-measurements.md`](01-methodology-and-measurements.md#the-un-prunable-scan-why-period-filters-help-less-than-they-should)).

SQLite scans the **whole** `idx_messages_timestamp` index and applies the
session-time predicate post-join, so each message query has a floor of
~50 ms (full index scan + 213k session lookups) **regardless of period**.
Fetching a single day's 133 rows still costs ~53 ms. That floor is
lifetime-linear and unavoidable until the predicate moves onto an indexed
message column.

## Why "default to day" is necessary but not sufficient

Changing the default to `"day"` removes the dominant term
(`messages_in_scope` collapses from ~213k to ~hundreds) and is the right
immediate fix — first paint goes from ~3.3 s to ~0.26 s here.

But two residual scaling hazards remain:

1. **The per-query scan floor** (§3): ~50 ms × (number of message passes)
   that grows with lifetime messages, paid even for `period = "day"`. At
   today's size that is ~200 ms of the 260 ms `day` budget; it will keep
   climbing.
2. **The wide-period paths still hit the wall.** A user who selects
   "all" — a completely reasonable thing to want — still waits 3.3 s and
   rising. The feature shouldn't degrade to unusable as history grows.

Both are addressed structurally in
[`03-remediation-plan.md`](03-remediation-plan.md): move the filter onto
`messages.timestamp` (seek, not scan), and — the durable fix — **push the
additive aggregation into SQLite**. A SQL `GROUP BY` over all history
computes the token/cost/energy/breakdown metrics in ~100 ms (vs ~500 ms
just to fetch the raw rows for one of the four JS passes), with no
maintenance surface and no fixed group-by lock-in.

Two caveats shape that plan. First, **not all metrics are additive**: turn
classification (`buildModelEfficiency`) and per-session token trajectory
(`buildContextAnalysis`) are inherently per-message and cannot be summed
into daily buckets — they move to ingest-time derived tables instead.
Second, a **persisted rollup table is deferred**, not the lead fix: build
it only if the in-DB `GROUP BY` scan is later measured to be the wall, and
if so at an **hourly UTC** grain (daily buckets cannot be re-derived into
other timezones, and the future arbitrary-period feature needs that
flexibility).
