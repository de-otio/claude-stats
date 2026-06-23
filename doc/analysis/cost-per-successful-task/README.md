# Cost per Successful Task

This directory analyses how claude-stats can compute **cost per successful
task** — the metric Laurie Voss argues becomes the only one that matters once
flat-rate model subsidies end and metered pricing returns.

> Source article: *"Model subsidies are ending — what do you do now?"*
> (L. Voss). The thesis: flat plans are priced for chat, not agents; agentic
> tasks burn ~1000× the tokens; labs lose money on subscriptions and make it on
> the API; that gap closes around Q3 2026. The defensive move is to **measure
> your own cost per successful task now**, while subsidised compute makes
> attempts cheap, so you can pick the cheapest model that still succeeds when
> the meter turns on.

## The metric in one line

```
cost per successful task = Σ cost(all task attempts) / count(successful tasks)
                         = mean cost per attempt / success rate
```

The article's worked example: a frontier model at **$31/attempt × 3% success
≈ $1,000 per correct result**. Token cost per attempt is the cheap, knowable
number; **success rate is the expensive, must-be-measured number** — and the
whole point is to measure it per model, so you can compare an expensive-but-
low-success model against a cheap-but-portable one on *outcome cost*, not token
cost.

## Why this is mostly a re-projection, not a greenfield build

claude-stats already computes the numerator and already has a task unit and an
outcome proxy — they were built for the **daily-recap** feature, not for this
metric, but they fit:

| Ingredient | Already exists | Where |
|---|---|---|
| Equivalent-API **cost** per token | `estimateCost()` | [`packages/core/src/pricing.ts`](../../../packages/core/src/pricing.ts) |
| A **task unit** (topic-segment, clustered) | `segmentSession()` → `clusterSegments()` → `DailyDigestItem` | [`packages/cli/src/recap/`](../../../packages/cli/src/recap/) |
| Per-task **cost** | `DailyDigestItem.estimatedCost` | [`recap/index.ts`](../../../packages/cli/src/recap/index.ts) |
| An **outcome proxy** (shipped / in-flight / thin) | `computeConfidence()` → `confidence: high\|medium\|low` | [`recap/index.ts:241`](../../../packages/cli/src/recap/index.ts#L241) |
| A **git success signal** (pushed, merged PR, lines) | `getProjectGitActivity()` → `ProjectGitActivity` | [`recap/git.ts`](../../../packages/cli/src/recap/git.ts) |
| An **explicit user override** (abort/hide) | `hide` correction → `DailyDigestItem.hidden` | [`recap/corrections.ts`](../../../packages/cli/src/recap/corrections.ts) |

So the work is not "invent task + success from scratch." It is:

1. **Fix** the per-task cost attribution (it currently double-counts — see
   [02](02-signal-inventory.md)).
2. **Project** `confidence` into a principled, honest **outcome** state that
   never conflates *failed* with *unobservable*.
3. **Attribute** cost and outcome **by model**, which is the article's actual
   use case.
4. **Aggregate** across a time window (recap is per-day today).
5. **Let the user supply ground-truth labels** so the metric can graduate from
   a proxy to a real evaluation — exactly what Voss means by "measure through
   evals."

## The one honesty principle that governs the whole design

> **Absence of a success signal is not failure.**

A task with no commit might have failed, or might be research that never had a
commit, or might be work in a non-git directory, or work whose author email
didn't match `git config`. A binary success/total ratio silently treats all of
those as failures and **flatters or wrecks the number depending on your
workflow, not your success**. The article's entire argument is that the gap
between "looks done" and "is correct" is where the money hides — so the metric
must surface that gap, not bury it. Every design choice here follows from that:
a three-state outcome, a coverage figure reported next to the rate, and
explicit labels that override proxies.

## Document index

| # | File | Contents |
|---|------|----------|
| 01 | [01-metric-definition.md](01-metric-definition.md) | Formal definitions, the decomposition, denominator variants, per-model form, a worked example reproducing Voss's number from local data |
| 02 | [02-signal-inventory.md](02-signal-inventory.md) | Exact mapping to existing code with file:line; the cost double-count bug; per-model attribution; the cross-day window problem |
| 03 | [03-outcome-model.md](03-outcome-model.md) | The three-state outcome taxonomy, the proxy→label hierarchy, coverage reporting, and the labeling UX |
| 04 | [04-limitations-and-privacy.md](04-limitations-and-privacy.md) | Honest limits, the biases that move the number, privacy, opt-in posture |

The implementation plan derived from this analysis lives in
[`plans/cost-per-successful-task/`](../../../plans/cost-per-successful-task/).

## Relationship to the deep-analysis catalog

This metric is the concrete, shippable instance of three ideas already in the
[`deep-analysis/`](../deep-analysis/) "wise mentor" catalog: *Model-fit savings*
(`model × archetype × cost`), *Token-per-outcome* (`tokens ÷ surviving
change`), and *Model-mix appropriateness* (`model × archetype × outcome`). It
inherits that catalog's tiering (`T0` metadata · `T1` local content) and its
non-negotiable rule — **no verification theatre**: a proxy is labelled a proxy,
and an unobservable task is never counted as a failure.
