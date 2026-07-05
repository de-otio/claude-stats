# Problem and goal

**Question:** Every surface of claude-stats (CLI, MCP server, web dashboard,
VS Code extension) only lets a user pick one of four fixed periods — `day`,
`week`, `month`, `all`. Can a user instead select an arbitrary start/end date
range (e.g. "March 1 – March 15", or a fee-billing cycle that doesn't line up
with a calendar month)?

**Answer:** Yes, and the change is smaller than it looks. The lowest layer —
the SQLite `Store` — already filters on arbitrary `since`/`until` epoch-ms
values everywhere; presets are a convenience computed *above* the store, not
a constraint baked into it (see [02](02-current-architecture.md)). The work
is: add one `since`/`until` (or `{start, end}`) pair alongside the existing
`period` field, thread it through the ~6 places that currently only know
about the four preset strings, and add a date-range picker to each UI
surface. No schema migration, no new store capability.

## Why this matters

- **Billing cycles rarely align with calendar months.** A user whose plan
  renews on the 14th cannot currently get an accurate spend total for "this
  billing period" — they have to eyeball `month` and manually subtract/add
  days, or use `report --period all` and mentally filter.
- **Incident/investigation windows are arbitrary.** "What did I spend between
  the migration kickoff and today" or "show me the three days around that
  cost spike" need exact boundaries, not the nearest preset.
- **Cross-tool consistency.** Every other consumer of usage data (billing
  dashboards, cost-explorer-style tools) supports a custom range as a
  baseline feature; its absence here is the most-requested gap relative to
  peer tools.

## Non-goals

- **No new bucketing/visualization concept.** Trend charts already bucket by
  day/week/month; a custom range reuses that machinery with one added
  granularity-selection rule (see [03](03-design-data-model-and-conversion.md)).
- **No relative/rolling range syntax** ("last 45 days", "last N tasks"). Only
  absolute `YYYY-MM-DD` boundaries are in scope for this design. Relative
  ranges can be layered on top later as sugar that resolves to an absolute
  range client-side.
- **Not fixing every pre-existing period bug.** `export --period` is
  currently a dead flag (accepted but never applied — see
  [02](02-current-architecture.md#pre-existing-gaps)); this design proposes
  fixing it as part of the same change since the fix is nearly free once
  `since`/`until` threading exists, but it is not the primary goal.
- **Not wiring the `packages/frontend` SPA to real data.** That package is
  currently mock-only (see [02](02-current-architecture.md)); custom-range
  support there is noted but deferred to whenever that surface goes live.

## Success criteria

1. A user can pass an arbitrary `since`/`until` date pair to the CLI, MCP
   tools, web dashboard, and VS Code extension, and get the same filtered
   sessions/totals/trend a preset period would produce for an equivalent
   range.
2. Existing preset behavior (`day`/`week`/`month`/`all`) is unchanged —
   this is additive, not a breaking change to the `period` field or any
   existing CLI flag, MCP schema, or URL query param.
3. Trend charts render sensible bucket granularity for any custom range
   (not just the three preset-shaped ranges they handle today).
4. Invalid ranges (start after end, obviously bogus dates, absurdly large
   ranges) fail with a clear error rather than a confusing empty/silent
   result.
