# `#5` — non-additive metrics → ingest-time derived tables: design

The last wide-period lever. After Phase A / `#7` / Phase B, the dominant
remaining `buildDashboard("all")` cost is the two **per-message, non-additive**
passes (profiled, warm, "all"): `buildModelEfficiency` ~400ms and
`buildContextAnalysis` ~280ms — together ~680ms of the ~1.3s "all" refresh.
They can't be served by an additive rollup (turn classification and per-session
token trajectory are sequence-dependent), so the fix is to compute them **once
at ingest** into derived tables the dashboard then aggregates cheaply.

> **Honest scoping note.** This is the biggest, most correctness-sensitive
> phase of the program — comparable to the whole of Build 2 — and the lowest
> marginal value (it speeds the *opt-in* "all"/wide views; the default "day"
> path is already ~0.14s). It writes to the user's live DB via the collector,
> so a consistency bug corrupts real data. Build it as a focused effort with
> the full parity discipline; do not rush it. Recommended to **stage by half**
> (turn-efficiency first, context second), each its own analyze→build→verify.

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

## Half A — turn-efficiency (`buildModelEfficiency`, ~400ms)

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
  JS. Cardinality: ~one row per prompt (tens of thousands) — smaller than
  messages, but **not tiny**; the overuse list needs per-turn rows, so keep
  per-turn granularity and rely on the `first_ts` index for period pruning.
- **Parity gate:** rollup-built `ModelEfficiencyData` == current
  `buildModelEfficiency` output, field-by-field, on the live DB (reuse the
  oracle pattern). `scoreComplexity`/`estimateCost` are pure, so per-turn rows
  reproduce exactly.

## Half B — context-analysis (`buildContextAnalysis`, ~280ms)

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
   drift (this is the bug the `#7` review caught).
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

`buildDashboard("all")` ~1.3s → ~0.6s (removing the ~680ms of per-message
passes). Combined with the shipped phases, "all" approaches the < 0.5s target;
the default "day" path is unaffected (already fast).

## Recommendation

Build **Half A (turn-efficiency)** first — bigger win (~400ms), self-contained,
clean per-session recompute. Verify + commit. Then **Half B**. Each via
analyze→ (this design) →review→build→parity-verify→commit, mirroring `#7`.

---

## Review outcome — BLOCKED on a behaviour decision + corrections

A correctness review against the actual code found the design is **not
output-preserving as written**. Five blockers; the first is a product decision.

### ⛔ Blocking decision — turn-assembly semantics (the user's call)

`buildModelEfficiency` assembles turns from a **single global `ORDER BY
m.timestamp ASC` stream** (`store/index.ts:1257`) with one `current` turn
carried across the whole stream (`dashboard/index.ts:1467-1501`). When sessions
**interleave** in global time order (parallel sessions, subagents — common), a
continuation from session B arriving while `current` belongs to A hits the
"different session → flush + drop" branch (`:1494`): A's turn is flushed early
and B's continuation is **dropped from classification**. So turn boundaries
**depend on cross-session interleaving** — the function is pure in *global*
order, NOT per-session.

A per-session derived table (this design's premise) therefore **cannot
reproduce** today's output: per-session assembly would absorb continuations the
live path drops, changing token sums, tier counts, and the overuse list.

To build Half A correctly we must **first refactor `buildModelEfficiency` to
assemble turns per-session** (group by session before the state machine, as
`buildContextAnalysis` already does). That is a **deliberate behaviour change**
— some continuations get classified differently — requiring sign-off and a
test re-baseline, exactly like the message-timestamp decision. Only then does a
per-session derived table match.

**Decision needed:** adopt per-session turn assembly (behaviour change, then
build) — or leave `buildModelEfficiency` as-is and abandon Half A.

### "all"-only scope (BLOCKER 1 + 3)

The derived `first_ts` window ≠ the live per-message `m.timestamp` clip-then-
assemble for any bounded period. The optimization is sound **only for
`period === "all"`** (since=undefined → no clip), which is the target anyway.
Bounded periods keep the live path (they're already fast post-Build-1). Make
this explicit, mirroring `#7`'s `getMessageTotals` unbounded-only dispatch.

### Corrections to fold in

- **`summary.totalMessages`** = count of in-period *messages* (incl. orphan
  continuations the turn loop drops); not reconstructable from turn rows. Source
  it from a message `COUNT(*)`, not `SUM(turn.message_count)`.
- **`markSourceDeleted` → do NOT delete** derived rows. Reads are EXISTS-only
  (confirmed: `getMessagesForEfficiency`/`getMessagesForContext` filter neither
  is_interactive nor source_deleted nor is_subagent); `markSourceDeleted` leaves
  the session row present so EXISTS stays true. Deleting would cause drift.
  (My original rule was backwards — same lesson as `#7`.)
- **Recompute must `getSessionMessages` (full re-read)**, not `parsed.messages`
  (append only yields the delta; turn assembly + position array need the whole
  ordered session). Accumulate `touchedSessions` and recompute after upserts
  commit, like `recomputeMessageHourly`.
- **Per-table freshness watermarks** (`turn_efficiency_watermark`,
  `session_context_watermark`), written in the same txn as each recompute;
  COUNT-based watermark is necessary-not-sufficient (in-place message updates
  change turn boundaries without changing COUNT) — rely on collect always
  recomputing touched sessions; non-collect mutations fall back to live.
- **contextGrowthCurve** reconstructs correctly ONLY if the reader sums raw
  per-position values + counts sessions (not averages-of-averages), and
  replicates the `break`-on-`count<3` and 50-position cap exactly.

### Honest cost note

The win's real source is "stop re-scoring every turn on every load" (the
per-turn `scoreComplexity`+2×`estimateCost`), not "fewer rows." Even done, "all"
stays **O(turns)** (grows with history) — capped, not eliminated. Marginal
value: speeds the **opt-in** "all"/wide views (~1.3s → ~0.6s); the default
"day" path is already ~0.14s.

### Recommendation

`#5` is the largest, most correctness-sensitive, lowest-marginal-value phase,
and Half A now requires a **behaviour-change decision** before it's buildable.
Recommend: decide the turn-assembly question first; given the value/risk, this
is a reasonable place to **stop the program** (default startup long-solved,
wide periods already much improved with a spinner) unless "all" < 0.5s is a
hard requirement.
