# 07 — What Review Changed

Two independent review passes ran against the first draft of
[06](06-implementation-plan.md) before any code was written: a security and
data-handling pass, and an adversarial best-practices pass that checked every
technical claim against the working tree. Both read the code, not just the plan.

They found enough that the first draft should be considered withdrawn rather
than amended. This chapter records what changed, because the errors are more
instructive than the plan.

## 7.1 The reviews disagreed, and the disagreement was the most useful part

**The security pass** found that the repair could not work: `resetCheckpoints()`
+ `collect()` is upsert-only, so the surplus rows from the old parser — carrying
uuids the corrected parser would no longer emit — would survive untouched. Its
fix: **delete** the non-survivors of each `message.id` group.

**The best-practices pass**, working from the same code, found that deleting
those rows would be a data-loss event: entries in a group are one *per content
block*, and the tool, thinking and file-path data is accumulated **per entry**.

Measured directly to settle it (12 most recent transcripts, 12,899 groups):

| | |
|---|---:|
| Multi-entry `message.id` groups | 10,780 (**84%**) |
| …carrying `tool_use` on a **non-first** entry | **9,955** |
| …with different block types per entry | 8,315 |

A delete-based repair would have destroyed roughly 92% of tool-use records to
fix a token count.

**The resolution belongs to neither review.** Keep every row; add
`usage_counted`; zero the usage on non-carriers
([06 §6.1](06-implementation-plan.md#61-the-row-model--settle-this-before-anything-else)).
Then uuids never change, the re-parse upserts the same rows in place, and the
security pass's finding **dissolves** — there is nothing to delete, so there is
no destructive pass, no crash window, no delete/upsert race, and no hourly-rollup
staleness from removed rows. Three further findings went with it.

The lesson is worth keeping: the security pass was right that the repair was
broken and wrong about the remedy; the best-practices pass was right about the
remedy's cost and did not connect it to the repair. Neither review alone
produced the design.

## 7.2 Errors in the analysis itself

Review caught three, all mine:

1. **The defect ranking was backwards.** [01](01-measured-defects.md) called
   `claude-opus-4-7` latent because a grep over transcripts found no Opus 4.7
   traffic. But 90.2% of sessions have had their transcripts deleted while their
   rows remain in `stats.db` forever. Measured against the database, Opus 4.7 is
   **$26,923 over-charged — 24× the Fable 5.1 error and the largest single
   correction in the release**. *Measure the surface the defect lives on.*
2. **§2.3 contradicted §2.5.** The suffix rule refused any remainder it did not
   recognise, which included `[1m]` — while §2.5 confirmed twice that
   `claude-opus-5[1m]` is correct to inherit base rates. As written it would have
   zeroed every 1M-context request, and the property test would have *pushed the
   implementer to make it so* in order to go green.
3. **The proposed test would have passed on the broken build.** Replay-invariance
   does not catch this defect: today's parser is already uuid-replay-invariant
   and 59% of multi-entry groups repeat no uuid. A test that cannot fail is
   worse than no test, because it certifies.

## 7.3 Accepted into the plan

| Finding | Change |
|---|---|
| Repair is upsert-only, repairs nothing, and *clears the disclosure label while leaving the defect* | Superseded by the carrier row model |
| `cost_basis` NULL-means-good inverts the fail-safe | `NOT NULL DEFAULT 'pre-dedupe'`; worst-wins on merge |
| `migrate()` stamps `schema_version` downward, re-arming V23's backfill | Guard the stamp; make the backfill idempotent |
| Parser-local dedupe misses groups straddling a collect boundary | Enforce the carrier rule at the store, partial unique index |
| `MONOTONIC_COUNTER_FIELDS` `max()` pins inflated counters across devices forever | Recompute aggregates from the merged union instead |
| `known: false` is silently swallowed at 15 of 19 call sites | New scope item: unknown-share surface |
| `usage_windows` ($113,222 stored), recap `algo:2`, `message_hourly` keep pre-fix numbers | New scope item: reprice the caches |
| Parser buffers whole files; largest here is 994 MB | Stream the line buffer |
| `sessions.source_file` is sync-controlled; feeding it to the parser writes arbitrary bytes into `quarantine` | Repair is scanner-driven only |
| New TEXT columns unvalidated, and `SELECT *` auto-enrols them in the personal-plane export | Shape-validate at the parser boundary |
| Lane partition not disjoint — six files needed two lanes | Three lanes; schema and its readers to one owner |
| `keepIfNoUsage` would reject the zeroed non-carriers | Gate it on `usage_counted` |
| Registration points, `SCHEMA_VERSION` bump, `validatePricingConfig`, override matcher | Named explicitly in the lanes |

## 7.4 Cut from scope on review

- **Fast-mode rates and `estimateCost(speed)`.** Only two of the five rates are
  published, and the missing ones include cache reads — 99.6% of input volume.
  No call site could pass `speed` anyway. The column is kept; the pricing is
  deferred until it is both knowable and reachable
  ([02 §2.4](02-pricing-drift.md)).
- **`effectiveUntil`.** A good mechanism with no consumer while `verify` is out
  of scope. Shipping it unwired is the verification theatre this project's own
  design defaults rule out.

## 7.5 Downgraded — two hazards that are not reachable

Both were inherited from the prior set's summary and repeated without checking.
A mis-stated hazard is not harmless: it trains reviewers to watch the wrong
thing.

- **The positional `INSERT INTO message_hourly SELECT`.** Real, but it projects
  *expressions over `messages`* into `message_hourly`'s 15 columns. Adding
  columns to `messages` cannot shift it. The hazard applies to widening
  `message_hourly`, which this release does not do.
- **`PRAGMA foreign_keys = ON` aborting a whole-file transaction.** `messages`
  has no foreign key. Not reachable — and it stays unreachable only because the
  repair never deletes `sessions` rows.
