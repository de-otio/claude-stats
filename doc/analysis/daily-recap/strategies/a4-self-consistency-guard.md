# A4 — Self-consistency / entity-presence guard

| | |
|---|---|
| Cost lever | Higher quality (catches hallucinations) |
| When it pays off | Always when synthesis is used |
| Effort | Small |

## Rationale

The synthesis pass is the only place in the recap pipeline where the
output isn't directly grounded in the digest. A small post-check defends
against the standard failure modes (made-up project names, inflated
commit counts, invented file changes) without spending another LLM call.

## Algorithm

```
guard(prose, digest) -> { ok: boolean; violations: string[] }

1. Extract candidate entities from prose:
   - quoted strings ("...")
   - capitalised tokens that match the project name pattern
   - integer counts followed by "commit", "file", "minute", "session"
   - file extensions and paths (.ts, src/foo.ts)

2. For each entity, check it appears verbatim (case-insensitive) in
   the digest's serialised form, OR matches a known synonym
   (project_path → repo basename, etc.).

3. If any entity is unmatched, the guard fails. Caller falls back to
   the deterministic template render or retries synthesis once with a
   "stick to the digest" reminder.
```

This is a few hundred lines of pure JS; no LLM, no external dependency.

## Where it lives

Agent-side. The guard runs in the calling agent after the model returns,
before showing prose to the user.

The `summarize_day` MCP tool description suggests the guard pattern with
a code-snippet example so agents implementing recap rendering pick it up
by default.

## Failure modes the guard catches

- "You shipped the **payment-service** refactor" when the digest only
  mentions `claude-stats`.
- "You merged **8 PRs**" when the digest shows `prMerged: 2`.
- "You touched **`src/auth/middleware.ts`**" when no such path appears
  in any item's `filePathsTouched`.
- Compound hallucinations: combining two real entities into a fake third
  ("the auth-refactor in claude-stats" when both terms appear separately
  but never together).

## Failure modes it does *not* catch

- Tone or framing errors (the guard only checks entity presence).
- Plausible-but-wrong **interpretation** of why something happened
  (e.g. "you fixed the bug" when the user actually only diagnosed it).
  Mitigation: keep the synthesis prompt explicit that the model must not
  attribute outcomes beyond what the digest's `git` and confidence
  fields say.

## Interaction with other strategies

- **[B2 — Confidence scores](b2-confidence-scores.md):** the synthesis
  prompt should pass confidence verbatim and the guard should treat
  confidence-modifying words ("shipped", "drafted", "investigated") as
  tied to the item's confidence level. Mismatch → guard fails.
- **[A3 — `max_tokens` cap](a3-max-tokens-cap.md):** capped outputs
  reach the guard faster and are easier to verify.
