# Additional Strategies — Index

A catalogue of techniques to raise quality and/or lower token cost beyond
the v1 pipeline described in `01`–`04` of the parent
[daily-recap/](../) analysis. None of these are required for a useful
first release; they are organised here as a menu for incremental
improvement.

Each strategy file follows the same shape:

- **Cost lever:** does it cut LLM tokens, raise quality, or both?
- **When it pays off:** the calling pattern that justifies the work.
- **Body:** rationale, design notes, and integration points.

## Group A — Cheaper synthesis when an LLM is in the loop

These apply only on Path B/C of the hybrid pipeline (Tier-3 narrative
synthesis). They are no-ops for users who consume the structured digest
directly.

| # | Strategy | Lever |
|---|---|---|
| A1 | [Prompt caching with `cache_control`](a1-prompt-caching.md) | Lower tokens (≈10× on cache hits) |
| A2 | [Tiered model routing](a2-tiered-model-routing.md) | Lower tokens (≈10–20×) |
| A3 | [Strict `max_tokens` cap](a3-max-tokens-cap.md) | Lower tokens (output side) |
| A4 | [Self-consistency / entity-presence guard](a4-self-consistency-guard.md) | Higher quality |

## Group B — Better quality from the deterministic side

These never invoke an LLM — they raise the structured-digest quality so
that synthesis becomes optional or cheaper.

| # | Strategy | Lever |
|---|---|---|
| B1 | [Local embeddings for clustering](b1-local-embeddings.md) | Higher quality + lower LLM-fallback usage |
| B2 | [Confidence scores per item](b2-confidence-scores.md) | Higher quality + cheaper synthesis |
| B3 | [Phrase-template bank in MCP description](b3-phrase-templates.md) | Lower tokens |
| B4 | [Background pre-computation](b4-background-precomputation.md) | Latency win + cache primes |
| B5 | [Diff-based incremental digest](b5-incremental-digest.md) | Lower CPU + faster cache rebuild |
| B6 | [Negative caching](b6-negative-caching.md) | Lower CPU |

## Group C — Tuning loop (one-time spend, lasting payoff)

| # | Strategy | Lever |
|---|---|---|
| C1 | [Offline LLM-as-judge for segmenter weights](c1-offline-llm-judge.md) | Higher quality (forever) |
| C2 | [User-correctable digests](c2-user-corrections.md) | Higher quality + personalisation |

## Explicitly rejected (re-evaluated)

For traceability — items that look attractive but were considered and
rejected:

| Idea | Why rejected | Notes |
|---|---|---|
| Embedding-based clustering as part of v1 | Adds an ONNX dependency before v1 ships | Deferred to [B1](b1-local-embeddings.md) |
| LLM-based ranking | Non-deterministic, expensive | Heuristic score is good enough |
| Re-prompting the LLM to verify each fact | Verification means re-running extraction, not re-prompting | [A4](a4-self-consistency-guard.md) is the deterministic equivalent |
| Generating fresh prose on every call | Snapshot-hash caching + [A1](a1-prompt-caching.md) make this a non-issue | — |
