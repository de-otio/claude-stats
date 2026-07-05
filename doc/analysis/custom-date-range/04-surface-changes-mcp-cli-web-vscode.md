# Surface changes: MCP, CLI, web dashboard, VS Code extension

Each surface exposes `period` today; each gets `since`/`until` added
alongside it, following the precedence rule from
[03](03-design-data-model-and-conversion.md): both-or-neither, and if
present they override `period`.

## MCP server (`packages/cli/src/mcp/index.ts`)

Add optional `since`/`until` string params to the four tools that currently
take `period`, with a Zod-level check that they're supplied together:

```ts
const dateRangeShape = {
  period: z.enum(["day", "week", "month", "all"]).default("week").optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("Start date YYYY-MM-DD, inclusive. Must be paired with `until`; overrides `period` when both are set."),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("End date YYYY-MM-DD, inclusive. Must be paired with `since`; overrides `period` when both are set."),
};
```

Apply to `get_stats` (line 73-74), `list_sessions` (91-96, which also
needs its inline `periodStart()` call at 101-104 swapped for
`periodRange()` — it doesn't go through `buildDashboard`/
`periodToReportOpts` today, so it needs the same edit made twice), 
`list_projects` (177-178), `get_cost_per_task` (321-328). Extract the
shape object once and spread it into each tool's schema rather than
re-declaring four times — this both adds the feature and removes one of the
six duplicated-enum sites from [02](02-current-architecture.md) in the same
change.

`periodToReportOpts()` (46-50) becomes `dateRangeToReportOpts()`, passing
`since`/`until` through unchanged into `ReportOptions`.

`summarize_day`'s existing `date` param (250-251) is untouched — it's a
different, single-day tool and stays that way; no need to unify it with
`since`/`until` symmetry for this change.

Validation errors (mismatched pair, start after end) should surface as MCP
tool errors with the `RangeError` message from `periodRange()`, not a
silent fallback to the default preset — an agent calling these tools needs
to see *why* its range was rejected.

## CLI (`packages/cli/src/cli/index.ts`)

Add `--since <date>` / `--until <date>` options next to each existing
`--period <period>` flag:

```ts
.option("--since <date>", "YYYY-MM-DD, inclusive; overrides --period when used with --until")
.option("--until <date>", "YYYY-MM-DD, inclusive; overrides --period when used with --since")
```

On: `report` (124-128), `spending` (211), `cost-per-task` (250), `dashboard`
(654). Commander passes both through into `opts`; the command handlers
already forward `opts.period` into `ReportOptions` — add `since`/`until` to
the same forwarding, no new plumbing needed beyond that.

**`export` (393):** fix the pre-existing dead-flag bug from
[02](02-current-architecture.md) as part of this change — the `action`
handler's `store.getSessions({ projectPath: opts.project })` call (396-398)
needs `since`/`until` derived via `periodRange({period: opts.period, since:
opts.since, until: opts.until}, tz)` and passed through, exactly like every
other command. Flag this explicitly in the PR description as "also fixes:
`--period` on `export` was previously a no-op" — it's a behavior change for
existing `export --period` users (their exports will start being filtered
where they weren't before), not purely additive, so it should be called out
rather than buried in a larger diff.

Validation failures should exit non-zero with the `RangeError` message
printed to stderr, matching how other CLI validation errors in this
codebase are reported (grep the existing pattern in `cli/index.ts` for
consistency rather than inventing a new error-reporting shape).

## Web dashboard (`packages/cli/src/server/{index,template}.ts`)

**Server (`server/index.ts:44-58`, `parseOpts`):** read `?since=&until=` in
addition to the existing `?period=`, pass both into `ReportOptions` /
whatever the route calls next. No change to the response shape — the
dashboard payload already doesn't echo the request period back in a way
that would need updating (verify at implementation time; not confirmed in
this pass).

**Template (`server/template.ts`):**

- Toolbar: add two `<input type="date">` elements next to the existing
  `<select id="period-select">` (232-240, 450-454). Native date inputs
  avoid pulling in a date-picker dependency and match the "plain HTML/CSS/JS
  template" style already used throughout this file.
- `changePeriod()` (1354-1366) currently rewrites `?period=` and reloads.
  Extend it (or add a sibling `changeDateRange()`) so that: picking a date
  clears/ignores the `period` select's value in the URL and writes
  `?since=&until=` instead; picking a preset from the `<select>` clears any
  `?since=&until=` params. The two controls are mutually exclusive in the
  UI, mirroring the mutual-override rule in the data model — don't let the
  UI produce a URL with all three params set, since that's exactly the
  ambiguous state the precedence rule exists to avoid.
- Keep both inputs constrained with `max` = today's date (in the
  dashboard's configured timezone) to cut down on obviously-invalid input
  before it ever reaches the server-side validation in `periodRange()`.

## VS Code extension (`packages/cli/src/extension/panel.ts`)

Mirrors the web dashboard's controls inside the webview HTML (same
`#period-select` pattern is reused per [02](02-current-architecture.md)) —
add the same two date inputs, and extend the `postMessage({command:
'changePeriod', period})` protocol (454-458, 484) with a
`{command: 'changeDateRange', since, until}` message, handled alongside the
existing handler at 136-138. Since this reuses the same `buildDashboard()`
call as every other surface, once `buildDashboard` accepts `since`/`until`
in its `ReportOptions` argument (it already does, transitively, once
`ReportOptions` gains those fields — no separate change needed in
`dashboard/index.ts` beyond what `periodRange()` already covers), the
extension side is purely UI/message-passing work.

## Frontend SPA (`packages/frontend/`) — deferred, not in scope

`SessionsPage.tsx:18-32` and `ProjectsPage.tsx:8-22` have their own
hardcoded `week`/`month`/`all` `<Select>` (no `day` option, and no backend
behind it — see [02](02-current-architecture.md)). When this package is
wired to a real API, its period type should be defined against the same
shared `Preset`/`DateRangeOpts` types from
[03](03-design-data-model-and-conversion.md) rather than inventing a fourth
independent copy. No action needed now beyond noting this for whoever picks
that package back up.
