# `#5` — non-additive metrics → ingest-time derived tables: design

The last wide-period lever. Once additive aggregation is served by query-time
`GROUP BY` and the hourly rollup (see [05-rollup-design.md](05-rollup-design.md)),
the dominant remaining cost of `buildDashboard("all")` is the two
**per-message, non-additive** passes: `buildModelEfficiency` and
`buildContextAnalysis`. They can't be served by an additive rollup (turn
classification and per-session token trajectory are sequence-dependent), so the
fix is to compute them **once at ingest** into derived tables the dashboard then
aggregates cheaply.

This is the most correctness-sensitive part of the design: it writes to the
user's live DB via the collector, so a consistency bug corrupts real data, and it
benefits only the opt-in "all"/wide views (the default "day" path is already
fast). It needs the full parity discipline.

## Why these are per-session, not per-hour (simpler maintenance than `#7`)

Both metrics are **per-session sequence** computations:
- A *turn* (buildModelEfficiency) = a prompt-bearing message + its tool
  continuations, within one session.
- Compaction events + context-growth (buildContextAnalysis) = consecutive
  input-token deltas within one session.

So the derived tables are **keyed by session_id**, and the collector already
processes **one file = one session** at a time. Maintenance is therefore
simpler than `#7`'s hour-partitions: **when a session's file is upserted
(append or rewrite), recompute that session's derived row(s) from its current
messages.** No cross-session partition like hours. On `markSourceDeleted`,
delete the session's derived rows (these reads DO filter source_deleted via
the session join — confirm per the actual section queries).

## Half A — turn-efficiency (`buildModelEfficiency`)

Current: `getMessagesForEfficiency` fetches all in-period messages, assembles
turns (prompt-bearing message + continuations), `scoreComplexity` → tier →
`estimateCost(actual)` + `estimateCost(tier-appropriate model)` per turn, then
aggregates to `byModelTier` (count/cost/tierCost per model), `opusScore`s, and a
top-N `overuse` list.

**Derived table `turn_efficiency`** — one row per turn:
```sql
CREATE TABLE turn_efficiency (
  session_id     TEXT NOT NULL,
  turn_index     INTEGER NOT NULL,      -- 0-based within session
  first_ts       INTEGER,               -- turn's first message timestamp (for period filter)
  model          TEXT,
  tier           TEXT,                  -- haiku|sonnet|opus (scoreToTier)
  complexity     INTEGER,
  actual_cost    REAL,
  tier_cost      REAL,
  prompt_excerpt TEXT,                  -- for the overuse list (sanitised, truncated)
  PRIMARY KEY (session_id, turn_index)
);
CREATE INDEX idx_turn_eff_ts ON turn_efficiency (first_ts);
```
- **Ingest:** at the collector's per-file upsert, recompute that session's turns
  (assemble from the session's messages — the collector already has
  `parsed.messages`, or re-read via getSessionMessages) and `DELETE … WHERE
  session_id=? ; INSERT …`. Pure function of the session's messages → re-running
  is idempotent (matches the `#7` recompute-from-raw rule).
- **Backfill (migrateToV13):** compute for every existing session, once.
- **Read:** `buildModelEfficiency` for a period selects `turn_efficiency` rows
  with `first_ts` in window (or session-keyed to match the current
  `getMessagesForEfficiency` semantics — **confirm which axis** the section uses
  after Build 1; replicate EXACTLY) and aggregates `byModelTier` / `overuse` in
  JS. Cardinality: about one row per prompt — smaller than
  messages, but **not tiny**; the overuse list needs per-turn rows, so keep
  per-turn granularity and rely on the `first_ts` index for period pruning.
- **Parity gate:** rollup-built `ModelEfficiencyData` == current
  `buildModelEfficiency` output, field-by-field, on the live DB (reuse the
  oracle pattern). `scoreComplexity`/`estimateCost` are pure, so per-turn rows
  reproduce exactly.

## Half B — context-analysis (`buildContextAnalysis`)

Mixed: `lengthDistribution` + `longSessions` are **session-keyed** (already
cheap, from `rows`/`sessionCostMap` — leave as-is). The per-message parts are
`compactionEvents` (consecutive input-token drops > 40% within a session) and
`contextGrowthCurve` (avg input tokens at each prompt position, capped at 50).

**Derived table `session_context`** — one row per session:
```sql
CREATE TABLE session_context (
  session_id        TEXT PRIMARY KEY,
  first_ts          INTEGER,
  peak_input_tokens INTEGER,
  compaction_json   TEXT,   -- the session's compaction events (small array)
  position_inputs   TEXT    -- JSON: input_tokens at positions 1..50 (for the growth curve)
);
```
- **Ingest:** recompute per session at file upsert (same per-session rule).
- **Read:** aggregate `contextGrowthCurve` (sum position_inputs across in-period
  sessions) + collect `compactionEvents` from the rows. `position_inputs` is a
  ≤50-element array per session → the growth-curve aggregation is O(sessions),
  cheap.
- **Parity gate:** vs current `buildContextAnalysis`.

## Consistency rules (the hard part — same lessons as `#7`)

1. **Recompute-from-raw per session** on every file upsert (append/rewrite);
   never incremental deltas. Idempotent.
2. **Inclusion predicate must match the section's raw query EXACTLY** — confirm
   whether `getMessagesForEfficiency`/`getMessagesForContext` filter
   is_interactive / source_deleted / subagents (post-Build-1 they use
   `m.timestamp` + the EXISTS membership; replicate verbatim). Mismatch = silent
   drift (the same bug class as the rollup's inclusion predicate).
3. **Freshness guard** (like `#7`): the read dispatches to the derived table
   only when a watermark matches the messages count; else falls back to the
   live computation. Protects tests / non-collect callers.
4. **markSourceDeleted** → delete the session's derived rows IF the section
   filters source_deleted; if not (like energy/totals), leave them (EXISTS via
   the session join still excludes orphans). Confirm per section.
5. **Backfill** behind a schema-version bump; DROP+CREATE during pre-release
   iteration (as `#7`'s migrateToV12).

## Verification (mandatory)

- Live-DB field-by-field parity: derived-table `ModelEfficiencyData` /
  `ContextAnalysis` == current output, for day/week/month/all.
- Ingest maintenance tests (synthetic): append/rewrite/delete a session →
  derived rows == a from-scratch recompute; idempotent re-collect.
- Existing dashboard tests pass unchanged.

## Expected outcome

The wide-period `buildDashboard("all")` path stops re-scoring every turn and
re-walking every message on each load; it reads per-session and per-turn rows
instead. The win's real source is "stop re-scoring every turn on every load"
(the per-turn `scoreComplexity` plus two `estimateCost` calls), not "fewer rows":
even done, "all" stays O(turns) — capped, not eliminated. The default "day" path
is unaffected.

## Constraints that follow from the code

**Turn-assembly semantics are not per-session today.** `buildModelEfficiency`
assembles turns from a **single global `ORDER BY m.timestamp ASC` stream** with
one `current` turn carried across the whole stream. When sessions interleave in
global time order (parallel sessions, subagents — common), a continuation from
session B arriving while `current` belongs to session A hits the "different
session → flush + drop" branch: A's turn is flushed early and B's continuation is
dropped from classification. Turn boundaries therefore depend on cross-session
interleaving; the function is pure in *global* order, not per session. A
per-session derived table cannot reproduce today's output (per-session assembly
absorbs continuations the live path drops, changing token sums, tier counts and
the overuse list). Building Half A correctly means first refactoring
`buildModelEfficiency` to assemble turns per session (group by session before the
state machine, as `buildContextAnalysis` already does) — a **deliberate
behaviour change** that needs sign-off and a test re-baseline. The alternative is
to leave `buildModelEfficiency` as it is and not build Half A.

**"All"-only scope.** The derived `first_ts` window is not the live per-message
`m.timestamp` clip-then-assemble for any bounded period, so the optimisation is
sound only for `period === "all"` (no clip). Bounded periods keep the live path,
which is already fast; dispatch for the unbounded read only, as the rollup does.

**Corrections to the sketch above.**
- `summary.totalMessages` is the count of in-period *messages* (including orphan
  continuations the turn loop drops); it is not reconstructable from turn rows.
  Source it from a message `COUNT(*)`, not `SUM(turn.message_count)`.
- Do **not** delete derived rows on `markSourceDeleted`. Reads are EXISTS-only —
  `getMessagesForEfficiency` and `getMessagesForContext` filter neither
  `is_interactive`, `source_deleted` nor `is_subagent` — and `markSourceDeleted`
  leaves the session row present, so EXISTS stays true. Deleting would cause
  drift.
- Recompute must re-read the whole session (`getSessionMessages`), not
  `parsed.messages`: an append yields only the delta, while turn assembly and the
  position array need the whole ordered session. Accumulate `touchedSessions` and
  recompute after upserts commit, like `recomputeMessageHourly`.
- Use per-table freshness watermarks (`turn_efficiency_watermark`,
  `session_context_watermark`) written in the same transaction as each
  recompute. A COUNT-based watermark is necessary but not sufficient (in-place
  message updates change turn boundaries without changing the count), so rely on
  collect always recomputing touched sessions; non-collect mutations fall back to
  the live path.
- `contextGrowthCurve` reconstructs correctly only if the reader sums raw
  per-position values and counts sessions (not averages of averages), and
  replicates the `break`-on-`count<3` rule and the 50-position cap exactly.
