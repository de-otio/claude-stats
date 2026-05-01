# Collection Strategy

How to parse, aggregate, and incrementally collect usage data from the local files described in [01-data-sources.md](01-data-sources.md).

## Discovery

1. Enumerate directories under `~/.claude/projects/`
2. For each project directory, find all `*.jsonl` files (these are sessions)
3. Also scan `subagents/` subdirectories within each project for additional JSONL files (see [01-data-sources.md](01-data-sources.md))
4. Optionally use `~/.claude/history.jsonl` as a quick index to map session IDs to projects without scanning the filesystem

## Parsing Session JSONL

Stream each file line-by-line (files can be multi-MB). For each JSON line:

**Filter by `type` field:**
- `assistant` — extract token usage from `message.usage`, model from `message.model`, tool calls from `message.content` blocks
- `user` — count prompts (exclude lines where `isMeta: true`)
- `queue-operation` — marks interaction boundaries within a session (`enqueue`/`dequeue`)
- Other types (`system`, `progress`, `file-history-snapshot`, `last-prompt`) — skip for basic stats

**Extract from `assistant` messages:**
```
message.usage.input_tokens
message.usage.output_tokens
message.usage.cache_creation_input_tokens
message.usage.cache_read_input_tokens
message.usage.cache_creation.ephemeral_5m_input_tokens
message.usage.cache_creation.ephemeral_1h_input_tokens
message.usage.server_tool_use.web_search_requests
message.usage.server_tool_use.web_fetch_requests
message.model
message.stop_reason
```

**Extract tool usage from `assistant` message content:**
- Scan `message.content` array for blocks with `type: "tool_use"`
- Record the `name` field (e.g., `Read`, `Edit`, `Bash`, `Grep`, `Write`, `Agent`)

**Extract session metadata (from first message in file):**
```
sessionId, cwd, version, gitBranch, timestamp, permissionMode, entrypoint
```

Note: `version` should be recorded per-message (not just per-session) as a session may span a Claude Code update. All parsing should follow the defensive rules in [08-resilience.md](08-resilience.md) — treat every field as optional, never crash on a malformed line.

## Aggregation Dimensions

| Dimension | Grouping | Use case |
|-----------|----------|----------|
| Per-session | `sessionId` | Individual session analysis |
| Per-project | project directory path | Project-level usage |
| Per-day/week/month | timestamp bucketing | Trend analysis |
| Per-model | `message.model` | Model preference tracking |
| Per-tool | tool `name` from content blocks | Tool usage patterns |

## Session-Level Aggregates

For each session, compute:
- Total input/output/cache tokens (sum across all assistant messages)
- Prompt count (count of non-meta user messages)
- Tool use count by tool name
- Duration (last timestamp - first timestamp)
- Model(s) used
- Git branch
- Entry point (CLI vs VS Code)

## Concurrent Access

Claude Code writes to session JSONL files in real-time. The collector may read a file while it's being written to.

**Risks:**
- Partial JSON line at EOF (write in progress)
- File being actively appended during a read pass

**Mitigations:**
- Discard the last line if it fails JSON parsing — it's likely a partial write. Re-read it on the next collection run.
- Use file size (not just mtime) in checkpoints — a truncated read is detectable if the file grows further.
- Never hold file handles open longer than needed. Read, parse, close.

## Incremental Collection

To avoid re-reading entire files on each run:

1. Maintain checkpoints in the SQLite database tracking:
   - File path (absolute)
   - File size at last successful read
   - Last processed byte offset
   - Last modification time
   - SHA-256 of first 1KB (detects file replacement/rewrite)

2. On each collection run:
   - Check file mtime and size against checkpoint
   - If unchanged → skip
   - If size grew and first-1KB hash matches → seek to last offset, read new lines (append-only case)
   - If first-1KB hash changed → file was rewritten; reprocess from beginning, replacing old records
   - If file no longer exists → mark session as `source_deleted` in DB (do not delete aggregated data)

3. For new files (no checkpoint entry), process from the beginning.

**Crash recovery:** Checkpoints are updated inside the same SQLite transaction as the parsed data. If the tool crashes mid-collection, the transaction rolls back and the next run re-reads from the last committed checkpoint. Collection is idempotent — re-processing the same lines produces the same aggregated records (upsert by message UUID).

## CI/CD Sessions

Claude Code can run in CI pipelines (`is_ci` field in telemetry, non-interactive sessions). These sessions may have different usage patterns (automated prompts, no human interaction).

- Tag sessions with `is_interactive` (derived from `is_ci` in telemetry or absence of `queue-operation` entries)
- Allow filtering CI sessions in/out of reports
- CI sessions are valuable for tracking automated usage costs but should not skew "developer activity" metrics

## Timezone Handling

Timestamps in session data are epoch milliseconds (UTC). When bucketing by day/week/month for reports:

- Store all timestamps as UTC in the database
- Apply timezone conversion only at report time
- Default to the system's local timezone; allow `--timezone` flag override
- A session spanning midnight belongs to the day of its first message

## Output Format

Store aggregated data in a local SQLite database with tables for:
- `sessions` — one row per session with aggregate metrics
- `messages` — per-message token counts (keyed by message UUID for idempotent upserts)
- `tool_usage` — per-session tool usage counts
- `collection_state` — checkpoints for incremental processing
- `schema_fingerprints` — per-version schema snapshots (see [08-resilience.md](08-resilience.md))

SQLite is ideal: zero-config, single file, queryable, and Python/Node both have built-in support.
