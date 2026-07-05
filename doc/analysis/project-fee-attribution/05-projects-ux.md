# 05 — Projects-tab UX

The Projects tab already shows, per project: token bars, a token-share pie,
thinking intensity, and a work-profile breakdown (server/template.ts,
`initProjects`). It already has the period selector at the top and already
receives `data.byProject` from `buildDashboard`. The change adds **one section**:
the fee distribution.

## 5.1 What to add to the data layer

Extend each `byProject` entry, and add a top-level block, both computed by the
`buildFeeAttribution` function from [03 §3.7](03-distribution-model.md):

```ts
// per project
byProject[i].feeShare?: {
  amount: number;          // pro-rated fee attributed to this project, in `currency`
  currency: string;
  monthlyEquivalent: number;  // amount / prorate — the "/mo run-rate" label
  percentOfTotal: number;     // share of the period's total attributed fee
};

// top-level (new)
feeAttribution?: {
  prorate: number;               // periodDays / 30.4
  byCurrency: Array<{
    currency: string;
    periodTotal: number;         // e.g. €78 this week
    monthlyTotal: number;        // e.g. €339/mo
    attributed: number;          // sum over projects
    idle: Array<{ label: string; amount: number }>;  // §3.4 idle pools
  }>;
  configured: boolean;           // false when no accountFees & no fallback fee
};
```

`buildDashboard` already holds everything the function needs (`rows`,
`sessionCostMap`, period bounds); it just needs `config.accountFees` threaded
through `ReportOptions` the way `planFee`/`planType` already are
([dashboard/index.ts:776](../../../packages/cli/src/dashboard/index.ts#L776)).

## 5.2 The view

A new card at the top of the Projects tab:

```
Subscription fee by project · this week (€78 of €339/mo)

  client-api          ███████████████████░░░  €23.01   29%
  claude-stats        ████████████████████████ €36.93   47%
  side-blog           ████████░░░░░░░░░░░░░░░░  €12.31   16%
  internal-tooling    ████░░░░░░░░░░░░░░░░░░░░  €5.75    7%
  ── idle ──────────────────────────────────────────────
  Personal subscription (no usage this week)    €0.00    —

  Attributed €78.00 · pro-rated from €339/mo over 7 days
```

Components:

- **Header** states the period total and the monthly total, so the pro-rating
  ([03 §3.3](03-distribution-model.md)) is transparent, not hidden.
- **Horizontal bars** (reuse the existing Chart.js bar pattern from `initProjects`)
  sorted by fee descending. A **doughnut** alternative maps naturally onto "share
  of a fixed pie" and matches the `chart-project-tokens` pie already present.
- **Idle section** renders any `idle[]` pools from [03 §3.4](03-distribution-model.md)
  — the honest remainder. Visually separated, never folded into project bars.
- **Currency-aware**: one card per currency when accounts differ; one combined
  card (€) when they match. No summing across currencies.

## 5.3 Period tie-in (free)

The period selector already drives `buildDashboard` and re-renders `byProject`.
Because `feeAttribution` is computed inside the same pass, switching Day → Week →
Month → All recomputes the pro-rated pools and the per-project shares with no
extra wiring. The only period-specific input is `periodDays`, derivable from the
window bounds the dashboard already computes
([dashboard/index.ts:510-521](../../../packages/cli/src/dashboard/index.ts#L510-L521)).

## 5.4 The unconfigured / low-confidence states

The card must degrade honestly:

- **No fees configured** (`configured === false`): show a prompt — *"Set your
  subscription fees in Settings to attribute them to projects"* — linking to the
  Settings tab, plus the auto-detected `lookupPlanFee` estimate as a greyed
  preview so the feature isn't blank on first view.
- **Large `(unknown)` bucket**: when a material share of period cost is in the
  `(unknown)` account ([02 §2.2](02-data-model-and-attribution.md)), show a
  caption — *"X% of usage couldn't be attributed to an account"* — so the user
  reads the split as approximate. This reuses the `(unknown)` key the dashboard
  already produces ([dashboard/index.ts:755](../../../packages/cli/src/dashboard/index.ts#L755)).
- **Single account**: collapses gracefully — one pool, no idle slice, behaves like
  the user's mental "€125 split across my work projects."

## 5.5 Relationship to the existing project cost number

The tab already shows an `estimatedCost` per project (API-equivalent, output-token
weighted, [dashboard/index.ts:548](../../../packages/cli/src/dashboard/index.ts#L548)).
Keep it — it answers a different question ("what would the metered API have
cost?"). Label the two distinctly to avoid confusion:

- **"API-equivalent cost"** — the hypothetical metered cost (existing).
- **"Subscription fee share"** — the real paid fee attributed (new).

The gap between them is itself informative: if a project's fee share vastly
exceeds its API-equivalent cost, the subscription is subsidising it; if the
reverse, that project alone would justify metered billing. Surfacing both is the
payoff of doing the attribution honestly rather than collapsing to one number.
