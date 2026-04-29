# Daily Recap — Analysis

A user-facing feature that answers the question:

> *"What did I get done today?"*

Asked of an agent connected to claude-stats over MCP. The hard part is not the data
— claude-stats already collects everything needed. The hard part is producing a
**high-quality narrative recap** while spending as few LLM tokens as possible. This
sub-analysis explores hybrid pipelines that do as much work deterministically as
possible and reserve LLM tokens for what only an LLM can do well.

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-feature-vision.md](01-feature-vision.md) | What the user is really asking for, and what a "good" recap looks like |
| 02 | [02-data-sources.md](02-data-sources.md) | What signals are available without an LLM in the loop |
| 03 | [03-hybrid-pipeline.md](03-hybrid-pipeline.md) | Tiered pipeline: deterministic extraction → optional LLM synthesis |
| 04 | [04-token-cost-model.md](04-token-cost-model.md) | Concrete token-cost comparison of strategies (naive vs. tiered) |
| 05 | [05-implementation-plan.md](05-implementation-plan.md) | MCP tool surface, file changes, phasing |

## Sub-analyses

| Directory | Purpose |
|-----------|---------|
| [strategies/](strategies/) | v2-and-beyond menu of additional quality + cost strategies (prompt caching, local embeddings, confidence scores, hallucination guard, tuning loop, …) — one file per strategy |

## Key Insight

A naive implementation — "agent, call `list_sessions`, then `get_session_detail`
on each, then summarize" — spends **~10–50k input tokens per recap** and re-pays
that cost on every invocation. A hybrid pipeline that does deterministic
extraction server-side and ships a pre-shaped digest can reach **~1–3k input
tokens per recap**, with an opt-in LLM synthesis pass adding another ~200–500
output tokens only when the user explicitly wants prose.

The largest efficiency wins are not from prompting tricks — they come from:

1. **Doing the obvious work without an LLM at all** (git log, session
   durations, first-prompt extraction, tool histograms).
2. **Pre-aggregating server-side** so the agent never reads raw JSONL.
3. **Caching the digest by snapshot hash** so unchanged days cost zero LLM
   tokens to re-recap.
4. **Extractive over generative** — verbatim commit subjects and verbatim
   first prompts beat any model paraphrase, and they cost nothing.
5. **Tiered models** — let the agent decide whether to spend Sonnet/Opus
   tokens on synthesis at all; many users will be happy with the structured
   digest.

## Architecture Summary

```
                                    ┌──────────────────────────┐
~/.claude-stats/stats.db ──┐        │ DETERMINISTIC LAYER      │
                           ├───────▶│  - session facts         │
~/.claude/projects/*/*.jsonl        │  - first-prompt verbatim │
                           │        │  - duration, tools[]     │
git: .git in each project ─┘        │  - cost / tokens         │
                                    └────────────┬─────────────┘
                                                 │
                                                 ▼
                                    ┌──────────────────────────┐
                                    │ STRUCTURED DIGEST (JSON) │
                                    │  ~1–3k tokens, hash-keyed│
                                    └────────────┬─────────────┘
                                                 │
                            ┌────────────────────┴────────────────────┐
                            ▼                                         ▼
              ┌──────────────────────────┐            ┌────────────────────────────┐
              │ MCP tool returns digest  │            │ Agent (optional)           │
              │ as-is — agent renders it │            │  - cluster related items   │
              │ with a markdown template │            │  - one-paragraph narrative │
              │ (zero LLM cost)          │            │  - flag abandoned vs done  │
              └──────────────────────────┘            └────────────────────────────┘
```

## Scope

- **In scope:** new MCP tool (`summarize_day` or similar), deterministic
  extraction pipeline, snapshot-hash caching, token-cost analysis,
  recommended phrasing/template strategies for the calling agent.
- **Out of scope:** UI for the recap (CLI/extension surfacing is a follow-up),
  multi-day rollups (a separate "weekly" question), cross-device sync of
  recaps (already covered by the cross-device-sync analysis).

## Critical Design Constraints

- **Privacy** — first-prompt text is sensitive; reuse `sanitizePromptText`
  and the existing `wrapUntrusted` marker. Never expose stored content
  without the untrusted-content envelope.
- **Determinism first** — every fact in the digest must be reproducible
  from a snapshot of the inputs. No LLM in the extraction layer.
- **Cache correctness** — the snapshot hash must include
  `(last_message_uuid, last_git_commit_sha)` per project so a digest is
  invalidated as soon as new work appears.
- **No new collection** — same principle as the energy dashboard: this
  feature is a computation/rendering layer over existing data.
