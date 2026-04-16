# Ruflo Integration Insights

## Overview

[Ruflo](https://github.com/ruvnet/ruflo) is an agent orchestration platform for Claude Code that deploys multi-agent systems, coordinates autonomous workflows, and implements self-learning patterns. It integrates via MCP server and lifecycle hooks. This document analyzes how claude-stats can generate insights for ruflo users to measure whether the tool is delivering value.

## Ruflo's Data Footprint

Ruflo produces data at several layers:

- **MCP tool invocations** — Every ruflo command (`agent spawn`, `memory search`, `swarm coordinate`, etc.) appears in Claude Code session JSONL files as `mcp__ruflo__*` tool calls.
- **SQLite with WAL** — Pattern success rates, agent metrics, task completion history.
- **ReasoningBank** — Learned pattern trajectories and confidence scores.
- **MemoryGraph** — Knowledge graph with PageRank and label propagation scores.
- **Session persistence** — Full context save/restore data across conversations.
- **33 lifecycle hooks** — Pre/post events for sessions, agents, tasks, tools, memory, swarms, files, and learning.

## Level 1: Already Works Out of the Box

Since ruflo registers as an MCP server (`claude mcp add ruflo -- npx ruflo@latest mcp start`), claude-stats already captures ruflo tool invocations from session JSONL files. Every `mcp__ruflo__*` call shows up in:

- **Tool cost attribution** — How much token spend is driven by ruflo tools vs. other tools.
- **Tool frequency** — Which ruflo commands are used most.
- **MCP server grouping** — All ruflo tools roll up under the `ruflo` server prefix in the spending breakdown.
- **Session-level impact** — Sessions using ruflo tools vs. sessions without them.

A user with ruflo installed would already see it in `claude-stats spending` output.

## Level 2: Comparative Insights

claude-stats could be extended to answer "is ruflo actually helping me?" by comparing sessions with and without ruflo activity:

| Metric | With Ruflo | Without Ruflo | Interpretation |
|--------|-----------|---------------|----------------|
| Tokens per task completion | Lower = better orchestration | Baseline | Agent coordination reduces redundant work |
| Cost per session | Higher is expected (more agents), but cost-per-outcome matters | Baseline | Raw cost increase is acceptable if outcomes improve |
| Session duration | Shorter = faster task completion | Baseline | Multi-agent parallelism should reduce wall-clock time |
| Cache hit rate | Ruflo's memory/patterns should improve this | Baseline | Pattern learning feeds cache reuse |
| Truncation rate | Multi-agent coordination may reduce this | Baseline | Better task decomposition avoids output limits |
| Prompts per session | More prompts but more autonomous = good | Baseline | Higher prompt count with lower human intervention is positive |

This requires tagging sessions as "ruflo-active" (detectable by presence of `mcp__ruflo__*` tool calls) and computing differential metrics — a straightforward extension of the existing `buildDashboard()` pipeline.

## Level 3: Deep Ruflo-Specific Insights

Reading ruflo's own data stores directly (similar to how claude-stats already reads `~/.claude/` files) would enable:

- **Agent efficiency** — Which of the 16+ agent types have the best success rates.
- **Pattern learning ROI** — Are learned patterns actually reducing future token costs.
- **Swarm utilization** — How often are multi-agent swarms used vs. single agents.
- **Memory value** — Is the vector memory actually being hit, and does it correlate with cheaper/faster sessions.
- **Hook activity** — Which of the 33 lifecycle hooks fire most frequently.

## Level 4: Ruflo as a Data Source

The most elegant approach: ruflo already exposes CLI commands like `agent metrics`, `performance report`, `memory stats`, and `neural status`. claude-stats could call ruflo's own reporting tools (or read its SQLite) during collection, avoiding any need to reverse-engineer ruflo's internal data format.

## Implementation Plan

### Phase 1: Detection and Attribution

Add a "ruflo detected" flag to claude-stats that tags sessions and adds a section to the dashboard showing ruflo tool usage frequency and cost. This leverages the existing MCP tool prefix convention (`mcp__ruflo__*`) as a natural detection mechanism.

Scope:
- Detect ruflo-active sessions during collection by scanning for `mcp__ruflo__*` tool calls.
- Add a `ruflo_active` boolean to `SessionRecord`.
- Add a ruflo section to the dashboard summary showing tool frequency breakdown and cost attribution.
- Minimal coupling — no dependency on ruflo internals.

### Phase 2: A/B Comparison

Add comparative metrics between ruflo and non-ruflo sessions using the existing session/message query API.

Scope:
- Compute per-session efficiency metrics (tokens/prompt, cost/session, duration, cache hit rate).
- Aggregate separately for ruflo-active vs. non-active sessions.
- Display side-by-side comparison in dashboard and CLI report.
- Track trends over time to show whether ruflo ROI is improving.

### Phase 3: Deep Integration

Integrate with ruflo's data stores for agent, pattern, and swarm metrics.

Scope:
- Discover and read ruflo's SQLite database.
- Extract agent success rates, pattern confidence scores, and swarm coordination metrics.
- Correlate ruflo internal metrics with claude-stats session outcomes.
- Requires understanding ruflo's schema stability guarantees before committing to this level.

## Privacy Considerations

- All ruflo data is local, consistent with claude-stats' existing privacy model.
- No network calls required to read ruflo metrics.
- Phase 3 reads ruflo's database in read-only mode — no writes or modifications.
- Users should be able to opt out of ruflo-specific tracking via config.
