# B2 — Confidence scores per item

| | |
|---|---|
| Cost lever | Higher quality + cheaper synthesis (agent self-edits) |
| When it pays off | Always — affects rendering decisions |
| Effort | Tiny |

## Rationale

Not all digest items deserve equal weight in a recap. A 4-hour effort
that landed two pushed commits is genuinely shipped; a 5-minute session
with no commits and no file changes is a context-switch the user
probably doesn't want surfaced.

A simple deterministic confidence score lets calling agents make
sensible rendering decisions — and the [self-consistency guard
(A4)](a4-self-consistency-guard.md) can refuse synthesis claims that
exceed an item's confidence.

## Levels

| Level | Conditions |
|---|---|
| `high` | At least one commit landed in this cluster's project window AND was pushed (`git.pushed: true`) — OR a PR was merged today. |
| `medium` | Commits exist but not pushed; OR no commits but ≥30 min active duration AND `linesAdded + linesRemoved ≥ 50`. |
| `low` | Duration-only signal: no commits, no PR, brief work, minimal file activity. |

Implementation is a ~15-line function in
`packages/cli/src/recap/index.ts` that runs after git enrichment.

## Default rendering rules

The CLI template renderer (`printDailyRecap`) uses confidence to:

| Confidence | Rendering |
|---|---|
| `high` | Always shown; "Shipped" verb; bold or first-tier styling |
| `medium` | Always shown; "Drafted" / "Investigated" verb |
| `low` | Hidden by default; shown when `--all` flag is passed; counted in totals (e.g., "+2 brief items") |

The MCP tool returns *all* items with their confidence scores; the
agent or CLI renderer applies the rendering rules.

## Token-cost effects

- The agent can synthesise prose for **only** the high/medium items,
  shrinking the synthesis input and keeping focus on real outcomes.
- The renderer's default of hiding `low` items removes ~30–50% of items
  on a typical day from view, without dropping them from the digest
  (they're still queryable for honesty about thin days).

## Interaction with other strategies

- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):** the
  guard cross-checks that synthesis verbs match confidence — using
  "shipped" or "merged" on a `medium` item fails the guard.
- **[B3 — Phrase templates](b3-phrase-templates.md):** templates are
  selected by confidence; "Shipped" template only fires on `high`.
- **[B6 — Negative caching](b6-negative-caching.md):** days where every
  item is `low` are still cached; the renderer reports honestly that
  the day was thin.

## What confidence is *not*

- Not a proxy for "important" — important work can be in progress
  (`medium` confidence).
- Not visible to the user as a label — it's an internal signal that
  drives rendering. The user sees the rendered verb ("Shipped" vs
  "Drafted") and the supporting facts, not the confidence string.
