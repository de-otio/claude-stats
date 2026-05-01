# B5 — Diff-based incremental digest

| | |
|---|---|
| Cost lever | Lower CPU + faster cache rebuild |
| When it pays off | Mid-day "how am I doing" patterns |
| Effort | Medium |

## Rationale

The v1 digest builder rebuilds today's digest from scratch each time the
snapshot hash invalidates. That's correct but wasteful when only a
handful of new messages or one new commit have arrived since the last
build.

An incremental builder maintains the previous digest plus the
`(last_message_uuid, last_commit_sha_per_project)` it was built against,
and on the next call:

1. Identifies which sessions/projects have new data since the last
   build.
2. Re-segments only those sessions.
3. Re-clusters only the segments that intersect a touched project.
4. Re-runs git enrichment only on touched projects.
5. Splices the result into the previous digest's structure.

For a typical mid-day call this turns a ~200ms full rebuild into a
~10ms patch.

## Where it lives

A new method on the `recap` module:

```typescript
export function patchDailyDigest(
  store: Store,
  previousDigest: DailyDigest,
  opts?: DailyDigestOptions,
): DailyDigest;
```

`buildDailyDigest` checks whether a previous digest exists in cache:

- Cache miss → full build.
- Cache hit but inputs changed → call `patchDailyDigest`.
- Cache hit and inputs unchanged → return cached digest unchanged.

## Correctness considerations

- **Segment boundaries crossing the patch boundary.** A new message can
  cause an existing segment to extend or split. The patcher must
  re-segment any session whose `last_message_uuid` differs from the
  previously-recorded value, not just append.
- **Cluster reshuffling.** A new commit on project X can cause a
  previously-medium item to become high-confidence; the patcher must
  re-run scoring/confidence on any cluster whose project changed.
- **Stable IDs.** Item `id`s remain stable when their constituent
  segments/commits don't change, so a UI that diffs two consecutive
  digests can highlight "what changed since last time."

Tests must cover all three reshuffling cases on top of the standard
build-from-scratch tests.

## When *not* to use B5

- After a long gap (e.g. ≥1 hour since the previous digest):
  full-rebuild and re-cache. The CPU difference is small in absolute
  terms and the correctness risk is lower.
- After the day boundary rolls over: a new digest is needed for the
  new day; the previous day's cache is independent.

## Token-cost effects

B5 has no direct effect on LLM tokens — it only affects CPU/IO. The
indirect effect is that fast rebuilds make repeated mid-day recaps
cheap enough that cached synthesis (via [A1](a1-prompt-caching.md)) can
run on each new state without rebuilding the digest from scratch.

## Interaction with other strategies

- **[B4 — Background pre-computation](b4-background-precomputation.md):**
  B4 produces the base digest; B5 patches it during the day.
- **[B2 — Confidence scores](b2-confidence-scores.md):** patching must
  recompute confidence on touched clusters, since a new commit can
  upgrade `medium` → `high`.
- **[A4 — Self-consistency guard](a4-self-consistency-guard.md):**
  unaffected; the guard runs on synthesis output, regardless of how the
  digest was built.
