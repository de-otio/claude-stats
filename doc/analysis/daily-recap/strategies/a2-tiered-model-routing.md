# A2 — Tiered model routing

| | |
|---|---|
| Cost lever | Lower tokens (≈10–20× on classifier-shaped calls) |
| When it pays off | Whenever an LLM tiebreaker or classification step runs |
| Effort | Small |

## Rationale

Two distinct LLM tasks live in the recap pipeline, and they have very
different requirements:

| Task | Quality bar | Best-fit model |
|---|---|---|
| Cluster tiebreakers / "are these two segments the same task?" | Structural; "good enough" answer | Haiku |
| Verb refinement on ambiguous tool histograms | Lookup-shaped; deterministic preferred | Haiku |
| One-paragraph standup narrative | User-facing prose; tone matters | Sonnet (or Opus when escalated) |
| Polished weekly retrospective | Multi-day synthesis | Opus |

Haiku is roughly **10–20× cheaper** than Sonnet on per-token cost and
handles structured/classification work with comparable accuracy. Routing
the cheap calls to Haiku and reserving Sonnet/Opus for the user-facing
paragraph is a near-pure cost win.

## Where it lives

Agent-side. The MCP server is model-agnostic. Document the recommended
routing in the `summarize_day` tool description so agents that build on
it pick up the pattern by default.

## When the LLM is invoked at all

Note that the deterministic spine (segment + cluster + score) avoids the
LLM entirely for the common case. LLM tiebreakers are only needed when:

- A project on the same day has two segments with no file-path overlap
  *and* no first-prompt prefix overlap, *and*
- The agent has been asked to produce a narrative and decides
  consolidation matters.

In practice this fires rarely. Tiered routing is mostly insurance for
when it does.

## Interaction with other strategies

- **[B1 — Local embeddings](b1-local-embeddings.md):** if embeddings are
  adopted, they replace most of the LLM-classifier traffic and reduce the
  payoff of A2 proportionally. A2 is still useful for the narrative
  layer, just not the classifier layer.
- **[A1 — Prompt caching](a1-prompt-caching.md):** orthogonal — caching
  helps within a tier; routing helps across tiers.
