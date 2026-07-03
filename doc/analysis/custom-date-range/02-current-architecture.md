# Current architecture (as verified in code)

## Surfaces, one shared core

claude-stats is a monorepo with one ingestion pipeline and four consumer
surfaces, all reading from a single local SQLite database
(`~/.claude-stats/stats.db`, `packages/cli/src/store/index.ts`, class
`Store`):

```
~/.claude/**/*.jsonl  →  scanner  →  parser  →  aggregator  →  Store (SQLite)
                                                                    │
                        ┌───────────────┬───────────────┬──────────┴─────────┐
                        │               │               │                    │
                   CLI commands    MCP server      web dashboard      VS Code extension
              packages/cli/src/  packages/cli/src/  packages/cli/src/  packages/cli/src/
                  cli/index.ts      mcp/index.ts    server/{index,template}.ts  extension/panel.ts
```

`packages/frontend/` is a separate React SPA for a "team app" concept; it is
currently **mock-data only** (`packages/frontend/src/hooks/useApi.ts:1-4`
says as much explicitly) and not wired to any backend, so it's out of scope
for wiring but noted for the UI-shape discussion in
[04](04-surface-changes-mcp-cli-web-vscode.md).

## The store already supports arbitrary ranges

`Store` query methods take `since?: number` / `until?: number` as raw
epoch-ms — there is no period-preset concept at this layer at all. Confirmed
directly:

```ts
// packages/cli/src/store/index.ts:2207-2208 (representative of ~10 similar methods)
if (filters.since !== undefined) { sessionConditions.push("s.first_timestamp >= ?"); sessionParams.push(filters.since); }
if (filters.until !== undefined) { sessionConditions.push("s.first_timestamp < ?"); sessionParams.push(filters.until); }
```

The same `since`/`until` pattern repeats in `getSessions` (1329-1340, which
also has a separate `activeSince` for "session was active during the
period" semantics), `getMessageTotalsRaw` (1266-1321), `listAccounts` (1409),
`getUsageWindows` (1592), and others around 1689, 1735-1785, 1823-1964,
2091-2109, 2536-2549. **None of this needs to change.** Any `since`/`until`
pair — preset-derived or user-supplied — already flows correctly once it
reaches the store.

## Where the preset-only limitation actually lives

The constraint is entirely in the layer *above* the store: the code that
turns a period **name** into a `since`/`until` **number pair**, and the
schemas/flags that only accept the four names.

### 1. The period → date conversion (`periodStart`)

`packages/cli/src/reporter/index.ts:87-113` — `periodStart(period, tz)`:

- Returns a **single epoch-ms `since` boundary** for `"day"` / `"week"` /
  `"month"`, using `tzMidnight()` (line 68-85, a DST-safe helper that derives
  the tz offset via `Intl.DateTimeFormat` rather than trusting the
  environment `TZ`).
- Returns `0` for `"all"` and for any unrecognized string.
- **There is no `until` counterpart.** Every caller treats "now" as the
  implicit end (e.g. `printTrend`, line 256: `const rangeEnd = Date.now();`).
  This matters for custom ranges: a historical range's end should be the end
  of the requested day, not `Date.now()`.

### 2. The type is duplicated ~6 times, not centralized

There is no single `Period` type; the four-string union is copy-pasted:

| Site | Declaration |
|---|---|
| `packages/cli/src/reporter/index.ts:22` | `ReportOptions.period?: "day" \| "week" \| "month" \| "all"` (the primary one — imported by dashboard/server/CLI/extension) |
| `packages/cli/src/cost-per-task/index.ts:58` | `export type Period = 'day' \| 'week' \| 'month' \| 'all';` (parallel, independent) |
| `packages/cli/src/alerts.ts:18` | `const PERIODS = ["day", "week", "month"] as const;` (no `"all"` — alerts are always bounded) |
| `packages/cli/src/mcp/index.ts:73,91,177,321` | `z.enum(["day","week","month","all"])`, inline per tool, 4× |
| `packages/cli/src/server/template.ts:232` | `const periods = ["day","week","month","all"] as const;` (drives the `<select>` options) |

### 3. Bucketing granularity is keyed off the preset string, not the range

`packages/cli/src/reporter/index.ts:159-233` — `buildBuckets(period, tz,
rangeStart, rangeEnd)`. It already takes explicit numeric `rangeStart` /
`rangeEnd`, but branches on `period === "week"` (7 daily buckets),
`period === "month"` (weekly buckets), and **everything else falls into the
`else` branch** (monthly buckets) — including `"day"` and `"all"` today.
There is no `"custom"` case, and no granularity rule derived from the actual
`rangeEnd - rangeStart` span.

### 4. A second, structurally different period→dates function

`packages/cli/src/cost-per-task/index.ts:347-376` —
`datesForPeriod(period, tz, nowMs, earliestMs)`. Doesn't return a
`[start, end]` range at all; it enumerates a `string[]` of `YYYY-MM-DD`
labels used to drive the day-by-day cost-per-task recap pipeline. This needs
its own, independent extension for custom ranges — it is not a thin wrapper
around `periodStart`.

### 5. A reusable primitive already exists for date-string → range

`packages/cli/src/recap/index.ts:131-151` — `dayWindowInTz(dateYmd, tz)`
converts one `YYYY-MM-DD` string to a `{startMs, endMs}` window using the
same DST-safe technique as `tzMidnight`. This is the natural building block
for custom ranges: call it once on the `since` date (take `startMs`) and once
on the `until` date (take `endMs`), instead of writing new date math.

## Per-surface entry points

**CLI** (`packages/cli/src/cli/index.ts`) — `--period <period>` on `report`
(124-128, default `all`), `spending` (211, default `day`), `cost-per-task`
(250, default `month`), `export` (393, default `all`), `dashboard` (654,
default `all`). Separately, `recap` takes a single `--date <date>` (726) and
`precompute` takes `--date <YYYY-MM-DD>` (777). **No `--since`/`--until`
flags exist anywhere today.**

**MCP server** (`packages/cli/src/mcp/index.ts`) — `get_stats`,
`list_sessions`, `list_projects`, `get_cost_per_task` all take
`period: z.enum([...]).default(...)` (lines 73, 91, 177, 321).
`summarize_day` takes a single `date: z.string().optional()` (250-251, the
only existing "arbitrary date" input in the codebase, but single-day only).
`periodToReportOpts(period)` (46-50) converts the tool-level period into
`ReportOptions`.

**Web dashboard** (`packages/cli/src/server/{index,template}.ts`) —
`parseOpts(url)` in `server/index.ts:44-58` reads `?period=`, `?project=`,
`?repo=`, `?account=`, `?entrypoint=`, `?timezone=`, `?includeCI=` — **no
date params**. `template.ts:232-240,450-454` renders the `<select
id="period-select">`; `changePeriod()` (1354-1366) rewrites the URL query
string and reloads.

**VS Code extension** (`packages/cli/src/extension/panel.ts`) — mirrors the
web dashboard's `#period-select` inside a webview, via
`postMessage({command:'changePeriod', period})` (454-458, 484), handled at
136-138. Reuses the same `buildDashboard()` entry point as everything else.

## Pre-existing gaps

- **`export --period` is dead.** The flag is declared
  (`cli/index.ts:393`) and typed into `opts.period`, but the command's
  `action` handler calls `store.getSessions({ projectPath: opts.project })`
  with no `since`/`until` at all (`cli/index.ts:396-398`) — `--period` on
  `export` currently has zero effect. Worth fixing alongside this work since
  the fix is nearly free once `since`/`until` threading exists uniformly
  (see [04](04-surface-changes-mcp-cli-web-vscode.md)).
- **`buildBuckets` mis-buckets `"day"`.** Falls through to the monthly-bucket
  branch today (rare in practice since day-period trend views are unusual,
  but worth folding into the same granularity-selection fix).
