# 03 — The distribution model

This is the heart of the feature: given per-account fees and per-session usage,
how do we produce a per-project fee number for the selected period? Four
decisions, then a worked example, then the algorithm.

## 3.1 Pooling: per-account, not global

The user phrased it as "distribute the total fee (€339) over the projects." Taken
literally, that is a **single global pool**: sum both fees, split across all
projects by usage. It is simpler — but **wrong**, because it lets one account's
fee leak into the other account's work.

Concretely: suppose the personal account did 90% of the period's tokens (a big
personal side-project) and the work account 10%. A global €339 pool would charge
the work projects only €34 and the personal projects €305 — but the user *pays*
€125 for work regardless. The work fee has leaked into personal usage.

**Recommendation: per-account pool.** Each account's fee is distributed only
across the projects *that account* touched, weighted by *that account's* usage in
each project. A project's total fee share is the sum of its slices across
accounts:

```
feeShare(project) = Σ_account  fee(account) × usage(account, project) / usage(account, ·)
```

When both accounts are active across a full month, the slices sum back to €339 —
satisfying the user's headline number — but without cross-account leakage. A
project used under both accounts (rare but possible) correctly receives a slice
from each pool.

## 3.2 Proportionality weight: API-equivalent cost, not output tokens

The existing project split weights by **output tokens**
([dashboard/index.ts:548](../../../packages/cli/src/dashboard/index.ts#L548)).
The existing *account* split weights by **API-equivalent cost** (`sessionCostMap`,
[dashboard/index.ts:769-770](../../../packages/cli/src/dashboard/index.ts#L769-L770)).
For fee attribution, **use API-equivalent cost.**

Why: output tokens ignore model price and cache mix. A project that ran Opus at
high effort and one that ran Haiku can have equal output tokens but a 10×
difference in real resource consumption. The subscription fee buys *compute*, and
API-equivalent cost (`estimateCost`,
[pricing.ts:72](../../../packages/core/src/pricing.ts#L72)) is the best local
proxy for compute consumed because it already folds in model + input/output +
cache-read + cache-creation. Weighting the fee by it means the expensive-model
project draws the larger share of the fee — which is the intuition the user
wants.

(Output-token weighting remains fine for the *existing* token-share charts; this
recommendation is specific to the fee split. The two can coexist.)

## 3.3 Period normalisation: pro-rate the monthly fee to the window

The fee is **€339 per month**. The Projects tab is viewed over Day / Week / Month
/ All. Showing the full monthly fee over a single day would be misleading. Two
honest options:

- **(A) Pro-rate to the period's calendar length** (recommended).
  `feeForPeriod = monthlyFee × (periodDays / 30.4)`. A 7-day week ≈ €78; a single
  day ≈ €11; "All" sums across the months the data spans. Answers *"what did this
  period's subscription cost, attributed to projects?"* — the natural reading of
  the request.
- **(B) Always show the full monthly fee**, split by the period's usage
  proportions. Answers *"if this period's project mix held for a whole month, who
  would owe what?"* Useful as a secondary "monthly run-rate" lens but confusing as
  the default.

**Recommendation: (A) as the default**, with the monthly figure available as a
label ("€78 this week · €339/mo"). The period length is already computable from
`sinceIso` / the period bounds the dashboard already derives
([dashboard/index.ts:510-521](../../../packages/cli/src/dashboard/index.ts#L510-L521)).
Pro-rating uses 30.4 days/month, matching the `4.33` weeks/month constant the
plan-utilisation code already uses
([dashboard/index.ts:787](../../../packages/cli/src/dashboard/index.ts#L787)).

## 3.4 Idle capacity: show the unattributed remainder

A flat fee accrues even when an account is idle. If, in the selected period, the
personal account had **zero** usage, its pro-rated €214 share has nothing to
attach to. Do **not** redistribute it onto the work projects — that would
fabricate a charge. Instead:

- Emit an explicit **"Unattributed / idle subscription"** line for any pooled fee
  whose account had no in-period usage (or only `(unknown)`-bucketed usage).
- This remainder *is the insight*: it is money spent on capacity not used in the
  period. A persistently large idle slice on the personal account is exactly the
  "am I getting value from this subscription?" signal the plan-utilisation feature
  already chases — see [06 §6.5](06-implementation-plan.md).

## 3.5 Currency: subtotal, don't blend

If both accounts use the same currency (here, EUR), the tab can show one total
(€339/mo, pro-rated). If they differ (one EUR, one USD), **do not sum** — show
per-currency subtotals and per-project shares tagged with their source currency.
No FX conversion: the fee is a paid amount, not an estimate, and baking in a
volatile FX rate would corrupt an otherwise exact input. ([02 §2.3](02-data-model-and-attribution.md).)

## 3.6 Worked example

Setup: work account €125/mo, personal €214/mo. Selected period = **this week**
(7 days → pro-rate factor 7/30.4 = 0.230). So the pools this week are:

- Work pool: €125 × 0.230 = **€28.76**
- Personal pool: €214 × 0.230 = **€49.24**
- Total this week: **€78.00**

This week's API-equivalent cost by (account, project):

| Account | Project | API-equiv cost | Account share |
|---|---|---|---|
| Work | `client-api` | $4.00 | 80% |
| Work | `internal-tooling` | $1.00 | 20% |
| Personal | `claude-stats` | $6.00 | 75% |
| Personal | `side-blog` | $2.00 | 25% |

Fee distribution (per-account pool × in-account share):

| Project | From work pool | From personal pool | **Project fee (week)** |
|---|---|---|---|
| `client-api` | €28.76 × 0.80 = €23.01 | — | **€23.01** |
| `internal-tooling` | €28.76 × 0.20 = €5.75 | — | **€5.75** |
| `claude-stats` | — | €49.24 × 0.75 = €36.93 | **€36.93** |
| `side-blog` | — | €49.24 × 0.25 = €12.31 | **€12.31** |
| **Total** | €28.76 | €49.24 | **€78.00** ✓ |

Note `client-api` draws **only** from the work pool — no personal fee leaks into
it — and the slices reconcile back to the pro-rated weekly total. Had the
personal account been idle this week, the €49.24 personal pool would appear as a
single "Idle — personal subscription" line instead of attaching to projects.

## 3.7 The algorithm

```
buildFeeAttribution(rows, accountFees, periodDays):
  prorate = periodDays / 30.4

  # 1. cost per (account, project), reusing sessionCostMap (estimateCost)
  costAP   = map<(acctUuid, projectPath) -> apiEquivCost>   # from rows + sessionCostMap
  costA    = map<acctUuid -> Σ project costAP>              # account total

  # 2. resolve each account's monthly fee:
  #    accountFees[uuid].monthlyFee  ??  plan.monthly_fee (if single account)  ??  lookupPlanFee(subType)
  feeA     = map<acctUuid -> resolveFee(uuid)>

  # 3. distribute
  perProject = map<projectPath -> {fee, byCurrency}>
  idle       = []
  for acct in accounts:
    pool = feeA[acct] * prorate
    if costA[acct] == 0 or acct == "(unknown)":
      idle.push({acct, pool, currency})           # §3.4 — never redistribute
      continue
    for (a, project), c in costAP where a == acct:
      perProject[project].fee += pool * (c / costA[acct])   # §3.1 + §3.2

  return { perProject, idle, totalByCurrency, prorate, monthlyTotalByCurrency }
```

Every input already exists in `buildDashboard`'s scope: `rows`, `sessionCostMap`,
the period bounds, and (after [02](02-data-model-and-attribution.md)'s config
change) `accountFees`. This is a pure function over data already in hand —
testable in isolation with synthetic rows, which is how [06](06-implementation-plan.md)
specs it.
