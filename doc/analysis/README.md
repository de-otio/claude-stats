# Claude Stats — Analysis

This directory contains the design analysis for a tool that collects Claude Code usage statistics from local data files. The analysis is based on direct inspection of real `~/.claude/` data across Claude Code versions 2.1.61–2.1.71.

## Goal

Collect token usage, session metadata, and developer activity metrics from Claude Code (CLI and VS Code extension) without requiring API access — targeting Claude Plans users (Teams, ProMax) where no per-token billing API exists.

## Key Finding

Claude Code stores rich session data locally in `~/.claude/projects/`. Every message includes token counts, model name, tool usage, timestamps, and git context. Both the CLI and VS Code extension write to the same directory. No API access is needed.

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-data-sources.md](01-data-sources.md) | What data exists, where it lives, platform paths |
| 02 | [02-collection-strategy.md](02-collection-strategy.md) | Parsing, aggregation, incremental collection, concurrency |
| 03 | [03-architecture.md](03-architecture.md) | Tool components, CLI interface, storage, future sync |
| 04 | [04-insights.md](04-insights.md) | What questions the data can answer |
| 05 | [05-privacy-security.md](05-privacy-security.md) | Data sensitivity, local-only principle, sync rules |
| 06 | [06-limitations.md](06-limitations.md) | Known gaps and constraints |
| 07 | [07-schema-reference.md](07-schema-reference.md) | Exact field-level schemas for parser implementation |
| 08 | [08-resilience.md](08-resilience.md) | Handling Claude Code updates and schema changes |
| 09 | [09-token-spending-analysis.md](09-token-spending-analysis.md) | Token spending breakdown: where did my tokens go? |

Read in order for full context, or jump to 07 and 02 to start implementing.

## Sub-analyses

| Directory | Purpose |
|-----------|---------|
| [energy-dashboard/](energy-dashboard/) | Energy consumption and carbon footprint estimation dashboard |

## Architecture Summary

```
~/.claude/projects/*/*.jsonl
          ↓
    Scanner → Parser → Schema Monitor
                ↓              ↓
           Aggregator      Quarantine
                ↓
           SQLite DB (~/.claude-stats/stats.db)
                ↓
    Reporter / Export / Sync (future)
```

## Primary Data: Session JSONL

Each session file is a JSONL stream where `assistant` messages carry the token usage:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "usage": {
      "input_tokens": 12345,
      "output_tokens": 678,
      "cache_creation_input_tokens": 500,
      "cache_read_input_tokens": 10000
    }
  },
  "timestamp": 1772558308674,
  "sessionId": "...",
  "gitBranch": "main",
  "entrypoint": "claude-vscode"
}
```

## Critical Design Constraints

- **No API access** — all data comes from local file parsing
- **Schema instability** — Claude Code updates frequently with no format contract; treat all fields as optional
- **Concurrent writes** — session files are written in real-time; discard partial last lines
- **Privacy by default** — prompt content never stored or synced; only aggregated metrics
- **Idempotent collection** — message `uuid` used as upsert key; safe to re-run after crashes
