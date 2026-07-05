# Remediation plan

Ordered by return on effort. Each item is independently shippable.

The guiding principle, validated by measurement (see
[`01-…md`](01-methodology-and-measurements.md#sql-side-aggregation-vs-js-materialisation)):
**the bottleneck for additive metrics is materialising rows into JS and
looping, not the scan.** A SQL `GROUP BY` over the *entire* 213k-message
history returns the daily×model rollup in ~100 ms — versus ~500 ms just to
*fetch* those rows into JS, before any looping, ×4 passes today. So the
structural fix is to push aggregation into SQLite, **not** to jump straight
to a maintained rollup table. Persist a rollup only once the scan itself —
not JS materialisation — becomes the wall.

A second principle, from the future arbitrary-period requirement: **choose
the storage/query grain to match the finest boundary you will ever query
or group by.** That argues for a date-granularity period picker and, if you
ever persist a rollup, an **hourly** grain (not daily).

## Summary table

| # | Fix | Effect | Effort | Risk | Status |
|---|---|---|---|---|---|
| 1 | Default period `"all"` → `"day"` | 3.3 s → 0.26 s on default path | trivial | none | **done** |
| 2 | Filter message queries on `m.timestamp` | index seek; removes the ~50 ms/query lifetime-linear floor | low | low | proposed |
| 3 | **Aggregate additive metrics in SQL** (`GROUP BY` + covering index) | replaces 4 JS passes; ~100 ms for full history | medium | low | proposed |
| 4 | Hoist `Intl` formatting / drop throwaway arrays in remaining JS loops | −~150–200 ms on the per-message work that stays | low | low | proposed |
| 5 | Move non-additive metrics (turn classification, context trajectory) to ingest-time derived tables | decouples the genuinely per-message work from open time | high | medium | proposed |
| 6 | Memoise `refresh()` per (period, watermark) | repeat opens / tab toggles ~free | low | low | proposed |
| 7 | Persisted **hourly** rollup table | only if #3's scan becomes the wall at much larger scale | high | medium | deferred |

The load-bearing insight versus the first draft of this plan: **#3 (in-DB
aggregation) is the real structural fix, and it likely defers a persisted
rollup (#7) indefinitely.** And a rollup is *not* a universal replacement —
only additive (SUM-able) metrics roll up; turn classification and
per-session trajectory are per-message and need #5 instead.

---

## 1. Default to `"day"` — DONE

[panel.ts:27](../../../packages/cli/src/extension/panel.ts). The single
highest-leverage change: the default open no longer scans all history.
First paint ~0.26 s here. Does not address the underlying scaling — items
2–5 do — but takes the common path off the lifetime-scaling curve.

## 2. Filter message queries on `messages.timestamp` (seek, don't scan)

`getMessagesForEfficiency`, `getMessagesForEnergy`, `getMessagesForContext`
([store/index.ts](../../../packages/cli/src/store/index.ts)) filter on
`s.first_timestamp >= ?`, which the message indexes cannot prune — SQLite
scans the whole `idx_messages_timestamp`. Add a predicate on the message
timestamp:

```sql
WHERE ... AND m.timestamp >= ?
```

Plan changes from `SCAN m USING INDEX idx_messages_timestamp` to
`SEARCH m USING INDEX idx_messages_timestamp (timestamp>?)` (verified — see
`01-…md`). Cost becomes O(messages in period), benefiting **every** period
including `day`, and it is the enabler for the per-message metrics in #5
that cannot be rolled up.

Semantics note: `m.timestamp >= since` selects messages *authored* in the
window; `s.first_timestamp >= since` selects messages of *sessions started*
in the window. For period charts the former is what's wanted (a session
straddling midnight attributes each message to its own day). Confirm
against existing tests; if exact parity is required for a given query, keep
both predicates — the `m.timestamp` one still enables the seek.

## 3. Aggregate additive metrics in SQL — the structural fix

The additive metrics — token totals, cost inputs, energy inputs, message
and prompt counts, per-day / per-model / per-project breakdowns — are all
`SUM ... GROUP BY`. Today they are computed by fetching every message row
into JS and looping (four separate passes). Compute them in SQLite instead:

```sql
SELECT
  (m.timestamp / 86400000) AS day_bucket,   -- or a tz-aware expression; see grain note
  m.model,
  SUM(m.input_tokens), SUM(m.output_tokens),
  SUM(m.cache_read_tokens), SUM(m.cache_creation_tokens),
  COUNT(*)
FROM messages m
WHERE m.timestamp >= ?
GROUP BY day_bucket, m.model;
```

Measured: ~101 ms for daily×model over **all** history (237 rows out),
~52 ms for daily-only — versus ~500 ms just to *fetch* the rows in the
current path. Add a **covering index** on `messages(timestamp, model,
input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)` so
the aggregation reads only the index, never the table heap.

Why this beats a persisted rollup as the first move:
- **No maintenance / consistency surface** — it reads the source of truth,
  always correct, nothing to backfill or invalidate on file rewrite.
- **No fixed group-by lock-in** — a persisted rollup answers only the
  group-bys baked into its key; an in-DB `GROUP BY` can slice by any
  dimension on demand (important for the future arbitrary-period UI, which
  may want new breakdowns: entrypoint, work-category, cache-efficiency-by-X).

Energy/CO₂ are additive *given a region factor*; either group raw tokens by
day×model and apply the region factor in JS over the few hundred grouped
rows, or fold the factor into the SQL. Either way the per-row `estimateEnergy`
over 213k rows disappears.

## 4. Hoist `Intl` / drop throwaway arrays in the JS that remains

Whatever per-message JS survives #3 should not format dates per row.
[dashboard/index.ts:1929](../../../packages/cli/src/dashboard/index.ts) calls
`dayFmt.format(new Date(m.timestamp))` per message (185 ms over 213k).
`Intl.DateTimeFormat.format` is extremely slow in tight loops. Compute the
day key by arithmetic on epoch ms (+ tz offset) and format only the handful
of distinct keys at the end. Also drop the 213k-element `allEstimates`
array in `buildEnergySection` if nothing consumes it beyond the
accumulators. Mostly moot once #3 lands, but applies anywhere a per-row
`Intl`/`new Date()` remains.

## 5. Move non-additive metrics to ingest-time derived tables

Two passes are **not** roll-up-able and remain per-message:

- **`buildModelEfficiency`** ([dashboard/index.ts:1441](../../../packages/cli/src/dashboard/index.ts))
  assembles *turns* from per-message `prompt_text` / `tools` /
  `thinking_blocks` and scores complexity. A daily token sum cannot
  reconstruct turns.
- **`buildContextAnalysis`** ([dashboard/index.ts:1643](../../../packages/cli/src/dashboard/index.ts))
  tracks per-session token-growth trajectory — also per-message.

The collector already touches each new message exactly once at ingest. Do
the per-turn classification and per-session trajectory **there**, writing
to derived tables (e.g. `turn_efficiency`, `session_context`). The
dashboard then aggregates those small derived rows instead of
re-classifying 213k raw messages on every open. Until #5 lands, #2 keeps
these passes bounded by period (recent data only on the default path).

Consistency rule for any derived/aggregated data (this and #7): the
aggregator reparses rewritten files, so **recompute the affected
day/hour-partitions from raw on change** — do not attempt incremental
deltas. A partition's raw rows are bounded, recompute is cheap, and it
avoids incremental-view-maintenance drift. Gate the derived schema behind
a `schema_fingerprints` bump and backfill idempotently.

## 6. Memoise `refresh()` between identical opens

`refresh()` recomputes from scratch even when nothing changed since the
last paint. Cache the computed `DashboardData` keyed on
`(period, accountUuid, last-collection-watermark)`; invalidate when the
collector commits new data (it already calls `refreshIfVisible()`,
[panel.ts:37](../../../packages/cli/src/extension/panel.ts)). Makes
re-opens and tab toggles effectively free. Low effort once the store
exposes a collection watermark/counter.

## 7. Persisted hourly rollup — deferred until proven necessary

Only build this if #3's `GROUP BY` scan becomes the wall at much larger
scale (many millions of messages). If/when you do:

- **Grain = hourly, not daily.** This is the choice the future
  arbitrary-period feature forces. Hourly buckets:
  - support the existing "day → byHour" view from the same table,
  - allow exact re-bucketing into any integer-offset local day (only the
    half-hour-offset zones — India, Nepal — lose exactness), so a single
    UTC-hour rollup serves multiple timezones, and
  - keep arbitrary date ranges exact at the edges.
  Daily buckets cannot be re-derived into a different timezone's local days
  (a UTC day straddles two local days), which is why daily is the wrong
  grain once tz or arbitrary periods are in play. Size is still tiny:
  hours-active × models × projects × accounts.
- Schema sketch: `message_hourly(hour_utc, model, project_path,
  account_uuid, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, message_count, prompt_count, PRIMARY KEY(hour_utc,
  model, project_path, account_uuid))`.
- Maintain by the recompute-affected-partition rule from #5.

---

## Interaction with the future arbitrary-period feature

The planned ability to select an arbitrary period does **not** change the
direction, but it pins three decisions:

1. **Constrain the picker to date (not instant) granularity.** Arbitrary
   *date* ranges are exact range scans / bucket sums. Arbitrary *instant*
   ranges make edge buckets partial and would force a raw-message fallback
   for the edges. Date granularity is the analytics-dashboard norm and
   keeps everything exact.
2. **Lead with in-DB aggregation (#3), not a fixed-key rollup.** A range
   `WHERE m.timestamp BETWEEN ? AND ? GROUP BY …` answers any arbitrary
   range and any grouping dimension. A persisted rollup answers only the
   group-bys in its key — a worse fit for an open-ended period/breakdown UI.
3. **If you ever persist (#7), use hourly UTC.** It is the only grain that
   stays exact across timezones, arbitrary ranges, and the sub-day byHour
   view simultaneously.

## Suggested sequencing

1. **#1** (done) — stops the bleeding.
2. **#2 + #4** — small, low-risk, benefit every period; verify against
   existing dashboard tests.
3. **#3** — the structural fix; land behind behaviour-comparison tests
   (capture current dashboard output on a fixed corpus, assert the
   SQL-aggregated output matches).
4. **#5** — the only genuinely per-message work; move to ingest with the
   recompute-affected-partition rule.
5. **#6** — optional polish once a watermark exists.
6. **#7** — defer; revisit only if #3's scan is measured to be the wall.

After #2–#5, dashboard open cost is decoupled from lifetime history without
a maintained rollup: the default `day` path stays sub-100 ms, and even an
arbitrary wide range reads a ~100 ms in-DB aggregation plus small derived
tables.
