# `#7` — persisted hourly rollup: design

The structural fix that decouples wide-period (esp. "all") dashboard cost from
lifetime message count. Query-time aggregation (Phase A) plateaus because it
re-scans all messages on every open; a maintained rollup turns "all" into a
read of O(hours) pre-aggregated rows.

**The hard part is not the rollup — it is keeping it consistent with `messages`
+ mutable session attributes without drift.** A rollup that silently disagrees
with the raw data is worse than a slow-but-correct dashboard. This document
fixes the maintenance strategy and the parity gate before any build.

## What it serves (and what it does NOT)

Serves the **additive** per-message aggregations currently done by
`getEnergyAggregates` and `getMessageTotals` (token/energy/cost sums, by
day/model/project/class/geo). For the **common case**: no account filter, the
standard period.

Does **not** serve (these fall back to the existing raw queries):
- **Account/repo-filtered reads** — rare; keeping account/repo as rollup
  dimensions would couple the rollup to `updateSessionAccounts` late-backfill
  (a mutation that happens *after* messages are stored). Excluding them removes
  that whole invalidation class. If `accountUuid`/`repoUrl` filter is set →
  raw path.
- **`sessionsWithThinking`** — a `COUNT(DISTINCT session_id)`; not additive
  across hourly buckets (a session spans hours). Stays a live indexed query
  (cheap: one `COUNT(DISTINCT … WHERE thinking_blocks>0)`).
- **Non-additive sections** (efficiency turns, context trajectory, recap) —
  out of scope (Phase C / Phase B).

## Schema

```sql
-- migrateToV12
CREATE TABLE message_hourly (
  hour_utc      INTEGER NOT NULL,   -- timestamp / 3600000 (integer hour bucket)
  project_path  TEXT NOT NULL,
  model         TEXT NOT NULL,
  inference_geo TEXT,               -- nullable; '' sentinel avoided, use IS
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  thinking_input_tokens  INTEGER NOT NULL,  -- SUM over thinking_blocks>0 (for pctEnergyFromThinking)
  thinking_output_tokens INTEGER NOT NULL,
  thinking_cache_read_tokens INTEGER NOT NULL,
  thinking_cache_creation_tokens INTEGER NOT NULL,
  msg_count     INTEGER NOT NULL,
  PRIMARY KEY (hour_utc, project_path, model, inference_geo)
);
CREATE INDEX idx_message_hourly_hour ON message_hourly (hour_utc);
```

The rollup must use **exactly** the inclusion predicate of the raw queries it
replaces, else parity breaks. The raw energy and totals reads filter on none of
`is_interactive` / `source_deleted` / `is_subagent` (only the spending report
does); the energy branch adds `m.model IS NOT NULL`, the totals branch does not.

`detectedRegion` (earliest mappable geo) and the dominant-geo region: derivable
from the rollup via `MIN(hour_utc)` per geo + `SUM(msg_count)` per geo.

## Maintenance strategy: recompute touched hour-partitions, once per collect

**Rule:** a rollup row for `hour_utc = H` is always a pure recompute of all
included messages in `[H·3600000, (H+1)·3600000)`. After each `collect()`,
recompute exactly the hour-buckets it could have changed — never an incremental
delta (deltas drift on rewrite/dedup).

`collect()` already processes files and knows their parsed messages. Accumulate
a `Set<hour_utc>` of touched hours from:
1. every message in every processed file (`parsed.messages[].timestamp / 3600000`)
   — covers append AND rewrite (rewrite reprocesses the whole file);
2. every session passed to `markSourceDeleted` — its messages' hours (one query
   per deleted session: `SELECT DISTINCT timestamp/3600000 FROM messages WHERE
   session_id=?`).

Then, in one transaction at the end of `collect()`:
```sql
DELETE FROM message_hourly WHERE hour_utc IN (<touched>);
INSERT INTO message_hourly
  SELECT timestamp/3600000 AS hour_utc, s.project_path, m.model, m.inference_geo,
         SUM(...), ..., COUNT(*)
  FROM messages m JOIN sessions s ON m.session_id = s.session_id
  WHERE m.timestamp/3600000 IN (<touched>) AND <inclusion predicate>
  GROUP BY hour_utc, s.project_path, m.model, m.inference_geo;
```
Cost = O(messages in touched hours), bounded by recent activity — **not**
O(lifetime). `idx_messages_timestamp` makes the hour ranges a seek.

**Why this is correct where incremental deltas are not:**
- **Append** → touched = current hour(s); recompute from current state. ✓
- **Rewrite** (same uuids re-upserted, content possibly changed) → the file's
  hours recompute from the now-current `messages`. ✓ (no double-count)
- **Delete** (`markSourceDeleted`) → session's hours recompute; its messages now
  fail the `source_deleted=0` predicate and drop out. ✓
- **Late `updateSessionAccounts`** → account is NOT a rollup dimension, so this
  mutation cannot affect the rollup. ✓ (the reason account is excluded)
- **Late `repoUrl` set** → not a dimension. ✓
- **`is_interactive` / `is_subagent`** → set at session upsert, *before* its
  messages' hours are recomputed in the same collect; the recompute SELECT reads
  current session attrs. Edge: if a pre-existing session's interactivity flips
  on a later reprocess, that reprocess goes through the file → its hours are in
  the touched set → recomputed. ✓

**Backfill / migration:** `migrateToV12` creates the table and does a one-shot
full build (`INSERT … SELECT … GROUP BY` over all messages, a one-time cost).
Gate behind the schema-version bump so it runs once, and make it idempotent
(clear the table first) so a crash-retry cannot double-count.

## Read path

`getEnergyAggregates` / `getMessageTotals` gain a rollup-backed branch:
- If no `accountUuid`/`repoUrl` filter → read `message_hourly` with
  `WHERE hour_utc >= since/3600000` (+ optional `project_path`), aggregate the
  few-hundred/thousand rows in JS exactly as today over grouped rows.
- Else → existing raw query (unchanged).
- `sessionsWithThinking` → always the live `COUNT(DISTINCT …)` query.

byDay re-buckets hour_utc → local day in JS (same Intl formatter; same
integer-offset-exact / fractional-offset caveat as Phase A).

## Correctness gate (mandatory before ship)

1. **Parity on the live DB:** rollup-backed `getEnergyAggregates` /
   `getMessageTotals` output == the raw-query output, for day/week/month/all,
   to display precision. (Reuse the Phase A oracle.)
2. **Maintenance correctness tests** (synthetic, deterministic):
   - append: add messages to a session → touched-hour recompute → rollup == raw.
   - rewrite: reprocess a file with changed token counts → rollup == raw (no
     double-count).
   - delete: `markSourceDeleted` → those messages drop from rollup.
   - a session spanning multiple hours/days → all its hours recomputed.
   - empty / no-touched-hours collect → rollup unchanged.
   - full backfill on migration == raw aggregate.
3. **Idempotency:** running `collect()` twice with no file changes leaves
   `message_hourly` byte-identical (touched set empty on the second run).
4. Existing `energy.test.ts` / `dashboard.test.ts` pass unchanged.

## Risks and open questions

- **Inclusion-predicate parity:** the rollup MUST use the exact same
  session-inclusion predicate as the current raw energy/totals queries
  (is_interactive? subagents?). Mismatch = silent drift. Verify against the
  actual SQL during build; the parity gate catches it.
- **`project_path` cardinality** in the PK — bounded by real project count;
  acceptable.
- **NULL `inference_geo` in the PK** — SQLite treats NULLs as distinct in a
  PRIMARY KEY/UNIQUE (multiple NULLs allowed). Because the table is only ever
  maintained by delete-by-hour + insert (never an `ON CONFLICT` upsert), nullable
  dimension columns are safe; see the dimension-value decision below.
- **Touched-hour set size** on a large rewrite (a multi-month session file) —
  could be many hours, but still bounded by that file's span, not lifetime.
- **Collect latency:** the end-of-collect recompute adds bounded work to a
  background task; measure it doesn't regress collect noticeably.

## Design decisions

**Period axis: message-timestamp semantics.** The raw queries this rollup
replaces bound the period on the *session's* first timestamp and then sum all of
that session's messages, whatever each message's own timestamp. An hourly
message rollup is inherently keyed on message timestamp, and it aggregates away
`session_id`, so it cannot reproduce session-axis semantics for a session that
straddles a period boundary. Adopting the rollup therefore means adopting
message-timestamp period semantics ("messages *sent* in the period") for the
period-filtered **message-level** reads (`getMessageTotals`,
`getMessagesForEnergy`, `getMessagesForEfficiency`, `getMessagesForContext`,
`getEnergyAggregates`). This also matches the energy `byDay` chart, which already
buckets by message timestamp. Session-keyed reads stay session-based: they
answer a different question ("sessions started in the period") and are already
cheap. The alternative — keeping session-axis semantics — would mean abandoning
the rollup for these reads; there is no option that preserves both.

**Dimension values are stored as they are, including NULL.** Real data has
`inference_geo` as the empty string, as `'not_available'`, **and** as `NULL` —
three distinct values. A `COALESCE(geo, '')` sentinel conflates the empty string
with null and corrupts the geo breakdowns, so `model`, `inference_geo` and
`project_path` are stored as their actual values. Synthetic fixtures that do
not reproduce the real value space hide this class of bug, which is why the
parity gate runs against a real store.

**Reads are guarded by a freshness watermark.** The dispatcher reads the rollup
only when a stored messages-count watermark matches the current count, and
otherwise falls back to the raw path, so any writer that upserts outside a
`collect()` recompute cannot cause a stale read.

**The rollup serves only the unbounded read.** For "all" (`since = 0`) the
hour-bucket boundaries are exact. Bounded periods keep the direct
`m.timestamp >= ? [AND m.timestamp < ?]` seek, which is already fast and avoids
the partial-boundary-hour granularity problem.

**Other invariants.** Recompute with a single shared SELECT for backfill and
incremental maintenance (parameter: the hour set; backfill = all hours) so they
cannot drift; parameterise the `IN (<touched hours>)` list (one `?` per element
or `json_each(?)`, mind `SQLITE_LIMIT_VARIABLE_NUMBER`); reserve a sentinel
`hour_utc` for null/zero-timestamp messages and recompute it each collect;
`upsertMessages` never deletes, so rewrite-dropped uuids leave stale message
rows that the rollup faithfully mirrors, and fixing that belongs in
`upsertMessages`; the read path must honour the `until` bound.
