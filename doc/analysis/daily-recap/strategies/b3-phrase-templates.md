# B3 — Phrase-template bank in the MCP tool description

| | |
|---|---|
| Cost lever | Lower tokens (often eliminates synthesis entirely) |
| When it pays off | Most "what did I do today" calls |
| Effort | Tiny |

## Rationale

A digest item carries enough structured fields that a calling agent can
produce prose-quality output by slot-filling a small bank of phrase
templates — no generative LLM call required. The `summarize_day` MCP
tool description is the right place to ship those templates, because
calling agents naturally pattern-match to instructions in tool
descriptions.

## Template bank

Selected by `confidenceLevel` (see
[B2](b2-confidence-scores.md)) and presence of git enrichment.

**Untrusted-slot rule (security):** `{firstPromptShort}` and `{prTitle}`
contain user-authored text that originated from session prompts and
must NEVER appear bare in a template. Every occurrence of these slots
MUST be wrapped in delimiters (single backticks for inline, single
quotes for narrative) so that calling agents and renderers visually and
semantically separate untrusted-sourced text from deterministic fields.
Any template that violates this rule fails the [self-consistency guard
(A4)](a4-self-consistency-guard.md).

```
high + commits pushed:
  "Shipped `{firstPromptShort}` ({project}) — {commitsToday} commits,
   {filesChanged} files, ~{activeMs|duration}"

high + PR merged:
  "Merged `{prTitle}` ({project}) — {filesChanged} files,
   ~{activeMs|duration}"

medium + commits not pushed:
  "Drafted `{firstPromptShort}` ({project}) — {commitsToday} local
   commits, {filesChanged} files, ~{activeMs|duration}"

medium + edits but no commits:
  "Worked on `{firstPromptShort}` ({project}) — {filePathsTouched.length}
   files touched, no commits yet, ~{activeMs|duration}"

low (when shown at all):
  "Brief: `{firstPromptShort}` ({project}, ~{activeMs|duration})"

closing line:
  "{totals.projects} projects · {totals.sessions} sessions ·
   {totals.activeMs|duration} active · ~{totals.estimatedCost|cost}"
```

`{firstPromptShort}` is the first prompt truncated at ~80 chars,
sanitised, wrapped with `wrapUntrusted`, and rendered inside backticks
in every template above. Any backticks present in the source prompt are
escaped at sanitisation time so they cannot break out of the delimiter.

## Where it lives

In the `description` field of the `summarize_day` MCP tool registration
(`packages/cli/src/mcp/index.ts`), as a structured rendering hint.

The CLI renderer in `packages/cli/src/reporter/index.ts` uses the same
template bank as its source of truth, so CLI and agent output stay
consistent.

## Token-cost effects

- A purely-template-rendered recap costs **0 LLM tokens**.
- Agents that follow the template bank produce prose-quality output
  that satisfies the [self-consistency guard
  (A4)](a4-self-consistency-guard.md) trivially — every entity in the
  output came from the digest.
- When prose *is* needed (e.g. user explicitly asks for a paragraph),
  the templates serve as one-shot examples in the synthesis prompt,
  improving quality at the same input cost.

## Interaction with other strategies

- **[A1 — Prompt caching](a1-prompt-caching.md):** the template bank
  is identical across calls and should be cached.
- **[B2 — Confidence scores](b2-confidence-scores.md):** templates are
  selected by confidence level; this is the primary use of confidence.
- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):** the
  guard's entity-presence check is satisfied by construction when
  templates are used directly.

## When templates are insufficient

- The user explicitly asked for a *narrative* recap ("write me a
  paragraph for my standup") — escalate to synthesis with templates as
  examples.
- The day has many items and the user wants prioritised highlights —
  the agent uses the templates per item but adds connective tissue
  ("…then in the afternoon…") that benefits from synthesis.

In both cases the templates remain the floor — synthesis adds prose on
top of, not in place of, structured rendering.
