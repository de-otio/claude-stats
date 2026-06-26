# Methodology and measurements

## Environment

- Host: macOS (Darwin), 12 cores, 32 GB RAM.
- Data corpus at time of measurement:
  - **1083** `*.jsonl` source files under `~/.claude/projects/`, **~708 MB** total.
  - SQLite store `~/.claude-stats/stats.db`: **64 MB** (+ ~4.4 MB WAL).
  - Row counts: `sessions` **943**, `messages` **~213k** (actively growing
    during the session: 213,085 → 213,214 across runs), `usage_windows`
    453, `collection_state` 961.
  - Of 943 sessions, only **167** are interactive (`is_interactive = 1`),
    which is the default `getSessions` filter.

## How timings were taken

Micro-benchmarks written as `tsx` scripts importing the real modules
(`Store`, `buildDashboard`, the section builders) and run against the live
`stats.db`. Each hot path was run repeatedly to reach steady state and
discard JIT/first-query warm-up. The OS page cache was warm (the 64 MB DB
fits comfortably in RAM), so these numbers isolate **CPU + query +
materialisation** cost, not cold disk I/O.

`buildDashboard` internal attribution was obtained by temporarily wrapping
the section-builder call sites with `performance.now()` markers, running
once, and reverting the instrumentation (no source change persisted).

Caveat: absolute milliseconds are machine- and cache-dependent. The
load-bearing finding is the **shape** — cost is linear in lifetime message
count, and several constant-factor passes stack on top of each other.

## End-to-end: `refresh()` by period

`DashboardPanel.refresh()` = `buildDashboard` + `attachCostPerTask` +
`attachCalibration`. The "Crunching…" splash is visible for exactly this
duration.

| period | new Store() | buildDashboard | attachCostPerTask | attachCalibration | **total** |
|---|---|---|---|---|---|
| day   | 1 ms | 259 ms  | 2 ms   | 1 ms   | **264 ms**  |
| week  | 1 ms | 367 ms  | 183 ms | 137 ms | **689 ms**  |
| month | 1 ms | 873 ms  | 512 ms | 565 ms | **1 951 ms** |
| all   | 1 ms | 2 255 ms| 534 ms | 495 ms | **3 286 ms** |

Every stage scales with the period window. `attachCostPerTask` /
`attachCalibration` are near-free for `day` (the recap pipeline only looks
at the period) but become hundreds of ms for `month`/`all`.

## Inside `buildDashboard` (period = all, steady state ≈ 2.2–2.3 s)

Repeated runs were stable: 2219 / 2309 / 2182 / 2154 ms — confirming this
is steady-state compute, **not** cold-start.

Per-stage attribution:

| stage | time | source |
|---|---|---|
| `buildEnergySection` | **1030 ms** | [dashboard/index.ts:1818](../../../packages/cli/src/dashboard/index.ts) |
| `buildModelEfficiency` | 418 ms | [dashboard/index.ts:1441](../../../packages/cli/src/dashboard/index.ts) |
| `buildContextAnalysis` | 285 ms | [dashboard/index.ts:1643](../../../packages/cli/src/dashboard/index.ts) |
| `buildSpendingSection` | 230 ms | [dashboard/index.ts:1294](../../../packages/cli/src/dashboard/index.ts) |
| everything before line 679 (store calls + JS loops) | ~330 ms | summary aggregation, velocity, conversation cost |

### Individual store calls (period = all, warm)

| call | time | rows returned |
|---|---|---|
| `getSessions({includeCI:false})` | 1 ms | 167 |
| `getMessageTotals({})` | ~113 ms | 6 (grouped) |
| `getStopReasonCounts(ids)` | 24 ms | 3 |
| `getMessageTimestamps({})` | 141 ms | **213 085** |
| `getUsageWindows({since})` | 1 ms | 134 |
| `getMessageTotalsBySession(ids)` | 53 ms | 193 |
| `getMessagesForEfficiency({})` | 328–406 ms | **213 214** |
| `getMessagesForEnergy({})` | 425–503 ms | **213 214** |

The expensive calls are precisely the ones that materialise **every
message row**. `getMessagesForEnergy` and `getMessagesForEfficiency` each
pull the full table (the latter including `prompt_text` and `tools` TEXT
columns), and `getMessageTimestamps` pulls all 213k timestamps.

### Within `buildEnergySection` (the single biggest stage)

| sub-step | time |
|---|---|
| `getMessagesForEnergy({})` (fetch 213k rows) | ~503 ms |
| `Intl.DateTimeFormat.format(new Date(m.timestamp))` per row | **185 ms** |
| `estimateEnergy(...)` per row + `allEstimates.push` + accumulators | remainder |

Two avoidable patterns: (1) a fresh `new Date()` + `Intl` format call **per
message** ([dashboard/index.ts:1929](../../../packages/cli/src/dashboard/index.ts));
`Intl.DateTimeFormat.format` is one of the slowest operations you can put in
a 213k-iteration loop. (2) building a 213k-element `allEstimates` array that
is then re-reduced.

## The un-prunable scan (why period filters help less than they should)

The message queries filter on the **session** start time, not the message
time:

```sql
-- getMessagesForEfficiency / getMessagesForEnergy / getMessagesForContext
FROM messages m JOIN sessions s ON m.session_id = s.session_id
WHERE ... AND s.first_timestamp >= ?      -- filter on the SESSION column
ORDER BY m.timestamp ASC
```

Query plan (with the `since` filter present):

```
SCAN m USING INDEX idx_messages_timestamp
SEARCH s USING INDEX sqlite_autoindex_sessions_1 (session_id=?)
```

`SCAN m` — SQLite walks the **entire** `idx_messages_timestamp` index
(all 213k entries), does a session lookup for each, and only then applies
the `s.first_timestamp` predicate. The period filter therefore reduces
**materialisation**, not the scan.

Measured floor — fetching *today only* (133 rows) still costs ~50 ms
because the full index is scanned:

| call | period = all | period = today (133 rows) |
|---|---|---|
| `getMessagesForEnergy` | 425 ms | **56 ms** |
| `getMessagesForEfficiency` | 328 ms | **53 ms** |

That ~50 ms is the irreducible per-query scan floor, and it grows linearly
with total lifetime messages — independent of the selected period.

### The fix the plan rests on

Adding a predicate on the **message** timestamp column lets the index seek
instead of scan:

```sql
WHERE ... AND m.timestamp >= ?
```

Plan becomes:

```
SEARCH m USING INDEX idx_messages_timestamp (timestamp>?)
SEARCH s USING COVERING INDEX sqlite_autoindex_sessions_1 (session_id=?)
```

`SEARCH ... (timestamp>?)` is a seek: cost becomes O(messages in period),
removing the lifetime-linear floor. See `03-remediation-plan.md`.

## SQL-side aggregation vs JS materialisation

The current passes fetch every message row into JS and loop. The additive
metrics (token/cost/energy totals, per-day / per-model breakdowns) are
plain `SUM ... GROUP BY` and can be computed inside SQLite, returning a few
hundred grouped rows instead of materialising 213k.

Measured over **all** history:

| approach | time | rows into JS |
|---|---|---|
| fetch all rows for one pass (`getMessagesForEnergy`) | ~425–503 ms | **213 214** |
| `SELECT day, model, SUM(...) GROUP BY day, model` | **101 ms** | 237 |
| `SELECT day, SUM(...) GROUP BY day` | **52 ms** | 116 |

i.e. the daily×model rollup for the entire history is computed in ~100 ms —
**less than the time to merely fetch the raw rows** for a single one of the
four current passes. The bottleneck is JS materialisation + looping, not
the scan. This is the evidence the remediation plan rests on: push the
additive aggregation into SQL (with a covering index) before considering a
persisted rollup table. See `03-remediation-plan.md` §3.

Caveat: a SQL `GROUP BY` answers only the dimensions in its `GROUP BY`
clause for that call, but — unlike a persisted rollup — it is free to group
by *any* dimension on demand, which matters for the future arbitrary-period
/ arbitrary-breakdown UI.
