# Context carry cost — the arithmetic and the honesty rules

Design record for `computeContextCarry` (`packages/core/src/contextCarry.ts`),
the `get_context_carry` MCP tool, and `claude-stats context`. Same convention
as [`doc/analysis/cache-ttl-fit/README.md`](../cache-ttl-fit/README.md): this
is a durable record of the *reasoning*, kept free of any measurement from a
real store — no session/message counts, no dated window, no per-model token
volumes, no dollar totals from a real workload. Every number below is
illustrative and synthetic. See
[commands.md](../../user-doc/commands.md#context) and
[faq.md](../../user-doc/faq.md#why-does-context-bloat-report-something-different-now)
for the user-facing side of this.

## Why the question exists

Every request Claude Code sends carries the whole conversation so far —
input tokens, cache-read tokens, and cache-creation tokens together are what
this tool calls "carried context." A long-running session's context grows
turn over turn until something resets it (a compaction, a `/clear`, a fresh
session). Two questions follow from that shape: how much of the bill is
carried context rather than genuinely new content, and where does that
volume concentrate — which sessions, which turns, which point in a
compaction cycle? `get_context_carry` / `claude-stats context` answer both,
from data the store already holds; no new collection.

## What is estimated, and what is a bound — and why neither word covers everything here

Two figures are easy to reach for and both are wrong to call a "bound":

- **`distinctTokensEstimate`** (the model's best guess at how much of the
  carried volume was genuinely new content, as opposed to context repeated
  from an earlier turn) is biased **in both directions at once**:
  - biased **down** — a turn that drops content and adds content in the same
    step nets to one signed increment. The dropped-and-replaced content is
    never counted twice, so real distinct content is understated.
  - biased **up** — a post-reset baseline (the first request after a
    compaction) is counted as entirely new, because the tool cannot tell a
    compaction summary from a restatement of what was dropped; and content
    that is dropped and later re-read in the same session is counted as
    distinct again the second time it enters.

  Because both biases are live simultaneously, the field is named
  `distinctTokensEstimate` — not `...LowerBound` or `...UpperBound`. Either
  bound name would be a claim the arithmetic cannot support, and a false
  bound is worse than no bound: it would be quoted as a hard limit precisely
  where it is least deserved. Every surface that renders this figure states
  both biases on the same line, never in a footnote.

- **`amplificationEstimate`** (`carriedTokens / distinctTokensEstimate`)
  inherits the same both-directions bias from its denominator, for the same
  reason. It is never printed as a bare ratio, and never described as "every
  distinct token was re-sent N times" — see the next section for why that
  particular sentence is wrong regardless of the bias question.

## The ratio is an aggregate, not a per-token lifetime

`amplificationEstimate` is `mean carried context per request ÷ mean new
content per request` — an aggregate over the whole window. It is tempting to
restate a number like that as "every distinct token was re-sent N times,"
but that reads a **per-token lifetime** claim into a ratio that cannot
support one: a token's actual lifetime is bounded by how many requests occur
before the next reset, which is a different (and much smaller) number than
the aggregate ratio. The honest restatement, and the only one any surface
here uses, is: *"the average request carried some number of tokens of
context to produce a much smaller number of new tokens."* Same ratio, same
data — a claim the arithmetic actually supports instead of one it only
resembles.

## The headline framing that was rejected, and why

An earlier framing considered for this feature was a single percentage:
*"X% of the bill is re-reading context that was already there."* That
framing is rejected, deliberately, because it attacks the wrong target. A
cache read is priced at roughly a **tenth** of a fresh input token — it is
the **cheapest** form this cost can take, not a wasteful one. The
counterfactual to a cache read is not zero spend; it is a fresh input token
at roughly **10×** the cache-read rate, or a cache write at roughly
**12.5–20×**, depending on TTL. A percentage that implies "this much is
wasted" is actually pointing at evidence the cache is doing its job.

So every surface that reports a share of spend attributable to carried
context carries the counterfactual on the **same line**: the lever available
here is carrying *less* context forward, not caching *less* of what is
carried — and what carrying less would cost in rework (re-deriving context
that was dropped, re-explaining decisions, restarting an investigation) is
explicitly **not measured** by this tool. A number with no counterfactual and
no rework caveat attached is not shipped anywhere in this feature.

## `carryCost` and every `aboveCap[].cost` are lower bounds, and why

Every carried token, wherever it is priced in this tool, is priced at the
cache-**read** rate — again, the cheapest form the cost can take. But a
carried token does not stay a cache read forever: at every cache-expiry
boundary within its cycle, it gets re-**written** at somewhere between
1.25× and 2× the input rate, depending on TTL. Pricing at the read rate
throughout therefore understates the true carried cost by a substantial
margin — on the order of half, in the internal measurement that motivated
this feature (not reproduced here per the no-real-figures rule above). Every
dollar figure this tool produces is labelled a lower bound on the same line
it renders, for this exact reason.

The increment that immediately precedes a reset is a special case worth
naming: priced by the general rule alone, it would come out at close to zero
carry cost (it is carried for only the one request before the reset drops
it). That is fine for an ordinary reset, but wrong for **auto-compaction**,
where that large addition is *what forced* the reset. The formula corrects
for this by adding the reset's own request cost onto that increment's
carry-cost figure — so the turn that triggered a compaction is not reported
as having cost nothing. Findings are never ranked by `carryCost` alone for
this reason: a cheap-looking turn right before a reset can be the most
consequential one in the window.

## Reset cycles and the sawtooth

Context grows turn over turn within a session until a reset (a compaction,
in the data this tool can see) drops it back down — a repeating
grow-then-drop shape this tool calls the **sawtooth**: a floor (post-reset
size), a peak (pre-reset size), and a mean cycle length in requests. That
shape is only meaningful across several repetitions; on fewer than three
resets in a window, the sawtooth renders as **not enough data**, never as an
average of one or two events dressed up as a shape.

A cycle with no following reset — the session simply ends, or the window
closes, before the next drop — is marked **open**, and its carry cost is a
lower bound on what it would eventually cost: a paused session, not a
finished one, keeps charging if it resumes.

## The `context-bloat` detector: rewritten from a level rule to an increment rule

Before this feature, `context-bloat` fired whenever a turn's *total* carried
context was large. That rule was measuring the wrong thing: a session can
legitimately run with a large context the entire time without ever adding a
large chunk in one step, and a rule keyed on level flags exactly that
session, over and over, on every turn — which made it the dominant
contributor to the hygiene ratio on a real workload, out of proportion to
how actionable any one finding was.

The detector keeps its id (`context-bloat`, so existing suppressions still
apply) but now fires on the **increment** — how much a turn *adds* to
context in one step — filtered to only the turns where that addition
represents real growth:

- an increment that spans a reset (a compaction drop) is never growth and
  never flags, regardless of size;
- a session's first request is a baseline, not growth;
- a post-reset baseline is a fresh floor, not growth.

(These three exclusions are exactly `hygiene/util.ts#contextIncrements`'
`"growth"` / `"session-start"` / `"post-reset"` / `"shrink"` kinds, filtered
to `"growth"` only — the same helper `computeContextCarry` uses for
`distinctTokensEstimate`, so the detector and the report never disagree
about what counts as growth.) The 3-occurrence precision guard is unchanged:
one large addition is often legitimate context-building; a repeated pattern
of them is what the detector exists to catch.

`estimatedWaste` is also repriced onto the carry-cost basis this feature
introduces, rather than the flagged turn's own full cost — most of a
flagged turn's cost was history it did not add, so pricing the whole turn
overstated the waste attributable to the pattern the detector is naming.

**Measured effect, in ratio form** (exact counts withheld per this
document's no-real-figures convention — see
[assumptions.md](../../../plans/context-carry-cost/assumptions.md) entry
14 for how this was verified): on the workload used to validate this
rewrite, the old level rule fired on roughly **half** of all sessions; the
new increment rule fires on roughly **one in sixteen**. The detector still
finds the same shape of thing — a real, repeated, addressable pattern of
large single-step growth — just far more selectively, because "the context
is large" stopped being conflated with "this turn made it large." Because
`estimatedWaste` is one of the terms in `hygieneRatio`, and this term
shrinks sharply, the ratio itself steps down with no other change to actual
spend — a reader comparing today's ratio to last week's needs to know the
denominator's meaning changed, not just its value. See
[faq.md](../../user-doc/faq.md#why-does-context-bloat-report-something-different-now).

## What the MCP tool omits, and why

`get_context_carry`'s payload is narrower than the full `ContextCarryResult`
the CLI and local dashboard can render:

| Field | Omitted from MCP | Why |
|---|---|---|
| `concentration` | entirely | ranks sessions by carried volume, keyed by `sessionId` |
| `preludeByProject` | entirely | per-project session-start baselines, keyed by an absolute project filesystem path |
| `turns` | entirely | per-request attribution, carrying both a `sessionId` and a message `uuid` — the most identifying array in the result |
| `resets[].sessionId`, `cycles[].sessionId` | field only (rows kept) | same identifier class as `concentration`, on rows whose other fields — token levels, cycle length, reset cost — are useful without it |

The rule mirrors `get_cache_ttl_fit`'s existing convention: a session id (or
an absolute project path) leaving the machine over MCP is a different
exposure than the same value rendered in a local CLI run or a dashboard file
the user controls. The CLI (`claude-stats context`) and the local dashboard
render the full result, `concentration` included; only the MCP boundary is
narrowed.

The local dashboard's own embedded payload (the whole-page HTML report,
which a user may forward to someone else) narrows further still, in one
respect the MCP tool does not need to: it re-keys `preludeByProject`'s
`projectPath` to a **shortened project label** (its last two path segments)
before the value ever reaches the rendered page, rather than shipping the
absolute path into every generated report file.

## No new config key, env var, migration, or store query

This feature adds none of the four. Verified directly against the code, not
assumed:

- **No config key.** `Config["hygiene"]` (`packages/cli/src/config.ts`) is
  `{ suppressions?: string[] }`, and `validateHygieneConfig` reads only
  `suppressions`. The `context-bloat` detector's thresholds
  (`minIncrementTokens`, `minOccurrences`) are a programmatic parameter to
  the detector, never a user-facing config surface — there was nothing to
  add a key for and nothing to migrate.
- **No env var.** `computeContextCarry` and `computeContextCarryForWindow`
  take options as ordinary function parameters (rate overrides, caps, band
  edges, reset thresholds) — no new environment variable governs any of
  them.
- **No migration.** The one column this feature reads that a prior feature
  didn't, `messages.tools`, already exists in the schema (added for an
  earlier detector); `getMessagesForHygiene`'s SELECT and the row mappers
  were extended to read it, which is a query change, not a schema change.
  `packages/cli/src/store/index.ts`'s migration list has no entry for this
  feature.
- **No new store query shape.** `computeContextCarryForWindow` mirrors the
  existing `computeTtlFitForWindow` glue exactly — same filter shape, same
  underlying `getMessagesForHygiene` read, no new table and no new SQL
  beyond the one column addition above.

## Illustrative example (synthetic)

Not a measurement — round numbers chosen only to show the shape of the
arithmetic:

```
A session runs 20 requests before a reset (a compaction), then 15 more.

Cycle 1 (20 requests, closed by a reset):
  request 1 adds 40K tokens of context (the session's own baseline)
  requests 2-19 each add a small amount, ~1K tokens apiece
  request 20 adds a further 60K in one step, then the reset fires

  carryCost for request 20's 60K increment includes the reset's own
  request cost too (review A-4's correction) — pricing it near zero would
  make the very turn that forced the compaction look free.

Cycle 2 (15 requests, open — the window ends before the next reset):
  starts fresh at the post-reset baseline (~25K), grows normally
  marked `open: true` — its carry cost is a lower bound, not a total,
  because a paused session would keep charging if it resumed.

distinctTokensEstimate sums: cycle 1's baseline (40K) + the small per-turn
  growth + the 60K spike, plus cycle 2's post-reset baseline (25K) — every
  `"growth"`/`"session-start"`/`"post-reset"` increment, never `"shrink"`.

amplificationEstimate = carriedTokens / distinctTokensEstimate — reported
  as "the average request carried N tokens of context to produce M of new
  content," never as "every token was re-sent N times."
```
