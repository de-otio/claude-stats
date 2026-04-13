# Command Reference

All commands follow the pattern:

```
claude-stats <command> [options]
```

Run `claude-stats --help` or `claude-stats <command> --help` for inline help.

---

## `collect`

Scan `~/.claude/projects/` and write new session data to the local database.

```
claude-stats collect [--verbose]
```

| Option | Description |
|---|---|
| `-v, --verbose` | Print one line per file as it is processed |

**How it works:**

- Each session file is compared against a stored checkpoint (mtime, size, and a SHA-256 of the first 1 KB).
- If the file is unchanged, it is skipped.
- If lines were appended, only the new lines are read (incremental).
- If the file was rewritten from scratch, it is reprocessed in full.
- Unparseable lines are recorded in a quarantine table rather than aborting the run.
- Files that have been deleted since the last run are marked `source_deleted` in the database.

**Example output:**

```
Collecting...
Done. 3 files processed, 41 skipped, 2 sessions upserted, 14 messages upserted.
```

---

## `report`

Print a usage summary to stdout, or write a graphical HTML report to a file.

```
claude-stats report [options]
```

| Option | Default | Description |
|---|---|---|
| `--project <path>` | _(all projects)_ | Filter to one project by its filesystem path (e.g. `/Users/you/repos/myproject`) |
| `--repo <url>` | _(all repos)_ | Filter to sessions whose git remote origin matches this URL |
| `--account <uuid>` | _(all accounts)_ | Filter to sessions associated with a specific Anthropic account UUID |
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |
| `--timezone <tz>` | System timezone | IANA timezone name used for day/week/month boundaries (e.g. `America/New_York`) |
| `--source <entrypoint>` | _(all)_ | Filter by entrypoint: `claude` (CLI) or `claude-vscode` |
| `--include-ci` | _(excluded)_ | Include sessions that appear to be from CI or automation |
| `--detail` | _(aggregate)_ | Show a per-session table instead of an aggregate summary |
| `--trend` | _(aggregate)_ | Show usage broken down by time period (day/week/month) |
| `--session <id>` | — | Show the full message-by-message detail for one session (prefix match) |
| `--tag <tag>` | _(all)_ | Filter to sessions with a specific tag |
| `--html [outfile]` | — | Write a self-contained HTML dashboard to a file instead of printing to stdout |

**Periods** are calculated from the start of the current day/week/month in the specified timezone to now.

**CI sessions** are those without an interactive queue-operation entry. They are excluded by default because they can inflate token counts significantly.

**`--html`** generates a standalone HTML file with interactive Chart.js charts. If `outfile` is omitted, the file is written to `claude-stats-<YYYY-MM-DD>.html` in the current directory. Cannot be combined with `--trend` or `--detail`.

**Examples:**

```sh
# Usage for the current week in Pacific time
claude-stats report --period week --timezone America/Los_Angeles

# Usage for a single project, all time
claude-stats report --project /Users/you/repos/myproject

# Usage for a repo, regardless of which local clone was used
claude-stats report --repo https://github.com/org/myrepo

# Include CI/automated sessions
claude-stats report --period month --include-ci

# Per-session table for the past week
claude-stats report --period week --detail

# Trend breakdown (week-by-week for the past month)
claude-stats report --trend

# Full detail for a single session
claude-stats report --session abc123

# Write an HTML dashboard for this week
claude-stats report --period week --html

# Write an HTML dashboard to a specific file
claude-stats report --period month --html ~/Desktop/april.html
```

---

## `status`

Show database statistics and the time of the last collection run.

```
claude-stats status
```

No options. Example output:

```
─── Claude Stats Status ───

Database size   : 1.2 MB
Sessions        : 42
Messages        : 1 876
Quarantined     : 0 unparseable lines
Last collected  : 3/8/2026, 9:15:04 AM
```

---

## `export`

Export raw session data to JSON or CSV for use in other tools.

```
claude-stats export [--format <fmt>] [--project <path>] [--period <period>]
```

| Option | Default | Description |
|---|---|---|
| `--format <fmt>` | `json` | `json` or `csv` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |

**Examples:**

```sh
# Export all sessions as JSON
claude-stats export > sessions.json

# Export this month's sessions as CSV
claude-stats export --format csv --period month > this-month.csv
```

The CSV format includes these columns:

```
session_id, project_path, first_timestamp, last_timestamp,
claude_version, entrypoint, prompt_count,
input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
account_uuid, subscription_type
```

---

## `serve`

Start a local web dashboard in your browser.

```
claude-stats serve [--port <n>] [--open]
```

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `9120` | TCP port to listen on |
| `--open` | _(off)_ | Open the dashboard in the default browser immediately after starting |

The server runs until you press `Ctrl+C`. Every page load queries the live database, so the charts always reflect the most recently collected data.

The dashboard shows:
- **Summary bar** — sessions, prompts, total tokens, cache efficiency, estimated cost
- **Daily trend** — tokens and cost per day (line chart)
- **Model split** — token share per Claude model (doughnut)
- **Top projects** — token consumption by project (horizontal bar)
- **Entrypoint** — CLI vs VS Code usage (pie)
- **Stop reasons** — end_turn / tool_use / max_tokens distribution (bar)
- **Cache efficiency** — cached vs uncached tokens (doughnut)

Use the period selector on the page to switch between Day / Week / Month / All without restarting the server. The auto-refresh toggle reloads the page every 30 seconds.

**URL query parameters** — You can filter the dashboard by appending parameters to the URL. All the same filters available on `report` work here:

| Parameter | Example | Description |
|---|---|---|
| `period` | `?period=week` | `day`, `week`, `month`, or `all` |
| `project` | `?project=/Users/you/repos/myproject` | Filter to one project path |
| `repo` | `?repo=https://github.com/org/myrepo` | Filter to one git remote |
| `entrypoint` | `?entrypoint=claude-vscode` | `claude` or `claude-vscode` |
| `timezone` | `?timezone=America/New_York` | IANA timezone for day/week/month boundaries |
| `includeCI` | `?includeCI=true` | Include CI/automated sessions |

Parameters can be combined: `http://localhost:9120/?period=week&project=/Users/you/repos/myproject`

The period selector on the page preserves any other parameters already in the URL.

**Examples:**

```sh
# Start the dashboard on the default port
claude-stats serve

# Start and open in browser
claude-stats serve --open

# Use a different port
claude-stats serve --port 8080
```

---

## `search`

Search your prompt history for a keyword.

```
claude-stats search <query> [--project <path>] [--limit <n>] [--count]
```

| Option | Default | Description |
|---|---|---|
| `--project <path>` | _(all)_ | Restrict search to one project |
| `--limit <n>` | `20` | Maximum number of results to show |
| `--count` | _(off)_ | Print only the match count, not the results |

Results are sorted newest-first and show the timestamp, project, session ID prefix, and matching prompt text with the matched substring highlighted.

**Examples:**

```sh
claude-stats search "refactor"
claude-stats search "sqlite" --project /Users/you/repos/myproject
claude-stats search "deploy" --count
```

---

## `tag`

Add or remove tags on a session, or list a session's tags.

```
claude-stats tag <session-id> [tags...] [--remove] [--list]
```

| Option | Description |
|---|---|
| `--remove` | Remove the listed tags instead of adding them |
| `--list` | Show current tags for the session (no other action) |

`<session-id>` can be a prefix (first 6+ characters) — the command resolves it to the matching session.

Tags are lowercase strings matching `[a-z0-9][a-z0-9_-]{0,49}`.

**Examples:**

```sh
# Add tags
claude-stats tag abc123 refactor important

# Remove a tag
claude-stats tag abc123 --remove refactor

# List tags for a session
claude-stats tag abc123 --list
```

---

## `tags`

List all tags with their session counts.

```
claude-stats tags
```

No options.

---

## `config`

View or update tool configuration (cost alert thresholds).

```
claude-stats config <action> [key] [value]
```

| Action | Description |
|---|---|
| `show` | Print all current configuration |
| `set <key> <value>` | Set a configuration value |
| `unset <key>` | Remove a configuration value |

Valid keys: `cost.day`, `cost.week`, `cost.month` (dollar thresholds that trigger a warning after `collect`).

**Examples:**

```sh
claude-stats config show
claude-stats config set cost.day 5
claude-stats config set cost.month 50
claude-stats config unset cost.day
```

---

## `dashboard`

Output pre-aggregated dashboard JSON to stdout.

```
claude-stats dashboard [--period <period>] [--project <path>] [--repo <url>]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |
| `--project <path>` | _(all)_ | Filter to one project |
| `--repo <url>` | _(all)_ | Filter to one repo |

Outputs a JSON object with `summary`, `byDay`, `byProject`, `byModel`, `byEntrypoint`, and `stopReasons` fields. Useful for piping into other tools or building custom visualisations.

```sh
claude-stats dashboard --period week | jq '.summary'
```

---

## `spending`

Show a detailed cost breakdown for a period: total cost by model, top sessions, top tools by estimated token cost, MCP server costs, anomalous prompts, and cache efficiency.

```
claude-stats spending [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `day` | `day`, `week`, `month`, or `all` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--model <name>` | _(all models)_ | Filter to sessions using a specific model (prefix match, e.g. `claude-opus`) |
| `--top <n>` | `5` | Number of top sessions/tools/anomalies to show |
| `--sort <key>` | `cost` | Sort sessions by: `cost`, `tokens`, or `prompts` |
| `--timezone <tz>` | System timezone | IANA timezone for period boundaries |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--json` | _(off)_ | Output full breakdown as JSON instead of a formatted report |

**What it shows:**

- **Total cost by model** — estimated API-equivalent cost broken down by model with input/output token counts
- **Top sessions** — most expensive sessions in the period (session ID prefix, project, prompt count, duration, model)
- **Top tools** — tools ranked by estimated cost contribution (based on tokens used in messages where the tool was called)
- **MCP servers** — cost and call volume grouped by MCP server
- **Anomalies** — prompts with unusually high token counts (relative to your average)
- **Cache efficiency** — hit rate and estimated savings from cache hits
- **Subagent overhead** — tokens consumed by spawned agent tool calls

**Examples:**

```sh
# Today's spending breakdown
claude-stats spending

# This week's spending, top 10 sessions
claude-stats spending --period week --top 10

# Sorted by prompt count rather than cost
claude-stats spending --period month --sort prompts

# Export as JSON for processing
claude-stats spending --period week --json | jq '.topSessions'
```

---

## `mcp`

Start a local MCP server over stdio for AI agent access to your usage stats.

```
claude-stats mcp
```

No options. The server is intended to be launched by a Claude Code client (not run manually in a terminal). It reads the local database and exposes read-only tools — no network access or authentication required.

**Available tools:**

| Tool | Description |
|---|---|
| `get_stats` | Usage summary for a period — tokens, cost, sessions, cache efficiency |
| `list_sessions` | Recent sessions with token counts and estimated cost |
| `get_session_detail` | Messages and token usage for a specific session |
| `list_projects` | Per-project usage breakdown |
| `get_status` | Database health, session count, last collection time |
| `search_history` | Search prompt history by keyword |

**Client configuration** — register via `claude mcp add`:

```sh
MCP_JS="$HOME/.vscode/extensions/claude-stats.claude-stats-vscode-0.1.0/dist/mcp.js"
claude mcp add -s user claude-stats -- "$(which node)" --experimental-sqlite \
  -e "require('$MCP_JS').startMcpServer().catch(e=>{console.error(e);process.exit(1)})"
```

> **Note:** The `mcpServers` key in `~/.claude/settings.json` is ignored by the Claude Code CLI for server registration. Servers must be registered in `~/.claude.json` via `claude mcp add` or `.mcp.json` for project-scope use.

The VS Code extension auto-registers this in `~/.claude.json` on first activation — no manual setup needed if you use the extension.

**Example queries once connected:**

- "How many tokens have I used this week?"
- "What were my most expensive sessions today?"
- "Which projects am I spending the most on?"

---

## `backfill`

Re-parse all session files from scratch to populate newly added fields (e.g. `prompt_text` added in schema v8). This resets all file checkpoints and runs a full collection.

```
claude-stats backfill [--verbose]
```

| Option | Description |
|---|---|
| `-v, --verbose` | Print one line per file as it is processed |

**Example output:**

```
Reset 44 file checkpoints. Running full re-collection...
Backfill complete. 44 files re-processed, 1876 messages updated.
```

Use this after upgrading `claude-stats` to a version that captures additional data from existing session files.

---

## `diagnose`

Show quarantine counts and schema health information.

```
claude-stats diagnose
```

Quarantined lines are raw JSONL lines that could not be parsed. They accumulate when Claude Code changes its output format or writes partial lines during a crash. Use this command to detect whether the parser needs updating.

Example output:

```
─── Diagnose ───

Quarantined lines : 2

Use 'status' for database metrics.
```

---

## VS Code Extension

The optional VS Code extension embeds the dashboard directly inside the editor. It provides:

- **Automatic collection** — watches `~/.claude/projects/` for file changes and runs incremental collection automatically. No need to run `claude-stats collect` manually.
- **Dashboard panel** — the same interactive Chart.js dashboard as `serve`, displayed in a VS Code webview tab (opened via the Command Palette: **Claude Stats: Open Dashboard**). Updates automatically after each collection.
- **Status bar item** — shows today's token count and estimated cost in the bottom bar; click to open the dashboard. Updates automatically after each collection.

### Installation

The extension is fully self-contained — all dependencies (including the parser, store, and dashboard renderer) are bundled into a single file via esbuild. You do **not** need to install the `claude-stats` CLI separately.

```sh
# Build and package in one step
npm run package:ext

# Install the .vsix
code --install-extension extension/claude-stats-vscode-0.1.0.vsix
```

For development, you can use `npm run build:ext` to rebuild just the extension bundle, or `npm run build:all` to build both the CLI and extension.

### Configuration

The extension contributes two settings (accessible via **Settings > Extensions > Claude Stats**):

| Setting | Default | Description |
|---|---|---|
| `claude-stats.port` | `9120` | Port for the `serve` command (informational; the extension panel uses direct data access) |
| `claude-stats.autoRefreshSeconds` | `30` | How often the dashboard panel refreshes its data (seconds). Set to `0` to disable |

### Multiple VS Code instances

Multiple VS Code windows can run the extension simultaneously without data corruption. SQLite WAL mode allows concurrent readers, and a `busy_timeout` lets concurrent writers wait rather than fail. Collection is idempotent (upsert-based), so duplicate work from multiple instances is harmless — at worst, two instances parse the same file and write the same data.

### Requirements

The extension requires Node.js 22.5+ (for `node:sqlite`). If the extension host's Node version is too old, you will see an error when opening the dashboard. In that case, use `claude-stats serve --open` from the terminal instead.
