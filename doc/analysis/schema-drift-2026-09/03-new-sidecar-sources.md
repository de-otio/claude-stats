# 03 — New Sidecar Sources

Files and surfaces that exist now and are not read by the scanner
(`packages/cli/src/paths.ts` centralizes what we do read). Local files below
were inspected directly **[live]** on 2026-09-01; org-side surfaces are
**[docs]**.

## 3.1 `~/.claude/stats-cache.json` — Claude Code's own aggregate

Claude Code now maintains a precomputed lifetime aggregate:

```json
{
  "version": <int>,
  "lastComputedDate": "...",
  "dailyActivity":   [{ "date", "messageCount", "sessionCount", "toolCallCount" }],
  "dailyModelTokens":[{ "date", "tokensByModel": { "<model>": <tokens> } }],
  "modelUsage":      { "<model>": { "inputTokens", "outputTokens",
                                    "cacheReadInputTokens", "cacheCreationInputTokens",
                                    "webSearchRequests", "costUSD",
                                    "contextWindow", "maxOutputTokens" } },
  "hourCounts": ..., "totalMessages", "totalSessions",
  "firstSessionDate", "longestSession", "totalSpeculationTimeSavedMs"
}
```

Value, in order:

1. **Backfill for pruned history.** The store records that 936 of 1168 sessions
   no longer have a transcript (`packages/cli/src/store/index.ts:579-586`).
   `dailyActivity`/`dailyModelTokens` here reach back before our archive mirror
   existed — daily-grain only, but real.
2. **Cross-validation.** An independent computation of daily token totals to
   check our aggregator against (a doctor-style `claude-stats verify` command).
3. **Novel signals**: `totalSpeculationTimeSavedMs` (speculative-decoding time
   saved) exists nowhere else.

Caveats: single-file, mutable, undocumented (`costUSD: 0` observed for models
where Claude Code lacks pricing — treat 0 as "unknown", not free); scope is
per config dir, so multi-account machines see the merged view of whichever
accounts share `~/.claude`.

## 3.2 `~/.claude/plans/*.md`

Plan-mode plans persisted as named markdown files (memorable slugs). Joinable
to sessions only heuristically (mtime/content) so far, but a plan-per-session
signal pairs with plan-mode `mode` entries for "planned vs unplanned work"
analytics.

## 3.3 `~/.claude/tasks/`, `~/.claude/teams/`, `~/.claude/file-history/`

- `tasks/<uuid>/` — background-task state (subagent output transcripts land
  here for background agents). Relevant to subagent accounting: background
  agents may not write under `projects/<p>/subagents/`.
- `teams/` — agent-team state (empty on this machine; present as a directory).
- `file-history/<uuid>/` — edit backups backing the `file-history-*` transcript
  entries and the rewind feature; 102 entries observed. An edit-volume signal
  independent of transcripts.

## 3.4 `~/.claude/history.jsonl` gained `pastedContents`

We read `{display, timestamp, project, sessionId}`
(`packages/cli/src/history/index.ts:29-78`). Entries now also carry
`pastedContents`. No action needed beyond tolerating it (we already do);
noting for the privacy docs: pasted content persists in a file we mirror to
the archive plane if archive scope ever expands beyond `projects/`.

## 3.5 `~/.claude/sessions/<pid>.json` — richer than we consume

The attribution anchor reader consumes only `sessionId` + `entrypoint`
(`packages/cli/src/attribution/anchors.ts:44-101`). Files now also include
key material siblings (`<pid>.<hash>.key`) — do **not** read or mirror those;
they are session encryption keys. Anchor logic unaffected.

## 3.6 Org-side surfaces **[docs]**

Relevant to the org/team plane ([data-planes](../data-planes/)), not the local
collector:

- **Claude Code Analytics API** — `/v1/organizations/usage_report/claude_code`
  (Admin API key, org accounts only): daily per-user `num_sessions`, lines
  added/removed, commits/PRs by Claude Code, per-tool accept/reject counts,
  per-model token+estimated-cost breakdown, `terminal_type`, `customer_type`.
  This overlaps heavily with what our AppSync org plane computes from raw
  transcripts. Worth a build-vs-buy pass: for Team/Enterprise orgs the API may
  replace part of the team plane; for Pro/Max individuals (our core audience,
  per the top-level README goal) it does not exist, so the local pipeline
  remains the product.
- **OpenTelemetry export** — `CLAUDE_CODE_ENABLE_TELEMETRY=1` +
  `OTEL_METRICS_EXPORTER=otlp`: metrics incl. `claude_code.token.usage`,
  `claude_code.cost.usage`, `claude_code.active_time.total`,
  `claude_code.lines_of_code.count`, plus event streams (`api_request`,
  `tool_decision`, ...) with `session.id`/`user.id`/`organization.id`
  attributes. Our OTel importer (`packages/cli/src/otel/parse.ts`) requires a
  user-supplied file today; a `claude-stats otel setup` that configures a local
  OTLP file exporter would turn it into a supported first-class source —
  especially for `active_time`, which transcripts don't carry.
- **Retention knobs** — `cleanupPeriodDays` now governs CLI transcripts only;
  a separate `desktopSessionCleanupPeriodDays` governs desktop/Cowork-written
  transcripts. The archive mirror (`packages/cli/src/archive/mirror.ts`)
  remains the right defense; the doctor command should surface both knobs.

## 3.7 Still declared, still dead

`paths.changelogFile` (`~/.claude/cache/changelog.md`) is defined at
`paths.ts:21` and read nowhere — the update-detection idea from
[../08-resilience.md](../08-resilience.md) was never wired up. Either wire it
to the fingerprinter's diff surface or delete the path.
