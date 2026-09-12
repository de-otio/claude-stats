# 04 — Scope

## 4.1 What this release is

**One claim: the numbers Claude Stats reports are correct.** Nothing else.

The prior implementation set totals 36–41 days of feature work behind 3–4 days
of Phase 0 correctness. This release is that Phase 0 slice, corrected by
[02](02-pricing-drift.md) and extended by the one defect that postdates it — and
nothing from Phase 2.

| # | Item | Source | Size |
|---|---|---|---|
| 1 | Pricing rows: add `claude-opus-4-7`, `claude-fable-5-1`, `claude-mythos-5-1`; delete the stale Sonnet 5 comment; bump `PRICING_VERIFIED_DATE` | [02 §2.1–2.2](02-pricing-drift.md) — **C5, corrected** | XS |
| 2 | Suffix-shape rule in **both** prefix matchers + drift finding + property test | [02 §2.3](02-pricing-drift.md#23-the-structural-fix) — new | S |
| 3 | **Unknown-share surface** — render drift findings and an unpriced-token caveat in `diagnose` / `status` and wherever a total is printed | review finding — new | S |
| 4 | Usage-carrier row model: `message_id` + `usage_counted`, one carrier per group | prior set **C1**, redesigned in review | M |
| 5 | V23 columns: `effort`, `speed`, `thinking_tokens` (nullable), `cost_basis` (**NOT NULL**) | prior set, `01-foundation.md` | S |
| 6 | Reprice the persisted caches: `usage_windows`, recap `algo:2`→`3`, full `message_hourly` rebuild | review finding — new | S |
| 7 | `schema_version` downgrade guard; idempotent V23 backfill | review finding — new | XS |
| 8 | Stream the parser's line buffer (unblocks re-parse on large transcripts) | review finding — new | S |
| 9 | Repair command + `cost_basis` disclosure | Q1 (a) + (c) | M |
| 10 | `HIGH_THINKING` predicate fix | prior set, **C7** | XS |
| 11 | Documentation, changelog, release | — | S |

Items 3, 6, 7 and 8 are **new since the reviews** and none is optional:

- **3** — without it the structural fix converts a *visible* over-charge into an
  *invisible* under-charge. Only 4 of 19 `estimateCost` call sites read
  `.known`; the other 15 add `cost` (which is `0` on refusal) straight into a
  total. The day `claude-opus-5-1` ships, Opus spend would silently read zero.
- **6** — `usage_windows` holds **$113,221.90** of stored pre-fix cost across 555
  rows and `collect()` recomputes only the last two days; the recap cache keys on
  `algo:2` and its own comment says to bump it when cost attribution changes.
  Without these the changelog's "your cost changed" is true on some surfaces and
  false on others, which is worse than either.
- **7** — `migrate()` stamps `schema_version` unconditionally, including
  *downward*. With three processes on one DB at different versions, an old build
  re-arms V23 and re-stamps every repaired row.
- **8** — the parse buffers a whole file; the largest transcript here is 994 MB.
  The changelog tells everyone to run the repair, so this is the main path.

Items 1–3 are pricing-only and independent of the rest. Items 4–8 are the
accounting change and must land together. Items 9–10 depend on 4–8. Item 4 is
the only one that changes numbers users have already seen.

## 4.2 What this release is not

Explicitly out, and none of it should be started as part of this work:

- **`verify`** (prior §3, 8 days). It is blocked on item 4 by the prior set's own
  sequencing — "or `verify`'s first output is 'this tool is wrong'"
  (`09-sequencing.md:39`). Correct order; this release supplies its
  precondition and stops there.
- **Effort and thinking-share analytics.** The columns land; no card, no MCP
  surface, no cost-per-effort comparison. See
  [03 §3.1](03-request-dimensions-delta.md#31-effort--confirmed-including-the-reason-not-to-build-the-analytic)
  — the corpus is 98.6% one effort level and the comparison would be confounded.
- **Fast-mode analytics, limit-impact, constraint-impact threading.** Zero
  observations. [03 §3.3](03-request-dimensions-delta.md#33-speed--confirmed-zero-one-narrow-change).
- **Everything in Phase 2** — session titles, friction, attribution, compaction,
  PR/work items. Unchanged and still pending.
- **The other defects in the prior set's list** — C2, C3, C6, C9, C10. They are
  real and they are cheap, but they are *prompt-counting* and *schema-monitoring*
  corrections, not cost corrections, and bundling them makes the cost change
  unattributable. The prior set makes this argument itself for C2+C3
  (`09-sequencing.md:38`); it applies here too.

## 4.3 The decision that needs the maintainer

The prior set's **open question Q1** (`09-sequencing.md:208-216`) is unresolved
and item 4 cannot ship without answering it.

Fixing the dedupe corrects every number **going forward**. It does not correct
the ~2× inflation already written into `stats.db`. Users will see historical
spend roughly halve, or not, depending on the answer.

| Option | What it does | Cost |
|---|---|---|
| **(a) Repair** | Add `messages.message_id`, re-parse the sessions whose transcripts still exist, collapse duplicates | Real work; repairs only what is repairable |
| **(b) Estimate** | Store a per-session `inflation_factor` and divide | Cheap; **fabricates a number** |
| **(c) Disclose** | Leave history, mark it with a `cost_basis` flag, say so in the UI | Cheap; honest; leaves a discontinuity |

The prior set recommends **(a) + (c)** — repair what is repairable, flag the
rest, never silently apply an estimated correction factor. This document
strengthens that recommendation with new evidence:

> [01 §1.1](01-measured-defects.md): the over-count ratio is **1.94× on
> cache-read tokens but 2.60× on output tokens** on the same sample.

A single per-session `inflation_factor` therefore cannot be right for all four
token classes at once. Option (b) does not merely fabricate a number — it
fabricates one that is *demonstrably wrong by token class*, and the error runs
in opposite directions for input-heavy and output-heavy sessions. **Option (b)
should be struck, not weighed.**

**Re-measured on current data**: 1,319 of 1,463 sessions (**90.2%**) have no
surviving transcript, and by message volume only ~28% of rows are repairable. So
(a) reaches under a third of the problem and (c) must cover the rest regardless.

What makes (a) worth doing anyway is a design change that came out of review:
under the **usage-carrier row model** (item 4) the repair is no longer
destructive. One `messages` row per transcript entry is kept, keyed on the same
`uuid` as before, so a re-parse *upserts the same rows in place* and simply
corrects which one carries the usage. There is no `DELETE`, no row-count change,
and no window in which a crash loses history — which removes the entire reason
(a) looked expensive and dangerous.

**Recommendation: (a) + (c).** The alternative worth considering, if (a)'s
re-parse is judged too large for this release, is **(c) alone** — flag all
existing rows as `cost_basis: 'pre-dedupe'`, correct everything from the fix
forward, and offer re-parse as an explicit `claude-stats backfill` the user
runs. That keeps the release small and never shows a fabricated number; its cost
is that history stays visibly inflated until the user opts in.

## 4.4 Release shape

One release, sequenced so that each change is separately attributable if it has
to be reverted:

1. Items 1–3 — pricing only. No user-visible number changes except Fable 5.1
   and Opus 4.7 traffic, both of which get *smaller* and *more correct*.
2. Item 5 — the V23 columns. Additive, no behaviour change.
3. Item 4 (+ 6) — the dedupe, with the Q1 decision applied. This is the change
   that needs the loudest changelog entry this project has written: **every
   historical cost figure moves.**

A user who upgrades and sees their reported spend halve must find the
explanation in the changelog before they conclude the tool is broken.
