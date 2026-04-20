# Claude Stats

View your Claude Code usage statistics directly inside VS Code. Local-only — no API key, no network access, nothing leaves your machine.

![claude-stats dashboard](https://raw.githubusercontent.com/deotio/claude-stats/master/doc/screenshot.png)

## Features

- **Dashboard webview** in the activity bar with tokens, cost, sessions, cache efficiency, and streaks
- **Per-project breakdown** showing where your tokens and dollars are going
- **Spending view** with model, session, tool, and MCP-server cost attribution
- **Environmental context** translating token usage into energy, CO₂, and comparable everyday figures
- **Work profile** — distribution of the nature of your work across projects
- **Auto-registers a local MCP server** so your AI agent can query stats directly ("how many tokens did I use this week?")

## Requirements

- **Node.js 22.5+** on your PATH (uses the built-in `node:sqlite` module)
- Claude Code installed and used at least once — the extension reads from `~/.claude/projects/`

## Getting started

1. Install the extension
2. Click the Claude Stats icon in the activity bar, or run **Claude Stats: Open Dashboard** from the command palette
3. **Restart Claude Code** so it picks up the MCP server the extension auto-registers in `~/.claude.json`

That's it. The extension reads Claude Code's local JSONL session files, aggregates them into a local SQLite database at `~/.claude-stats/stats.db`, and renders the dashboard on demand.

## MCP tools available to your agent

Once installed, ask your AI agent things like:

- "How many tokens have I used this week?"
- "What were my most expensive sessions today?"
- "Which projects am I spending the most on?"
- "How much CO₂ did my Claude usage cause last week?"

| Tool | Purpose |
| --- | --- |
| `get_stats` | Usage summary — tokens, cost, sessions, cache efficiency, streaks |
| `list_sessions` | Recent sessions with token counts and estimated cost |
| `get_session_detail` | Messages and token usage for a specific session |
| `list_projects` | Per-project usage breakdown |
| `get_status` | Database health, session count, last collection time |
| `search_history` | Search prompt history by keyword |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claude-stats.port` | `9120` | Port for the standalone web dashboard (CLI `serve` command) |
| `claude-stats.autoRefreshSeconds` | `30` | Auto-refresh interval for the dashboard panel. `0` disables. |

## Privacy

- **Nothing leaves your machine.** All data stays under `~/.claude-stats/`.
- **Incremental.** Only new JSONL lines are read on each refresh.
- **Non-destructive.** The extension never modifies Claude Code's own files.
- **No API scraping.** Reads only the local JSONL files Claude Code already writes to disk.

## Issues and source

- Source: https://github.com/deotio/claude-stats
- Issues: https://github.com/deotio/claude-stats/issues

## License

MIT
