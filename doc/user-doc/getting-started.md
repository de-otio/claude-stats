# Getting Started

## Requirements

- **Node.js 22.5 or later** — required for the built-in `node:sqlite` module.
- Claude Code installed and used at least once (so `~/.claude/projects/` exists).

## Installation

Clone the repository and build:

```sh
git clone <repo-url> claude-stats
cd claude-stats
npm install
npm run build
```

To use the `claude-stats` command globally, link it:

```sh
npm link
```

Or run it directly without linking:

```sh
node --experimental-sqlite dist/index.js <command>
```

The `npm start` script also works as an alias:

```sh
npm start -- <command>
```

> **Node warning:** You will see `ExperimentalWarning: SQLite is an experimental feature`. This is expected and harmless — it comes from Node itself, not from this tool.

## First run

**1. Collect session data:**

```sh
claude-stats collect
```

This scans `~/.claude/projects/`, parses every session JSONL file, and stores the results in `~/.claude-stats/stats.db`. It is safe to run repeatedly — files that have not changed are skipped automatically.

**2. View a summary:**

```sh
claude-stats report
```

Example output:

```
─── Claude Stats — all time ───

Sessions : 42
Prompts  : 318
Input    : 4.2M
Output   : 891K
Cache    : 1.8M read, 312K created (29.9% efficiency)
Models   : claude-opus-4-6 (38), claude-sonnet-4-6 (4)
Top tools: Read:412  Edit:198  Bash:87  Glob:62  Grep:55
```

**3. Open the graphical dashboard:**

```sh
claude-stats serve --open
```

This starts a local web server on `http://localhost:9120` and opens it in your browser. The dashboard shows token trends, model splits, project breakdowns, and cache efficiency as interactive charts. Press `Ctrl+C` to stop the server.

Alternatively, export a self-contained HTML file you can open any time:

```sh
claude-stats report --html
# → Wrote claude-stats-2026-03-08.html
```

If you use VS Code, you can also install the optional extension to get the dashboard as an editor tab and a status bar showing today's usage. The extension collects data automatically — no need to run `collect` manually. See the [VS Code Extension](commands.md#vs-code-extension) section for setup instructions.

**4. Check database health:**

```sh
claude-stats status
```

## Typical workflow

Run `collect` before viewing reports to ensure the data is current:

```sh
claude-stats collect && claude-stats report --period week
```

To open the dashboard with fresh data:

```sh
claude-stats collect && claude-stats serve --open
```

To collect on a schedule, add a cron job:

```sh
# Collect every 15 minutes
*/15 * * * * node --experimental-sqlite /path/to/dist/index.js collect
```
