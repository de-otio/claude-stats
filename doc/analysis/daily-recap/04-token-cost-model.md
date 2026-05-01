# 04 — Token Cost Model

This document quantifies the savings from the hybrid pipeline. Numbers are
rounded order-of-magnitude estimates calibrated against representative
local data; precise costs depend on model and cache state.

## Baseline assumptions

For a moderately active developer day:

| Quantity | Typical value |
|---|---|
| Sessions on the day | 5 |
| Assistant messages per session (median) | 35 |
| Mean assistant message size | ~1.5k input + 500 output tokens (cached) |
| Mean user prompt size | ~80 tokens |
| Projects touched | 2 |
| Commits authored | 6 |

## Strategy comparison

The five strategies below all answer the same user question:
*"What did I get done today?"*

### Strategy A — Naive: agent reads raw JSONL

Agent uses Bash + Read to walk `~/.claude/projects/*/*.jsonl` and dumps the
day's records into context.

| Item | Tokens |
|---|---|
| Raw session JSONL for the day (5 × 35 messages × ~2k tok metadata) | ~350k |
| Agent's reading + chunking overhead | +10–30% |
| Output (paragraph) | ~250 |
| **Per-recap input total** | **~400k** |

This is infeasible — exceeds most context windows and is wildly expensive.

### Strategy B — Existing MCP tools (`list_sessions` + `get_session_detail` per session)

Agent calls existing tools, then assembles a summary.

| Item | Tokens |
|---|---|
| `list_sessions` response (5 sessions × ~150 tok each) | ~750 |
| 5 × `get_session_detail` (full message dump per session) | ~30k–80k |
| Output (paragraph) | ~250 |
| **Per-recap input total** | **~30–80k** |

Workable but expensive, and the agent still has to do clustering and
synthesis from raw data. **This is the floor without server-side help.**

### Strategy C — Hybrid (Tier-2 digest + template render, no synthesis)

New `summarize_day` MCP tool returns the structured digest. Agent renders
it with a markdown template.

| Item | Tokens |
|---|---|
| `summarize_day` response (5 items × ~400 tok each + totals) | ~2.5k |
| Template render | 0 (mechanical) |
| Output (markdown table) | ~400 |
| **Per-recap input total** | **~2.5k** |

**~12–30× reduction vs Strategy B.** No LLM synthesis at all; output is
the user's own words and verifiable facts. This is the recommended default.

### Strategy D — Hybrid + LLM synthesis (one paragraph)

Same digest, plus an explicit LLM pass to produce prose.

| Item | Tokens |
|---|---|
| `summarize_day` response | ~2.5k |
| Synthesis prompt + digest re-shipped | ~3k |
| Output (paragraph) | ~200 |
| **Per-recap input total** | **~5.5k** |

Still **~6–15× cheaper than Strategy B** with comparable or better narrative
quality (because the digest has already done the hard extraction work).

### Strategy E — Hybrid + cache hit

Same as C or D, but the digest cache hit returns immediately.

| Item | Tokens |
|---|---|
| Cache hit (no recomputation, no LLM) | 0 input / 0 output |
| Optional template render | 0 |
| **Per-recap input total** | **0** |

Asking "what did I get done today" multiple times in a session, or running
a daily cron-style recap from a wrapper script, costs nothing after the
first call.

## Summary table

| Strategy | Per-recap tokens | Notes |
|---|---|---|
| A — Naive raw JSONL | ~400k | Infeasible |
| B — Existing MCP tools | ~30–80k | Today's floor |
| C — Hybrid digest, no synthesis | ~2.5k | **Recommended default** |
| D — Hybrid digest + paragraph | ~5.5k | When prose is requested |
| E — Cache hit on C/D | 0 | Repeated calls in same window |

## Where the savings actually come from

The hybrid pipeline's wins decompose as follows (vs Strategy B):

| Lever | Savings contribution | Why |
|---|---|---|
| Server-side aggregation | ~70% | Agent never sees per-message rows |
| Extractive first-prompt quoting | ~10% | No paraphrase round-trip |
| Tool-histogram → verb mapping | ~5% | No "characterise this session" prompt |
| Heuristic ranking | ~5% | No "rank these items" prompt |
| Snapshot-hash caching | up to 100% | Repeated calls cost nothing |
| Truncation caps in digest | ~10% | Bounded payload size |

## Quality-cost frontier

Strategy C trades only one thing for its 12–30× cost reduction: the recap is
**structured rather than prose**. Quality on every other axis (accuracy,
groundedness, recognisability, freshness) is *better* than Strategy B,
because the digest is built from authoritative signals (git, sanitised
prompts) rather than from an LLM's reading of raw transcripts.

When prose is genuinely needed, Strategy D recovers it for an extra ~3k
tokens — still well below the cost of any non-hybrid approach.

## Anti-patterns to reject

- **"Just stream the whole transcript and let the model summarize."**
  Spends 10–100× more tokens for a *worse* result, because the model has to
  re-derive facts the database already knows.
- **"Use embeddings to cluster sessions."** Adds latency, infrastructure
  and per-call cost for an answer the rule-based clusterer gets right
  almost every time.
- **"Have the agent re-call `get_session_detail` to verify each fact."**
  The digest is the source of truth for facts; verification means
  re-running deterministic extraction, not re-prompting an LLM.
- **"Generate a fresh paragraph on every page load."** A digest hash that
  hasn't changed should serve the cached paragraph. Burning tokens to
  regenerate identical prose is pure waste.
