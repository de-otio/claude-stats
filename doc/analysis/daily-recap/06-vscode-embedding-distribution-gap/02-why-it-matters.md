# Why this matters

The B1 strategy doc ([strategies/b1-local-embeddings.md](../strategies/b1-local-embeddings.md))
makes the case for embeddings on quality grounds: Jaccard misses obvious
near-duplicates (`"add russian locale"` vs `"add japanese locale"`,
`"refactor auth"` vs `"rewrite authentication"`). The recap pipeline depends on
clustering to dedupe topic-segments across sessions; bad clustering produces
duplicated digest items, lowers confidence scores, and pushes more items into
the "+N brief items" collapse. The deterministic-first design philosophy of
the recap (see [03-hybrid-pipeline.md](../03-hybrid-pipeline.md)) is least
defensible exactly where Jaccard is weakest.

Quality aside, the VS Code path is the **primary distribution surface** for
non-CLI users. A feature that exists only behind a flag on a separately-
installed npm binary, never mentioned in the extension's UI or readme, is
effectively shipped to nobody. The integrity work (SR-5: SHA-256 pin,
tampered-file deletion) and the privacy posture (local-only, `0o600` cache)
are paid-for security infrastructure that today guards a code path the VS Code
audience cannot reach.
