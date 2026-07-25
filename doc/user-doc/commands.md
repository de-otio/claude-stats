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

## `account`

Show the current logged-in Claude account, its suggested plan, and the accounts known to claude-stats. Also manages cost-ownership rules and account re-attribution.

```
claude-stats account [subcommand] [options]
```

| Subcommand | Description |
|---|---|
| _(none)_ | Print the current account plus the known-accounts table |
| `reattribute [--dry-run] [--force]` | Recompute account attribution across all stored sessions |
| `own [options]` | Manage cost-ownership rules (assign a path or remote glob to an account) |
| `classify` | Show project clusters ranked by estimated cost, to help identify ownership |

**`account` (no subcommand)** prints, when a Claude login is present: account UUID, organization type, rate-limit tier, seat tier, billing type, extra-usage status, plus (when local usage data exists) a suggested plan, a verdict on the current plan (good value / underusing / no plan), and a usage-intensity tier (light / typical / power) benchmarked against Anthropic's per-seat usage tiers. It never recommends a company-wide seat count — see `plan-advisor` for that.

| Option (`account reattribute`) | Description |
|---|---|
| `--dry-run` | Preview the changes without writing or creating a backup |
| `--force` | Proceed even if re-attribution would clear existing attributions |

| Option (`account own`) | Description |
|---|---|
| `--account <uuid\|split>` | Account UUID to assign cost to, or `split` to keep measured attribution |
| `--path <glob>` | Glob pattern matching project paths (e.g. `~/repos/work/**`) |
| `--remote <glob>` | Glob pattern matching git remote owner (e.g. `github.com/example-org/*`) |
| `--dry-run` | Preview how many sessions the rule would match, without creating it |
| `--force` | Create the rule even if it matches more than 90% of sessions |
| `--list` | List all existing owner rules |
| `--clear <id>` | Remove the owner rule with the given id and revert its sessions |

**Examples:**

```sh
# Show the current account and suggested plan
claude-stats account

# Recompute attribution across the whole store (dry run first)
claude-stats account reattribute --dry-run
claude-stats account reattribute

# Assign a path glob to a specific account
claude-stats account own --account <uuid> --path "~/repos/work/**"

# List and clear ownership rules
claude-stats account own --list
claude-stats account own --clear 3

# Show project clusters ranked by cost
claude-stats account classify
```

---

## `plan-advisor`

Size Team vs Enterprise seats for a company-wide Claude rollout from a headcount and a technical-role fraction. Prints a scenario table across adoption levels — seat counts, whether each fits Team's seat range, procurement motion, and a cost projection per plan — with the source data's staleness warning. Never picks a plan for you.

```
claude-stats plan-advisor --headcount <n> --technical-fraction <pct> [options]
```

| Option | Default | Description |
|---|---|---|
| `--headcount <n>` | _(required)_ | Total company headcount (whole number, at least 1) |
| `--technical-fraction <pct>` | _(required)_ | Share of headcount that would get a Claude Code seat, as a fraction 0–1 or a percentage like `50` |
| `--tier-mix <light,typical,power>` | Anthropic's benchmark mix | Optional measured light/typical/power intensity split (e.g. `0.5,0.4,0.1`); must sum to 1 |
| `--compliance` | _(off)_ | Surface the compliance trigger prominently in the output. Does not change the numbers or pick a plan |

The scenario table is computed for adoption fractions 25% / 50% / 75% / 100% of the technical population. Every dollar figure is an estimate resting on the tier-mix assumption and the negotiated Enterprise seat floor — not a quote; re-verify current pricing at claude.com/pricing before purchasing. Two questions are always left open for the user to decide, never resolved by this command: whether their compliance posture requires Enterprise independent of seat count, and which spend-limit philosophy (pooled vs per-user) they prefer. See the `license-advisor` skill (`skills/license-advisor/SKILL.md`) for an agent-guided walkthrough of the same tradeoffs.

**Examples:**

```sh
# Size seats for a 400-person company, half technical roles
claude-stats plan-advisor --headcount 400 --technical-fraction 0.5

# With a measured usage-intensity split instead of the default benchmark mix
claude-stats plan-advisor --headcount 400 --technical-fraction 0.5 --tier-mix 0.6,0.3,0.1

# Surface the compliance trigger prominently
claude-stats plan-advisor --headcount 200 --technical-fraction 0.25 --compliance
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

## `cost-per-task`

Show **cost per successful task** — equivalent-API dollars spent per *shipped / confirmed* task, overall and per model. This is an outcome-cost metric: it divides cost over observable attempts by the number that succeeded, rather than stopping at tokens.

```
claude-stats cost-per-task [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `month` | `day`, `week`, `month`, or `all` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--repo <url>` | _(all repos)_ | Filter to a specific git remote URL |
| `--include-ci` | _(off)_ | Include CI/automated sessions |
| `--by-model` | _(off)_ | Show the per-model breakdown table |
| `--timezone <tz>` | System timezone | IANA timezone for period boundaries |
| `--json` | _(off)_ | Output the full report as JSON |

**What it shows:**

- **Headline** — cost per successful task, with its decomposition: `mean cost per attempt ÷ success rate`.
- **Coverage & labelling** — a task is one of four states (`success` / `failed` / `in-flight` / `unobservable`). The success rate is computed over the **observable** subset (success ∪ failed) only; `coverage` and the labelled share are reported beside it. If coverage is low, the report leads with mean cost per attempt and warns.
- **Per-model table** (`--by-model`) — cost-per-success and success rate by dominant model (suppressed below a minimum number of observable tasks).

Outcome is proxied from git activity and recap confidence unless you label a task explicitly with `task-outcome`. A note: `--period all` on a cold cache is slow (per-day git enrichment) — run `recap precompute` first to warm it.

**Examples:**

```sh
# This month's cost per successful task
claude-stats cost-per-task

# Last 7 days, with the per-model breakdown
claude-stats cost-per-task --period week --by-model

# As JSON
claude-stats cost-per-task --json
```

---

## `task-outcome`

Label a task's outcome so the cost-per-task metric rests on ground truth instead of a proxy. Explicit labels override the git/confidence proxy.

```
claude-stats task-outcome <item> <success|partial|fail>
claude-stats task-outcome <item> --clear
```

`<item>` is an id prefix or prompt substring from **today's** recap (the same selector style as `recap correct hide`/`rename`). Use `--clear` to remove an existing label.

Labelling is a human action — the read-only MCP server cannot set labels, which keeps the producer of the number (the model) separate from the judge of success (you). The same control is also available per-task in the VS Code dashboard webview.

**Examples:**

```sh
# Mark a task as successfully shipped
claude-stats task-outcome a1b2c3 success

# Mark by prompt substring
claude-stats task-outcome "refactor auth" partial

# Remove a label
claude-stats task-outcome a1b2c3 --clear
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
| `summarize_day` | Clustered digest of what you accomplished on a given day |
| `get_cost_per_task` | Cost per successful task — outcome-cost overall and per model (read-only) |

**Per-account filtering:** `get_stats`, `list_sessions`, `list_projects`, and
`get_cost_per_task` all accept an optional `account` param — a full account
UUID or an unambiguous prefix (e.g. `<uuid-prefix>`). An empty string, a
prefix matching no account, or a prefix matching more than one account
returns an error rather than silently falling back to all accounts.
`list_sessions` rows also include an `accountUuid` field.

**Per-account token breakdown:** `get_stats`'s `planUtilization.byAccount[]`
entries carry `inputTokens`, `outputTokens`, `cacheReadTokens`, and
`cacheCreationTokens`, plus a `byModel` split (mirroring the top-level
`byModel` shape). Every token, prompt and cost figure — `summary`,
`byAccount`, `byModel`, `byDay`, `byHour`, `byProject` — is **in-window**
(bounded to the requested period) and computed from the same per-message data,
so each breakdown sums exactly to the headline.

Only `sessions` counts are session-scoped: a session is counted in the period
it was active, and attributed to the day it *started*. Its tokens are always
attributed to when they were actually sent, so a session spanning several days
contributes one session count but per-day token counts.

**Client configuration** — register via `claude mcp add`:

```sh
MCP_JS="$HOME/.vscode/extensions/de-otio.claude-stats-vscode-0.1.1/dist/mcp.js"
claude mcp add -s user claude-stats -- "$(which node)" --experimental-sqlite \
  -e "require('$MCP_JS').startMcpServer().catch(e=>{console.error(e);process.exit(1)})"
```

> **Note:** The `mcpServers` key in `~/.claude/settings.json` is ignored by the Claude Code CLI for server registration. Servers must be registered in `~/.claude.json` via `claude mcp add` or `.mcp.json` for project-scope use.

The VS Code extension auto-registers this in `~/.claude.json` on first activation — no manual setup needed if you use the extension.

**Example queries once connected:**

- "How many tokens have I used this week?"
- "What were my most expensive sessions today?"
- "Which projects am I spending the most on?"
- "What's my cost per successful task, by model?"
- "How many tokens did my work account use this month?" (pass `account: "<uuid-prefix>"`)

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

## `purge`

Delete claude-stats data from this machine and unregister the MCP server. **Dry
run by default** — without `--yes` it only prints what *would* be deleted and
exits without changing anything.

```
claude-stats purge [--yes] [--include-db] [--backup-cloud]
```

| Option | Description |
|---|---|
| _(none)_ | Dry run: preview what would be deleted; deletes nothing |
| `--yes` | Actually delete claude-stats data (archive/bundle files); also unregisters the MCP server from `~/.claude.json` |
| `--include-db` | Also delete the SQLite database `~/.claude-stats/stats.db` (otherwise the DB is kept) |
| `--backup-cloud` | Also describe/target the encrypted cloud backup copy for this device (other devices keep their own copies) |

```sh
# Preview only (safe)
claude-stats purge

# Delete local data but keep the database
claude-stats purge --yes

# Delete everything including the database
claude-stats purge --yes --include-db
```

See [backup-and-sync.md](backup-and-sync.md#removing-your-data) for the cloud
scope and the VS Code **Delete All Stored Data…** equivalent.

---

## `setup`

Connect this device to a shared team Claude Stats backend and choose which local
accounts to share (aggregate-only). See [team-sync.md](team-sync.md).

```
claude-stats setup [--backend-url <url>] [--email <email>] [--accounts <csv> | --all-accounts]
```

| Option | Description |
|---|---|
| `--backend-url <url>` | Team backend URL (or set `CLAUDE_STATS_BACKEND_URL`); discovers config from `<url>/.well-known/claude-stats.json` |
| `--email <email>` | Email for the passwordless sign-in (or set `CLAUDE_STATS_EMAIL`) |
| `--accounts <csv>` | Link these accounts (UUIDs or labels, comma-separated) without prompting |
| `--all-accounts` | Link all known local accounts without prompting |

Prompts for the backend URL, email, and (unless a flag is given) which accounts
to share. Generates a per-user salt used to derive one-way account handles — your
raw account UUID never leaves the machine.

## `link`

Re-choose which local accounts to share, after `setup`. Same selection flags.

```
claude-stats link [--accounts <csv> | --all-accounts]
```

Requires a prior `setup` (needs the salt). Without at least one linked account,
`sync` has nothing to send.

## `sync`

Push minimized per-day aggregates for your linked accounts to the team backend.

```
claude-stats sync [--dry-run]
```

| Option | Description |
|---|---|
| `--dry-run` | Print exactly what would be sent (per-day rollups only) without sending |

Sends only aggregate totals — never per-session, prompt, path, or transcript
data. Each `(you, day)` row is an optimistic, idempotent upsert, so re-syncing a
day is safe.

## `disconnect`

Remove team-sync tokens and configuration. Preserves the salt so re-linking later
produces the same account handles.

```
claude-stats disconnect
```

---

## VS Code Extension

The optional VS Code extension embeds the dashboard directly inside the editor. It provides:

- **Automatic collection** — watches `~/.claude/projects/` for file changes and runs incremental collection automatically. No need to run `claude-stats collect` manually.
- **Dashboard panel** — the same interactive Chart.js dashboard as `serve`, displayed in a VS Code webview tab (opened via the Command Palette: **Claude Stats: Open Dashboard**). Updates automatically after each collection.
- **Status bar item** — shows today's token count and estimated cost in the bottom bar; click to open the dashboard. Updates automatically after each collection.
- **Optional backup & sync** — **Claude Stats: Set Up Backup & Sync…** (or the dashboard's **Settings tab → Backup & Sync**, which also shows status and can turn it off again) turns on optional, end-to-end-encrypted backup and cross-device sync via a cloud folder you already use; **Claude Stats: Delete All Stored Data…** removes it. See [backup-and-sync.md](backup-and-sync.md).
- **Optional team sync (aggregate-only)** — **Claude Stats: Connect to Team Sync…** → **Link Accounts to Share…** → **Sync Now** shares minimized per-day usage totals with a shared team backend (never per-session or prompt data); **Disconnect from Team Sync** and **Open Team Dashboard** round it out. Equivalent to the CLI `setup` / `link` / `sync` / `disconnect` commands. See [team-sync.md](team-sync.md).

### Installation

The extension is fully self-contained — all dependencies (including the parser, store, and dashboard renderer) are bundled into a single file via esbuild. You do **not** need to install the `claude-stats` CLI separately.

```sh
# Build and package in one step
npm run package:ext

# Install the .vsix
code --install-extension extension/claude-stats-vscode-*.vsix
```

For development, you can use `npm run build:ext` to rebuild just the extension bundle, or `npm run build:all` to build both the CLI and extension.

### Configuration

The extension contributes these settings (accessible via **Settings > Extensions > Claude Stats**):

| Setting | Default | Description |
|---|---|---|
| `claude-stats.port` | `9120` | Port for the `serve` command (informational; the extension panel uses direct data access) |
| `claude-stats.autoRefreshSeconds` | `30` | How often the dashboard panel refreshes its data (seconds). Set to `0` to disable |
| `claude-stats.recap.embeddings` | `auto` | Semantic clustering for daily-recap. `auto` uses the bundled local embedding model; `off` falls back to lexical clustering. All inference is on-device |
| `claude-stats.backendUrl` | `""` | Base URL of your team's Claude Stats backend, set when you **Connect to Team Sync** (team sync only) |
| `claude-stats.autoSync` | `false` | Push minimized daily aggregates to your team backend automatically after each collection (team sync only) |

### Multiple VS Code instances

Multiple VS Code windows can run the extension simultaneously without data corruption. SQLite WAL mode allows concurrent readers, and a `busy_timeout` lets concurrent writers wait rather than fail. Collection is idempotent (upsert-based), so duplicate work from multiple instances is harmless — at worst, two instances parse the same file and write the same data.

### Requirements

The extension requires Node.js 22.5+ (for `node:sqlite`). If the extension host's Node version is too old, you will see an error when opening the dashboard. In that case, use `claude-stats serve --open` from the terminal instead.
