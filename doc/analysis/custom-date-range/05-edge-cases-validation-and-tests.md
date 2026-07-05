# Edge cases, validation, and test coverage

## Validation rules (enforced once, in `periodRange()`/`datesForPeriod()`)

1. **Both-or-neither.** `since` without `until` (or vice versa) is a hard
   error, not a silent fallback to the preset default — a partially-typed
   date pair silently reverting to `period=week` would be a confusing UX
   (user thinks they filtered, they didn't).
2. **`since` must be ≤ `until`** (day-granularity; equal is valid — a
   single-day custom range, e.g. `since=2026-03-14&until=2026-03-14`,
   should behave like the existing `recap --date` single-day case, not be
   rejected as degenerate).
3. **Malformed date strings** (`2026-13-40`, `March 3rd`) are rejected at
   the schema layer before reaching `periodRange()` — MCP's Zod `.regex()`
   catches the syntactic case; `Date.UTC`/`Intl.DateTimeFormat` calls inside
   `dayWindowInTz` will silently normalize some out-of-range values (e.g.
   `2026-02-30` rolls to March), so add an explicit round-trip check
   (format the parsed date back to `YYYY-MM-DD` and compare) rather than
   trusting `Date.UTC` to reject nonsense.
4. **Future dates.** `until` in the future is *not* an error (a user asking
   for `since=2026-01-01&until=2026-12-31` mid-year should just get data up
   to now, same as today's `period=all` doesn't error when "now" is
   mid-range) — clamp the effective upper bound to `Date.now()` rather than
   rejecting, matching existing preset semantics.
5. **No hard max-range cap by default**, but flag cost: an unbounded
   `since=2000-01-01&until=2026-12-31` on `getMessageTotalsRaw` or similar
   per-message-row queries is a full-table scan with no upper bound. This
   already happens today for `period=all` — the store has no cap on that
   path either — so a custom range isn't introducing a new class of
   problem, just a new way to spell the same "all" case with typos. No new
   guard is strictly required, but a soft warning (e.g. CLI prints "range
   spans N years, this may be slow" past some threshold like 2 years) is a
   cheap, non-blocking UX improvement worth doing alongside this change.

## Timezone interaction

`since`/`until` are interpreted in the request's `timezone` (the existing
`ReportOptions.timezone` field, defaulting to the OS timezone) — a user in
`America/Los_Angeles` requesting `since=2026-03-01` gets midnight Pacific on
March 1, not midnight UTC. This matches the existing `periodStart`/
`dayWindowInTz` behavior for presets and `recap --date`, so no new timezone
concept is introduced; the risk is purely in making sure `periodRange()`
actually threads `tz` through to both `dayWindowInTz` calls (one for
`since`, one for `until`) rather than defaulting one of them to UTC by
accident — worth a dedicated test (see below).

## Interaction with `activeSince` semantics

`Store.getSessions` has both `since` (session *started* after this instant)
and `activeSince` (session was *active* — i.e. `last_timestamp` — after this
instant) as distinct filters (`store/index.ts:1339-1340`), and
`buildDashboard` uses `activeSince`, not `since`, when calling
`getSessions` (`dashboard/index.ts:399-406`) so that a long-running session
that started before the period but continued into it is still counted. A
custom range needs the same treatment: `periodRange()`'s `since` return
value should feed `activeSince` (not `since`) wherever `buildDashboard`
currently does that substitution — this is an existing distinction to
preserve, not a new one to design, but it's easy to regress by having
`periodRange()`'s output plugged into the wrong field name at a call site
that was previously hand-wired to `activeSince`.

## Alerts (`packages/cli/src/alerts.ts`) — explicitly out of scope

`PERIODS` (line 18) covers `day`/`week`/`month` only, no `all` — alerts are
inherently about a *recent, bounded* trailing window ("has spend in the
last day/week/month crossed a threshold"), which doesn't have a meaningful
custom-range analog (an alert isn't "did spend between March 1 and March 15
exceed X," it's a live rolling check). Leave `alerts.ts` untouched; note the
decision explicitly in the PR so a reviewer doesn't wonder why it wasn't
extended.

## Test coverage to add/extend

Existing period-related tests (found in
[02](02-current-architecture.md#per-surface-entry-points) and reproduced
here for the extension checklist):

- **`reporter.test.ts`** — `describe("periodStart", ...)` (79-86): add a
  parallel `describe("periodRange", ...)` covering: preset passthrough
  (`until` = `Date.now()`, unchanged from before), custom pair happy path,
  both-or-neither rejection, `since > until` rejection, timezone-boundary
  case (a range that starts just after local midnight in a positive-offset
  tz to catch UTC-vs-local mistakes), single-day range (`since === until`).
  `describe("buildBuckets", ...)` (836-885): add cases for the new
  `pickGranularity` thresholds (just under/over each cutoff) and confirm
  `"day"`-period trend now buckets daily instead of falling into the
  monthly branch (the pre-existing gap noted in
  [02](02-current-architecture.md#pre-existing-gaps)).
- **`dashboard.test.ts`** — extend the "period-boundary overlap" describe
  block (73-142) with a custom-range equivalent asserting `activeSince`
  gets the custom `since`, not the raw `since` (see previous section).
- **`cost-per-task.test.ts`** — extend `describe('datesForPeriod', ...)`
  (106+) with custom-range day enumeration; verify the existing period-cap
  test (544) applies the same cap logic to a custom range that would
  otherwise exceed it (e.g. `since` far before `earliestMs`).
- **`mcp.test.ts`** — add `since`/`until` cases to the existing period
  tests for `get_stats` (223) and `list_sessions` (252); add a rejection
  test for a malformed/partial pair on at least one tool (don't need to
  repeat for all four — the validation logic is shared).
- **`server.test.ts`** — extend the `/api/dashboard?period=week` round-trip
  test (91-95) with a `?since=&until=` equivalent; add a case asserting
  `?period=week&since=...&until=...` together resolves to the custom range
  (precedence rule), not an error and not the preset.
- **`extension.test.ts`** — spot-check the webview message-passing path if
  the test harness covers `postMessage` handling; otherwise this surface's
  new UI code is likely better covered by a quick manual check (see
  [06](06-rollout-plan.md)) than by adding webview-message unit tests for a
  UI shell.
- **`alerts.test.ts`** — no changes; confirms the explicit out-of-scope
  decision above by absence.

## Things this design deliberately does not solve

- **Relative ranges** ("last 45 days") — noted as a non-goal in
  [01](01-problem-and-goal.md); would layer on top as a client-side
  resolver that computes `since`/`until` from "today minus N" and calls the
  same API, no server-side change needed if ever added.
- **Saved/named custom ranges** (e.g. "my billing cycle") — a UX nicety on
  top of this, not a prerequisite; could be a small addition to
  `packages/cli/src/config.ts` later (a named range persisted alongside the
  existing `accountFees` config) but isn't needed for the core feature to
  ship.
