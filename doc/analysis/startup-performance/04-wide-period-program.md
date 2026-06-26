# Wide-period performance program

`#1` (default → "day") and `#2` (session-id subquery seek) fixed the **default**
dashboard path (3.3 s → ~0.13 s). This document scopes the remaining work to
make the **opt-in wide periods** (week/month/all) fast. Measured state after
`#2`:

| period | total refresh | breakdown |
|---|---|---|
| day (default) | **0.13 s** | — fixed |
| week | 0.57 s | recap pipeline 0.35 s + buildDashboard 0.23 s |
| month | 1.91 s | recap pipeline **1.11 s** + buildDashboard 0.80 s |
| all | 3.72 s | buildDashboard **2.62 s** + recap pipeline 1.10 s |

`#2` barely helped month/all: when the period selects most of the history, a
seek touches nearly all rows anyway. The wide-period cost has **three
independent sources**, each its own phase below.

## Why `#2` didn't help wide periods (and the rollup intuition)

`buildDashboard`'s `byDay`/`byProject`/`byHour` summary is **session-keyed**
(iterates `getSessions()`, ~hundreds of rows, already ~1 ms). The expensive
wide-period work is the **per-message passes**: energy (additive), model
efficiency + context (non-additive), each scanning all in-period messages.
Plus the **recap pipeline** (`attachCostPerTask`/`attachCalibration`), a
separate subsystem.

---

## Phase A — `#3`: in-DB aggregation for the energy section

`buildEnergySection` (`dashboard/index.ts:1818`) fetches every in-period
message and runs `estimateEnergy` + an `Intl` date-format per row (~1030 ms of
the "all" `buildDashboard`). `estimateEnergy` (`core/energy.ts:320`) is **purely
linear** in the four token counts at fixed per-model-class rates and fixed
region — so `SUM(tokens) GROUP BY model → apply rate` equals the per-message
sum **to display-rounding precision** (raw float may differ at ~1e-15;
all outputs are `Math.round`-ed). Parity gate = existing `energy.test.ts` +
a live-DB check to rounding precision.

**Output contract to preserve** (every field of `DashboardEnergy`):
`totalEnergyWh`, `totalCO2Grams`, `co2Grams{Low,High}`, `equivalents.*`,
`journeyAnchor`, `period*`, `byDay`, `byModel`, `byProject`, `byClass`,
`cacheImpact.*`, `thinkingImpact.{sessionsWithThinking,pctEnergyFromThinking}`,
`inferenceGeo.{detected,coveragePct}`, `region`, `gridIntensity`, `pue`.

**Aggregation design (replaces the 213k-row loop):**
- `GROUP BY inference_geo` → `geoCount` histogram, `coveragePct`, and the
  **dominant-geo region detection that must run first** (it sets
  `gridIntensity` used by all energy sums).
- `GROUP BY model` → per-model token sums → `byModel`, `byClass` (model→class),
  totals, `cacheImpact` (needs Σcache_read, Σinput).
- `GROUP BY (hourBucketUtc, model)` → re-bucket hours to the **local day** in JS
  (hourly grain, per the tz rule in `03` §7; a UTC-*day* bucket cannot be
  re-mapped to local days) → `byDay`.
- `GROUP BY (project_path, model)` → `byProject` (model needed for the rate).
- Non-additive: `COUNT(DISTINCT session_id) WHERE thinking_blocks > 0` →
  `sessionsWithThinking`; conditional energy sum over `thinking_blocks > 0` →
  `pctEnergyFromThinking`.

Lowest-risk implementation: **keep the existing reducer, shrink its input** —
feed it pre-grouped tuples instead of raw rows so the accumulator logic is
unchanged; only `sessionsWithThinking` needs the separate distinct-count query.

Self-contained (no schema/collector change). Expected: energy section
~1030 ms → ~150 ms on "all".

### Phase A — shipped (with a follow-up)

Implemented: `getEnergyAggregates` (Store) runs the rollups via the session-id
subquery seek; `buildEnergySection` reuses the exact `estimateEnergy`/
`aggregateEnergy` arithmetic over the grouped sums. **Verified output-preserving**
against an independent per-message oracle on the full 213k-message live DB
(totalEnergyWh, CO₂, byModel 6/6, byDay 116/116, sessionsWithThinking,
cacheEfficiency all exact) plus a legacy-`toEqual` fixture test (UTC + Vienna,
multi-day, varied/null geo, empty).

Measured win was **modest, not the ~150 ms target**: `getEnergyAggregates` is
~771 ms for "all" / ~257 ms for month, because it runs ~7 separate `GROUP BY`
scans (byModel, byProjectModel, byHourModel, byGeo, geoByEarliest, two thinking
queries). buildDashboard "all" 2623 → 2132 ms; day/week improved; month roughly
flat. **Follow-up optimization:** consolidate to ~4 scans — derive
byModel/byClass/totals/cacheImpact by rolling up `byHourModel` in JS, fold the
thinking-energy into `byHourModel` via `SUM(CASE WHEN thinking_blocks>0 …)`, and
merge `byGeo`+`geoByEarliest` into one `GROUP BY inference_geo` with
`COUNT`+`MIN(timestamp)`. (A single mega-`GROUP BY` over
hour×model×project×geo is rejected — cardinality blows up for "all".) Even
consolidated, "all" stays O(213k)·scans; the genuine structural fix for "all"
is the deferred **#7** persisted rollup.

---

## Phase B — recap pipeline floor (the biggest month cost)

**Profiled finding:** the recap cache barely helps. Warm repeat calls are still
~500 ms each (`attachCostPerTask` 580 ms cold → 526 ms warm; `attachCalibration`
580 → 505). The cause (confirmed by code read): `buildDailyDigest`
(`recap/index.ts:404`) computes a **per-day snapshot hash that is O(messages
that day)** — `maxMessageUuid`, per-session message UUIDs — **before** the cache
lookup (`recap/index.ts:455-547`). So month = ~30× per-day message-hashing +
30 cache-file reads + JSON.parse, *even when every day is a cache hit*. The
LLM judge is **off** by default and embeddings are off/cached — neither is the
floor.

**Targets (need their own analysis cycle — cache-correctness risk is real):**
- Batch the per-day snapshot-hash inputs into **one** period query
  (`GROUP BY day`) instead of 30 round-trips.
- Avoid re-reading + re-parsing 30 cache files when an in-memory/period-level
  guard can short-circuit (e.g. a single period-level watermark).
- Consider a period-level digest cache keyed on the period watermark, not only
  per-day.

Invalidation correctness is the hard part — defer detailed design to Phase B's
own analyze→build→verify cycle.

---

## Phase C — `#5`: non-additive metrics to ingest-time derived tables

`buildModelEfficiency` (`dashboard/index.ts:1441`, turn classification) and
`buildContextAnalysis` (`:1643`, per-session token trajectory) are inherently
per-message and cannot be `GROUP BY`-ed (analysis `03` §5). Together ~700 ms of
"all" `buildDashboard`. The collector touches each new message once at ingest —
compute the per-turn classification and per-session trajectory **there**, into
derived tables (e.g. `turn_efficiency`, `session_context`); the dashboard then
aggregates small derived rows. Largest change (collector + schema +
recompute-affected-partition on file rewrite + `schema_fingerprints` gate +
backfill). Own analyze→build→verify cycle.

---

## Sequencing

1. **Phase A** (`#3` energy) — self-contained, cleanest parity story. First.
2. **Phase B** (recap floor) — biggest month win; needs cache-correctness care.
3. **Phase C** (`#5`) — biggest change; schema + collector.

Each phase: analyze → plan → review → build → verify (parity gate) → commit,
measuring after each. Target: "all" < 0.5 s after all three.
