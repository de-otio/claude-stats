# 07 — Compaction Analytics

Implements [§4.7](../schema-drift-2026-09/04-feature-opportunities.md).

The theme: `contextCarry` and `autoCompactFit` are among the most carefully
reasoned modules in the repo, and **almost every compaction-related quantity in
them is an inference with a measurable error.** This chapter replaces the
inferences with the client's own numbers, and quantifies each error so the change
can be reviewed as a correction rather than a refactor.

## 7.1 Observed reality

933 transcript files across 47 project dirs, read-only, 2026-09-01.

**The compaction record is `type: "system"`, `subtype: "compact_boundary"`** —
not a distinct entry type. Envelope keys (n = 903):

```
compactMetadata, content, cwd, entrypoint, gitBranch, isMeta, isSidechain,
level, logicalParentUuid, parentUuid, sessionId, slug, subtype, timestamp,
type, userType, uuid, version
```

### `compactMetadata` — the parent doc's `messageCount` does not exist

| Field | Type | Observed (n = 903) |
|---|---|---|
| `trigger` | string | **`"manual"` on all 903. No `"auto"` observed** — the value domain beyond `manual` is **UNVERIFIED** |
| `durationMs` | number | min 60,109 · p25 114,115 · **median 132,575** · p75 150,181 · p95 171,265 · max 200,340 |
| `preTokens` | number | min 58,943 · median 236,033 · p95 523,307 · max 746,295 |
| `postTokens` | number | min 7,770 · **median 16,342** · p95 24,603 · max 28,464 |
| `cumulativeDroppedTokens` | number | **not `preTokens − postTokens`** — equality held in only 137/903. It is a **session running total** across compactions |
| `preservedMessages` | object | `{anchorUuid, uuids[], allUuids[]}` — `uuids` length median 1, p95 3, max 7 |
| `preservedSegment` | object | `{headUuid, anchorUuid, tailUuid}` |
| `preCompactDiscoveredTools` | array \| absent | present in 806/903 |

> [02 §2.2](../schema-drift-2026-09/02-transcript-schema-changes.md) lists
> `messageCount`. **There is no such field.** The nearest thing is
> `preservedMessages.uuids.length` — a *preserved*-message count, not a
> *collapsed*-message count. The quantity readers actually want is token volume.

Window: 2026-07-28 → 2026-09-01, Claude Code 2.1.220–2.1.245.

**Replay factor 2.32×** — 903 occurrences, **389 unique uuids**, across 73
sessions. Per-file counts run 1…136; 28 files have exactly 1.

**`isCompactSummary`:** 903 occurrences, **389 unique uuids — exactly 1:1 with
`compact_boundary`.** Every one is `type: "user"`, `message.content` a **string**
(not a block array), `isMeta` **absent**, `isVisibleInTranscriptOnly: true`.
`isVisibleInTranscriptOnly` occurred 903 times and **never** on a
non-compact-summary entry — on this corpus it carries zero information beyond
`isCompactSummary`.

## 7.2 A live bug this data proves

The parser dedupes `type: "assistant"` only (`session.ts:167`, `:305-306`);
**user entries are never deduped** — the same gap [04 §4.4](04-attribution-hardening.md)
measured at 62.5%.

A compaction summary is `!isMeta` and is not a tool-result carrier (its content
is a string), so at `session.ts:246-260` it hits `promptCount++`,
`pendingTurnStart = true`, **and `lastPromptText = extractPromptText(...)`**.

On this machine that is **903 phantom prompts across 73 sessions**, and up to
2,000 sanitised characters of a **model-authored conversation summary** written
into `messages.prompt_text` — which then flows into recap headlines
(`recap/templates.ts:97`) and `taskTitle` (`cost-per-task/index.ts:268`).

The `isCompactSummary` suppression from [01 §1.3](01-foundation.md) fixes the
count. **It must also suppress `lastPromptText`** — otherwise a summary keeps
leaking into user-visible headlines.

## 7.3 `contextCarry`: seven inferences and their errors

`packages/core/src/contextCarry.ts` (854 lines) is pure; all compaction knowledge
comes from `packages/core/src/hygiene/util.ts`:

- `detectResets` (`util.ts:266-284`) — a reset fires when
  `curTotal < prevTotal × (1 − 0.4)` **and** `prevTotal > 150,000`
  (`DEFAULT_DROP_RATIO`, `DEFAULT_RESET_MIN_BEFORE_TOKENS`).
- `contextIncrements` (`util.ts:199-216`) — the same 40% rule, floorless,
  classifying `"post-reset"`.
- Its own docstring is candid: *"this is inference from token counts, not an
  event log."*

| # | Inference today | Measured error | Replacement |
|---|---|---|---|
| **1** | **A reset happened** — 40% drop from >150K | **False negatives:** min observed `preTokens` is **58,943**, so every compaction starting below 150K is invisible. **False positives:** any resume or branch that drops ≥40% from >150K is counted as a compaction, indistinguishably. | An explicit event row. Exact count, no threshold. |
| **2** | **Where the boundary sits** — `beforeRow`/`afterRow`, two chain-adjacent messages | Off by up to one request each way: the boundary is placed at the first *billed request* after the drop, not at the compaction. Requests in between are attributed to the wrong cycle. | `logicalParentUuid` names the pre-compaction parent; `preservedSegment.{headUuid,anchorUuid,tailUuid}` names the seam. Zero-error boundary. |
| **3** | **`beforeTokens`** = `totalContext(beforeRow)` | Systematically **understates** — the last request's billed context excludes everything added after it and before the compaction fired. Median `preTokens` is 236,033; the gap is unbounded and unmeasured. | `compactMetadata.preTokens`. |
| **4** | **`afterTokens`** = `totalContext(afterRow)` | **Overstates** — `afterRow` is the first request *after* the summary, so it already includes the summary **plus** the next prompt **plus** re-read files. True floor median is **16,342**; a first post-reset request routinely carries several times that. | `compactMetadata.postTokens`. |
| **5** | **`distinctTokensEstimate`** counts each `"post-reset"` baseline in full as new content (`contextCarry.ts:228-240`, decision **D8**: *"this tool cannot see whether a compaction summary is new text or a restatement"*) | Biased **up** by the whole summary at every compaction: 389 × median 16,342 ≈ **6.4M tokens** charged to "distinct content" on this corpus. | `postTokens` **is** the restated volume. D8's blind spot closes: the post-compaction baseline splits into `postTokens` (restatement) + remainder (genuinely new). `amplificationEstimate` inherits the correction. |
| **6** | **Cycle membership / `remainingRequestsInCycle`** | Every error in #1 and #2 propagates: a missed reset merges two cycles (inflating `carryCost` for every turn in the first); a spurious one splits one (deflating it). **`carryCost` is linear in `remainingRequestsInCycle`, so this is the largest dollar-side error in the module.** | Cycles split at real events. |
| **7** | **Compaction is free** — no cost, no duration attributed to the event itself | Compaction is an LLM call over the whole context: median **132.6 s**, p95 171 s, input median 236K. At cache-read rates that is a real per-event line item, 389 times on this machine. | `durationMs` is measured. The *cost* is still not directly in `usage` — **UNVERIFIED** whether a compaction's own API call appears as an assistant message. Check before claiming a dollar figure. |

These are **ledger and attribution corrections**. `carriedTokens`
(`SUM(totalContext)`) is measured today and does not change.

## 7.4 `autoCompactFit`: five more, and one that may invalidate shipped advice

`packages/core/src/autoCompactFit.ts` (918 lines) consumes `ContextCarryResult`
and never re-derives resets, so it **inherits** all of §7.3, plus:

| # | Inference | Error | Replacement |
|---|---|---|---|
| **8** | **`observedFloorTokens`** = mean of inferred `afterTokens`; `simulateSlice` (`:609-660`) restarts every simulated cut from it. Its own doc (`:175-179`): *"an earlier compaction … would plausibly land LOWER, so using the observed floor understates savings. Stated, not modelled."* | Inherits #4 — the floor is overstated, so `savedTokens` is understated, in a direction the module flags but cannot quantify. | `mean(postTokens)` — median **16,342**. The "an earlier compaction lands lower" caveat remains, but becomes the *only* one. |
| **9** | **`observedPeakTokens` / `observedMaxPeakTokens`** (`:180-190`) — mean and max of inferred `beforeTokens`. `observedMaxPeakTokens` gates the `at-or-above-peak` candidate filter and the `already-tuned` verdict (`ALREADY_TUNED_FRACTION = 0.15`, `:421`). | Inherits #3 (understated). An understated max peak **drops candidate windows that would in fact have cut**, and makes `already-tuned` fire too readily. **This changes the recommendation, not just a displayed number.** | `max(preTokens)` / `mean(preTokens)` — 746,295 / ~236,033 here. |
| **10** | **`resetFloorUsed` / `resetFloorDefault`** (`:194-197`, constant duplicated at `:432`) — a whole *adaptive-floor* machinery exists purely to work around the 150K threshold, and the result carries both values so a reader can explain why two screens show different reset counts. | Pure inference overhead. | **Deletable.** Under measured mode the floor has no meaning. Keep the fields nullable for one release, then drop. |
| **11** | **`MIN_RESETS_FOR_SAWTOOTH = 3`** (`:412`) → the `no-sawtooth` degraded verdict | Sessions with 1–2 *real* compactions below the 150K floor produce 0 detected resets and are silently excluded. **28 of 73 files here have exactly 1 compaction.** | Real counts; the ≥3 gate can stay, but now gates on truth. |
| **12** | **`trigger` is unknown.** The module recommends `autoCompactWindow`, a setting that only affects **auto** compaction. | **The load-bearing one.** All 903 observed triggers are `"manual"`. If this corpus is representative, `computeAutoCompactFit` has been recommending a window setting for a workload whose compactions are all user-issued `/compact` — **where the setting would change nothing.** The module cannot currently tell. | `compactMetadata.trigger`. Split resets into auto vs manual, compute the fit **only over auto events**, report the manual count as a stated exclusion. |

> **#12 is a shipped-advice correction, not a feature.** It should be surfaced to
> the user as such — see [09 §9.5 Q5](09-sequencing.md).

## 7.5 `ttlFit` × compaction

`packages/core/src/ttlFit.ts` (669 lines) has **zero** compaction awareness — a
grep for `compact`/`reset` returns only two unrelated strings (`:614`, `:621`).
It is a pure idle-gap histogram (`shortTtlMs` 5 min, `longTtlMs` 60 min).

Two interactions:

1. **Benign.** Max observed compaction `durationMs` is **200,340 ms ≈ 3.3 min**,
   strictly below the 5-minute `shortTtlMs`, so a compaction pause never crosses
   the short-TTL bucket edge. *This is an observation, not a guarantee* — assert
   it, don't assume it.
2. **Real.** A compaction discards the prefix. The pre-compaction cache entry is
   dead regardless of TTL, and the post-compaction request is a cache **write**
   whichever TTL was configured. `ttlFit`'s `extra = R × (write5m − read)` counts
   reads-recovered-by-1h across every gap, **including the gap that straddles a
   compaction**, where the 1-hour TTL recovered nothing because the prefix
   changed. 389 events here — a small but systematic **overstatement of the
   1-hour TTL's benefit**.

**Recommendation (low priority, additive):** once `compaction_events` exists,
`computeTtlFitForWindow` should mark gaps spanning a compaction as a fourth
origin (`post-compaction`, alongside `session-start` / `mid-work` /
`resume-short` / `resume-long`) and exclude them from the `R` term.

## 7.6 Is the assistant dedupe still necessary?

**Yes — unconditionally. Do not remove it.** Three independent reasons:

1. **Explicit records do not remove the duplicates.** The dedupe exists because
   resumes and compaction replay earlier turns verbatim. Knowing a compaction
   *happened* says nothing about which of the following assistant entries are
   replays. The evidence is in the compaction records themselves: **903
   occurrences, 389 unique uuids — the event log is itself replayed 2.32×.** A
   mechanism that duplicates its own event log will certainly duplicate assistant
   turns.
2. **The correctness argument is billing, not compaction.** One API call was
   charged once. `messages` collapses on `uuid PRIMARY KEY`; the session
   accumulators must match or they can never reconcile with the rows they
   summarise. That invariant is independent of *why* a uuid repeats.
3. **Replay is not only compaction-caused.** A resumed session replays history
   into a new file, and nothing in `compactMetadata` covers that path.

**Corollary for V23:** `compaction_events(uuid PRIMARY KEY)` handles the 2.32×
replay by upsert, the same idempotency pattern as `messages` and
`api_error_events`. And the *missing* dedupe is on the **user** side —
`isCompactSummary` suppression must be **unconditional per occurrence**, not
gated on first sight, because the same summary uuid recurs 2.32× and each
occurrence currently costs one phantom prompt.

> This is a third, independent confirmation of the same defect found in
> [03 §3.0](03-cost-verification.md) (assistant `message.id` duplication) and
> [04 §4.4](04-attribution-hardening.md) (user-entry uuid replay). Three
> chapters, three samples, one root cause: **the parser's dedupe model is
> incomplete on both sides.**

## 7.7 MCP result shapes and the redaction constraint

| Tool | Location | Posture |
|---|---|---|
| `get_context_carry` | `packages/cli/src/mcp/index.ts:1255-1341` | Spreads `ContextCarryResult` minus a denylist. **Dropped:** `concentration`, `preludeByProject`, `turns`. **`resets`/`cycles` returned with `sessionId` stripped** per element. `autoCompactFit` is pulled out of the rest-spread *deliberately* and rebuilt **field-by-field as an allowlist**, because a rest-spread is a denylist-by-omission that would silently carry future fields. |
| `get_cache_ttl_fit` | `:893-970` | Full `TtlFitResult`; states explicitly it *"deliberately does not return session ids"*. |
| `get_autocompact_window_fit` | — | **Does not exist.** The fit reaches MCP only as `get_context_carry`'s `autoCompactFit` sub-object. |

> **Binding constraint.** Compaction *numbers* are safe.
> `preservedMessages.uuids`, `preservedSegment.*Uuid`, and `logicalParentUuid`
> are **message identifiers** and fall under the same rule that already strips
> `turns[].uuid`. They must never cross the MCP boundary. Add compaction
> aggregates to the payload only as counts and percentiles; add uuid-bearing
> fields via the allowlist — i.e. **not at all**.

## 7.8 Design

### Parser capture

New `case` inside `case "system":`, after the existing `api_error` arm
([01 §1.3](01-foundation.md)):

```ts
if (entry.subtype === "compact_boundary" && entry.uuid && entry.compactMetadata) {
  const cm = entry.compactMetadata;
  compactionEvents.push({
    uuid: entry.uuid,
    sessionId: entry.sessionId ?? sessionId ?? "",
    timestamp: ts,
    durationMs:              intOrNull(cm.durationMs),
    preTokens:               intOrNull(cm.preTokens),
    postTokens:              intOrNull(cm.postTokens),
    cumulativeDroppedTokens: intOrNull(cm.cumulativeDroppedTokens),
    preservedMessageCount:   Array.isArray(cm.preservedMessages?.uuids)
                               ? cm.preservedMessages.uuids.length : null,
    logicalParentUuid:       strOrNull(entry.logicalParentUuid),
    trigger:                 strOrNull(cm.trigger),
  });
}
```

**Free text dropped at the parser:** `entry.content` (the compaction narrative),
`preCompactDiscoveredTools`, and `slug` are **not captured**. Uuid arrays are
reduced to a **count** at the parser and never stored — `preservedMessages.uuids`
(max 7) and `preservedSegment` add no analytic value that `postTokens` does not
already carry, and storing them would put message identifiers in a second table
for nothing.

In the `user` case, **before** the prompt accounting at `:246`:

```ts
if (entry.isCompactSummary === true) {
  // Synthetic: not a human prompt, not a turn start, not prompt text.
  if (ts !== null) lastUserTimestamp = ts;   // it IS a real clock event
  break;   // skips promptCount++, pendingTurnStart, lastPromptText
}
```

Run this **unconditionally per occurrence** — the same uuid recurs 2.32×, and
each occurrence currently costs one phantom prompt. **Do not key the suppression
on `isVisibleInTranscriptOnly`**: it was 1:1 with `isCompactSummary` on 903/903
and adds nothing, and its independent semantics are UNVERIFIED.

### DDL — three changes to the sketch in [01 §1.4](01-foundation.md)

1. **`message_count` is not a real field.** Replace with
   `preserved_message_count INTEGER`, and document that it is a *preserved*
   count, not a *collapsed* count.
2. **Add the three token columns** — they are the entire analytic payload and are
   absent from the sketch. Store `cumulative_dropped_tokens` verbatim but
   **never** derive per-event dropped from it (a session running total; equality
   with `pre − post` held in only 137/903). Per-event dropped is
   `pre_tokens − post_tokens`, computed at read time.
3. **`trigger` stays TEXT nullable, not a CHECK-constrained enum.** Only
   `"manual"` observed; `"auto"` is expected but UNVERIFIED, and an unexpected
   future value must land in the row, not abort the file transaction.

```sql
CREATE TABLE IF NOT EXISTS compaction_events (
  uuid                      TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL,      -- no FK, per 01 §1.4
  timestamp                 INTEGER,
  duration_ms               INTEGER,
  pre_tokens                INTEGER,
  post_tokens               INTEGER,
  cumulative_dropped_tokens INTEGER,
  preserved_message_count   INTEGER,
  logical_parent_uuid       TEXT,
  trigger                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_compaction_events_session ON compaction_events (session_id);
CREATE INDEX IF NOT EXISTS idx_compaction_events_ts      ON compaction_events (timestamp);
```

Add the timestamp index: **every** consumer here is window-scoped.

### Algorithm: a measured sibling, not a replacement

`hygiene/util.ts` gains a measured sibling that does **not** replace
`detectResets`:

```ts
export interface MeasuredResetEvent extends ContextResetEvent {
  source: "measured";
  trigger: string | null;
  durationMs: number | null;
  droppedTokens: number | null;   // pre - post
}
export function measuredResets(
  events: readonly CompactionEventRow[],
  rows: readonly HygieneMessageRow[],
): MeasuredResetEvent[];
```

It maps each event onto the chain by `logicalParentUuid` → `beforeRow`, next
chain row → `afterRow`, and sets `beforeTokens = pre_tokens`,
`afterTokens = post_tokens` from the record.

`computeContextCarry` gains `options.measuredResets`. When supplied it uses them
**instead of** `detectResets` for `resets`/`cycles`/`sawtooth`, and
`contextIncrements` marks a `"post-reset"` increment's `postTokens` portion as
**restatement, excluded from `distinctTokensEstimate`** — closing D8. When
absent (old data, no records) behaviour is **byte-identical to today**.

Add `ContextCarryResult.resetSource: "measured" | "inferred" | "mixed"` so every
surface can say which it is. **A window mixing pre- and post-2.1.220 data is
`"mixed"` and must not present measured precision.**

`computeAutoCompactFit` gains `options.autoOnly` (default true under measured
mode): compute over `trigger === "auto"` events only, report
`manualResetsExcluded`, set `observedFloorTokens = mean(post_tokens)` and
`observedMaxPeakTokens = max(pre_tokens)`. `resetFloorUsed` /
`resetFloorDefault` become `null`.

## 7.9 Cost before/after per session — the query, and what confounds it

```sql
WITH ev AS (                       -- one row per REAL compaction (uuid PK dedupes replay)
  SELECT uuid, session_id, timestamp AS ts, trigger,
         pre_tokens, post_tokens, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp) AS seq
  FROM compaction_events
  WHERE timestamp IS NOT NULL AND timestamp >= :since AND timestamp < :until
),
win AS (                           -- the request window on each side of the seam
  SELECT e.uuid, e.session_id, e.ts, e.trigger,
         COALESCE(LAG(e.ts)  OVER (PARTITION BY e.session_id ORDER BY e.ts), 0) AS prev_ts,
         COALESCE(LEAD(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts),
                  9223372036854775807) AS next_ts
  FROM ev e
),
m AS (
  SELECT session_id, timestamp, uuid,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
  FROM messages WHERE timestamp IS NOT NULL
)
SELECT w.session_id, w.uuid, w.trigger,
       SUM(CASE WHEN m.timestamp <  w.ts AND m.timestamp >= w.prev_ts THEN 1 ELSE 0 END) AS req_before,
       SUM(CASE WHEN m.timestamp >= w.ts AND m.timestamp <  w.next_ts THEN 1 ELSE 0 END) AS req_after,
       SUM(CASE WHEN m.timestamp <  w.ts AND m.timestamp >= w.prev_ts
                THEN m.input_tokens + m.cache_read_tokens + m.cache_creation_tokens END) AS ctx_before,
       SUM(CASE WHEN m.timestamp >= w.ts AND m.timestamp <  w.next_ts
                THEN m.input_tokens + m.cache_read_tokens + m.cache_creation_tokens END) AS ctx_after
FROM win w JOIN m ON m.session_id = w.session_id
GROUP BY w.session_id, w.uuid, w.trigger;
```

**Cost is not computed in SQL.** Pricing lives in `packages/core/src/pricing.ts`;
emit per-cycle token sums per model and price in core. Every other cost surface
does this, and a SQL-side cost would be a second pricing implementation.

### Seven confounds, in descending severity

1. **Cycles are not comparable units.** `req_before` and `req_after` are whatever
   happened to fit; `preTokens` spans 58,943 → 746,295. Comparing total cost
   across unequal request counts is meaningless. Normalise to **cost per
   request** — and even then see #2.
2. **Selection effect — the big one.** Compaction fires *because* context got
   large. The before-window is by construction the expensive tail of a cycle and
   the after-window its cheap start. A naive before/after shows a huge "saving"
   that is **the definition of the event, not an effect of it**. A before/after
   difference is not a causal estimate and must never be presented as one. The
   honest comparison is cycle N+1's trajectory against the *counterfactual
   continuation* of cycle N — which is exactly what `simulateSlice` already
   models, with its stated caveats.
3. **Rework is unmeasured.** `autoCompactFit`'s `SAVING_CAVEAT` (`:437-456`)
   already names it: the model re-reads files it lost. That rework lands in
   `req_after` and *is* caused by the compaction, but is indistinguishable from
   ordinary new work.
4. **The compaction's own cost is missing** — median 132.6 s over median 236K
   input. UNVERIFIED whether that call emits a billable assistant message; if it
   does not, `messages` under-counts and the "after" side is flattered.
5. **`trigger` skew.** All 903 observed are `"manual"` — a `/compact` is issued
   *when the human decides*, often at a task boundary, so the after-cycle is
   often a **different task**, not a continuation. **Auto and manual must never
   be pooled.**
6. **Session boundaries.** `LAG`/`LEAD` are per-session, but a resumed session is
   a **new** `session_id` with replayed history. Join
   `sessions.parent_session_id` before treating a first cycle as a baseline.
7. **Window edges.** The last cycle in every session is open
   (`ContextCycle.open`) and truncated by `:until`. `contextCarry` already
   excludes open cycles from `closedCycleCarriedTokens`; this query must too, or
   every session contributes one artificially cheap "after".

## 7.10 Surfaces

| File | Change |
|---|---|
| `packages/core/src/parser/session.ts` | `switch` conversion; `compact_boundary` case; `isCompactSummary` suppression; `compactionEvents` on `ParseResult` |
| `packages/core/src/types.ts` | `CompactionEvent` — numbers + `trigger` + `logicalParentUuid` only; **no `content`, no uuid arrays** |
| `packages/cli/src/store/index.ts` | `SCHEMA_VERSION` 22→23 (`:30`); `migrateToV23()`; `insertCompactionEvents` upsert; `getCompactionEvents(filters)` |
| `packages/core/src/hygiene/util.ts` | `measuredResets()`, `MeasuredResetEvent`; leave `detectResets` / `contextIncrements` untouched |
| `packages/core/src/contextCarry.ts` | `options.measuredResets`; `resetSource`; the D8 restatement split |
| `packages/core/src/autoCompactFit.ts` | `autoOnly`; `manualResetsExcluded`; measured floor/peak; null `resetFloorUsed`/`resetFloorDefault` under measured mode |
| `packages/cli/src/contextCarry/index.ts` | second store query; pass through to both core modules |
| `packages/cli/src/contextCarry/format.ts` | render `resetSource`, the trigger split, `durationMs` |
| `packages/cli/src/dashboard/index.ts` | `:2929` `detectResets(carryRows)` → measured when available; `:2931-2938` `compactionEvents` / `sessionsWithCompaction`; `:2998` `compacted`; `:3046` `compactionRate`; `:3051` `sessionsNeedingCompaction`; `ContextAnalysis` (`:747-782`) gains `resetSource` + `avgCompactionDurationMs` |
| `packages/cli/src/server/template.ts:1512-1536` | "Long sessions" *Compacted* column becomes measured; add duration |
| `packages/cli/src/mcp/index.ts:1255-1341` | extend the **allowlist** only — counts, trigger split, duration/token percentiles. **No uuid-bearing field.** |
| `packages/core/src/insight.ts:884-925` | `autoCompactSetupClause` must not recommend a window when every event is `manual` |
| `packages/core/src/ttlFit.ts` | (later) a `post-compaction` gap origin |

## 7.11 i18n

`cli.json → contextCarry.*`: `resetsMeasuredLine`, `resetsInferredNote`,
`resetsMixedWarning`, `compactionTriggerSplit`, `compactionDurationLine`.

`cli.json → contextCarry.autoCompactFit.*`: **`manualOnlyWarning`** (the §7.4 #12
finding — the highest-value new string in this chapter), `manualResetsExcluded`,
`measuredFloorNote`.

`dashboard.json → context.*`: `compactionSourceMeasured`,
`compactionSourceInferred`, `avgCompactionDuration`,
`tableHeaders.compactionDuration`.

`common.json`: `insight.setup.autoCompactManualOnly`.

## 7.12 Tests

1. **`compact_boundary` capture** — inline JSONL with the exact §7.1 key set →
   one row, correct values, **`content` absent from the row**.
2. **Replay** — the same uuid three times (the real 2.32× pattern) → exactly one
   row after upsert.
3. **`isCompactSummary` suppression** — a summary entry (string content, no
   `isMeta`) between two real prompts → `prompt_count` is 2, not 3, and
   `prompt_text` on the following message is **not** the summary. **This test
   fails on `master` today**; it pins the live bug in §7.2.
4. **Replayed summary** — the same summary uuid twice → still 2 prompts (proves
   the suppression is not first-sight-gated).
5. **`measuredResets` boundary** — `logicalParentUuid` maps to the right
   `beforeRow`; a missing or unknown one degrades to the inferred path rather
   than throwing.
6. **Back-compat** — no events supplied → output byte-identical to today's
   fixtures, `resetSource === "inferred"`.
7. **D8 correction** — measured mode with `postTokens` set →
   `distinctTokensEstimate` drops by exactly `Σ postTokens`.
8. **Manual-only fit** — all events `trigger: "manual"` → the manual-only
   degraded verdict, `manualResetsExcluded === n`, **no window recommended**.
9. **Property (fast-check)** — for any generated event stream,
   `Σ (pre − post)` is monotone against `cumulative_dropped_tokens` per session,
   and `measuredResets(...).length === distinct uuids`.
10. **`turns`/`cycles` correspondence** — `__tests__/context-carry.test.ts`
    already pins the self-delimiting invariant (`contextCarry.ts:327-347`);
    re-run it under measured mode. **The highest-risk regression.**
11. **MCP redaction** — snapshot `get_context_carry` and assert no field name
    matching `/uuid/i` and no 36-char uuid-shaped value.
12. **Migration idempotency** — V22 DB → V23 twice; `message_hourly`'s `COUNT(*)`
    watermark unmoved (`store:938-956`).

## 7.13 Effort, risks, open questions

**Effort: medium — 4–5 days.** §4.7's "small–medium" understates it. Parser +
DDL + store is ~1 day. The real cost is that `contextCarry` and `autoCompactFit`
are 854 + 918 lines of load-bearing doc comments, with decisions D2/D8/D9/D10/
D11/D12 and C4–C14 explicitly marked "read before changing". Threading a measured
path through them without breaking the `turns`/`cycles` partition identity is
~2–3 days including tests. Surfaces + i18n ×10 ≈ 1 day.

**Risks**

1. **Dual-mode divergence.** Two reset sources means two code paths that can
   disagree; the dashboard already carries a comment
   (`dashboard/index.ts:2887-2895`) about *not* showing two mutually inconsistent
   compaction counts. `resetSource` must reach every surface, and a `"mixed"`
   window must be visibly degraded.
2. **Silent regression in `simulateSlice`.** Changing `observedFloorTokens`
   changes every dollar figure the module emits. **Behaviour comparison on a real
   30-day window before and after is mandatory.**
3. **Retroactivity.** `compact_boundary` first appears 2026-07-28 / CC 2.1.220.
   Every older session is inference-only, forever — and a historical file must
   still exist and be re-parsed from byte 0 to populate the table.
4. **§7.4 #12 may invalidate existing advice.** If `autoCompactFit` has been
   recommending `autoCompactWindow` to users whose compactions are all manual,
   that is a shipped-advice correction, not just a feature.

**Open questions / UNVERIFIED**

- **`trigger` value domain.** `"auto"` is expected but 903/903 are `"manual"` on
  one machine. Needs a second corpus, or a deliberate auto-compact run, before
  the `autoOnly` filter ships.
- **Does the compaction call itself appear as a billable assistant message?**
  Determines whether §7.9 can attribute the compaction's own cost.
- **Is `preservedSegment` worth keeping?** Currently discarded as identifiers. If
  cycle-boundary precision ever needs `headUuid`/`tailUuid`, revisit — local-only.
- **Should `detectResets` be retired once coverage is high enough?** Not for
  years; old sessions never gain records.
