# Additional Strategies — Index

A catalogue of techniques to raise quality and/or lower token cost beyond
the v1 pipeline described in `01`–`05` of the parent
[daily-recap/](../) analysis. None of these are required for a useful
first release; they are organised here as a menu for incremental
improvement.

Each strategy file follows the same shape:

- **Cost lever:** does it cut LLM tokens, raise quality, or both?
- **When it pays off:** the calling pattern that justifies the work.
- **Effort:** rough sizing in the same scale as the existing plans.
- **Body:** rationale, design notes, and integration points.

## Group A — Cheaper synthesis when an LLM is in the loop

These apply only on Path B/C of the hybrid pipeline (Tier-3 narrative
synthesis). They are no-ops for users who consume the structured digest
directly.

| # | Strategy | Lever | Effort |
|---|---|---|---|
| A1 | [Prompt caching with `cache_control`](a1-prompt-caching.md) | Lower tokens (≈10× on cache hits) | Tiny |
| A2 | [Tiered model routing](a2-tiered-model-routing.md) | Lower tokens (≈10–20×) | Small |
| A3 | [Strict `max_tokens` cap](a3-max-tokens-cap.md) | Lower tokens (output side) | Tiny |
| A4 | [Self-consistency / entity-presence guard](a4-self-consistency-guard.md) | Higher quality | Small |

## Group B — Better quality from the deterministic side

These never invoke an LLM — they raise the structured-digest quality so
that synthesis becomes optional or cheaper.

| # | Strategy | Lever | Effort |
|---|---|---|---|
| B1 | [Local embeddings for clustering](b1-local-embeddings.md) | Higher quality + lower LLM-fallback usage | Medium |
| B2 | [Confidence scores per item](b2-confidence-scores.md) | Higher quality + cheaper synthesis | Tiny |
| B3 | [Phrase-template bank in MCP description](b3-phrase-templates.md) | Lower tokens | Tiny |
| B4 | [Background pre-computation](b4-background-precomputation.md) | Latency win + cache primes | Medium |
| B5 | [Diff-based incremental digest](b5-incremental-digest.md) | Lower CPU + faster cache rebuild | Medium |
| B6 | [Negative caching](b6-negative-caching.md) | Lower CPU | Tiny |

## Group C — Tuning loop (one-time spend, lasting payoff)

| # | Strategy | Lever | Effort |
|---|---|---|---|
| C1 | [Offline LLM-as-judge for segmenter weights](c1-offline-llm-judge.md) | Higher quality (forever) | Medium |
| C2 | [User-correctable digests](c2-user-corrections.md) | Higher quality + personalisation | Medium |

## Recommended subset for "v2"

If only three additions are pursued post-v1:

1. **[A1 — Prompt caching](a1-prompt-caching.md)** — Tiny effort,
   immediate cost win on every synthesis call after the first.
2. **[B2 — Confidence scores](b2-confidence-scores.md)** — Tiny effort,
   raises quality with zero token cost; unlocks A4 and B3.
3. **[B1 — Local embeddings for clustering](b1-local-embeddings.md)** —
   Medium effort, strictly better quality than Jaccard, no API cost,
   supersedes the LLM-cluster fallback path from
   [03-hybrid-pipeline.md](../03-hybrid-pipeline.md).

Together these raise the quality ceiling meaningfully while *reducing*
total token spend per recap.

The remaining items form an "as-time-permits" backlog with diminishing
marginal returns; pursue them only when v1 shows specific weaknesses
they address.

## Explicitly rejected (re-evaluated)

For traceability — items that look attractive but were considered and
rejected:

| Idea | Why rejected | Notes |
|---|---|---|
| Embedding-based clustering as part of v1 | Adds an ONNX dependency before v1 ships | Deferred to [B1](b1-local-embeddings.md) |
| LLM-based ranking | Non-deterministic, expensive | Heuristic score is good enough |
| Re-prompting the LLM to verify each fact | Verification means re-running extraction, not re-prompting | [A4](a4-self-consistency-guard.md) is the deterministic equivalent |
| Generating fresh prose on every call | Snapshot-hash caching + [A1](a1-prompt-caching.md) make this a non-issue | — |
