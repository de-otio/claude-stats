# 04 — Implementation plan

Four independent changes. Only the first is required for the tool; the two
defect fixes stand on their own merits and should not be bundled into one
commit with the feature.

## 4.1 The store method

`getMessageTimestamps` already exists
([`store/index.ts:2402-2438`](../../../packages/cli/src/store/index.ts#L2402-L2438))
and is close, but insufficient in three ways: it matches `project_path` by
exact equality (no prefix), accepts only `since` (no `until`), and returns bare
timestamps with no project label, so results cannot be grouped.

Add a sibling rather than widening it — the existing signature has callers:

```ts
getMessageTimestampsByProject(filters: {
  since: number;
  until: number;
  accountUuid?: string;
}): Array<{ ts: number; projectPath: string; isTurnStart: number }>
```

One indexed scan over `idx_messages_timestamp`, joined to `sessions` for
`project_path`. Grouping, day bucketing, the union, and the split rule all live
in a pure function in `core/` — no SQL beyond the fetch:

```ts
// core/src/engagedTime.ts
export function computeEngagedHours(
  rows: ReadonlyArray<TimestampRow>,
  opts: { capMinutes: number; split: SplitRule; timezone: string;
          groups: ProjectGroup[] },
): ProjectHoursResult
```

Keeping it pure matters here: the metric is parameter-sensitive and the
correctness argument in [02](02-the-engaged-time-metric.md) rests on invariants
(bounded by wall clock, bounded by 24 h, reconciling under `proportional`) that
are worth asserting directly as property tests, which is only cheap if the
function takes rows and returns a result.

**Cost check.** ~413 k messages in a mature database; a month window is a few
tens of thousands of rows on an indexed range scan. No caching, no new table,
no migration.

## 4.2 Fix the accumulating upsert (independent defect)

[`store/index.ts:1109`](../../../packages/cli/src/store/index.ts#L1109) adds
each collection slice's duration to the stored value, producing session rows
whose active time exceeds their own wall-clock span — 61 of the 1 398 sessions
carrying both fields (4.4 %) on the database measured, worst case 3.1×.

`active_duration_ms` is a derived measure over the whole timeline, not a
running total, so the accumulate is wrong in principle as well as in effect.
Two options:

1. **Recompute on upsert** from the session's full message set. Correct, and
   costs one extra query per changed session per collection.
2. **Clamp**: `MIN(accumulated, last_timestamp − first_timestamp)`. Cheap,
   restores the invariant, but silently under-reports genuinely resumed
   sessions.

Recommend (1), with (2) as a one-off repair pass for existing rows — there is
already a `claude-stats repair` command for derived data that normal collection
cannot fix retroactively, which is the natural home.

This fix does **not** change the field's 30-minute drop semantic, and so does
not disturb the velocity metrics
([`reporter/index.ts:575-580`](../../../packages/cli/src/reporter/index.ts#L575-L580))
or the org plane ([`org/aggregate.ts:298`](../../../packages/cli/src/org/aggregate.ts#L298)).

## 4.3 Fix the recap duration duplication (independent defect)

[`recap/index.ts:1017-1028`](../../../packages/cli/src/recap/index.ts#L1017-L1028)
sums the whole session's duration into every topic-segment, so
`totals.activeMs` counts a multi-segment session once per segment — observed at
48 h for a single day.

Apply the same treatment the cost calculation already documents fourteen lines
below ([`recap/index.ts:1030-1033`](../../../packages/cli/src/recap/index.ts#L1030-L1033)):
compute the duration over exactly the messages in the segment, via
`computeEngagedHours` from §4.1. The digest then gains a `totals.activeMs` that
obeys the 24-hour ceiling, and the two figures in the same object stop
disagreeing about which messages they cover.

## 4.4 Tests that fail on today's code

The invariants are the specification, and each of these fails now:

| Test | Asserts | Currently |
|---|---|---|
| `engaged ≤ wall clock`, over every session in a fixture DB | The core invariant | **Fails** — 4.4 % of rows |
| `Σ day hours ≤ 24` for every day in a multi-project fixture | Day ceiling | **Fails** — 11 of 31 days |
| Two fully-overlapping sessions in one project | Union equals one session's span, not two | **Fails** — doubles |
| Interleaved A/B/A messages, `split: "proportional"` | Per-group hours sum to `dayUnionHours` | n/a — new |
| Same fixture, `split: "duplicate"` | `coverage.reconciles === false` | n/a — new |
| Gap of exactly `capMinutes` ± 1 ms | Contribution is continuous across the boundary | n/a — new; the *drop* rule is discontinuous here by construction |
| Empty window | Returns the no-activity note, not `0.0` as a measurement | n/a — new |
| Session spanning midnight | Time lands in both days, split at the local boundary | **Fails** for `active_duration_ms` (all on start day) |

Property-based coverage is worthwhile for the first three: generate random
timestamp sets and assert the bounds hold for every cap value. The failure mode
this guards against — a metric that silently exceeds physical possibility — is
exactly what shipped.

Fixtures must pin the timezone; day bucketing is the one place a passing test
can become a failing one in another zone.

## 4.5 Sequencing

1. `core/src/engagedTime.ts` + property tests (pure, no DB) — establishes the
   invariants before anything depends on them.
2. `getMessageTimestampsByProject` + `projectGroups` config plumbing.
3. `get_project_hours` MCP tool + `claude-stats hours` CLI parity.
4. §4.2 upsert fix + `repair` pass — separate PR, own regression test.
5. §4.3 recap fix, now that `computeEngagedHours` exists — separate PR.

Steps 4 and 5 are the ones that change existing numbers. Each should say so in
its own changelog entry: reported active-duration figures will **drop**, and
that is a correction, not a regression — the same framing the pricing-basis
note uses for the cache-TTL cost correction.
