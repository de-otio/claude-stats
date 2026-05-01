# B6 — Negative caching

| | |
|---|---|
| Cost lever | Lower CPU |
| When it pays off | Days with no work (weekends, sick days, vacation) |
| Effort | Tiny |

## Rationale

A non-trivial fraction of days produce no recap content: weekends,
holidays, sick days, all-meeting days. The v1 cache key already covers
these, but it's worth being explicit about how empty days are handled.

## Behaviour

For a date with zero sessions and zero authored commits across all
known projects:

- Snapshot hash is computed from the same inputs as a normal day —
  `(date, tz, lastMessageUuid=null, perProjectLastCommit={…all null})`.
- Digest stored in cache as `{ date, tz, totals: { all zeros }, items:
  [], cached: true, snapshotHash }`.
- Cache file is small (~200 bytes) and cheap to read.

The CLI renderer detects an empty digest and prints:

```
No recorded work today.
```

The agent receives the same empty digest and can render its own
honesty-preserving message.

## Why "negative caching" deserves a name

Without it, an empty day would still trigger a full rebuild on every
call — slightly wasteful, mostly harmless, but it's an obvious
optimisation worth flagging:

- Cost per rebuild: ~50ms CPU plus N git invocations, where N is the
  number of known projects.
- With B6: ~1ms cache read, no git invocations.

## Cache invalidation correctness

The cache key includes the full set of `(project, lastCommitSha)`
pairs, not just non-null ones. A late-arriving commit on any project
shifts the hash and invalidates the empty-day cache automatically.

A subtle case: if a user adds a *new* project (one claude-stats hasn't
seen before) on what was previously an empty day, the project list
itself changes. The hash inputs must include the *sorted set of project
paths considered*, not just their commit shas, to invalidate correctly.

## Interaction with other strategies

- **[B2 — Confidence scores](b2-confidence-scores.md):** an empty
  digest has no items to score; this is a degenerate case that should
  not return synthetic items.
- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):**
  agents synthesising prose for an empty digest must produce
  confessional output ("nothing to report") — the guard rejects any
  prose that mentions specific projects or work.
- **[B4 — Background pre-computation](b4-background-precomputation.md):**
  pre-computing yesterday for a non-working day still produces a useful
  cache entry.
