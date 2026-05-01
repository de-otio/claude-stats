# C2 — User-correctable digests

| | |
|---|---|
| Cost lever | Higher quality + personalisation |
| When it pays off | Power users who recap daily |
| Effort | Medium |

## Rationale

Even with embeddings (B1), tuned weights (C1), and a robust segmenter,
the recap will occasionally cluster things wrong: two efforts that look
similar but aren't, or two unrelated-looking sessions that the user
considers part of the same task.

Letting the user correct the digest and persisting those corrections
turns a one-time miss into a permanent improvement, without any LLM
involvement.

## CLI surface

```
claude-stats recap correct merge <itemA> <itemB>
claude-stats recap correct split <item> <segmentId>
claude-stats recap correct rename <item> "<new label>"
claude-stats recap correct hide <item>
```

`<itemA>` / `<itemB>` are item ids from the most recent digest (or any
prior cached digest). The CLI helps the user discover them by printing
each item with its id.

## Persistence

A new SQLite file `~/.claude-stats/recap-corrections.db` (or a table
in the existing store) with rows keyed by a *signature* of the work,
not the per-day item id.

**Security requirements (mandatory):**

- All writes use **parameterized queries** (`db.prepare(...).run(?, ?)`),
  never string interpolation. The CLI accepts a free-form `<new label>`
  for the `rename` command, which is a direct SQL-injection vector if
  interpolated. The existing `Store` class follows this pattern; the
  corrections database MUST inherit it.
- File created at mode `0o600` and the parent directory at `0o700`,
  matching the existing `stats.db` posture.
- Length-cap the user-supplied label at 200 characters and reject
  control characters (`/[\x00-\x1f\x7f]/`).
- The label is rendered as untrusted content (wrapped, delimited)
  whenever it appears in a digest's narrative output — same posture as
  `firstPromptShort`.

Rows keyed by a *signature* of the work:

| Signature feature | Purpose |
|---|---|
| Sorted set of file paths | Same code = same task, even on a different day |
| Project path | Disambiguates same-named files in different repos |
| First-prompt prefix (normalised) | Catches "same task continued" in different sessions |

When `clusterSegments` runs on a future day, it consults the
corrections table: any cluster whose signature matches a recorded
`merge` correction gets merged with the corresponding cluster
likewise. `split` and `hide` corrections work the same way. `rename`
provides an override label for synthesis prompts and templates.

## Why signature, not item id

Item ids are unstable across days — they're hashes of segment content
plus commit shas, which change every time. Corrections need to apply to
the *underlying work*, not the day's projection of it. A signature
based on project + file paths + prompt prefix captures that.

## Token-cost effects

C2 has no direct LLM-cost effect. The indirect benefit: corrections
make the deterministic spine more accurate, which reduces the rate at
which calling agents need to escalate to LLM tiebreakers (when those
exist).

## Interaction with other strategies

- **[B2 — Confidence scores](b2-confidence-scores.md):** a `merge`
  correction recomputes confidence on the merged result. A correction
  cannot raise confidence above what the underlying signals support
  (an `hide`-then-`merge` sequence does not invent commits).
- **[C1 — Offline LLM judge](c1-offline-llm-judge.md):** corrections
  form a labelled corpus that can periodically feed into per-user
  weight tuning, if the user opts in.
- **[B5 — Incremental digest](b5-incremental-digest.md):** corrections
  invalidate any cached digest whose item signatures match the
  corrected ones. The patcher handles this naturally — corrections
  count as "input changed."

## Privacy

Corrections never leave the local machine. The corrections database
inherits the same `0600` posture as `stats.db`. Cross-device sync of
corrections is out of scope for this analysis (would belong with the
broader cross-device-sync workstream).
