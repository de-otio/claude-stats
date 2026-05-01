# Token Spending Analysis

When Claude shows "You've used 95% of your session limit", users have no visibility into *what* consumed those tokens. This analysis defines the queries, metrics, and UI components needed to answer: **where did my tokens go?**

---

## 1. Problem

Claude's usage indicator is a single opaque percentage. Users cannot determine:

- Which sessions or prompts consumed the most tokens
- Whether a specific MCP server or tool is disproportionately expensive
- Which model choices drove the bulk of spending
- Whether cache efficiency was good or poor during the window
- How their current session compares to historical norms

Without this visibility, users cannot make informed decisions about when to use Opus vs Sonnet, which workflows to restructure, or whether an MCP server is worth the token overhead.

---

## 2. Data Already Available

All required data is in the existing SQLite store. No new collection is needed.

### Session level (`sessions` table)

| Column | Use |
|--------|-----|
| `input_tokens`, `output_tokens` | Total spend per session |
| `cache_read_tokens`, `cache_creation_tokens` | Cache efficiency |
| `models` (JSON array) | Which models were used |
| `tool_use_counts` (JSON array of `{name, count}`) | Tool breakdown including MCP tools |
| `prompt_count` | Interaction count |
| `project_path` | Group by project |
| `first_timestamp`, `last_timestamp` | Time range |
| `active_duration_ms` | Wall-clock active time |
| `throttle_events` | Rate limit hits |
| `is_subagent`, `parent_session_id` | Attribute subagent cost to parent |
| `subscription_type` | Plan context for ROI |

### Message level (`messages` table)

| Column | Use |
|--------|-----|
| `input_tokens`, `output_tokens` | Per-turn cost |
| `cache_read_tokens`, `cache_creation_tokens` | Per-turn cache behavior |
| `model` | Model used for this specific response |
| `tools` (JSON array) | Tools invoked in this response |
| `thinking_blocks` | Extended thinking usage |
| `prompt_text` | The user prompt that triggered the response |
| `timestamp` | Ordering and window attribution |
| `stop_reason` | Detect truncations (`max_tokens`) |

---

## 3. Key Queries

### 3.1 Most Expensive Sessions (by API-equivalent cost)

Answers: "Which conversations ate my budget?"

```sql
SELECT
  s.session_id,
  s.project_path,
  s.prompt_count,
  s.input_tokens,
  s.output_tokens,
  s.cache_read_tokens,
  s.cache_creation_tokens,
  s.models,
  s.tool_use_counts,
  s.first_timestamp,
  s.last_timestamp,
  s.active_duration_ms,
  s.throttle_events,
  s.is_subagent,
  s.parent_session_id
FROM sessions s
WHERE s.first_timestamp >= ?  -- rolling 5h window or period start
ORDER BY (s.input_tokens + s.output_tokens + s.cache_creation_tokens) DESC
LIMIT 20;
```

Cost is computed in application code via `estimateCost()` per model (since sessions may use multiple models). For multi-model sessions, fall back to message-level aggregation.

### 3.2 Most Expensive Individual Prompts

Answers: "Which single interaction was the most costly?"

```sql
SELECT
  m.uuid,
  m.session_id,
  m.model,
  m.input_tokens,
  m.output_tokens,
  m.cache_read_tokens,
  m.cache_creation_tokens,
  m.thinking_blocks,
  m.tools,
  m.prompt_text,
  m.timestamp,
  m.stop_reason
FROM messages m
WHERE m.timestamp >= ?  -- period start
ORDER BY (m.input_tokens + m.output_tokens + m.cache_creation_tokens) DESC
LIMIT 20;
```

Prompt text is truncated for display (first 120 chars) to give context without overwhelming the UI.

### 3.3 Token Spend by Tool (including MCP servers)

Answers: "Is my MCP server burning tokens? Which tools are expensive?"

This requires correlating tool invocations with the message-level token cost. Each assistant message in the `messages` table has a `tools` JSON array listing tools used in that response.

```sql
SELECT
  m.tools,
  SUM(m.input_tokens) as total_input,
  SUM(m.output_tokens) as total_output,
  SUM(m.cache_creation_tokens) as total_cache_write,
  COUNT(*) as invocation_count
FROM messages m
WHERE m.timestamp >= ?
  AND m.tools != '[]'
GROUP BY m.tools
ORDER BY (total_input + total_output + total_cache_write) DESC;
```

Since `tools` is a JSON array (e.g. `["Read","Edit","Bash"]`), application code must:
1. Parse each row's tools array
2. Attribute the message cost proportionally or fully to each tool
3. Aggregate by individual tool name
4. Flag MCP tools (prefixed with `mcp__`) separately for dedicated reporting

**MCP server detection:** Tool names follow the pattern `mcp__<server>__<method>`. Group by server prefix to show per-server totals.

### 3.4 Token Spend by Model

Answers: "How much did Opus cost me vs Sonnet?"

```sql
SELECT
  m.model,
  SUM(m.input_tokens) as input_tokens,
  SUM(m.output_tokens) as output_tokens,
  SUM(m.cache_read_tokens) as cache_read,
  SUM(m.cache_creation_tokens) as cache_write,
  COUNT(*) as message_count
FROM messages m
WHERE m.timestamp >= ?
GROUP BY m.model
ORDER BY (input_tokens + output_tokens) DESC;
```

Apply `estimateCost()` per model row to show dollar-equivalent comparison. This is critical because Opus output tokens cost 5x Sonnet and 25x Haiku.

### 3.5 Token Spend by Project

Answers: "Which project is consuming the most budget?"

```sql
SELECT
  s.project_path,
  SUM(s.input_tokens) as input_tokens,
  SUM(s.output_tokens) as output_tokens,
  SUM(s.cache_read_tokens) as cache_read,
  SUM(s.cache_creation_tokens) as cache_write,
  SUM(s.prompt_count) as prompts,
  COUNT(*) as sessions
FROM sessions s
WHERE s.first_timestamp >= ?
GROUP BY s.project_path
ORDER BY (input_tokens + output_tokens + cache_write) DESC;
```

### 3.6 Cache Efficiency Analysis

Answers: "Am I getting good cache hits or paying full price repeatedly?"

```sql
SELECT
  m.session_id,
  SUM(m.cache_read_tokens) as cache_hits,
  SUM(m.input_tokens) as uncached_input,
  SUM(m.cache_creation_tokens) as cache_writes,
  ROUND(
    CAST(SUM(m.cache_read_tokens) AS REAL) /
    NULLIF(SUM(m.cache_read_tokens) + SUM(m.input_tokens), 0) * 100,
    1
  ) as cache_hit_pct
FROM messages m
WHERE m.timestamp >= ?
GROUP BY m.session_id
ORDER BY cache_hit_pct ASC;  -- worst efficiency first
```

Sessions with low cache hit rates on large input counts are candidates for optimization (e.g., restructuring system prompts, consolidating CLAUDE.md files).

### 3.7 Subagent Cost Attribution

Answers: "How much did spawned subagents cost on top of my main session?"

```sql
SELECT
  parent.session_id as parent_session,
  parent.project_path,
  SUM(child.input_tokens + child.output_tokens + child.cache_creation_tokens) as subagent_tokens,
  COUNT(child.session_id) as subagent_count,
  parent.input_tokens + parent.output_tokens + parent.cache_creation_tokens as parent_tokens
FROM sessions parent
JOIN sessions child ON child.parent_session_id = parent.session_id
WHERE parent.first_timestamp >= ?
GROUP BY parent.session_id
ORDER BY subagent_tokens DESC;
```

### 3.8 Anomaly Detection: Outlier Prompts

Answers: "Which prompts were unexpectedly expensive compared to my average?"

```sql
WITH stats AS (
  SELECT
    AVG(input_tokens + output_tokens) as avg_cost,
    AVG(input_tokens + output_tokens) +
      2 * SQRT(AVG((input_tokens + output_tokens) * (input_tokens + output_tokens))
             - AVG(input_tokens + output_tokens) * AVG(input_tokens + output_tokens)) as threshold
  FROM messages
  WHERE timestamp >= ?
)
SELECT
  m.uuid,
  m.session_id,
  m.model,
  m.input_tokens,
  m.output_tokens,
  m.tools,
  m.prompt_text,
  m.timestamp,
  (m.input_tokens + m.output_tokens) as total_tokens,
  s.avg_cost,
  ROUND(CAST(m.input_tokens + m.output_tokens AS REAL) / s.avg_cost, 1) as times_avg
FROM messages m, stats s
WHERE m.timestamp >= ?
  AND (m.input_tokens + m.output_tokens) > s.threshold
ORDER BY total_tokens DESC
LIMIT 10;
```

---

## 4. Derived Metrics

### 4.1 Cost-Weighted Token Total

Raw token counts are misleading because model prices differ dramatically. A single metric that normalizes across models:

```
weightedCost = SUM over messages:
  estimateCost(model, input, output, cacheRead, cacheWrite).cost
```

This is the number to compare against the plan fee and use for rankings.

### 4.2 Tokens per Prompt

```
tokensPerPrompt = totalTokens / promptCount
```

High values indicate either complex tasks (expected) or inefficient prompting (actionable). Compare across sessions to find outliers.

### 4.3 Output/Input Ratio

```
outputRatio = outputTokens / inputTokens
```

- High ratio (> 1.0): Claude is generating a lot relative to context — code generation, long explanations
- Low ratio (< 0.1): Context-heavy sessions — large file reads, MCP tool results feeding context

### 4.4 MCP Overhead Ratio

```
mcpOverhead = tokensInMcpToolMessages / totalSessionTokens
```

If an MCP server is injecting large tool results, this surfaces it. Compare across sessions with and without the MCP server to quantify its cost.

### 4.5 Thinking-to-Output Ratio

Extended thinking blocks consume output tokens. When `thinking_blocks > 0`:

```
thinkingRatio = thinkingTokens / totalOutputTokens
```

High ratios may indicate problems where Claude is "overthinking" — spinning on reasoning without producing useful output.

---

## 5. CLI Report: `claude-stats spending`

New subcommand that produces a spending breakdown.

### Default Output (period=day)

```
Token Spending — Today (2026-04-09)

Total cost (API-equivalent): $14.82
  Opus:   $12.40 (83.7%)  — 248K input, 89K output
  Sonnet:  $2.42 (16.3%)  — 161K input, 52K output

Top sessions by cost:
  #1  $6.20  claude-stats (42 prompts, 1h 23m)  opus
  #2  $3.85  myapp-backend (28 prompts, 55m)     opus
  #3  $2.42  docs-site (15 prompts, 22m)         sonnet
  #4  $1.38  myapp-backend (8 prompts, 18m)      opus
  #5  $0.97  infra (4 prompts, 11m)              opus

Top tools by cost:
  Read   $4.20 (1,247 calls)
  Agent  $3.15 (12 calls)          ← subagent spawns
  Edit   $2.80 (89 calls)
  Bash   $1.92 (156 calls)
  mcp__doc-search__search_docs  $0.85 (34 calls)

Expensive prompts (> 2x average):
  1. "Refactor the auth middleware..."  — 142K tokens ($3.55)  opus
  2. "Search across all test files..."  — 89K tokens ($2.22)   opus
  3. "Update the database schema..."    — 67K tokens ($1.68)   opus

Cache efficiency: 68.2% hit rate (saved ~$4.12)
Subagent overhead: $3.15 across 12 spawned agents
```

### Flags

| Flag | Description |
|------|-------------|
| `--period day\|week\|month\|all` | Time range (default: day) |
| `--project <path>` | Filter to one project |
| `--model <name>` | Filter to one model |
| `--top N` | Number of top items to show (default: 5) |
| `--json` | Machine-readable JSON output |
| `--sort cost\|tokens\|prompts` | Sort order for session ranking (default: cost) |

---

## 6. Dashboard Visualization

### 6.1 Spending Breakdown Panel

A new panel on the existing dashboard with three views:

**By Session** — Bar chart ranking sessions by API-equivalent cost. Each bar is color-coded by model. Hovering shows project, prompt count, duration, and top tools.

**By Tool** — Horizontal bar chart of token cost attributed to each tool. MCP tools are visually grouped with a distinct color band. Highlights tools where cost-per-invocation is unusually high.

**By Model** — Donut chart showing cost distribution across models. Accompanying table shows tokens, message count, and cost per model.

### 6.2 Expensive Prompts Table

Sortable table of individual messages, columns:

| Time | Session | Prompt (truncated) | Model | Input | Output | Cost | Tools | Flags |
|------|---------|-------------------|-------|-------|--------|------|-------|-------|

"Flags" column highlights anomalies:
- `OUTLIER` — cost > 2x session average
- `TRUNCATED` — stop_reason = max_tokens
- `HIGH_THINKING` — thinking blocks > 50% of output
- `MCP_HEAVY` — MCP tool results dominate input

### 6.3 Cache Efficiency Heatmap

Grid of sessions showing cache hit percentage. Color scale from red (< 30%) through yellow (50-70%) to green (> 80%). Clicking a session drills into its message-level cache behavior.

### 6.4 MCP Server Cost Card

Dedicated card when MCP tools are detected:

```
MCP Server Costs (today)
  doc-search     $0.85  (34 calls, avg 25K tokens/call)
  github         $0.42  (12 calls, avg 35K tokens/call)
  slack          $0.18  (6 calls, avg 30K tokens/call)
```

---

## 7. Implementation Plan

### Phase 1: Core Queries (no schema changes)

1. Add `getSpendingReport()` method to `Store` — runs queries 3.1-3.6 above
2. Add tool-level cost attribution logic (parse `tools` JSON, aggregate)
3. Add MCP server grouping (split on `mcp__` prefix)
4. Add `spending` subcommand to CLI using existing `Reporter` patterns
5. Add anomaly detection (query 3.8) with configurable threshold (default: 2x average)

### Phase 2: Dashboard Integration

6. Add `spending` section to `DashboardData` in dashboard builder
7. Add spending breakdown panel (sessions, tools, models)
8. Add expensive prompts table
9. Add MCP server cost card (conditional on MCP usage)

### Phase 3: Enhancements

10. Cache efficiency heatmap
11. Subagent cost roll-up into parent session view
12. Historical comparison ("today vs your 7-day average")
13. Export: CSV/JSON dump of spending data for external analysis

### Dependencies

- No new npm packages needed
- No schema migrations needed — all queries use existing columns
- Pricing calculation reuses existing `estimateCost()` from `@claude-stats/core/pricing`
- Reporter formatting reuses existing `formatTokens()`, `formatCost()`, `formatDuration()`

---

## 8. Limitations

- **Cost is API-equivalent, not plan cost.** Claude subscription plans bundle usage; there's no public formula mapping tokens to the percentage shown in the UI. The dollar amounts are informational comparisons, not billing-accurate.
- **Tool cost attribution is approximate.** A message invoking `[Read, Edit, Bash]` has a single token count. We attribute the full cost to each tool (over-counting) or split evenly (under-counting per tool). The analysis notes this and defaults to full attribution with a "shared" flag.
- **MCP tool result sizes aren't isolated.** When an MCP server returns a large result, it inflates `input_tokens` on the *next* assistant message (as context). We can detect MCP tool invocations but cannot precisely measure how many input tokens the result consumed.
- **Thinking tokens aren't separated.** Extended thinking consumes output tokens but isn't broken out in the usage data. `thinking_blocks` count is available but not thinking token count.
- **Subagent sessions may lack parent linkage** if the parent session wasn't collected yet or if Claude Code didn't emit the parent session ID.
