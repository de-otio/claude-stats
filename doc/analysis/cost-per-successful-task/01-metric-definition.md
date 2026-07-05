# 01 — Metric Definition

## 1.1 The core quantity

For a set of task attempts `T` in a window, where `cost(t)` is the
equivalent-API dollar cost of attempt `t` and `S ⊆ T` is the subset judged
successful:

```
cost_per_successful_task = ( Σ_{t∈T} cost(t) ) / |S|
```

This is the article's metric: total spend across **every** attempt — including
the ones that failed — divided by the count of attempts that **succeeded**.
The failed attempts stay in the numerator. That is the whole point: you paid
for them.

## 1.2 The decomposition that makes it legible

The headline number hides two independently-actionable quantities. Always
surface both alongside it:

```
mean_cost_per_attempt = ( Σ_{t∈T} cost(t) ) / |T|
success_rate          = |S| / |T|
cost_per_successful_task = mean_cost_per_attempt / success_rate
```

The identity `cost_per_success ≡ mean_cost_per_attempt / success_rate` holds by
construction and is worth asserting as a property test (see the plan). It is
also the lens the article uses:

- **mean_cost_per_attempt** is what token-accounting tools already report. It is
  exact and cheap.
- **success_rate** is the number nobody measures. It is the expensive half, and
  the half that moves when you change models.

A model can win on `mean_cost_per_attempt` (cheap tokens) and lose on
`cost_per_successful_task` (low success), or vice-versa. Reporting only the
ratio hides which lever is which.

## 1.3 What counts as `|T|` — the denominator of *attempts*

`T` is the set of **tasks** in the window. A task is the recap pipeline's
`DailyDigestItem`: a cluster of topic-segments across one or more sessions,
already bounded by topic shift, file-path change, explicit user marker, or a
git commit ([`recap/segment.ts`](../../../packages/cli/src/recap/segment.ts),
[`recap/cluster.ts`](../../../packages/cli/src/recap/cluster.ts)). See
[02](02-signal-inventory.md) for why this unit, and its limits.

One nuance the article elides but a real tool cannot: **a task with no
observable outcome is not a failed attempt — it is an unscored one.** So `T`
splits three ways, and the metric is computed over the *observable* subset.
[03](03-outcome-model.md) defines this precisely. In short:

```
T = success ∪ failed ∪ in_flight ∪ unobservable
observable = success ∪ failed
success_rate = |success| / |observable|          (NOT / |T|)
cost_per_successful_task = ( Σ_{t∈observable} cost(t) ) / |success|
```

Reporting `success_rate` over `|observable|` rather than `|T|`, and printing
`coverage = |observable| / |T|` next to it, is the single most important
correctness decision in the whole design. A 90%-success number computed over
the 8% of tasks that happen to touch git is a lie of omission.

## 1.4 The per-model form — the article's real ask

Voss's strategic advice is *"run the expensive model now, measure its success
rate, then compare against a cheaper portable model."* That requires the metric
**sliced by model**:

```
cost_per_successful_task[m] = ( Σ_{t∈observable, model(t)=m} cost(t) ) / |{t∈success : model(t)=m}|
```

Two attribution rules are needed because a task can span models:

- **Cost by model (exact, splittable).** Each message carries its own `model`
  and tokens, so a task's cost splits cleanly across the models that produced
  it. Use this for the numerator and for a pure "cost by model" view.
- **Outcome by model (assigned, not split).** Success is a property of the
  *task*, not of a message; you cannot give 40% of a "shipped" to Sonnet. Assign
  the whole task to its **dominant model** — the model with the largest share
  of the task's output tokens (tie-break on cost). This is an assignment, not a
  causal claim, and must be labelled as such.

So the per-model table has two honest columns that do not perfectly reconcile —
*cost attributed by message-level split* and *successes counted by dominant
model* — and a note explaining why. The alternative (forcing them to reconcile)
would require pretending success is divisible, which it isn't.

## 1.5 Cost basis: equivalent-API dollars, deliberately

`estimateCost()` returns the **equivalent API cost**, not what a subscription
plan charged ([`pricing.ts`](../../../packages/core/src/pricing.ts) header
comment). For this metric that is the *correct* basis, and not by accident: the
article is about what happens when the subsidy disappears and you pay API-like
rates. Cost-per-successful-task in equivalent-API dollars **is the post-subsidy
number** — it is what each correct result will cost you when the meter turns on.
A subscription-fee-amortised basis would answer a different, less useful
question ("what did my flat fee buy this month").

The pricing table is the live, auto-fetched one
([`packages/cli/src/pricing-cache.ts`](../../../packages/cli/src/pricing-cache.ts)),
so the number tracks current published rates and is stamped with
`PRICING_VERIFIED_DATE`.

## 1.6 Worked example — reproducing the $1,000 result locally

Suppose in the last 30 days, attributing by dominant model, the most expensive
model `opus-4-x` did 40 observable tasks:

- total cost over those 40 attempts: `$420`
- successful (shipped: pushed commit or merged PR): `12`

```
mean_cost_per_attempt = 420 / 40        = $10.50
success_rate          = 12 / 40         = 30%
cost_per_successful_task = 10.50 / 0.30 = $35.00
```

Now the same window for a cheaper model `sonnet-4-x`, 60 observable tasks:

- total cost: `$180`, successful: `33`

```
mean_cost_per_attempt = 180 / 60        = $3.00
success_rate          = 33 / 60         = 55%
cost_per_successful_task = 3.00 / 0.55  = $5.45
```

The cheaper model wins on cost-per-success **6.4×**, not the ~3.5× its token
price implies — because it also succeeded more often on this user's workload.
That delta is exactly the decision the article says to make before repricing,
and it is invisible to any tool that stops at tokens. (The numbers are
illustrative; the structure — two models, observable-only denominators, the
ratio diverging from the token-price ratio — is what the feature produces.)

## 1.7 Output contract (what the feature returns)

A single `CostPerTaskReport` for a window + filter set:

```
overall:
  windowStart, windowEnd
  tasksTotal            // |T|
  observable            // |success| + |failed|
  coverage              // observable / tasksTotal
  successCount          // |success|
  failedCount, inFlightCount, unobservableCount
  successRate           // success / observable
  totalCostObservable   // Σ cost over observable
  meanCostPerAttempt    // over observable
  costPerSuccessfulTask // headline
  labelledCount         // how many outcomes are user-labelled vs proxied
byModel[]:               // same shape, dominant-model assignment, + costByModelExact
```

`labelledCount` next to the headline is deliberate: it tells the reader how much
of the number is ground truth versus proxy, which is the difference between an
eval and a guess.
