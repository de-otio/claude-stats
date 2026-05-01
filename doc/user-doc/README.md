# claude-stats — User Documentation

**claude-stats** collects and reports usage statistics from Claude Code sessions stored locally on your machine. No API key or network access is required.

## Contents

| Document | What it covers |
|---|---|
| [getting-started.md](getting-started.md) | Install, first run, quick tour |
| [commands.md](commands.md) | Full command and option reference |
| [output-guide.md](output-guide.md) | Reading and interpreting the reports |
| [faq.md](faq.md) | Common questions and troubleshooting |

## How it works

Claude Code writes a JSONL file for every session under `~/.claude/projects/`. `claude-stats` reads those files incrementally, stores aggregated token counts and session metadata in a local SQLite database (`~/.claude-stats/stats.db`), and renders summaries on demand.

- **Nothing leaves your machine.** All data stays in `~/.claude-stats/`.
- **Incremental.** Only new lines are read on each `collect` run.
- **Non-destructive.** The tool never modifies Claude Code's own files.
