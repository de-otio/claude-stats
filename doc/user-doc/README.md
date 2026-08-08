# claude-stats — User Documentation

**claude-stats** collects and reports usage statistics from Claude Code sessions stored locally on your machine. No API key or network access is required.

## Contents

| Document | What it covers |
|---|---|
| [getting-started.md](getting-started.md) | Install, first run, quick tour |
| [commands.md](commands.md) | Full command and option reference |
| [output-guide.md](output-guide.md) | Reading and interpreting the reports |
| [backup-and-sync.md](backup-and-sync.md) | Optional end-to-end-encrypted backup/sync, recovery keys, and the data-privacy model |
| [team-sync.md](team-sync.md) | Optional aggregate-only usage sharing to a shared team backend, and what it can and cannot see |
| [account-otel.md](account-otel.md) | Authoritative per-account attribution via Claude Code's OpenTelemetry export |
| [faq.md](faq.md) | Common questions and troubleshooting |

## How it works

Claude Code writes a JSONL file for every session under `~/.claude/projects/`. `claude-stats` reads those files incrementally, stores aggregated token counts and session metadata in a local SQLite database (`~/.claude-stats/stats.db`), and renders summaries on demand.

- **Local by default.** Out of the box nothing leaves your machine — all data
  stays in `~/.claude-stats/` and no network requests are made. Optional,
  opt-in [backup and sync](backup-and-sync.md) can copy an **end-to-end-encrypted**
  bundle to a cloud folder you already control; you turn it on explicitly.
- **Incremental.** Only new lines are read on each `collect` run.
- **Non-destructive.** The tool never modifies Claude Code's own files.
