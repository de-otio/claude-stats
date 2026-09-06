# 01 — Why the shipped time fields cannot answer it

Three signals in the codebase look like they measure working time. All three
fail the question "hours on project X on day D", and two of them fail a
physical-plausibility invariant that no time metric may violate.

The invariant used throughout this document:

> **A day's engaged time cannot exceed 24 hours, and a session's engaged time
> cannot exceed its own wall-clock span.**

Any metric that violates this is not merely imprecise — it is measuring
something other than elapsed human time, and no amount of calibration repairs
it.

## 1.1 The three candidates

| Signal | Where | Grain | Verdict |
|---|---|---|---|
| `sessions.active_duration_ms` | [`store/index.ts:4077`](../../../packages/cli/src/store/index.ts#L4077), computed in [`parser/session.ts:462-472`](../../../packages/core/src/parser/session.ts#L462-L472) | per session | Right algorithm, wrong grain, and corrupted on re-collection |
| `duration.activeMs` in the day digest | [`recap/index.ts:1017-1028`](../../../packages/cli/src/recap/index.ts#L1017-L1028) | per topic-segment | Duplicates whole-session duration onto every segment |
| `first_timestamp` / `last_timestamp` | `sessions` | per session | Wall clock — already banned as a time basis |

## 1.2 `active_duration_ms`: the algorithm is right, everything around it is wrong

The parser already computes precisely the metric this analysis recommends —
a gap-capped union over sorted timestamps:

```ts
// Compute active session duration, excluding idle gaps > 30 minutes
if (allTimestamps.length >= 2) {
  const sorted = allTimestamps.slice().sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap < 30 * 60_000) active += gap;
  }
  activeDurationMs = active;
}
```
— [`core/src/parser/session.ts:462-472`](../../../packages/core/src/parser/session.ts#L462-L472)

That is sound *within one session*. Two things break it:

**(a) It is accumulated, not recomputed, on incremental collection.** The
session upsert adds the newly-parsed slice's duration to whatever is already
stored:

```sql
active_duration_ms = COALESCE(sessions.active_duration_ms, 0)
                   + COALESCE(excluded.active_duration_ms, 0),
```
— [`cli/src/store/index.ts:1109`](../../../packages/cli/src/store/index.ts#L1109)

Every sibling column on that upsert is either a genuine running total
(`input_tokens`, `prompt_count`) or a replacement (`models`, `repo_url`).
Duration is neither: it is a *derived measure over the whole timeline*, and
adding slice-wise results double-counts any span re-parsed by a backfill or an
overlapping collection window.

Measured on a real database, across the 1 398 sessions carrying both a
duration and an end timestamp: **61 (4.4 %) report more active time than their
own wall-clock span** — impossible for a union metric.
The worst substantive case is a 93-prompt session reporting 1.53 h of active
time inside a 0.5 h span (3.1×).

**(b) It cannot be summed across sessions.** Subagents and parallel sessions
are separate rows with overlapping timelines, so adding them counts the same
wall-clock minute once per concurrent stream. This is not a rounding error.
Summing `active_duration_ms` by the day each session started, over one
machine-month:

| Basis | August total | Max single day | Days over the 24 h ceiling |
|---|---|---|---|
| Naive sum of `active_duration_ms` | **719.9 h** | **144.0 h** | **11 of 31** |
| Gap-capped union of `messages.timestamp` | 272.1 h | 12.5 h | 0 |

The naive basis is 2.6× high in aggregate, and it fails the invariant on a
third of all days.

It is also unstable in the *other* direction, which is easy to miss: because
the field is attributed to the day the session *started*, a long-lived session
dumps its entire duration on its first day and leaves the following days
reading near zero. Five days in the same month report under 1 h. A metric that
is 14× high on one day and 10× low on the next is not usable as a trend, let
alone a burn-down.

## 1.3 The day digest duplicates duration across segments

`summarize_day` clusters a session into topic-segments, then computes each
segment's duration by summing the *whole session's* `active_duration_ms`:

```ts
// duration: sum wallMs and activeMs across contributing sessions
for (const sessionId of sessionIds) {
  const session = allSessions.find((s) => s.session_id === sessionId);
  if (session) {
    wallMs += Math.max(0, sessionWall);
    activeMs += session.active_duration_ms ?? 0;
  }
}
```
— [`cli/src/recap/index.ts:1017-1028`](../../../packages/cli/src/recap/index.ts#L1017-L1028)

A session split into three segments contributes its full duration three times,
and `totals.activeMs` sums those duplicates. Observed: a single calendar day
reporting **48 h** of active time.

The fix pattern already exists **fourteen lines below**, where cost was given
exactly this treatment:

```ts
// estimatedCost: sum per-message cost over exactly the messages in this
// task's segments (NOT every message in a contributing session — that
// double-counts when a session spans multiple clusters), plus folded-in
// subagent cost.
```
— [`cli/src/recap/index.ts:1030-1033`](../../../packages/cli/src/recap/index.ts#L1030-L1033)

Cost is computed over the segment's own messages; duration is not. This is a
straightforward inconsistency, and the remedy is to apply the same
message-scoped computation to time — which is what [04](04-implementation-plan.md)
proposes.

Two further properties make the digest unsuitable regardless of the bug: its
durations are not clipped to the requested day, and its item list is ranked
and scored for narrative, not exhaustive for accounting.

## 1.4 Wall clock is already ruled out — and the recommendation does not revive it

`last_timestamp − first_timestamp` is ambiguous across resumes and is named on
the do-not-build list in
[human-time-saved/03 §"do not build"](../human-time-saved/03-improvement-options.md);
[06-limitations.md](../06-limitations.md) predates that ruling and still offers
it as "a rough duration".

It matters that the metric recommended here is **not** wall clock and does not
reopen that question. It is the same gap-capped union the parser already
performs, moved to the right grain. The distinction is exact: wall clock counts
the idle overnight gap, the union does not.

This also settles design choice #2. `active_duration_ms`'s 30-minute semantic
is documented and consumed by shipped velocity metrics
([`reporter/index.ts:575-580`](../../../packages/cli/src/reporter/index.ts#L575-L580))
and by the org aggregate plane
([`org/aggregate.ts:298`](../../../packages/cli/src/org/aggregate.ts#L298)).
Redefining it would silently change those. The upsert bug in §1.2(a) should be
fixed because it is a bug; the *grain* problem should be solved by computing at
query time, not by mutating the stored field.

## 1.5 What this leaves

No shipped field answers the question, but the raw material is intact:
`messages.timestamp` is indexed
([`idx_messages_timestamp`, `idx_messages_session_ts`](../../../packages/cli/src/store/index.ts)),
every message joins to a session carrying `project_path`, and
`messages.is_turn_start` marks human turns. The metric in
[02](02-the-engaged-time-metric.md) needs nothing else.
