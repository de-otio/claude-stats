# A3 — Strict `max_tokens` cap on synthesis

| | |
|---|---|
| Cost lever | Lower tokens (output side) |
| When it pays off | Always; bounds worst-case output cost |
| Effort | Tiny |

## Rationale

A standup paragraph is ≤80 words. A weekly retrospective is ≤300 words.
Without an explicit `max_tokens` cap the model can drift into
multi-paragraph essays — quality often drops with length, and cost
scales linearly with output tokens.

Concrete recommended caps:

| Path | `max_tokens` |
|---|---|
| One-line subject line | 40 |
| Standup paragraph | 200 |
| Weekly retrospective | 600 |
| "What changed since last digest" | 120 |

These caps map to ~80 / ~250 / ~80 word targets respectively, with
headroom for tokenisation overhead.

## Where it lives

Agent-side. The MCP server cannot enforce caps it doesn't know about;
the calling agent applies them when constructing the API call.

The `summarize_day` tool description includes recommended caps as part
of the rendering guidance so calling agents pick them up.

## Interaction with other strategies

- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):** a
  capped output is more likely to fall back to template render if the
  guard rejects it. That is the correct behaviour — short, bounded
  prose or no prose at all is better than long, possibly-hallucinated
  prose.
- **[A1 — Prompt caching](a1-prompt-caching.md):** orthogonal; caps act
  on output, caching on input.
