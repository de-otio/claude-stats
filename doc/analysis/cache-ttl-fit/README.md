# Cache TTL fit — the ratio and the arithmetic

Design record for `computeTtlFit` (`packages/core/src/ttlFit.ts`), the
`get_cache_ttl_fit` MCP tool, and `claude-stats ttl-fit`. This is a durable
record of the *reasoning*, kept deliberately free of any measurement from a
real store — no session counts, no message counts, no dated window, no
per-model token volumes, no dollar totals. Every number below is
illustrative and synthetic. See [commands.md](../../user-doc/commands.md#ttl-fit)
and [faq.md](../../user-doc/faq.md#why-did-my-cost-figures-go-up) for the
user-facing side of this.

## Why the question exists

Anthropic's prompt cache offers two ephemeral TTLs for a cache write: **5
minutes** and **1 hour**. The 1-hour TTL costs more to write (a published
premium over the 5-minute rate) in exchange for surviving a longer idle gap
before the cache expires and has to be rebuilt from scratch. Which one is
cheaper depends entirely on a workload's own shape — how often it goes idle
for 5–60 minutes, and how much it writes when it does — so there is no
universal answer, only a per-workload one. That is what this tool computes.

On the shipped default rate table, the write-premium structure is uniform
across models: reading from cache costs roughly a tenth of the input rate,
writing at the 5-minute TTL costs about 1.25× the input rate, and writing at
the 1-hour TTL costs about 2× the input rate. Those two multipliers —
**1.25× and 2×** — are what the rest of this document reduces to arithmetic
on, but they are never assumed; see "Derived, not hardcoded" below.

## The derivation

Let, for one model, per million tokens:

- `read` — the cache-read rate
- `write5m` — the cache-write rate at the 5-minute TTL
- `write1h` — the cache-write rate at the 1-hour TTL

For a window of activity, let:

- `R` — cache-read tokens recovered **by** the 1-hour TTL: reads on requests
  whose preceding same-session idle gap falls between the two TTL thresholds
  (5–60 minutes by default), and which were actually recorded at the 1-hour
  TTL. A gap in that band under a 5-minute TTL had already expired, so its
  reads were never "recovered" by anything — that request rebuilt regardless
  of which TTL was configured.
- `W1h` — cache-creation tokens actually **written** at the 1-hour TTL (as
  opposed to `W`, total cache-creation volume across both TTLs — see below).

Switching this window from the 1-hour TTL to the 5-minute one would:

- **cost extra**, because the `R` reads that the 1-hour TTL kept warm would
  instead have expired and been rewritten: `extra = R × (write5m − read)`
- **save**, because the tokens written at the 1-hour TTL would instead have
  paid the cheaper 5-minute rate: `saved = W1h × (write1h − write5m)`

```
net = extra − saved
```

A negative `net` means the 5-minute TTL would have been cheaper over this
window; positive means the 1-hour TTL is worth its premium. The **break-even
ratio** — the `R`/`W1h` ratio above which the 1-hour TTL pays for itself — is

```
break-even = (write1h − write5m) / (write5m − read)
```

On the shipped table's uniform structure (read ≈ 0.1×, write5m ≈ 1.25×,
write1h ≈ 2× the input rate) this reduces to `(2 − 1.25) / (1.25 − 0.1)`
≈ **0.65** — a workload needs roughly two recovered reads for every three
tokens written at the 1-hour TTL before that TTL is worth it.

## Why `W1h`, not total `W`

An earlier draft of this arithmetic used total cache-creation volume `W` in
the `saved` term instead of `W1h`. That is wrong, and wrong in the specific
direction that biases every *mixed* window (one that writes at both TTLs)
toward "prefer 5-minute": the 1-hour premium is only ever **paid** on tokens
that were actually written at the 1-hour TTL. Using `W` instead of `W1h`
credits the 5-minute TTL with "saving" a premium that was never charged on
the `W − W1h` tokens that were written at 5 minutes anyway. On a window
recorded entirely at one TTL, `W1h == W` and the two formulations agree — the
error only bites on a mixed window, which is exactly the case worth getting
right, since a workload that is *already* all one TTL has no decision left to
make.

## Why the multipliers are derived, not hardcoded

The 1.25× / 2× (and their 0.65 break-even) are real numbers on the shipped
default rate table, but `computeTtlFit` never assumes them — it resolves
`read`, `write5m`, and `write1h` from whatever pricing table is in effect
(the shipped table, a partner-platform override, or a user-configured rate)
and derives `break-even` from those three resolved numbers every time. A
hardcoded constant would silently go wrong the moment a rate table changes —
a Bedrock/Vertex override, a re-fetched published-rate snapshot, or a
user-supplied `rateOverrides` block with different ratios — and there would
be no signal that it had. A model whose 1-hour rate cannot be trusted (never
reported by the source, or incoherent against its own other rates — e.g. a
1-hour rate cheaper than the 5-minute one) is excluded from the priced half
of the result entirely rather than guessed at with a fallback multiplier: its
token volume still counts, but no signed dollar figure is produced for it.

## Stated limitations

These are carried into the tool's own output, not only recorded here:

1. **Idle gaps are a proxy for cache expiry, not an observation of it.** The
   tool infers "this cache probably expired" from the size of the gap since
   the previous message in the same session; it does not — cannot — observe
   the cache server's own expiry directly. The near-100% rebuild rate the
   data shows on gaps past the long threshold is what makes the proxy
   credible, but it remains a proxy.
2. **The second-order effect is not modelled.** Under a 5-minute TTL, the
   reads this tool counts as "recovered" by the 1-hour TTL would themselves
   trigger a rebuild, and that rebuilt cache would itself be read again
   later. Modelling that fully requires a simulation of the whole session
   under the counterfactual TTL, not an arithmetic identity over the
   observed one. Left unmodelled and stated as such, rather than silently
   assumed away.
3. **Subagent traffic is recorded at the 5-minute TTL regardless of the
   parent session's setting.** Where that traffic isn't separable from the
   main session's in the stored data, `R` is overstated for a workload with
   heavy subagent use — real recovered reads get attributed to a TTL
   decision the subagent traffic didn't actually make.
4. **A verdict computed from a window recorded at the other TTL is a
   projection, not a measurement.** If a window was actually recorded at the
   1-hour TTL and the fit recommends the 5-minute one (or vice versa), that
   recommendation is a counterfactual derived from this window's own
   gap/write shape — not an observation of what the other setting would
   actually have produced, because of limitation 2 above. Every surface that
   renders a verdict (the CLI, the MCP tool, the dashboard) labels this case
   explicitly rather than presenting it with the confidence of a same-TTL
   result.

## Illustrative example (synthetic)

Not a measurement — round numbers chosen only to show the arithmetic:

```
read = $1/MTok, write5m = $1.25/MTok, write1h = $2/MTok
R = 40 MTok recovered reads, W1h = 50 MTok written at the 1-hour TTL

extra = 40 × (1.25 − 1)      = $10
saved = 50 × (2 − 1.25)      = $37.50
net   = 10 − 37.50           = −$27.50   → the 5-minute TTL would have been
                                           cheaper by about $27.50 here

break-even = (2 − 1.25) / (1.25 − 1) = 3.0
  → this workload would need R/W1h ≈ 3.0 to make the 1-hour TTL worth it;
    its actual ratio (40/50 = 0.8) falls well short, hence the verdict above.
```
