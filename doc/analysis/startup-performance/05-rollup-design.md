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

Only messages from **included** sessions contribute: `is_interactive = 1 AND
source_deleted = 0` (matches the dashboard's default `getSessions` filter; note
the energy/efficiency queries do NOT currently filter is_interactive — confirm
the exact inclusion predicate against `getMessagesForEnergy`'s session subquery
during build and replicate it EXACTLY, else parity breaks).

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
full build (`INSERT … SELECT … GROUP BY` over all messages — the ~100–250 ms
measured cost, one time). Gate behind the schema-version bump so it runs once.

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

## Risks / open questions for review

- **Inclusion-predicate parity:** the rollup MUST use the exact same
  session-inclusion predicate as the current raw energy/totals queries
  (is_interactive? subagents?). Mismatch = silent drift. Verify against the
  actual SQL during build; the parity gate catches it.
- **`project_path` cardinality** in the PK — bounded by real project count;
  acceptable.
- **NULL `inference_geo` in PK** — SQLite treats NULLs as distinct in a PRIMARY
  KEY/UNIQUE (multiple NULLs allowed), which would split buckets. Use a `''`
  sentinel or `COALESCE` in GROUP BY + a NOT NULL column to keep one row per
  (hour,project,model,no-geo). Decide and test.
- **Touched-hour set size** on a large rewrite (a multi-month session file) —
  could be many hours, but still bounded by that file's span, not lifetime.
- **Collect latency:** the end-of-collect recompute adds bounded work to a
  background task; measure it doesn't regress collect noticeably.

## Sequencing

Design (this doc) → review (stress the maintenance/invalidation correctness) →
build (migration + collect hook + read path + tests) → verify (parity + the
maintenance tests above) → commit. Expected: "all" energy/totals reads drop
from O(213k)·scans to O(hours).

---

## Review outcome (security + correctness) — build is BLOCKED on one decision

Two parallel reviews against the actual code found that the first draft of this
design would have **silently corrupted dashboard numbers**. Corrections folded
in below; one finding is a product decision that gates the build.

### ⛔ Blocking product decision — period axis

The raw queries this rollup replaces (`getMessageTotals`, `getMessagesForEnergy`)
bound the period on **session `first_timestamp`** (`store/index.ts:657,1103`)
and then sum **all** messages of qualifying sessions, regardless of each
message's own timestamp. An hourly-message rollup is inherently keyed on
**message timestamp**. These two axes disagree for any session that **straddles
a period boundary** (starts before `since` but has messages after, or vice
versa). An hourly rollup that aggregates away `session_id` **cannot** reproduce
the session-first-timestamp semantics — so shipping the rollup necessarily
**changes period filtering to message-timestamp semantics** for the affected
reads.

Message-timestamp ("count messages authored in the period") is arguably the
more intuitive semantics, and the energy `byDay` chart already buckets by
message timestamp — but switching the period *filter* changes every
period-bounded number for boundary-straddling sessions. **This requires
sign-off before build.** Options: (a) adopt message-timestamp period semantics
dashboard-wide (enables the rollup; update the raw oracle + all period-filtered
queries to match; document the behaviour change); or (b) keep session-axis
semantics and abandon the hourly rollup for these reads (the rollup cannot serve
them correctly). There is no (c) that preserves session-axis *and* gets the
rollup.

### Corrections folded in (apply when/if the build proceeds)

1. **Inclusion predicate — match raw EXACTLY.** Raw energy/totals filter on
   **none** of `is_interactive` / `source_deleted` / `is_subagent` (only
   `getSpendingReport` filters `is_interactive=1 AND source_deleted=0`). The
   rollup recompute must use the same: energy branch adds `m.model IS NOT NULL`,
   totals branch does not. Drop the proposed `is_interactive=1 AND
   source_deleted=0` from the schema-inclusion note above.
2. **`markSourceDeleted` invalidation becomes a no-op for value** (raw doesn't
   filter `source_deleted`), so remove it from the touched-set correctness
   argument. (It also had a filePath→session_id resolution gap.)
3. **NULL `model` and NULL `inference_geo`:** `getMessageTotals` includes
   NULL-model messages; the schema's `NOT NULL` columns would crash/drop them.
   Use `COALESCE(m.model,'')` / `COALESCE(m.inference_geo,'')` (sentinel) in the
   recompute GROUP BY, store `NOT NULL DEFAULT ''`, map back at read. Forbid any
   `ON CONFLICT` upsert against the table — only delete-by-hour + insert.
4. **Null/zero-timestamp messages:** 0 exist today (verified) but the column is
   nullable and raw counts them; `NULL/3600000` → never bucketed. Reserve a
   sentinel `hour_utc` (e.g. `-1`), recompute it unconditionally each collect,
   include it in "all"/total reads — or add a `timestamp IS NOT NULL` guard to
   the raw queries too. Test either way.
5. **Rewrite stale rows:** `upsertMessages` is upsert-only, never deletes
   (`store/index.ts:468`); a rewrite that drops uuids leaves stale message rows.
   The recompute reads current `messages`, so rollup == raw (both retain them).
   Do **not** special-case this in the rollup; if undesired, fix `upsertMessages`
   and the rollup follows for free.
6. **Parameterized `IN (<touched hours>)`** — one `?` per element (as
   `getStopReasonCounts`/`getMessageTotalsBySession`) or `json_each(?)`; never
   string-interpolate. Mind `SQLITE_LIMIT_VARIABLE_NUMBER` for big rewrites.
7. **Idempotent backfill** — `migrateToV12` is not atomic across CREATE + INSERT;
   prefix the backfill with `DELETE FROM message_hourly` (or wrap in a txn) so a
   crash-retry can't double-count.
8. **`until` bound** — totals supports `until`; the read path needs
   `hour_utc < until/…` for that branch.
9. **Single shared recompute SELECT** for backfill + incremental (param: the
   hour-set; backfill = all hours) so they cannot drift. Tests use synthetic
   `project_path` only — never the live DB.

### Decision (made) + staged build

**Period axis: message-timestamp semantics adopted.** Period-filtered
**message-level** reads (`getMessageTotals`, `getMessagesForEnergy`,
`getMessagesForEfficiency`, `getMessagesForContext`, `getEnergyAggregates`) now
mean "messages **sent** in the period" — filter on `m.timestamp`, not the
session-first-timestamp subquery. Session-keyed reads (`getSessions` and the
byDay/byProject/byHour/conversation/plan/spending summaries built from it) stay
session-based — they answer a different question ("sessions started in period")
and are already cheap. This makes the message reads consistent with the energy
`byDay` chart (which already buckets by message timestamp).

Staged to contain the silent-corruption risk the reviews demonstrated:

- **Build 1 — semantics switch.** Replace the `m.session_id IN (SELECT … WHERE
  s.first_timestamp …)` filter in the message-level reads with a direct
  `m.timestamp >= ? [AND m.timestamp < ?]` (seeks `idx_messages_timestamp`;
  O(period) for all bounded periods). Session-scoped filters
  (project/repo/account) stay as a session-id subquery, ANDed. **Behaviour
  change:** re-baseline the affected period-filtered test assertions —
  distinguishing intended semantic changes from regressions, never editing
  assertions just to go green. Little perf delta vs the current subquery seek;
  its purpose is the semantics + setting up the rollup axis.
- **Build 2 — the rollup.** `message_hourly` (migrateToV12, corrections 1–9) +
  collector touched-hour maintenance + backfill. Read path: serve energy +
  totals from the rollup **only for the unbounded "all" read** (since=0), where
  hour-bucket boundaries are exact; bounded periods keep the Build-1 direct
  seek (already fast, and avoids the partial-boundary-hour granularity issue).
  Parity oracle compares rollup output to the Build-1 raw output on the full DB.
