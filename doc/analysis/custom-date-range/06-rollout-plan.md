# Rollout plan

Ordered so each phase ships independently useful, is verifiable on its own,
and de-risks the next phase. No phase requires a schema migration or store
change — the entire plan operates above the `Store` layer
([02](02-current-architecture.md)).

## Phase 1 — Core conversion + CLI (lowest risk, most direct value)

1. Introduce `Preset`/`DateRangeOpts` types
   ([03](03-design-data-model-and-conversion.md)); have `ReportOptions`,
   `cost-per-task`'s `Period`, and `alerts.ts`'s `PERIODS` reference the
   shared `Preset` instead of re-declaring the literal.
2. Implement `periodRange()`, migrate all internal callers off
   `periodStart()`/manual `Date.now()` pairs.
3. Fix `buildBuckets`' granularity selection (`pickGranularity`), including
   the `"day"`-falls-into-monthly-buckets gap.
4. Extend `datesForPeriod` in `cost-per-task/index.ts`.
5. Add `--since`/`--until` to `report`, `spending`, `cost-per-task`,
   `dashboard`; fix `export --period`'s dead-flag bug and add `--since`/
   `--until` there too.
6. Tests per [05](05-edge-cases-validation-and-tests.md) for `reporter.test.ts`,
   `dashboard.test.ts`, `cost-per-task.test.ts`.

This phase alone gives CLI users (and anything scripting the CLI) full
custom-range support — the highest-leverage surface for the lowest UI
effort, since it's flags-only, no HTML/webview work.

**Verify:** run `claude-stats report --since 2026-03-01 --until 2026-03-15`
against real local data and confirm totals match a manual cross-check
against `report --period all` filtered by eye, or against
`export --format csv` for the same range once that's fixed in the same
phase.

## Phase 2 — MCP server

1. Extract the shared `since`/`until` Zod shape, apply to `get_stats`,
   `list_sessions` (including its inline `periodStart()` call),
   `list_projects`, `get_cost_per_task`.
2. `periodToReportOpts()` → `dateRangeToReportOpts()`.
3. Tests per [05](05-edge-cases-validation-and-tests.md) for `mcp.test.ts`.

Depends on Phase 1's `periodRange()`/types but is otherwise independent of
Phase 3/4 — ships as soon as Phase 1 lands.

**Verify:** call each updated tool through an MCP client (or the existing
MCP test harness) with a `since`/`until` pair and confirm the returned
stats match the Phase 1 CLI result for the same range — this is the
cheapest cross-surface consistency check available, since both paths now
share `periodRange()`.

## Phase 3 — Web dashboard

1. `server/index.ts` `parseOpts()` reads `?since=&until=`.
2. `template.ts` toolbar: date inputs, `changeDateRange()` JS, mutual
   exclusivity with the preset `<select>`.
3. Tests per [05](05-edge-cases-validation-and-tests.md) for `server.test.ts`.

**Verify:** per the repo's UI-change norm — start `claude-stats serve`
locally, exercise the golden path (pick a custom range, confirm the totals
and trend chart update and the URL reflects `?since=&until=`) and at least
one edge case (picking a preset after a custom range clears the custom
params) in an actual browser before calling this phase done. Type-checking
and the `server.test.ts` HTTP-level tests do not substitute for this.

## Phase 4 — VS Code extension

1. Mirror the webview HTML/date-input change from Phase 3.
2. Extend the `postMessage` protocol with `changeDateRange`.

Deferred to last since it's the smallest audience and directly copies
Phase 3's UI decisions once they're validated — doing it last avoids
redoing webview work if Phase 3's UI shape changes during review.

**Verify:** load the extension in an Extension Development Host, exercise
the same golden path as Phase 3 inside the webview panel.

## Explicitly not phased in

- `packages/frontend/` SPA — mock-only today, no backend to wire against;
  revisit when/if that package moves off mock data
  ([04](04-surface-changes-mcp-cli-web-vscode.md)).
- `alerts.ts` — no custom-range analog, left untouched by design
  ([05](05-edge-cases-validation-and-tests.md)).
- Relative ranges, saved ranges — noted as future sugar on top, not part of
  this plan ([01](01-problem-and-goal.md), [05](05-edge-cases-validation-and-tests.md)).

## Rough sizing

Each phase is a small, single-session-reviewable change per the project's
own PR-size default — none requires touching more than one surface's files,
and Phase 1 is the only one with any real logic (the rest are almost
entirely plumbing + a schema/UI extension of the Phase 1 result). No phase
has a hidden dependency on data migration, backfill, or a store schema
change.
