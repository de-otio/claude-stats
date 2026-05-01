# Derivable Insights

What questions the collected data can answer.

## Individual Developer

**Usage volume:**
- Daily/weekly/monthly token consumption (input vs output)
- Number of sessions and prompts per time period
- Peak usage hours and days

**Model usage:**
- Which models are used most (Opus, Sonnet, Haiku)
- Model switching patterns within sessions
- Model usage trends over time

**Efficiency:**
- Cache hit ratio: `cache_read_input_tokens / input_tokens` — higher means better prompt caching efficiency
- Average tokens per prompt — are prompts getting more or less verbose?
- Session duration vs token usage — identifying long-running vs intensive sessions

**Tool patterns:**
- Most-used tools (Bash, Read, Edit, Grep, Write, Agent, etc.)
- Tool usage per session — characterizing session types (exploration vs implementation)
- Tool error rates (from telemetry — caveat: only failed-to-send events are available locally, see [06-limitations.md](06-limitations.md))

**Project distribution:**
- Which projects consume the most tokens
- Active vs dormant projects
- Cross-project usage patterns

## Team Insights (with server sync)

**Aggregate consumption:**
- Total team token usage over time
- Per-project totals across all team members
- Usage distribution across the team (identify heavy/light users without exposing prompts)

**Cost awareness:**
- Token trends for budget planning
- Per-project token allocation and tracking
- Identifying unexpected spikes

**Adoption:**
- Claude Code version distribution across the team
- CLI vs VS Code extension adoption
- Model preference trends
- Feature adoption (which tools are used, MCP server usage)

**Operational:**
- Streaming error rates (from telemetry — incomplete, see [06-limitations.md](06-limitations.md))
- Cost threshold events — how often developers hit limits
- Session patterns — typical session length, prompts per session

## Cost Estimation

Token counts can be mapped to approximate costs using published pricing. However, for Claude Plans users (Teams, ProMax), pricing is bundled — token-to-dollar mapping is informational, not billing-accurate.

**Useful cost metrics:**
- Relative cost between projects (even without exact pricing, token ratios are meaningful)
- Cache savings: `cache_read_input_tokens * discount_factor` vs full-price input tokens
- Output-heavy vs input-heavy sessions

## Example Reports

**Daily summary:**
```
Today: 3 sessions, 47 prompts, 1.2M input tokens, 89K output tokens
Cache efficiency: 73% (saved ~876K tokens from cache)
Models: opus (2 sessions), sonnet (1 session)
Top tools: Read (42), Edit (18), Bash (15), Grep (12)
```

**Weekly project breakdown:**
```
Project          Sessions  Prompts  Input Tokens  Output Tokens
myapp-backend         12      156        4.2M          312K
myapp-frontend         8       94        2.1M          178K
infra-scripts          3       22        380K           45K
```
