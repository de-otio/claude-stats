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
| 05 | [05-privacy-security.md](05-privacy-security.md) | Data sensitivity, local-only principle, org-plane sync rules, the opt-in transcript archive, the personal E2E plane, and the two-plane separation |
| 06 | [06-limitations.md](06-limitations.md) | Known gaps and constraints |
| 07 | [07-schema-reference.md](07-schema-reference.md) | Exact field-level schemas for parser implementation |
| 08 | [08-resilience.md](08-resilience.md) | Handling Claude Code updates and schema changes |
| 09 | [09-token-spending-analysis.md](09-token-spending-analysis.md) | Token spending breakdown: where did my tokens go? |

Read in order for full context, or jump to 07 and 02 to start implementing.

## Sub-analyses

| Directory | Purpose |
|-----------|---------|
| [daily-recap/](daily-recap/) | "What did I get done today?" — hybrid AI + deterministic pipeline for token-efficient day summaries |
| [energy-dashboard/](energy-dashboard/) | Energy consumption and carbon footprint estimation dashboard |
| [cost-per-successful-task/](cost-per-successful-task/) | "What does a correct result actually cost?" — outcome-cost metric per model, for the post-subsidy pricing era |
| [value-per-cost/](value-per-cost/) | Reanalysis of the above: splits the one value-flavoured number into efficiency (machine-owned) + output/survival + value (user-owned), to answer "was the AI investment justified, was it efficient, what to change?" |
| [account-attribution/](account-attribution/) | "Whose account ran this?" — reliably attributing usage to one of several accounts that share a machine, when transcripts carry no account id; observation-timeline + anchors + optional OTEL |
| [data-planes/](data-planes/) | How backup, cross-device sync, and team features relate — one two-plane model (personal E2E plane vs org aggregate plane), the encrypted-bundle keystone, per-class optional encryption, and the effortless/dummy-proof UX; reconciles cross-device-sync/, team-dashboard/, and team-app/ |
| [ticket-attribution/](ticket-attribution/) | Token cost per Jira ticket — evidence-graded attribution (branch/commit/prompt/tag), a coverage-honest report shape, and the org-plane/backend changes for automated team reporting; the attribution layer under value-per-cost/ |
| [constraint-impact/](constraint-impact/) | What withholding capability costs — budget caps, model-tier removal ("no Opus"), throttling/quotas — measured as cost-per-outcome and dev-time deltas across a policy boundary; two-sided by construction, outputs a costed tiered-access proposal; the mirror of ticket-attribution/ |
| [efficiency-hygiene/](efficiency-hygiene/) | Local, deterministic waste detectors (cache churn, retry loops, abandoned spend, context bloat, tier mismatch) — the clean-hands half that makes justification reports credible; strictly local, only the trend is shareable |
| [gui-redesign/](gui-redesign/) | Answer-first dashboard IA: an Insights default layer (five business-question cards + alerts) with the full guru surface re-homed under Explore; how ticket/constraint/hygiene data surfaces without new tabs; migration without a rewrite |
| [context-metaphor/](context-metaphor/) | How to *talk* about context cost — which metaphors teach the billing mechanics correctly (backpack for the one-liner, amnesiac consultant for caching/TTL/compaction) and which install the wrong model (anything storage-shaped, especially "context is RAM") |

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
- **Privacy by default** — user prompt text is stored locally (sanitized, since schema V8) but never leaves the machine except via the personal plane the user explicitly enables; the org/team plane only ever receives locally-computed aggregates (see [05-privacy-security.md](05-privacy-security.md))
- **Idempotent collection** — message `uuid` used as upsert key; safe to re-run after crashes
