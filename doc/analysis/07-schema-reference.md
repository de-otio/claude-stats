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
