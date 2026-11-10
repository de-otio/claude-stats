# 02 — The Rate Table Against Live Pricing

Every rate in this chapter is **[docs]**, read from the published pricing page.
None is recalled: a rate recalled from memory, or predicted in a code comment,
is exactly how a table drifts from the page it claims to mirror.

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
| Claude Sonnet 5 | 2 / 2.50 / 4 / 0.20 / 10 | identical | correct |
| Claude Sonnet 4.6 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct |
| Claude Sonnet 4.5 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct |
| Claude Sonnet 4 | 3 / 3.75 / 6 / 0.30 / 15 | identical | correct (retired) |
| Claude Haiku 4.5 | 1 / 1.25 / 2 / 0.10 / 5 | identical | correct |

`claude-opus-4-7` is absent and resolves by prefix to `claude-opus-4` — the
retired $15/$75 row, a **3× over-charge** — the largest rate error in the
table, because the retired row is three times the current one on every class.

### Not defects

- **Long context.** "Claude 4.6 and later models include the full 1M token
  context window at standard pricing." There is no premium tier to model for any
  current model. The table is right to have no `[1m]` rows.
- **Regional endpoints.** Bedrock regional and Google Cloud multi-region/regional
  endpoints carry a 10% premium over global; first-party is global by default.
  `messages.inference_geo` is captured but no multiplier is applied. Correct for
  first-party traffic, latent for partner-platform users. Out of scope here.

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
| `[` + digits + `m`/`k` + `]` (`[1m]`) | context-window tier | **inherit the row** — verified correct in §2.4; do **not** refuse |
| `-` + 1–2 digits (`-1`, `-11`) | **point-release successor** | refuse: `known: false`, raise a drift finding |
| anything else | unknown shape | refuse: `known: false`, raise a drift finding |

The `[1m]` row is not optional. An earlier draft of this table omitted it and
fell through to "anything else → refuse", which would have turned every
1M-context request into `cost: 0` — contradicting §2.4, where
`claude-opus-5[1m]` is shown to be *correct* to inherit base rates. The cleaner
implementation strips the bracketed suffix in `normalizeModelId` into a
`contextTier` field before matching.

**The rule must also apply to the override table.** Configured partner rates go
through a *second* longest-prefix matcher, `lookupIn` (`pricing.ts:286-292`),
which has the identical defect: a user override for `claude-fable-5` would
silently capture `claude-fable-5-1`. Both matchers get the shape rule.

Refusing yields the `{cost: 0, known: false}` path the module was designed
around — a visibly missing number instead of a confidently wrong one — and the
drift finding names the model so the row gets added deliberately.

This slots into the existing drift machinery rather than adding new
machinery: a `PricingDriftFinding` kind alongside `"missing-cost-term"` and
`"tier-suffix-unmodelled"`, surfaced by `verify`.

Property to assert: **for any model id, either the resolved key equals the
canonical id, or the remainder matches the dated-snapshot or context-tier
shape.** Stated without the context-tier arm it is *wrong* and would drive an
implementer to break `[1m]` in order to make the test green.

The property fails for any point-release id that plain longest-prefix matching
resolves to its predecessor's row (`claude-fable-5-1`, `claude-opus-4-7`).

## 2.4 Verified by execution, not by reading

Every claim above about what the resolver *does* was checked by calling it
(`node -e` against `packages/core/dist/pricing.js`) rather than by reading the
matching rule:

| Model id | Resolved input | Resolved output | Resolved cache hits | Correct? |
|---|---:|---:|---:|---|
| `claude-fable-5-1` | 10 | 50 | **1.00** | ✗ — should be 0.25 (**4×**) |
| `claude-mythos-5-1` | 10 | 50 | **1.00** | ✗ — should be 0.25 (**4×**) |
| `claude-opus-4-7` | **15** | **75** | **1.50** | ✗ — should be 5 / 25 / 0.50 (**3×**) |
| `claude-opus-5-1` *(does not exist yet)* | 5 | 25 | 0.50 | ✗ in principle — inherits silently |
| `claude-sonnet-5-1` *(does not exist yet)* | 2 | 10 | 0.20 | ✗ in principle — inherits silently |
| `claude-haiku-4-5-20251001` | 1 | 5 | 0.10 | ✓ — dated snapshot, correct to inherit |
| `claude-opus-5` | 5 | 25 | 0.50 | ✓ |
| `claude-opus-5[1m]` | 5 | 25 | 0.50 | ✓ — 1M window carries no premium |

Two rows deserve comment.

**`claude-opus-4-7` is a live 3× over-charge**, not a hypothetical: it has been
wrong since Opus 4.7 shipped, and is invisible only to a user whose history
holds no Opus 4.7 traffic. Anyone whose history does hold some is being billed
three times over for it.

**`claude-opus-5[1m]` resolves to base rates**, which is *correct*: repricing
against Claude Code's own `cost-state` ground truth shows the 1M window carries
no premium, and the live pricing page independently confirms it — 4.6-and-later
models include the full 1M window at standard pricing. Two different methods,
same answer, so no premium rows are added.
