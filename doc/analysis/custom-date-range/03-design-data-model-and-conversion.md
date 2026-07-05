# Design: data model and period → range conversion

## Shape of the new field: additive, not a discriminated union

Two options were considered:

**A. Replace the string union with a discriminated type**, e.g.
`type PeriodSpec = { kind: "preset"; preset: Preset } | { kind: "custom"; since: string; until: string }`,
used everywhere `period?: "day"|"week"|"month"|"all"` appears today.

**B. Add `since?`/`until?` alongside the existing `period?` field**, with a
simple precedence rule: if both `since` and `until` are present, they win;
otherwise fall back to `period` exactly as today.

**Decision: B.** Reasons:

- The store already speaks `since`/`until` as raw numbers everywhere (see
  [02](02-current-architecture.md)) — option B extends that idiom one layer
  up instead of introducing a second vocabulary (`kind`/`preset`/`custom`)
  that every call site would need to branch on.
- It's strictly additive: every existing caller that sets `period` and
  nothing else keeps working unchanged. A discriminated union would force
  every one of the ~6 duplicated-type call sites to be touched and
  recompiled even where behavior doesn't change.
- It matches the precedent already in the codebase: `summarize_day`'s
  `date` param coexists with nothing else because it's the only field on
  that tool, but the general pattern in this codebase for "optional
  override of a computed default" is bare optional fields, not tagged
  unions (e.g. `ReportOptions.timezone` overrides the OS default the same
  way `since`/`until` would override the preset).

Field types: `since?: string` / `until?: string`, both `YYYY-MM-DD`
(inclusive on both ends, interpreted in the request's `timezone`), mirroring
the existing `summarize_day.date` and `recap --date` convention rather than
raw epoch-ms — callers (CLI users, MCP clients, humans typing a URL) think
in calendar dates, not milliseconds. Internal plumbing still converts to
epoch-ms once, immediately, at the boundary (see below).

## One converted type, still centralize it

Even though the *field* addition is minimal, the current ~6-way duplication
of the plain `"day"|"week"|"month"|"all"` literal (§02) is worth collapsing
into one exported type now, since this change touches every one of those
sites anyway:

```ts
// packages/cli/src/reporter/index.ts (promote to packages/core/src/types/ if
// cost-per-task and mcp need it without importing reporter's other exports)
export type Preset = "day" | "week" | "month" | "all";

export interface DateRangeOpts {
  period?: Preset;
  since?: string;   // YYYY-MM-DD, inclusive, in `timezone`
  until?: string;   // YYYY-MM-DD, inclusive, in `timezone`
}
```

`ReportOptions` extends `DateRangeOpts` instead of declaring `period`
inline; `cost-per-task/index.ts`'s local `Period` type and `alerts.ts`'s
`PERIODS` array reference the shared `Preset` type instead of re-declaring
the literal (alerts keeps its own `"day"|"week"|"month"` subset since it
has never supported `"all"` — that's an existing, intentional difference,
not a bug to fix here).

## `periodRange()`: the new conversion function

Replace (or supplement — see migration note) `periodStart()`'s single-value
return with a function that always returns both boundaries:

```ts
// packages/cli/src/reporter/index.ts
export function periodRange(opts: DateRangeOpts, tz: string): { since: number; until: number } {
  if (opts.since || opts.until) {
    if (!opts.since || !opts.until) {
      throw new RangeError("since and until must be provided together");
    }
    const start = dayWindowInTz(opts.since, tz).startMs;
    const end = dayWindowInTz(opts.until, tz).endMs; // exclusive upper bound, end-of-day
    if (start >= end) {
      throw new RangeError(`since (${opts.since}) must be before until (${opts.until})`);
    }
    return { since: start, until: end };
  }
  const since = periodStart(opts.period, tz);
  return { since, until: Date.now() };
}
```

Notes:

- Reuses `dayWindowInTz` from `recap/index.ts` (already DST-safe, already
  exported) rather than duplicating date math a third time. This does
  create a `reporter/` → `recap/` dependency that doesn't exist today;
  alternatively hoist `dayWindowInTz`/`tzMidnight` into a shared
  `packages/cli/src/time.ts` and have both `reporter.ts` and `recap.ts`
  import from there — cleaner, and removes the near-duplicate
  `tzMidnight`/`localMidnightToEpochMs` implementations that currently
  exist in both files. Recommended as part of this change, not a
  prerequisite.
- Preset behavior is byte-for-byte unchanged: `until` for a preset is still
  `Date.now()`, exactly as every current call site computes it inline
  today. Only the custom-range branch introduces a non-`now()` `until`.
- Validation (`since`/`until` must come as a pair, start before end) throws
  synchronously with a message naming the offending values — every surface
  (CLI, MCP, web) is responsible for turning that into its own
  user-facing error shape (exit code / MCP error / HTTP 400), not for
  re-validating.

## Callers migrate from `periodStart` to `periodRange`

Every current `const since = periodStart(opts.period, tz)` call becomes
`const { since, until } = periodRange(opts, tz)`, and every current
`const rangeEnd = Date.now()` (computed separately, e.g.
`reporter/index.ts:256`) becomes `until` from the same call — this also
fixes the latent inconsistency where a preset's `rangeEnd` and its
`store.getSessions` "now" were computed at two slightly different instants.

`periodStart()` itself can stay as an internal helper `periodRange` calls
for the preset branch — no need to delete it, just stop exporting/calling it
directly from outside `reporter.ts`.

## Bucketing: granularity from range width, not from the preset string

`buildBuckets(period, tz, rangeStart, rangeEnd)` needs a case for when the
caller didn't have a preset name at all — i.e. today's implicit "else ⇒
monthly" branch needs to become a real decision. Add a granularity picker
keyed off the actual span, used whenever `period` is absent or `"custom"`:

```ts
function pickGranularity(rangeStart: number, rangeEnd: number): "day" | "week" | "month" {
  const days = (rangeEnd - rangeStart) / 86_400_000;
  if (days <= 9) return "day";      // ~1 week+slack → daily buckets, matches "week" preset shape
  if (days <= 62) return "week";    // ~1-2 months → weekly buckets, matches "month" preset shape
  return "month";                   // longer → monthly buckets, matches "all" preset shape
}
```

`buildBuckets` gains a `"custom"` period value that runs `pickGranularity`
and then falls into the existing day/week/month bucket-construction
branches by granularity rather than by literal preset string — this also
transparently fixes the pre-existing `"day"`-falls-into-monthly-buckets gap
noted in [02](02-current-architecture.md), since `"day"` should map to
daily buckets under the same rule (0-1 days → daily, single bucket).

Thresholds are a judgment call, not derived from a hard constraint;
9/62-day cutoffs approximate "keep the bucket count in a readable ~5-10
row range," matching what the three presets already produce (`week` → 7
rows, `month` → 4-5 rows, `all` → N months). Flag as tunable in code
review rather than treating as load-bearing.

## `datesForPeriod` (cost-per-task): parallel extension

`packages/cli/src/cost-per-task/index.ts:347-376` enumerates
`YYYY-MM-DD` day strings for the day-by-day recap pipeline. It needs the
same `since`/`until` acceptance, structurally separate from `periodRange`
because its output shape (a list of day labels, not a `{since, until}` pair)
is different:

```ts
export function datesForPeriod(opts: DateRangeOpts, tz: string, nowMs: number, earliestMs: number): string[] {
  if (opts.since && opts.until) {
    return enumerateDays(opts.since, opts.until); // new helper: inclusive day-string range
  }
  // existing preset logic, unchanged
}
```

The existing period-capping logic (there's a cap test at
`cost-per-task.test.ts:544` limiting how far back a period reaches) should
apply equally to a custom range — cap `since` to `earliestMs`/a max-days
bound rather than special-casing custom ranges as uncapped. See
[05](05-edge-cases-validation-and-tests.md) for the max-range guard
discussion.
