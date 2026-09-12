# Cost Correctness — 2026-09-12

> **Status: implemented in extension 0.23.0** — see the changelog.

A re-measurement of what Claude Stats reports as spend, prompted by Anthropic's
new cost tooling in the bundled `claude-api` skill (Claude Code 2.1.269) and by
eleven days of new transcript data.

This set is a **delta** on [../schema-drift-2026-09/](../schema-drift-2026-09/)
and
[../schema-drift-2026-09-implementation/](../schema-drift-2026-09-implementation/),
written 2026-09-01 and committed as documentation only — none of it has been
implemented (`dcc1727` is docs; nothing since touches the defects it names).

**That plan is still right, and this document does not restate it.** Read it
first. What follows is only what eleven days of new data changed:

1. **One defect that did not exist on 2026-09-01.** `claude-fable-5-1` entered
   the corpus and is mispriced — no prior coverage, confirmed by grep across
   both doc sets.
2. **One prior recommendation that live data now contradicts.** Phase 0 step
   0.1 would introduce a 50% over-report on Claude Sonnet 5 if implemented as
   written.
3. **Independent reproduction** of the prior set's headline defect, on a
   different sample, with the combined dollar impact of both multipliers.

Everything else it found — `effort`, `speed`, `thinking_tokens`, `[1m]`
normalisation, the `message.id` dedupe — this document either confirms or
leaves untouched. Where the two analyses converge on the same conclusion from
different evidence, that is noted as corroboration, not as a new finding.

## The headline

**Claude Stats over-reports cost by 2.34× on the corpus measured.**

Two independent multipliers compound:

| Defect | Effect | Prior coverage |
|---|---|---|
| Assistant usage deduped on `entry.uuid` instead of `message.id` | **1.94×** over-count of every token class | Fully designed — implementation set, defect **C1** |
| `claude-opus-4-7` missing from the rate table, prefix-matched onto the **retired** `claude-opus-4` row | **3×** over-charge — **$26,923** in this database | **None** — new in this document |
| `claude-fable-5-1` missing, prefix-matched onto `claude-fable-5` | **4×** over-charge on that model's cache reads — $1,113 | **None** — new in this document |

The two pricing rows are one defect, not two: a point-release model id is a
string prefix of its predecessor's, so longest-prefix matching silently inherits
an old rate row. Fixing the class matters more than adding two rows
([02 §2.3](02-pricing-drift.md#23-the-structural-fix)).

Measured over the 150 most recently modified session files: **$27,014 reported
against $11,565 actual**. That sample is transcript-derived and so contains **no
Opus 4.7 traffic at all** — the largest correction is missing from it. Method,
and why that matters, in [01-measured-defects.md](01-measured-defects.md).

Both are *confidently wrong numbers* rather than missing ones — the failure mode
`pricing.ts` was designed to avoid. Neither trips the `{cost: 0, known: false}`
safety net: C1 because dedupe runs before pricing, the Fable row because
`startsWith` matching finds a plausible wrong row.

## Chapters

| | |
|---|---|
| [01-measured-defects.md](01-measured-defects.md) | The two multipliers, measured; reproduction scripts |
| [02-pricing-drift.md](02-pricing-drift.md) | The rate table against the live pricing page, fetched 2026-09-12 |
| [03-request-dimensions-delta.md](03-request-dimensions-delta.md) | What eleven days changed for `effort`, `speed`, `thinking_tokens` — mostly nothing |
| [04-scope.md](04-scope.md) | What belongs in this release, what does not, and the one decision that needs a maintainer |
| [05-roadmap.md](05-roadmap.md) | Opportunities from Claude Code 2.1.252–2.1.269, deliberately deferred |
| [06-implementation-plan.md](06-implementation-plan.md) | The plan: row model, three lanes, dependency graph, tests |
| [07-review-integration.md](07-review-integration.md) | What two review passes changed, including three errors in this analysis |

## Evidence conventions

Following the parent analysis: **[live]** marks an observation measured on
current local data, **[docs]** marks one taken from published documentation.

Every rate in [02](02-pricing-drift.md) is **[docs]**, fetched from the pricing
page on 2026-09-12 rather than recalled. This matters more than it sounds: the
one prior recommendation this document retracts is a remembered price that was
never re-fetched, and the retraction only exists because the page was read.

Absolute dollar figures come from one contributor's local corpus, quoted only
where a ratio alone understates severity. They are not representative of any
user's spend.
