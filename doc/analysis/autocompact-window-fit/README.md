# Auto-compact window fit — why it simulates, and why it isn't an argmax

Design record for `computeAutoCompactFit` (`packages/core/src/autoCompactFit.ts`),
the `autoCompactWindow` block inside the `get_context_carry` MCP tool, and the
matching block on `claude-stats context`. Same convention as
[`doc/analysis/cache-ttl-fit/README.md`](../cache-ttl-fit/README.md) and
[`doc/analysis/context-carry-cost/README.md`](../context-carry-cost/README.md):
a durable record of the *reasoning*, kept free of any measurement from a real
store — no session counts, no dated window, no per-model token volumes, no
dollar totals from a real workload. Every number below is illustrative and
synthetic. See [commands.md](../../user-doc/commands.md#context),
[output-guide.md](../../user-doc/output-guide.md), and
[faq.md](../../user-doc/faq.md) for the user-facing side of this.

## Why the question exists

`claude-stats context` (see
[context-carry-cost](../context-carry-cost/README.md)) already reports the
**sawtooth** a session's context traces out under auto-compaction: it grows
turn over turn, then a compaction drops it back to a floor and the cycle
repeats. `autoCompactWindow` is the setting that decides how high that sawtooth
is allowed to climb before a compaction fires. Once the tool can already see
the shape, the natural next question is whether a different window would have
served this workload better — and if so, roughly what to set it to. This
feature answers that from the same data the carry report already reads; no
new collection.

## Capping wraps the sawtooth — it does not clip it

The tempting shortcut is to read the answer straight off data the tool already
has: `context`'s "tokens carried above each cap" table shows exactly how much
volume sits above a given ceiling, so summing that column for a candidate
window looks like the saving that window would produce.

It is not. A smaller `autoCompactWindow` does not truncate a session's context
and let it continue growing past the old cap — it triggers a compaction
*earlier*, dropping the context back to the floor and starting a new cycle.
The same underlying work still happens; it is now spread across **more,
shorter cycles**, each of which pays its own reset cost. Reading "tokens above
the cap" as the saving both **overstates** the saving (the same tokens that
would have been carried past the old cap don't simply vanish — most of that
volume still gets carried, just earlier in a new cycle) and **ignores the
cost side entirely** (a smaller window means more resets, and every reset has
a real cost: the compaction request itself, plus whatever the model has to
re-derive from a shorter summary).

That is why `computeAutoCompactFit` **simulates** each candidate window
instead: it replays each closed cycle's turn-by-turn context increments
against the candidate, cutting back to the observed floor whenever the
running total would exceed it, and only then measures what volume was
actually carried and how many extra resets that cost. The candidate grid's
own JSDoc puts it plainly: "capping does not clip the sawtooth, it wraps it."

## Why the recommendation is not an argmax

Carrying context is priced at the cache-read rate; resetting costs a
compaction request. On essentially every real workload, those two costs are
not close — carrying costs thousands of tokens' worth of cache reads over a
cycle, resetting costs a single request's worth of cents. An optimiser that
simply picks the candidate with the largest `netSaving` will therefore always
land on the smallest settable window (100K tokens): arithmetically correct,
and useless in practice, because it also means the shortest cycles, the most
frequent compactions, and the least working context available at any one
time.

So `recommendedTokens` is deliberately **not** the argmax. The result reports
a **range** — `[conservative, aggressive]`, in that descending order — and
`recommendedTokens` is always the **conservative** end: the largest candidate
window that still captures at least half of the aggressive end's `netSaving`.
Diminishing returns are steep enough in practice that this is usually one or
two steps up the candidate grid from the aggressive end, giving away little
saving for a meaningfully longer cycle length. The **decision variable** every
surface hands the reader alongside the dollar figures is each candidate's
resulting **median cycle length in requests** — not the saving alone — because
that is the number that actually describes what living with that window would
feel like.

## The adaptive floor, and the convergence problem it solves

The standard reset detector only counts a compaction as a "reset" when the
context it dropped from exceeded a floor (150,000 tokens by default) — below
that, a drop reads as noise rather than a real cycle boundary. That default
floor is fine for the *primary* carry report, which describes the workload as
it actually ran. It is a trap for this feature specifically: if the fit
recommends a smaller window and a developer follows the advice, their next
run's contexts may never climb back above 150K — and the detector then finds
**zero** qualifying resets, the sawtooth collapses to "not enough data," and
the tool that just gave good advice reports it cannot see anything anymore.
The tool's own recommendation, followed, would make the tool blind to the
outcome.

The fix is a **second, adaptive-floor pass**: alongside the primary
`computeContextCarry` result (unchanged, and still what every other surface —
`context-bloat`, the hygiene ratio, the caps table, the dashboard's compaction
timeline — renders), the CLI/MCP glue runs a **second** pass over the same
already-fetched rows with the reset floor lowered to
`min(150,000, 0.5 × p95(observed context sizes))`, clamped to a small minimum
so it can never reach zero. That second result feeds the fit only; it is
discarded once the fit is computed, so it costs one extra in-memory pass and
no extra store query. This is what makes the fit still work on the smaller
windows it might itself recommend, instead of converging to "insufficient
data" the moment its own advice succeeds.

The cost of that fix is a disclosure obligation, not a free lunch: the fit's
reset count is now computed at a **different floor** than the primary block
the same screen shows just above it, and the two numbers will not match on any
window whose contexts sit under the default floor. Every surface that renders
both states this — `claude-stats context`'s text output prints an explicit
divergence note naming both floor values whenever they differ; `--json` and
the MCP payload carry both `resetFloorUsed` and `resetFloorDefault` for a
reader (or an agent) to reconcile programmatically. See
`plans/autocompact-window-fit/divergence.md` for the full surface-by-surface
enumeration — the same treatment `plans/cache-ttl-fit/fallback-sites.md` gave
the TTL build's own cost-basis split.

## Honest bounds, in both directions

Every dollar figure this feature produces sits between two biases that pull
in **opposite** directions, and both are stated on the same line as any
dollar figure, never one alone:

- **The saving is an upper bound.** It assumes the same work gets done with
  less context in front of the model — the identical-work assumption. What
  carrying less context actually costs in rework (re-deriving something that
  got dropped, re-explaining a decision, restarting an investigation) is not
  measured anywhere in this tool. A workload where less context genuinely
  costs more time than it saves in tokens would not show up as worse here.
- **The token arithmetic underneath it is a lower bound.** The simulation
  restarts every cut from the *observed* post-reset floor — an actual
  compaction of a shorter conversation would plausibly land lower still, so
  using the observed floor understates how much a smaller window would
  actually save.
- **The margin that gates the verdict is biased toward recommending.** The
  `too-close-to-call` threshold is 5% of `totalCarryCost` — and
  `totalCarryCost` is *itself* a lower bound (every carried token priced at
  the cache-read rate, the cheapest form that cost can take). A margin
  measured against an already-understated denominator is easier to clear than
  one measured against the window's true cost, so the threshold leans toward
  telling the reader something is worth changing, not the other way around.

## What the tool cannot see

Two limitations are structural, not fixable by more careful arithmetic, and
no surface may imply otherwise:

- **It cannot see your current `autoCompactWindow` setting.** Claude Code's
  transcripts record the context sizes a session actually reached, not the
  configuration that produced them. This tool has no way to tell whether a
  session's peaks reflect the default window, a value written by an earlier
  `/autocompact`, a launch flag, or a managed-settings default — so no surface
  ever says "you are currently on the default" or anything that implies the
  tool knows the current value.
- **It cannot detect Claude Code's own clamp of the window to the model's
  context window.** Claude Code caps the effective auto-compact window at
  whatever the active model's own context window is (verified against
  <https://code.claude.com/docs/en/context-window>, 2026-08-10) — a 1M
  recommendation on a session running a 200K-context model would be silently
  clamped by Claude Code itself, invisibly to this tool. `core` carries no
  context-window-per-model column today, so a uniform-model window cannot
  trigger a "this candidate would be clamped" warning; a same-vs-different
  model mix (`modelMix.uniform`) is reported for what limited signal it
  offers, and every surface states the limitation directly rather than
  presenting `modelMix` as a substitute for the missing check.

Precedence is also worth recording here, verified against the same URL and
date: environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` overrides the
`--autocompact` launch flag, which overrides managed settings, which
overrides user settings (the value `/autocompact` itself writes) — and the
launch flag is **not** preempted by managed settings. Because of that last
point, no surface describes a recommended or fleet-configured window as
*enforced*; the only honest word for any of these is "default." Settable
range: 100K–1M tokens. `/autocompact auto` — a **revert** to the model-tuned
window, never framed as disabling compaction — is the one alternative this
feature may mention; disabling compaction outright is never presented as an
option.

## No new config key, env var, migration, or store query

This feature adds none of the four. Verified directly against the code, not
assumed:

- **No config key.** `Config["hygiene"]` and `Config["pricing"]`
  (`packages/cli/src/config.ts`) are unchanged by this feature; nothing new
  was added to either, and there is no third top-level config section for it.
- **No env var.** `computeAutoCompactFit` takes an already-computed
  `ContextCarryResult` plus an options bag as ordinary function parameters
  (candidate windows, rate overrides, the adaptive floor to report) — no
  `process.env` read anywhere in the module, deliberately: an
  environment-derived value must not reach a result that crosses MCP.
- **No migration.** `packages/cli/src/store/index.ts`'s schema version and
  migration list are untouched; this feature reads no column the primary
  carry pass didn't already read.
- **No new store query shape.** The adaptive-floor pass is a second
  in-process call to `computeContextCarry` over rows the glue already
  fetched for the primary pass — one extra CPU pass, zero extra SQL.

## Review history: what the plan got wrong before any code was written

The plan behind this feature (`plans/autocompact-window-fit/plan.md`) was
reviewed before implementation started, the same way `cache-ttl-fit` and
`context-carry-cost` were. That review round produced **eleven corrections**
to the original analysis, **six of which were blockers** — errors that would
have shipped a confidently-wrong number rather than merely an imprecise one.
Two are worth naming here because they are the kind of mistake that looks
completely reasonable until it's traced against the actual code, and a future
maintainer touching this module should know they were live risks, not
hypothetical ones:

- **The simulation seated every cycle at twice its floor.** An early version
  of the replay initialised a cycle's simulated context at the observed
  post-reset floor, then added the cycle's first real increment on top — but
  that first increment, in the actual data, already *is* the whole
  post-compaction context, not a small addition to it. Seating a cycle this
  way double-counted the floor on every single cycle, which inflated the
  simulated "carried" volume and could drive the reported saving negative,
  and — worse — made the very first comparison at small candidate windows
  trip immediately, causing the reset count to explode exactly at the
  candidates a reader would care about most. The fix: the simulated context
  starts at zero, the first increment supplies the baseline itself, and the
  floor is only substituted back in *after* a simulated cut.
- **The recommendation ladder's fixed point was "cannot tell," not "already
  tuned."** Because carrying is priced far more heavily than resetting on any
  real workload, the simulated saving is monotone non-increasing as the
  candidate window shrinks — which means a savings-based "already tuned"
  test can never fire: there is always a smaller window that looks like it
  saves more, so the ladder always points further down. Worse, chasing that
  pointer far enough lands below the reset-detector's floor, at which point
  the *primary* detector stops finding any resets at all and the tool would
  report "insufficient data" — the exact state the feature exists to avoid.
  The adaptive-floor pass (above) and switching "already tuned" from a
  savings test to a **peak-proximity** test (is the workload's own observed
  peak already close to a candidate window, rather than "is there no cheaper
  option") are what broke that cycle.

Both were caught before a line of production code shipped, which is the
value of reviewing the plan rather than only the diff — one is a numeric bug
that would have quietly under- or over-stated every dollar figure the tool
ever produced, and the other is a design defect that would have made the
tool's most confident answer ("you're all set") unreachable by construction.

## Illustrative example (synthetic)

Not a measurement — round numbers chosen only to show the shape of the
arithmetic, not real figures from any workload:

```
A workload's sessions observe a post-reset floor around 70K tokens and peaks
(the mean pre-reset size) around 260K, with the window's own carry cost
priced at roughly $2 for this stretch (a stand-in "totalCarryCost").

Candidate grid, filtered to [floor × 1.5, max observed peak):
  150K, 200K survive; 100K is dropped as below-floor; 300K+ is dropped as
  at-or-above the observed peak.

Simulating each survivor against the recorded increment sequence:
  200K → saves a modest share of carried volume, few extra resets
  150K → saves more carried volume, more extra resets

Aggressive end = 150K (largest simulated saving).
Conservative end = the largest candidate still capturing >= 50% of that
  saving — here, 200K.

range = [200K, 150K]   (conservative first, descending)
recommendedTokens = 200K

The verdict sentence reports this as a recommend-window verdict, with the
upper-bound/lower-bound caveat rendered on the same line as both dollar
figures, and each candidate's own median resulting cycle length shown
alongside its saving so the reader can see what living at that window would
look like, not only what it would cost.
```
