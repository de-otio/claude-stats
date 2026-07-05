# Custom (arbitrary) date-range selection

**Question:** claude-stats currently only lets a user pick one of four fixed
periods — `day`, `week`, `month`, `all` — across the CLI, MCP server, web
dashboard, and VS Code extension. Can arbitrary start/end date selection be
added, and how much does it cost?

**Answer:** Yes, and it's cheaper than the four-surface fan-out suggests.
The SQLite `Store` layer already filters on arbitrary `since`/`until`
epoch-ms values everywhere it's queried — the preset-only constraint lives
entirely in the conversion/schema/UI layers *above* the store, not in the
store itself. The design adds one optional `since`/`until` date pair
alongside the existing `period` field (both-or-neither, overrides the
preset when present), a single `periodRange()` conversion function that
replaces the current `since`-only, `until`-implicitly-now `periodStart()`,
and a matching UI/flag/schema addition on each surface. No schema
migration, no store change, no breaking change to any existing `period`
consumer.

## Contents

1. [Problem and goal](01-problem-and-goal.md) — why arbitrary ranges matter
   (billing cycles, investigation windows), what's explicitly out of scope
   (relative ranges, the mock-only frontend SPA), and success criteria.
2. [Current architecture](02-current-architecture.md) — verified,
   line-referenced tour of where period logic lives today: the store
   already supports arbitrary ranges; the constraint is the duplicated
   preset-string type (~6 sites), `periodStart()`'s missing `until`,
   `buildBuckets`' preset-keyed granularity, and a second independent
   period→dates function in `cost-per-task`. Also documents two pre-existing
   bugs found along the way (`export --period` is a dead flag; `"day"`
   trend buckets fall into the monthly-bucket branch).
3. [Design: data model and conversion](03-design-data-model-and-conversion.md)
   — the `since?`/`until?` field addition (chosen over a discriminated
   union), the new `periodRange()` function, a granularity-from-range-width
   rule for trend buckets, and the parallel extension needed in
   `cost-per-task`'s `datesForPeriod`.
4. [Surface changes: MCP, CLI, web, VS Code](04-surface-changes-mcp-cli-web-vscode.md)
   — concrete edits per surface: Zod schema additions for the 4 MCP tools
   that take `period`, new `--since`/`--until` CLI flags (plus the
   `export --period` fix), date-input additions to the web dashboard
   toolbar and its URL-param handling, and the VS Code webview mirror.
5. [Edge cases, validation, and tests](05-edge-cases-validation-and-tests.md)
   — validation rules (both-or-neither, `since ≤ until`, malformed/future
   dates), timezone handling, the `since` vs `activeSince` distinction that
   must be preserved, why `alerts.ts` is explicitly left untouched, and the
   specific existing test files/describe-blocks each phase extends.
6. [Rollout plan](06-rollout-plan.md) — four independently shippable
   phases (core+CLI → MCP → web dashboard → VS Code extension), each with
   a concrete manual-verification step, ordered by risk and leverage.

## TL;DR scope

| Layer | Change needed? |
|---|---|
| SQLite `Store` (`since`/`until` filters) | **No** — already arbitrary-range capable |
| Period type (`Preset`/`DateRangeOpts`) | Consolidate ~6 duplicated literals into one shared type |
| `periodStart` → `periodRange` | New function; returns `{since, until}` instead of just `since` |
| `buildBuckets` | Add range-width-based granularity rule (also fixes a pre-existing `"day"` bucketing gap) |
| `cost-per-task`'s `datesForPeriod` | Parallel extension (different output shape, not a `periodRange` wrapper) |
| MCP tool schemas (4 tools) | Add optional `since`/`until` alongside `period` enum |
| CLI flags (5 commands) | Add `--since`/`--until`; also fixes `export --period`'s dead-flag bug |
| Web dashboard toolbar + URL params | Add date inputs, `?since=&until=` query params |
| VS Code extension webview | Mirror the web dashboard's UI/message-passing |
| `packages/frontend` SPA | Out of scope — mock-only today, no backend to wire |
| `alerts.ts` | Out of scope by design — no custom-range analog for a rolling threshold check |
