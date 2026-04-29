# A1 — Prompt caching with `cache_control`

| | |
|---|---|
| Cost lever | Lower tokens (≈10× on cache hits) |
| When it pays off | Multiple recap calls in the same conversation/day |
| Effort | Tiny |

## Rationale

Anthropic's API supports prompt caching via `cache_control: { type:
"ephemeral" }` markers on prompt segments. Cached tokens cost ~10% of
their non-cached price for the cache TTL (5 minutes by default).

The synthesis pass for the daily recap has a stable preamble:

- The digest schema description.
- One or two in-context example digests with desired narrative outputs.
- A short system prompt describing tone, length, and groundedness rules.

These are identical across calls for the same user. Marking them as
cached means the *first* synthesis call of a session pays full price; all
subsequent calls within the TTL pay ~10% on the cached portion.

## Where it lives

This is an **agent-side** concern, not a claude-stats server concern.
The MCP server returns the digest; the calling agent decides whether and
how to invoke a model.

The `summarize_day` MCP tool's *description* should explicitly suggest
the caching pattern so calling agents pick it up. Example wording:

> When synthesising prose from this digest, mark the digest schema and
> any in-context examples with `cache_control: { type: "ephemeral" }`.
> Repeated calls within a 5-minute window will pay ~10% of the input
> token cost on the cached portion.

## Interaction with other strategies

- **[B3 — Phrase templates](b3-phrase-templates.md):** the template bank
  itself should be cached, so agents that escalate from template render
  to free-form synthesis don't re-pay for the templates.
- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):** the
  guard runs on output, no caching interaction.
- **[B5 — Incremental digest](b5-incremental-digest.md):** when the
  digest changes by only a small delta, the cached *examples* still hit;
  only the digest payload itself is uncached.

## When it does *not* help

- One-off recap calls (single invocation, no follow-up).
- Calls separated by more than the cache TTL.
- Agents that can render the structured digest with [B3](b3-phrase-templates.md)
  and never invoke an LLM at all — those already cost zero.
