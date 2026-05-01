# Data Sources

Claude Code stores all session and usage data locally in `~/.claude/`. Both the CLI and VS Code extension write to this same directory, making it the single source of truth.

## Primary: Session JSONL Files

**Location:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`

The richest data source. Each line is a JSON object representing a message in the conversation. Project paths are encoded with `/` replaced by `-` (e.g., `-Users-rmyers-repos-myproject`).

**What it contains:**
- Full conversation transcript (user prompts, assistant responses)
- Per-message token usage (input, output, cache creation, cache read)
- Model identifier (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`)
- Timestamps (epoch milliseconds)
- Session metadata: git branch, working directory, Claude Code version
- Tool usage details (which tools were called, results)
- Service tier and inference geography
- Stop reason for each response

**Update pattern:** Written to in real-time during a session. Files range from a few KB to several MB depending on session length.

**Subagent data:** Sessions using subagents store additional JSONL files in `subagents/` subdirectories within the session's project folder.

## Secondary: History Index

**Location:** `~/.claude/history.jsonl`

A lightweight log of every user prompt across all projects and sessions.

**What it contains:**
- `display` — the user's prompt text
- `timestamp` — epoch milliseconds
- `project` — full path to the project directory
- `sessionId` — links to the full session JSONL

**Update pattern:** One line appended per user prompt. Small file (~50KB for ~200 prompts).

**Use case:** Quick index for finding sessions without scanning all project directories.

## Tertiary: Telemetry Events

**Location:** `~/.claude/telemetry/1p_failed_events.<session-id>.<device-id>.json`

System-level events with process metrics and feature usage tracking.

**What it contains:**
- Event name (100+ types covering init, tool use, API queries, cost thresholds, streaming errors)
- Client type (`cli` or `claude-vscode`)
- Platform info (OS, architecture, Node version)
- Process metrics (memory RSS, heap, CPU usage)
- Model and session identifiers

**Important caveat:** These are *failed-to-send* telemetry events only. Successfully transmitted events are not retained locally. This data is inherently incomplete and biased toward error conditions. See [06-limitations.md](06-limitations.md).

## Supporting: File History

**Location:** `~/.claude/file-history/<session-id>/`

Versioned snapshots of files modified during sessions. Files named `<hash>@v<version>`. Useful for understanding the scope of changes but not directly relevant to usage statistics.

## Supporting: Configuration

**Location:** `~/.claude/settings.json`, `~/.claude/policy-limits.json`

User preferences (model selection, permission modes). Small JSON files, useful for context but not usage metrics.

## CLI vs VS Code Extension

Both use the same `~/.claude/` directory. The VS Code extension bundles its own Claude binary at `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude`. The `entrypoint` field in session data distinguishes the source:
- `claude` — CLI
- `claude-vscode` — VS Code extension

VS Code also maintains its own chat session data in its workspace storage directory (see platform paths below), but this duplicates what's already in `~/.claude/projects/` and uses a less accessible format.

## Platform Paths

Claude Code runs on macOS, Linux, and Windows. The `~/.claude/` directory is consistent across platforms, but VS Code storage paths differ:

| Platform | `~/.claude/` | VS Code workspace storage |
|----------|-------------|--------------------------|
| macOS | `~/.claude/` | `~/Library/Application Support/Code/User/workspaceStorage/` |
| Linux | `~/.claude/` | `~/.config/Code/User/workspaceStorage/` |
| Windows | `%USERPROFILE%\.claude\` | `%APPDATA%\Code\User\workspaceStorage\` |

Since `~/.claude/projects/` captures both CLI and VS Code sessions on all platforms, it should be the sole data source. The tool should resolve `~` / `%USERPROFILE%` at runtime rather than hardcoding paths.
