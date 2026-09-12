# 06 — Implementation Plan

Scope is [04](04-scope.md). This is the **post-review** plan; what the two
review passes changed, and why, is recorded in
[07-review-integration.md](07-review-integration.md). The first draft's lane
partition and repair design were both wrong, and the corrections are load-bearing
rather than cosmetic.

## 6.1 The row model — settle this before anything else

Every other decision follows from it, and the first draft left it implicit
("dedupe on `message.id`, MAX-wins"), which hid a data-loss hazard.

**One API response is written as N transcript entries — one per content block.**
Measured on the 12 most recent transcripts: 84% of `message.id` groups are
multi-entry, **9,955 carry a `tool_use` block on a non-first entry**, and 8,315
have different block types per entry. A typical group:

```
0c61c8a0  ['thinking']  usage: {out: 324, ...}
6856c2e2  ['text']      usage: {out: 324, ...}
d4da6ac3  ['tool_use']  usage: {out: 324, ...}
```

Each entry repeats the *whole response's* usage. That is the over-count.

**Do not delete the non-carrier rows.** `toolUseCounts`, `filePaths`,
`thinkingBlocks` and `toolErrorCount` are accumulated **per entry**
(`parser/session.ts:378-420`), so dropping non-winners would delete ~92% of
tool-use records and silently collapse every tool-cost surface, along with
`assistant_message_count` and `message_hourly.msg_count`.

**The model is therefore:**

- One `messages` row per transcript entry. `uuid` stays the primary key.
- New `message_id TEXT` and `usage_counted INTEGER NOT NULL DEFAULT 1`.
- Exactly one entry per `message.id` group is the **usage carrier** (MAX usage
  within the group — it differs in only 18 of 10,554 groups, so the rule barely
  matters, but MAX is the prior set's verified choice).
- Non-carriers keep their tool/thinking/file-path data and are written with
  `usage_counted = 0` and **zeroed token columns**.
- Every cost and token aggregate sums over carriers only.

Two consequences worth stating because they are what make this release safe:

1. **The repair is not destructive.** Uuids are unchanged, so re-parsing a
   session upserts the *same rows in place* and merely corrects which one
   carries the usage. No `DELETE`, no row-count change, no partial-crash window.
2. **`keepIfNoUsage` must be taught the difference.** `upsertMessages` currently
   treats "all four token fields are 0" as "this copy carries no usage" and
   refuses the update (`store/index.ts:1165-1169`). A deliberately zeroed
   non-carrier is indistinguishable from a replay, so the guard must be gated on
   `excluded.usage_counted = 1`. Without this the zeroing silently no-ops and
   the release fixes nothing.

### The dedupe cannot live only in the parser

`parseSessionFile` is incremental from `checkpoint.lastByteOffset`
(`aggregator/index.ts:156`), and a `message.id` group whose entries straddle
that offset is split across two parse invocations. A parser-local `Map` cannot
see the earlier half. Groups are consecutive lines written seconds apart while a
session is live, and the collector runs periodically from three processes — so
boundaries land mid-group routinely, not exotically.

**The carrier rule is enforced at the store.** The parser marks the carrier
within its own range; `upsertMessages` additionally zeroes an incoming row whose
`message_id` already has a counted row for that session. A partial unique index
(`WHERE message_id IS NOT NULL`) makes it enforceable rather than advisory.

## 6.2 Partition by file, and the partition must actually be disjoint

The first draft partitioned four lanes by file ownership and got it wrong:
Lane C's own deliverables (`cost_basis` in the V23 migration, the
`thinking_tokens` read path) live inside `store/index.ts`, which Lane B owned.
Six files needed two lanes.

Corrected partition — **three** lanes, with the schema and its readers held by
one owner:

| Lane | Owns (exclusive write) | Items |
|---|---|---|
| **A — Pricing** | `packages/core/src/pricing.ts`, `packages/cli/src/config.ts` (`validatePricingConfig` only), `vitest.config.ts` + `packages/core/package.json` (alias/exports block only), their tests | 1, 2, 3 |
| **B — Accounting** | `packages/core/src/types.ts`, `packages/core/src/parser/session.ts`, `packages/cli/src/store/index.ts`, `packages/cli/src/aggregator/index.ts`, `packages/cli/src/sync-merge/*`, `packages/cli/src/recap/cache.ts`, their tests | 4, 5, 6, 7, 8 |
| **C — Repair & surfaces** | `packages/cli/src/repair/*`, `packages/cli/src/cli/*`, `packages/cli/src/dashboard/index.ts`, `packages/cli/src/reporter/*`, `packages/cli/src/server/template.ts`, `packages/cli/src/mcp/index.ts`, `packages/core/src/locales/*`, their tests | 9, 10 |
| **D — Documentation** | `extension/CHANGELOG.md`, `doc/user-doc/*`, `doc/analysis/*.md` | 11 |

`packages/core/src/types.ts` goes to **B**, not A. A cannot know the parser's
raw-entry shape, and B's edits to it are the larger set. A's one type need
(`PricingDriftFinding`) lives in `pricing.ts` alongside its logic — which is also
required, because `packages/core/src/types/**` is **excluded from coverage**
(`vitest.config.ts:81`), so no runtime logic may live there.

Nobody owns `package.json` version fields. The release commit is mine.

## 6.3 Dependency graph

```
   A (pricing) ──────────────────────────┐
                                          ├──→ D (docs) ──→ release
   B (accounting) ──→ C (repair+surfaces) ┘
```

A and B share no files and start together. C waits on B for real now — the
schema, the carrier rule, the store-level enforcement and the streaming parser
are all B's, and C's repair is a thin driver over them.

## 6.4 Model assignment

| Lane | Model | Why |
|---|---|---|
| **A — Pricing** | **Opus** | Every cell is a money number; four of five rates are identical between the models being distinguished. The shape rule is a subtle invariant that a wrong property test actively pushes you to break. |
| **B — Accounting** | **Opus** | The largest blast radius in the release: billing semantics, an upsert guard whose failure mode is a silent no-op, a migration that cannot be un-run, and cross-device convergence. |
| **C — Repair & surfaces** | **Opus** | Decides what users are told about numbers that just moved, and drives a pass over the whole database. |
| **D — Documentation** | **Sonnet** | Bounded and derivative — the diff and this analysis are the source material. I review it before it ships. |

Haiku is not used: there is no high-volume checkable-output work here, which is
the shape it fits.

## 6.5 The lanes

### Lane A — Pricing

1. **Rows.** `claude-opus-4-7` (5 / 6.25 / 10 / 0.50 / 25) — the largest
   correction in the release; `claude-fable-5-1` and `claude-mythos-5-1`
   (10 / 12.50 / 20 / **0.25** / 50). Delete the stale Sonnet 5 comment and
   **leave its rates at $2/$10** ([02 §2.2](02-pricing-drift.md)).
   `PRICING_VERIFIED_DATE` → `2026-09-12`.
2. **Shape rule** in **both** prefix matchers — `resolvePricing`'s built-in loop
   *and* `lookupIn`, the override-table matcher, which has the identical defect.
   Remainder classes per [02 §2.3](02-pricing-drift.md#23-the-structural-fix);
   `[1m]` **inherits**, point-release suffixes **refuse**.
3. **Unknown-share surface.** A `PricingDriftFinding` is useless with no
   consumer — `verify` is out of scope, so render findings in `diagnose` and
   `getStatus`, and add an unpriced-token caveat wherever a total is printed.
   Coordinate the surface with C, which owns the renderers.
4. **Not in this lane:** fast-mode rates and `estimateCost(speed)` — cut, see
   [02 §2.4](02-pricing-drift.md). `effectiveUntil` — cut, it has no consumer
   without `verify`. Both are recorded in the analysis for when they are
   reachable.

Also: `validatePricingConfig` (`config.ts:415-445`) rebuilds `ModelPricing`
field-by-field, so any new field is silently dropped from user overrides unless
added there. And note `applyPricingCache` **overwrites** `PRICING_VERIFIED_DATE`
with the fetch date (`pricing.ts:178`) — the new constant is not what users see;
say so in a comment so nobody "fixes" it later.

**Tests.** Table-driven regression over the ids in
[02 §2.5](02-pricing-drift.md#25-verified-by-execution-not-by-reading) **plus**
`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`, a Bedrock id, a Vertex id, and
the bare aliases `opus` / `sonnet` / `haiku` (which must stay `known: false`).
The shape property, stated **with** the context-tier arm.

### Lane B — Accounting

1. **Types first** — `RawSessionEntry.effort` and `UsageData.speed` /
   `output_tokens_details` do not exist. A field absent from `RawSessionEntry`
   cannot be read, by deliberate compile-time rule.
2. **Migration V23** — `SCHEMA_VERSION` 22 → 23 **and** the
   `if (current < 23)` line in the chain; both are easy to miss and produce a
   silently un-migrated DB. Columns: `effort TEXT`, `speed TEXT`,
   `thinking_tokens INTEGER`, `message_id TEXT`, `usage_counted INTEGER NOT NULL
   DEFAULT 1`, `cost_basis TEXT NOT NULL DEFAULT 'pre-dedupe'`. Partial unique
   index on `message_id`.
   - `thinking_tokens` **nullable** — `NOT NULL DEFAULT 0` fabricates a 0%
     thinking share for the third of history predating the field. Parse it
     `?? null`, never `?? 0`, and put it in the `keepIfNoUsage` family, not the
     plain-`COALESCE` family: it is a token count, not a label, and `COALESCE`
     protects against `NULL` but not against a replay's `0`.
   - `cost_basis` is the **one exception** to the nullable rule, deliberately:
     `NOT NULL DEFAULT 'pre-dedupe'` so that "I don't know" reads as "don't
     trust me". The corrected parser writes an explicit basis token. Merge is
     worst-wins — a sync may add doubt, never remove it.
   - Backfill must be idempotent against a *partially repaired* table:
     `... WHERE cost_basis IS NULL`, not a blanket update.
3. **`schema_version` downgrade guard** — stamp only `if (current <
   SCHEMA_VERSION)`, and warn loudly when a DB is from the future.
4. **Parser** — capture `entry.effort` (entry root), `usage.speed`,
   `usage.output_tokens_details.thinking_tokens`, `message.id`; mark the carrier.
   **Validate at the parser boundary**, per this project's rule that free text is
   dropped where it enters: `effort`/`speed` must match `/^[a-z]{1,10}$/`,
   `message_id` `/^[A-Za-z0-9_-]{1,64}$/`, else `null`. A shape check, not an
   enum — `xhigh` was a surprise once already. This matters because
   `getSessionMessages` is `SELECT *` and feeds the personal-plane export, so
   any column added to `messages` enrols itself automatically.
5. **Stream the line buffer** — `parseSessionFile` accumulates every line of its
   range before processing (`parser/session.ts:116-131`). Fine for a tail, fatal
   for a 994 MB file at offset 0. Keep one line buffered; that is all the
   discard-last-line rule needs.
6. **Sync-merge** — the first draft had this backwards. No session-level counter
   is added, so `MONOTONIC_COUNTER_FIELDS` needs no *additions*; the hazard is
   that the fields already in it are folded with `Math.max`, and this release
   makes them **shrink**. An un-upgraded peer's shard would pin the inflated
   values forever, unrecoverably. Recompute session aggregates from the merged
   message union instead of max-folding them. `rowToMessageRecord`
   (`sync-merge/apply.ts:70-91`) must carry the new columns — it already silently
   drops five existing fields. This directory has a **90% line coverage floor**.
7. **Reprice the persisted caches** — bump the recap cache `algo:2` → `algo:3`;
   recompute `usage_windows` over all history once (it stores dollars and
   `collect()` only revisits two days); force a **full** `recomputeMessageHourly()`
   after any repair, because its freshness watermark is a row *count* and a
   repair changes values without changing counts.

**Tests.** The replay-invariance property the first draft proposed **does not
fail on this bug** — today's parser is already uuid-replay-invariant, and 59% of
multi-entry groups carry no repeated uuid. The properties that do fail when
wrong:

- Generate a response as *n* ∈ [1,8] entries sharing one `message.id` with
  distinct uuids, each carrying the same usage and one content block. Assert
  token totals equal **one** response's usage, and that `tools` /
  `thinkingBlocks` / `filePaths` equal the **union** across entries.
- Cut the same group at **every** inter-entry byte offset, parse as two
  invocations through the store, assert totals identical to a single pass.
- Assert at the **store**, after `upsertMessages` + `recomputeSessionAggregates`
  + `recomputeMessageHourly` — every real cost surface reads SQL aggregates, not
  `ParseResult` — and assert the rollup and the raw read agree.
- Migration test: `thinking_tokens` reads back `NULL` on old rows, not `0`;
  `cost_basis` is `'pre-dedupe'` on every pre-existing row.

### Lane C — Repair & surfaces

1. **Repair command** on the `repair/` template, not `backfill`: dry-run,
   **DB file backup before write** (`repair/project-paths.ts:17-19`), one
   transaction per session, then `recomputeSessionAggregates` and a full
   `recomputeMessageHourly`.
   - **Scanner-driven only.** Iterate files discovered under the projects
     directory; never open `sessions.source_file`, which arrives from peers via
     sync and is not trustworthy input — feeding it to the parser writes
     arbitrary file bytes into `quarantine.raw_line`. If a session-driven pass is
     ever needed, `realpath` it and require containment under the projects dir.
   - Take an exclusive advisory lock: the collector's compare-and-swap guard is
     disabled when `startOffset === 0` (`aggregator/index.ts:212-216`), so two
     concurrent full re-parses are possible exactly during a repair.
2. **Disclosure** — surfaces that report cost say when their range includes
   `pre-dedupe` rows. `cost_basis` is a closed machine token, rendered
   unlocalised; labels go through i18n. **Only `cost_basis` joins the MCP
   payload** — `message_id`, `effort` and `speed` have no analytic in this
   release and must not be added to `get_session_detail`; "expose it now, use it
   later" is how an allowlist rots.
3. **`HIGH_THINKING`** (`dashboard/index.ts:2566-2569`) — re-express against
   `thinking_tokens` with a >50% threshold. It will **never fire on pre-August
   rows** (NULL), a visible behaviour change that needs a changelog line. Keep
   `message_hourly`'s `th_*` columns and the three other reads on
   `thinking_blocks` — moving some and not others makes the rollup and the raw
   reads disagree.
4. **Locales** — all ten. `fill-locales.mjs` drives `claude -p`, so it needs the
   CLI and network and **a sandboxed agent cannot run it**; the parity ratchet
   fails the build on a partial fill. Lane C prepares the `en` strings and hands
   the fill to me.

### Lane D — Documentation

`extension/CHANGELOG.md` is the deliverable that matters. It must state plainly
that **reported cost changes for everyone**, give the measured ratios, name all
three causes, explain `pre-dedupe`, and say how to run the repair. A user who
upgrades and sees their spend fall by half must find the reason here before
concluding the tool broke. Then `doc/user-doc/faq.md`, `output-guide.md`,
`commands.md` (the new repair command), `doc/analysis/07-schema-reference.md`
(six new columns), and a *Status: implemented* note on this README.

Also correct `doc/analysis/05-privacy-security.md:78-79`, which asserts the DB
is `0600`. It is `0644`; containment comes from the `0700` parent directory.

## 6.6 Verification

Per lane: scoped `vitest` runs. At integration: `npm run typecheck`, full
`npm test`, `npm run locales:check`, `npm run coverage:gate`.

**Sandbox note.** `packages/cli/src/__tests__/server.test.ts` and `mcp.test.ts`
bind `127.0.0.1` and fail with `listen EPERM` under the tool sandbox. They pass
with it disabled. Baseline before this work: **3,691 passing**. Do not chase
those two as regressions.

**The measurement that decides the release.** Reprice the **whole `messages`
table**, per model, before and after — not the transcript-derived sample, which
contains no Opus 4.7 traffic and so misses the largest correction. Expected:
`claude-opus-4-7` from $40,384 → $13,461, `claude-fable-5-1` cache reads ÷4, and
token totals per session halving where a session's entries were multi-block. A
green suite proves the code does what it was written to do; only this proves the
number is right.

## 6.7 Release

Version bump, release commit, `ext-vX.Y.Z` tag. The tag push triggers
`.github/workflows/publish-extension.yml`, which rebuilds from source — nothing
built is committed.

**The push is egress to a public repository and is not mine to make.** The
commit and tag are prepared locally and the exact push command is handed to the
maintainer.
