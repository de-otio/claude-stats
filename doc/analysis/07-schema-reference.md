# Schema Reference

Exact field-level schemas for parser implementation. All schemas are derived from inspecting actual `~/.claude/` data.

## Session JSONL Message Types

**File location:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`

Each line is a JSON object. The `type` field determines the schema.

### Common Envelope (all types)

Fields present on most message types, but **none are guaranteed** — see [08-resilience.md](08-resilience.md) for evidence of missing timestamps. Parsers must treat all fields as optional.

```json
{
  "type": "user|assistant|system|progress|queue-operation|file-history-snapshot|last-prompt",
  "timestamp": 1772558308674,
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Note: `uuid` is absent from some types (e.g., `queue-operation`, `last-prompt`). `timestamp` is present on nearly all entries but has been observed missing in malformed data.

### type: "assistant"

Primary source for token usage data.

```json
{
  "parentUuid": "uuid|null",
  "isSidechain": false,
  "userType": "external",
  "cwd": "/path/to/project",
  "sessionId": "uuid",
  "version": "2.1.71",
  "gitBranch": "main",
  "slug": "session-slug",
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_xxxx",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "..."},
      {"type": "tool_use", "id": "toolu_xxxx", "name": "Read", "input": {}},
      {"type": "thinking", "thinking": "...|redacted"}
    ],
    "stop_reason": "end_turn|tool_use|max_tokens",
    "usage": {
      "input_tokens": 12345,
      "output_tokens": 678,
      "cache_creation_input_tokens": 500,
      "cache_read_input_tokens": 10000,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 300,
        "ephemeral_1h_input_tokens": 200
      },
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "inference_geo": "us"
    }
  },
  "requestId": "req_xxxx",
  "entrypoint": "claude|claude-vscode",
  "uuid": "uuid",
  "timestamp": 1772558308674,
  "permissionMode": "default"
}
```

### type: "user"

User prompts and tool results.

```json
{
  "parentUuid": "uuid|null",
  "isSidechain": false,
  "userType": "external",
  "cwd": "/path/to/project",
  "sessionId": "uuid",
  "version": "2.1.71",
  "gitBranch": "main",
  "slug": "session-slug",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {"type": "text", "text": "user prompt here"},
      {"type": "tool_result", "tool_use_id": "toolu_xxxx", "content": "..."}
    ]
  },
  "isMeta": false,
  "uuid": "uuid",
  "timestamp": 1772558308674
}
```

Note: `isMeta: true` indicates system-generated messages (not user prompts). Filter these out when counting prompts.

### type: "queue-operation"

Marks interaction boundaries within a session.

```json
{
  "type": "queue-operation",
  "operation": "enqueue|dequeue",
  "timestamp": 1772558308674,
  "sessionId": "uuid"
}
```

### type: "system"

System-level messages (local commands, notifications).

```json
{
  "type": "system",
  "subtype": "local_command",
  "content": "...",
  "level": "info",
  "isMeta": true,
  "timestamp": 1772558308674,
  "uuid": "uuid"
}
```

### type: "progress"

Tool execution progress updates.

```json
{
  "type": "progress",
  "data": {
    "type": "hook",
    "hookEvent": "...",
    "hookName": "...",
    "command": "..."
  },
  "parentToolUseID": "toolu_xxxx",
  "toolUseID": "toolu_xxxx",
  "timestamp": 1772558308674,
  "uuid": "uuid"
}
```

### type: "file-history-snapshot"

File modification tracking.

```json
{
  "type": "file-history-snapshot",
  "messageId": "uuid",
  "snapshot": {
    "messageId": "uuid",
    "trackedFileBackups": {},
    "timestamp": 1772558308674
  },
  "isSnapshotUpdate": false
}
```

### type: "last-prompt"

Session resume marker.

```json
{
  "type": "last-prompt",
  "lastPrompt": "the user's last prompt text",
  "sessionId": "uuid"
}
```

## History JSONL

**File location:** `~/.claude/history.jsonl`

```json
{
  "display": "I want to refactor the auth module",
  "pastedContents": {},
  "timestamp": 1772558308674,
  "project": "/Users/rmyers/repos/myproject",
  "sessionId": "uuid"
}
```

## Telemetry Events

**File location:** `~/.claude/telemetry/1p_failed_events.<session-id>.<device-id>.json`

Array of event objects:

```json
{
  "event_type": "ClaudeCodeInternalEvent",
  "event_data": {
    "event_name": "tengu_api_success",
    "client_timestamp": "2026-03-08T12:00:00.000Z",
    "model": "claude-opus-4-6",
    "session_id": "uuid",
    "user_type": "external",
    "entrypoint": "claude-vscode|claude",
    "is_interactive": true,
    "client_type": "cli|vscode",
    "env": {
      "platform": "darwin",
      "arch": "arm64",
      "node_version": "22.x",
      "version": "2.1.71",
      "terminal": "xterm-256color",
      "is_ci": false,
      "is_claude_ai_auth": true
    },
    "process": "{\"rss\":123456,\"heapTotal\":98765,\"heapUsed\":87654}",
    "additional_metadata": "{...event-specific JSON...}",
    "event_id": "uuid",
    "device_id": "hash"
  }
}
```

## claude-stats' Own Local Schema (SQLite, V19–V22)

The sections above describe the raw files **Claude Code** writes. This
section describes fields claude-stats itself **derives and persists** into
its own local SQLite database (`~/.claude-stats/stats.db`, schema version 22
at time of writing) from that raw data — added since this reference was last
updated. See [`packages/cli/src/store/index.ts`](../../packages/cli/src/store/index.ts)
for the authoritative migration source, and
[05-privacy-security.md](05-privacy-security.md)'s draft amendment for what
each addition means for data leaving the machine.

### V19 — `ticket_links`

One row per (session, ticket key, extraction source) — a session can link to
more than one ticket key, from more than one source, at once.

```sql
CREATE TABLE ticket_links (
  session_id  TEXT NOT NULL,
  ticket_key  TEXT NOT NULL,
  source      TEXT NOT NULL,     -- 'branch' | 'commit' | 'prompt' | 'tag' (manual)
  confidence  TEXT NOT NULL,     -- 'high' | 'medium' | 'low'
  granularity TEXT NOT NULL DEFAULT 'session',
  first_uuid  TEXT,
  last_uuid   TEXT,
  evidence    TEXT,              -- the matched substring/branch/commit subject
  negated     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, ticket_key, source)
);
```

Ticket keys are extracted from **prompt text** (among other sources) — this
is new since the last privacy review of this project; see the draft
amendment. `evidence` can therefore hold a fragment of prompt text and
inherits the same local-only handling as `messages.prompt_text`. `source:
'tag'` rows are manual links from `claude-stats ticket` / `recap correct
ticket`, which always take precedence over automatic extraction; `negated: 1`
tombstones a specific automatic link so re-extraction cannot resurrect it.

### V20 — `messages.git_branch`

```sql
ALTER TABLE messages ADD COLUMN git_branch TEXT;
```

A per-message git branch, additive to the existing session-level
`sessions.git_branch` (which is first-seen-only and mis-attributes every
message after a mid-session branch switch). Nullable with **no backfill** —
historical rows stay `NULL` and fall back to the session-level branch.
Backfilling requires re-reading the transcript and is an explicit,
resumable, opt-in step (`claude-stats backfill`), never a side effect of
opening the database.

### V21 — `session_task_class`

One row per session: its task classification, at the classifier version that
produced it.

```sql
CREATE TABLE session_task_class (
  session_id         TEXT PRIMARY KEY,
  task_class         TEXT NOT NULL,   -- fine class, e.g. 'debug', 'refactor-multi-file'
  coarse_class       TEXT NOT NULL,   -- coarse class, e.g. 'build', 'diagnose'
  confidence         TEXT NOT NULL,   -- 'high' | 'medium' | 'low'
  rule               TEXT NOT NULL,   -- which rule decided (closed enum)
  abstain_reason     TEXT,            -- closed enum, when the classifier abstained
  classifier_version INTEGER NOT NULL,
  classified_at      INTEGER NOT NULL
);
```

`rule` and `abstain_reason` are closed enums from the classifier, never free
text — this table cannot carry prompt content. The version column is the
invalidation mechanism: `claude-stats task-class` reclassifies only sessions
with no row or a row below the current classifier version, so a rule change
never needs a manual purge.

### V22 — `api_error_events`

Append-only: one row per structured API-error or retry signal Claude Code
itself writes.

```sql
CREATE TABLE api_error_events (
  uuid             TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  timestamp        INTEGER,
  terminal         INTEGER NOT NULL,   -- 1 = user-visible rejection, 0 = retry-ladder attempt
  kind             TEXT NOT NULL,
  status           INTEGER,
  retry_in_ms      INTEGER,
  retry_attempt    INTEGER,
  is_network_down  INTEGER NOT NULL DEFAULT 0
);
```

Kept out of `messages` deliberately: a retry-ladder attempt has no token
usage at all, and folding either kind into `messages` would corrupt
cost-per-turn analytics that assume a row is a real billed API response.
Feeds the constraint-impact engine's before/after comparison. No prompt or
response content is captured here — only classification and retry metadata.

## Key Telemetry Event Names

| Category | Events |
|----------|--------|
| Session | `tengu_init`, `tengu_exit` |
| API | `tengu_api_query`, `tengu_api_success`, `tengu_api_cache_breakpoints` |
| Tool use | `tengu_tool_use_success`, `tengu_tool_use_error`, `tengu_bash_tool_command_executed` |
| Cost | `tengu_cost_threshold_reached` |
| Streaming | `tengu_streaming_error`, `tengu_streaming_stall` |
| Context | `tengu_context_size`, `tengu_compact`, `tengu_auto_compact_succeeded` |
| Files | `tengu_file_operation`, `tengu_file_changed` |
