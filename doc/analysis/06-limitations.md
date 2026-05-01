# Limitations and Data Gaps

## No Direct Cost Data

Session files contain token counts but no dollar amounts. Claude Plans (Teams, ProMax) use bundled pricing — there is no per-token billing and no API endpoint to query account usage or remaining quota.

**Workaround:** Map tokens to approximate costs using published API pricing as a reference. This is directionally useful but not billing-accurate for Plan users.

## Telemetry Is Incomplete

The `~/.claude/telemetry/` directory contains only *failed-to-send* events (`1p_failed_events`). Successfully transmitted telemetry is not retained locally.

**Impact:** Telemetry data is biased toward error conditions and gaps in connectivity. It cannot be used as a reliable primary data source for usage tracking. Use session JSONL files instead.

## No Cross-Device Aggregation

Each machine has its own `~/.claude/` directory. A developer working across multiple machines (e.g., laptop + desktop, or local + remote) has fragmented data.

**Workaround:** Server sync (future) would aggregate across machines per developer identity.

## Schema Instability

Claude Code updates frequently. Session JSONL fields may be added, renamed, or restructured across versions. The `version` field in each message helps, but there is no formal schema contract or migration path. See [08-resilience.md](08-resilience.md) for detailed analysis of observed changes and defense strategies.

**Mitigation:** Parse defensively — treat all fields as optional (including `timestamp`, which has been observed missing). Log warnings for unexpected structures rather than failing.

## Thinking Tokens

Extended thinking content is redacted from session files (replaced with `"redacted_thinking"` content blocks). Thinking token counts may or may not appear in `message.usage` depending on the Claude Code version.

**Impact:** Token usage totals may undercount if thinking tokens are not included in the usage object.

## Rate Limits and Quotas

No local data captures rate limit events or remaining quota. The telemetry event `tengu_claudeai_limits_status_changed` exists but only in failed events (unreliable).

**Impact:** Cannot track or predict rate limit hits from local data alone.

## Session Boundaries

Sessions can be resumed across multiple CLI invocations. A single `sessionId` may span hours or days with gaps. `queue-operation` messages (`enqueue`/`dequeue`) mark interaction boundaries within a session but don't indicate calendar gaps.

**Impact:** "Session duration" is ambiguous — elapsed wall time vs active time. Use first-to-last-message timestamp as a rough duration.

## VS Code-Specific Data

The VS Code extension stores additional chat session data in `~/Library/Application Support/Code/User/workspaceStorage/`. This data overlaps with `~/.claude/projects/` but uses VS Code's internal format. Parsing this secondary source adds complexity for marginal benefit.

**Recommendation:** Rely on `~/.claude/projects/` as the single source. It captures both CLI and VS Code sessions.

## No Built-In Export

Claude Code has no `claude stats` or `claude usage` command. There is no built-in way to export or summarize usage data. Everything must be parsed from raw files.

## Platform Differences

Claude Code runs on macOS, Linux, and Windows. While `~/.claude/` is consistent, the tool must handle platform-specific path resolution (see [01-data-sources.md](01-data-sources.md) platform paths table). File permission models also differ — `drwx------` semantics on macOS/Linux vs ACLs on Windows.

## Source File Deletion

Claude Code may delete or clean up old session files (manually or through future built-in cleanup). When a source JSONL file disappears:
- The tool's aggregated data for that session remains in SQLite (the source is gone but the stats are preserved)
- The checkpoint entry is marked `source_deleted`
- Reports should not treat this as an error — it's expected over time

The tool cannot re-verify aggregated data once the source file is deleted. This is acceptable since the data was validated at collection time.

## Historical Data Availability

Data only exists for sessions that were run on the current machine. There is no way to backfill data from before the tool is installed, though all existing `~/.claude/` data can be processed retroactively.
