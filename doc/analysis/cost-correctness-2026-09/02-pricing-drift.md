# 02 — The Rate Table Against Live Pricing

Every rate in this chapter is **[docs]**, read from the published pricing page
on **2026-09-12**. None is recalled. The retraction in §2.2 exists only because
the page was fetched rather than remembered, which is the argument for §2.4.

## 2.1 Full comparison

`DEFAULT_PRICING` (`packages/core/src/pricing.ts:47-66`) against the live page.
Columns are base input / 5m write / 1h write / cache hits / output, $ per MTok.

| Model | Live **[docs]** | In the table | Verdict |
|---|---|---|---|
| Claude Fable 5.1 | 10 / 12.50 / 20 / **0.25** / 50 | *absent* | **Missing — prefix-matches Fable 5** |
| Claude Mythos 5.1 | 10 / 12.50 / 20 / **0.25** / 50 | *absent* | **Missing — prefix-matches Mythos 5** |
| Claude Fable 5 | 10 / 12.50 / 20 / 1 / 50 | identical | correct |
| Claude Mythos 5 | 10 / 12.50 / 20 / 1 / 50 | identical | correct |
| Claude Opus 5 | 5 / 6.25 / 10 / 0.50 / 25 | identical | correct |
| Claude Opus 4.8 | 5 / 6.25 / 10 / 0.50 / 25 | identical | correct |
| Claude Opus 4.7 | 5 / 6.25 / 10 / 0.50 / 25 | *absent* | prefix-matches Opus 4 — **wrong rate** (see below) |
| Claude Opus 4.6 | 5 / 6.25 / 10 / 0.50 / 25 | identical | correct |
| Claude Opus 4.5 | 5 / 6.25 / 10 / 0.50 / 25 | identical | correct |
| Claude Opus 4.1 | 15 / 18.75 / 30 / 1.50 / 75 | identical | correct (retired) |
| Claude Opus 4 | 15 / 18.75 / 30 / 1.50 / 75 | identical | correct (retired) |
| **Claude Sonnet 5** | **2 / 2.50 / 4 / 0.20 / 10** | 2 / 2.50 / 4 / 0.20 / 10 | **correct — do not change, see §2.2** |
| Claude Sonnet 4.6 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct |
| Claude Sonnet 4.5 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct |
| Claude Sonnet 4 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct (retired) |
| Claude Haiku 4.5 | 1 / 1.25 / 2 / 0.10 / 5 | identical | correct |

`claude-opus-4-7` is absent and resolves by prefix to `claude-opus-4` — the
retired $15/$75 row, a **3× over-charge**, and it is **the largest single
correction in this release**: $26,922.87 over-charged in this database against
$1,112.85 for Fable 5.1. See [01 §1.2.1](01-measured-defects.md#121-the-same-defect-24-larger-claude-opus-4-7),
which also records why an earlier draft mis-ranked it.

### Not defects

- **Long context.** "Claude 4.6 and later models include the full 1M token
  context window at standard pricing." There is no premium tier to model for any
  current model. The table is right to have no `[1m]` rows.
- **Regional endpoints.** Bedrock regional and Google Cloud multi-region/regional
  endpoints carry a 10% premium over global; first-party is global by default.
  `messages.inference_geo` is captured but no multiplier is applied. Correct for
  first-party traffic, latent for partner-platform users. Out of scope here;
  recorded in [05](05-roadmap.md).

## 2.2 Retraction: do not bump the Claude Sonnet 5 row

The prior set's **Phase 0 step 0.1 / defect C5** instructs:

> bump the row to $3 / $15 (and the cache-write/read derivatives), update
> `PRICING_VERIFIED_DATE` … the row lands at $3/$15 either way
> — `../schema-drift-2026-09/01-immediate-fixes.md:5-18`

**Do not do this.** The live pricing page on 2026-09-12 — eleven days after the
increase was supposed to take effect — still publishes Claude Sonnet 5 at **$2 /
MTok input, $10 / MTok output**, with the cache derivatives the table already
carries. The fetched pricing cache (`fetchedAt: 2026-08-31`) agrees.

Implementing C5 as written would introduce a **50% over-report on every Claude
Sonnet 5 request** — replacing a correct row with an incorrect one, in the name
of fixing it.

The prior document did flag the possibility ("the changelog research reported
that the planned Sep-1 increase may have been cancelled … re-verify against the
live pricing page … before committing"), and this is that verification. Its
conclusion — "the row lands at $3/$15 either way" — is the part that is wrong.

What survives from C5, and should still ship:

- The **stale comment** above the row, which instructs a future reader to make
  exactly this wrong edit. Delete it.
- `PRICING_VERIFIED_DATE` → `2026-09-12`.
- The `effectiveUntil` mechanism the implementation set designed
  (`03-cost-verification.md:519-536`). It remains the right idea; this episode
  is the argument for it. A row that had carried `effectiveUntil: "2026-08-31"`
  would have raised a finding that prompted a re-fetch — which is what should
  drive the edit, rather than a code comment predicting a price.

**Lesson worth recording**: the comment encoded a *prediction* about a future
price as though it were a fact. Predictions belong in a field a checker can act
on, never in prose that reads as an instruction.

## 2.3 The structural fix

Adding two rows fixes today's instance and leaves the class intact. The class is:

> A point-release model id is a string prefix of its predecessor's id, so
> longest-prefix matching resolves a new model to an old rate row with
> `known: true`.

`claude-fable-5-1` → `claude-fable-5`. `claude-opus-4-7` → `claude-opus-4`. Next
it will be `claude-opus-5-1` → `claude-opus-5`, and nobody will notice until a
rate differs — as it does for Fable 5.1, in exactly the cell that matters most.

Prefix matching cannot simply be removed: it is load-bearing for **dated
snapshot ids** (`claude-haiku-4-5-20251001`), which must inherit their base
row's rates.

So the two cases must be told apart by the shape of the remainder after the
matched key:

| Remainder | Meaning | Action |
|---|---|---|
| empty | exact match | the row |
| `-` + 8 digits (`-20251001`) | dated snapshot of the same model | inherit the row — current behaviour, correct |
| `[` + digits + `m`/`k` + `]` (`[1m]`) | context-window tier | **inherit the row** — verified correct in §2.5; do **not** refuse |
| `-` + 1–2 digits (`-1`, `-11`) | **point-release successor** | refuse: `known: false`, raise a drift finding |
| anything else | unknown shape | refuse: `known: false`, raise a drift finding |

The `[1m]` row is not optional. An earlier draft of this table omitted it and
fell through to "anything else → refuse", which would have turned every
1M-context request into `cost: 0` — contradicting §2.5, where the same document
confirms twice that `claude-opus-5[1m]` is *correct* to inherit base rates. The
cleaner implementation strips the bracketed suffix in `normalizeModelId` into a
`contextTier` field before matching, which is where the prior set placed it
(`03-cost-verification.md:540-553`).

**The rule must also apply to the override table.** Configured partner rates go
through a *second* longest-prefix matcher, `lookupIn` (`pricing.ts:286-292`),
which has the identical defect: a user override for `claude-fable-5` would
silently capture `claude-fable-5-1`. Both matchers get the shape rule.

Refusing yields the `{cost: 0, known: false}` path the module was designed
around — a visibly missing number instead of a confidently wrong one — and the
drift finding names the model so the row gets added deliberately.

This slots into the prior set's existing machinery rather than adding new
machinery: a `PricingDriftFinding` kind alongside `"missing-cost-term"` and
`"tier-suffix-unmodelled"` (`03-cost-verification.md:540-574`), surfaced by
`verify`.

Property to assert: **for any model id, either the resolved key equals the
canonical id, or the remainder matches the dated-snapshot or context-tier
shape.** Stated without the context-tier arm it is *wrong* and would drive an
implementer to break `[1m]` in order to make the test green.

The property fails today on `claude-fable-5-1` and has failed on
`claude-opus-4-7` since the day it shipped.

## 2.4 Fast mode: price the rate, build nothing else

The implementation set examined `usage.speed` and concluded, correctly, that
there is nothing to build: `"standard"` on 281,942 of 282,073 observations,
**zero** `"fast"` across 1.9 GB and four months
(`05-request-dimensions.md:55-66`), and it explicitly rules out fast-mode
analytics and limit-impact modelling (`:481-511`).

Re-measured here on current data: 489,970 occurrences, **all `"standard"`**.
Still zero. That finding holds and this document does not reopen it.

One narrow thing has changed, though, and it is a pricing fact rather than an
analytic: the rate is now **published**.

> Fast mode … provides significantly faster output for Claude Opus 5 and Claude
> Opus 4.8 at premium pricing. Fast mode pricing applies across the full context
> window. Model: Claude Opus 5 / Claude Opus 4.8 — **$10 / MTok input, $50 /
> MTok output** — **[docs]**

That is a **2× multiplier** on both classes, on the two models that carry almost
all of this corpus's traffic, reachable by any user typing `/fast`. Today
`estimateCost` has no `speed` parameter, so a fast-mode response would be priced
at standard rates — silently, with `known: true`. Same failure mode as §2.3.

The proportionate response is **the column and nothing else**, for two reasons
that only emerged in review:

1. **Only two of the five rates are published.** The quote gives input and
   output. `estimateCost` needs five, and cache reads are 99.6% of input volume
   — the rate that would decide a fast-mode bill is precisely the one not
   published. A row built from two known rates and three guesses is the failure
   mode this chapter exists to prevent.
2. **No caller could pass it.** All 19 non-test `estimateCost` call sites use
   positional arguments and none has a `speed` in scope; the reads that price
   cost aggregate *per model*, with no `speed` in the `GROUP BY`. A `speed`
   parameter would be unreachable — the appearance of a guard without the guard.

So: **capture `messages.speed`; add no rate row, no parameter, no analytic.**
Record the two published rates here, and revisit when a `"fast"` observation
exists and the cache rates are published. Until then the honest statement for
the changelog is that fast mode is *captured but not priced*.

## 2.5 Verified by execution, not by reading

Every claim above about what the resolver *does* was checked by calling it
(`node -e` against `packages/core/dist/pricing.js`, 2026-09-12) rather than by
reading the matching rule:

| Model id | Resolved input | Resolved output | Resolved cache hits | Correct? |
|---|---:|---:|---:|---|
| `claude-fable-5-1` | 10 | 50 | **1.00** | ✗ — should be 0.25 (**4×**) |
| `claude-mythos-5-1` | 10 | 50 | **1.00** | ✗ — should be 0.25 (**4×**) |
| `claude-opus-4-7` | **15** | **75** | **1.50** | ✗ — should be 5 / 25 / 0.50 (**3×**) |
| `claude-opus-5-1` *(does not exist yet)* | 5 | 25 | 0.50 | ✗ in principle — inherits silently |
| `claude-sonnet-5-1` *(does not exist yet)* | 2 | 10 | 0.20 | ✗ in principle — inherits silently |
| `claude-haiku-4-5-20251001` | 1 | 5 | 0.10 | ✓ — dated snapshot, correct to inherit |
| `claude-opus-5` | 5 | 25 | 0.50 | ✓ |
| `claude-opus-5[1m]` | 5 | 25 | 0.50 | ✓ — corroborates the prior set's reversal |

Two rows deserve comment.

**`claude-opus-4-7` is a live 3× over-charge**, not a hypothetical. It has been
wrong since Opus 4.7 shipped and is invisible only because this corpus holds no
Opus 4.7 traffic. Anyone whose history does hold some is being billed three
times over for it by this tool.

**`claude-opus-5[1m]` resolves to base rates**, which the implementation set
established is *correct* by repricing against Claude Code's own `cost-state`
ground truth (`03-cost-verification.md:139-168`), reversing the parent
document's instruction to add premium rows. The live pricing page independently
confirms it: 4.6-and-later models include the full 1M window at standard
pricing. Two different methods, same answer — this is corroboration of their
finding, not a new one, and the "do not add premium rows" instruction stands.
