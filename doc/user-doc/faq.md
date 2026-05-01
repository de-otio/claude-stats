# FAQ & Troubleshooting

## General

### How do I see a graphical view of my usage?

Run `claude-stats serve --open` after collecting data. This starts a local web server and opens the dashboard in your browser. All data stays on your machine — the server only listens on `127.0.0.1`.

To get a shareable snapshot without running a server, use `claude-stats report --html`, which writes a self-contained HTML file with the same charts.

If you use VS Code, install the extension for an in-editor dashboard panel and status bar. See [VS Code Extension](commands.md#vs-code-extension).

### Does this tool send my data anywhere?

No. Everything stays on your machine. `claude-stats` reads `~/.claude/projects/`, writes to `~/.claude-stats/`, and makes no network requests.

### Does it modify Claude Code's files?

No. The tool reads Claude Code's session files but never writes to them.

### Does it work with Claude Code running at the same time?

Yes. Claude Code appends to session files; `claude-stats collect` reads from the beginning (or from the last checkpoint offset). SQLite WAL mode ensures the database is safe for concurrent reads.

---

## Data questions

### Why do my token counts differ from what I expected?

Token counts come directly from the `usage` field in each assistant response — the same numbers the API returns. They reflect actual billing units.

Note that `cache_read_input_tokens` are separate from `input_tokens` in the raw data. Both are shown in the report; the cache efficiency percentage shows how much of the total context was served from cache.

### Why are some sessions missing?

A few common causes:

- You haven't run `collect` recently. Run `claude-stats collect` to pick up new sessions.
- The session is from CI or automation. By default, sessions without an interactive marker are excluded. Use `--include-ci` to include them.
- The session file was created before `collect` was first run and has since been deleted. Deleted source files are marked `source_deleted` in the database.

### What does "source_deleted" mean?

If a session JSONL file under `~/.claude/projects/` is deleted (by you, or by Claude Code's own cleanup), the sessions derived from that file are marked `source_deleted = 1`. They are excluded from `report` output by default but still present in the database.

### Why does the report show 0 sessions for today?

The `--period day` filter uses midnight in the specified timezone (or your local timezone if none is given) as the start boundary. If the sessions were collected before midnight in that timezone, or if you haven't run `collect` today, they may not appear. Run `claude-stats collect` first.

---

## Errors and warnings

### "No sessions found for the given filters."

Either:
- You haven't run `collect` yet — run `claude-stats collect`.
- The filters are too narrow — try without `--period` or `--project`.
- All matching sessions are CI sessions — try `--include-ci`.

### "ExperimentalWarning: SQLite is an experimental feature"

This warning comes from Node.js, not from this tool. It is expected on Node 22.x and will disappear when Node promotes `node:sqlite` to stable. It does not affect functionality.

### Parse errors / quarantined lines

If `claude-stats status` shows `Quarantined: N unparseable lines`, it means one or more lines in a session JSONL file could not be parsed. Common causes:

- Claude Code was interrupted mid-write and left a partial line. The last partial line is discarded automatically and is not quarantined.
- Claude Code changed its output format after an update. Run `claude-stats diagnose` to check whether the schema has changed.

Quarantined lines do not affect the rest of the data — parsing continues on the next line.

### VS Code extension: "node:sqlite" error when opening dashboard

The extension requires Node.js 22.5+ for the `node:sqlite` module. VS Code's extension host runs on the Node.js version bundled with Electron, which may be older. If you see this error, use `claude-stats serve --open` from the terminal instead — it works identically.

### The database file is growing large

`~/.claude-stats/stats.db` stores all session history. You can check its size with `claude-stats status`. There is no automatic compaction yet — you can delete the file and re-run `collect` to rebuild from scratch (no data from Claude Code's own files is lost). Alternatively, use `claude-stats backfill` to re-parse everything while preserving the database.

---

## Development

### How do I run the tests?

```sh
npm test          # run once
npm run test:watch  # watch mode
npm run coverage  # with coverage report
```

### How do I build after making changes?

```sh
npm run build     # compile TypeScript → dist/
npm run typecheck # type-check without emitting
```
