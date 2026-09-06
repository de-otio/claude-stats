# Schema Drift 2026-09 — Implementation Analysis

The build-out of [../schema-drift-2026-09/04-feature-opportunities.md](../schema-drift-2026-09/04-feature-opportunities.md).
That document listed eight opportunities ordered by value ÷ effort. This one
works out how to implement **all of them except §4.3**, which is being
implemented separately, and respects §4.9's three exclusions unchanged.

Each chapter grounds its design in the live data on this machine and in
`file:line` references into the codebase. Where the parent analysis turned out to
be wrong about the data — and it is wrong in fourteen places — the correction is
recorded rather than worked around.

## The headline

**Designing these features found more correctness debt than feature value.**
Eleven defects in shipped behaviour, catalogued in
[09 §9.1](09-sequencing.md). Three of them share one root cause and were found
independently, on three different samples, by three different lines of enquiry:

> **The parser's dedupe model is incomplete on both sides and keyed on the wrong
> identifier on the assistant side.**
>
> - Assistant usage is summed once per transcript **entry** rather than per API
>   response. Blocks of one response share a `message.id` but carry distinct
>   envelope uuids, so the `uuid` dedupe misses them. Measured against Claude
>   Code's own `cost-state` rollup: **$124.25 vs $60.52 — a 2.05× over-report**;
>   deduping on `message.id` matched ground truth exactly on all four token
>   classes.
> - User entries are not deduped at all — **62.5% are replays**.
> - Compaction summaries are counted as human prompts *and* written into
>   `prompt_text`, where they flow into recap headlines.

The forward fixes are unambiguous and cheap. What to do about the existing
database is not, and is the first open decision in
[09 §9.5](09-sequencing.md).

The second-order point matters too: **`verify` ([03](03-cost-verification.md)) is
the instrument that found this**, during its own design phase, before a line of
it was written. That is the argument for building it.

## Documents

| # | File | Covers |
|---|---|---|
| 01 | [01-foundation.md](01-foundation.md) | Parser, schema V23, ingestion, backfill, the free-text rule, drift instrumentation. Every other chapter depends on it |
| 02 | [02-pr-and-work-items.md](02-pr-and-work-items.md) | §4.1 — `pr-link`, run collapse, the work-item key space beyond Jira, the cost join |
| 03 | [03-cost-verification.md](03-cost-verification.md) | §4.2 — `claude-stats verify`, the four comparison layers, the trust budget, pricing-drift detection |
| 04 | [04-attribution-hardening.md](04-attribution-hardening.md) | §4.4 — `bridge-session` in the precedence chain, `promptId` turn identity, tool-error attribution |
| 05 | [05-request-dimensions.md](05-request-dimensions.md) | §4.5 — effort, thinking tokens, speed, `iterations`, MCP/skill context-carry attribution |
| 06 | [06-friction.md](06-friction.md) | §4.6 — hooks, refusals, fallbacks, denials; three new hygiene detectors; the constraint-impact integration |
| 07 | [07-compaction.md](07-compaction.md) | §4.7 — twelve inferences in `contextCarry`/`autoCompactFit` replaced with measurements |
| 08 | [08-session-titles.md](08-session-titles.md) | §4.8 — `ai-title`/`custom-title`/`agent-name`, the precedence chain, and the privacy boundary they cross |
| 09 | [09-sequencing.md](09-sequencing.md) | The eleven defects, the build order, i18n and test budgets, and eight decisions that need the maintainer |

Read [09](09-sequencing.md) first if you want the plan; read
[01](01-foundation.md) first if you want to start building.

## What each chapter concluded

| § | Verdict | Effort |
|---|---|---|
| **4.1** PR linkage | **Not "small".** `pr-link` is a per-turn ambient stamp — 7,926 entries for 460 facts — with no PR title and no branch, and 54% name a repo other than the session's. Real value, but it needs run collapse, a same-repo discriminator, and a widened key space | 6–7 d |
| **4.2** Cost verification | **Build it.** It found the 2.05× defect during design. Four layers, because a single end-to-end comparison conflates parse error with pricing error — and here the two point in opposite directions | 8 d |
| **4.4** Attribution | **Build it.** `bridge` is the first account signal that works on non-CLI surfaces offline. `promptId` is exactly 1:1 with a real turn — empirically confirmed | 5–6 d |
| **4.5** Request dimensions | **Build two of three.** Thinking share and MCP carry-cost are real; **fast mode has zero observations**, no pricing dimension, and would need a consumption model that does not exist | 5–6 d |
| **4.6** Friction | **Build it — and it fixes two shipped detectors.** 19.7% of "tool errors" are permission denials. Report a vector, never a weighted score | 3–4 d |
| **4.7** Compaction | **Build it.** Twelve inferences replaced by measurement, one of which may invalidate advice the tool currently gives | 4–5 d |
| **4.8** Titles | **Build it first.** 95% coverage on interactive sessions, and four surfaces that today show a file path. But it is the first free-text field the compile-time privacy guard does not cover by name | 2 d |

Plus ~3–4 days of correctness work before any of it, and ~3 days of foundation.
**Roughly 42–48 days total.**

## Method and evidence grades

Same grades as the parent analysis:

- **[live]** — observed in real data on this machine, read-only, on 2026-09-01.
- **[code]** — verified against a `file:line` reference.
- **UNVERIFIED** — stated but not confirmed. Marked inline throughout, and
  collected in [09 §9.6](09-sequencing.md).

Two caveats on the evidence that apply everywhere:

1. **One operator, one machine.** 224 surviving session files against 413,985
   messages in the store — the transcripts are a recent tail of the history.
   Distributions here are existence proofs of *shape*, not population estimates.
   Where a value domain has a single observed member (`speed: "standard"`,
   `trigger: "manual"`, `apiRefusalCategory: "cyber"`), that is called out rather
   than treated as the domain.
2. **Absolute token totals quoted in [05](05-request-dimensions.md) are inflated
   by the `message.id` factor**, since they were measured over raw entries.
   Ratios are largely unaffected; absolute figures there are not spend.

## Relationship to the rest of `doc/analysis/`

This folder is a **design record**, not a plan of record — nothing here has been
implemented. When the work lands, the confirmed shapes belong in
[../07-schema-reference.md](../07-schema-reference.md) and the fourteen
corrections in [09 §9.3](09-sequencing.md) should be applied to
[../schema-drift-2026-09/](../schema-drift-2026-09/), which stays the
point-in-time drift report.

Chapters land on existing sub-analyses as follows:

| Chapter | Sub-analysis it advances |
|---|---|
| 02 | [ticket-attribution/](../ticket-attribution/) — **not** [business-value-visibility/](../business-value-visibility/), whose gap is surface and cadence, not grain |
| 03 | [value-per-cost/](../value-per-cost/) — the trust budget is what makes a $/outcome figure honest |
| 04 | [account-attribution/](../account-attribution/) |
| 05 | [cost-per-successful-task/](../cost-per-successful-task/), [../09-token-spending-analysis.md](../09-token-spending-analysis.md), [constraint-impact/](../constraint-impact/) |
| 06 | [efficiency-hygiene/](../efficiency-hygiene/), [constraint-impact/](../constraint-impact/) |
| 07 | [context-carry-cost/](../context-carry-cost/), [autocompact-window-fit/](../autocompact-window-fit/), [cache-ttl-fit/](../cache-ttl-fit/) |
| 08 | [sessions/](../sessions/), [daily-recap/](../daily-recap/), [gui-redesign/](../gui-redesign/) |

Two privacy documents need edits when the work lands:
[../05-privacy-security.md](../05-privacy-security.md) gains a friction-events
row and a titles retention line, and its "does NOT store" section gains hook
command lines, hook output, and refusal explanations.
