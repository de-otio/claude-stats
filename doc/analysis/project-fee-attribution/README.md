# Project Fee Attribution — distributing per-account subscription fees across projects

This directory designs two related features requested by the owner:

> "I have 2 Anthropic accounts: one for work, one personal. The work account
> costs €125, the personal account costs €214. On the **Settings** tab I want
> to configure the monthly fee for each account I use. On the **Projects** tab
> I want to show the cost distribution of the total fee (€339/month) over the
> projects for the selected period — so AI costs can be attributed to projects
> proportionally."

In one sentence: **let the user record what each Claude subscription actually
costs them, then split that real, paid amount across the projects that consumed
it — so a flat monthly sunk cost becomes a per-project, per-period attributable
number.**

## The one-paragraph conclusion

Almost all the machinery already exists. The store already stamps every session
with `account_uuid` / `subscription_type` ([store/index.ts:153-155](../../../packages/cli/src/store/index.ts#L153-L155)),
already enumerates distinct accounts ([`listAccounts`](../../../packages/cli/src/store/index.ts#L941)),
already groups cost by account and auto-detects a plan fee per account
([dashboard/index.ts:748-877](../../../packages/cli/src/dashboard/index.ts#L748-L877)),
and already distributes a total cost across projects proportionally to output
tokens ([dashboard/index.ts:540-551](../../../packages/cli/src/dashboard/index.ts#L540-L551)).
The Settings tab already round-trips config and already has a single
`monthly_fee` field ([config.ts:18-21](../../../packages/cli/src/config.ts#L18-L21)).
What is missing is three small things: **(1)** a config shape that holds a fee
*per account* instead of one global fee; **(2)** a distribution function that
splits each account's fee across that account's projects for the selected
period — the **per-account-pool** model, not a single global pool; and **(3)**
two view changes (a per-account fee editor in Settings, a fee-by-project view in
Projects). The two genuinely hard parts — currency, and the honesty of
attribution when account identity is only best-effort — are design decisions,
not engineering, and are spelled out here so they are chosen deliberately rather
than by accident.

## The core design choices (decide these first)

| # | Choice | Recommendation | Where argued |
|---|--------|----------------|--------------|
| 1 | **Pooling**: one global €339 pool, or one pool per account? | **Per-account pool.** The work fee must only flow to work usage; the personal fee only to personal usage. A global pool lets a personal side-project absorb part of the €125 work fee, which is wrong. | [03 §3.1](03-distribution-model.md) |
| 2 | **Proportionality weight**: output tokens, or API-equivalent cost? | **API-equivalent cost** (`estimateCost`). It already blends model + token mix, so an expensive-model project draws more fee than a cheap one at equal token count. Output-token weighting (today's `byProject`) under-charges expensive models. | [03 §3.2](03-distribution-model.md) |
| 3 | **Period normalisation**: a monthly fee shown over a Day/Week/All window | **Pro-rate the fee to the period's calendar length**, then split by in-period usage share. €339/mo over a 7-day week ≈ €78 distributed. | [03 §3.3](03-distribution-model.md) |
| 4 | **Idle capacity**: fee for an account with no usage in the period | **Show it as an explicit "unattributed / idle subscription" slice** — never silently inflate active projects. Paying for capacity you didn't use is itself the signal. | [03 §3.4](03-distribution-model.md) |
| 5 | **Currency**: the app is USD-internal; the user pays EUR | **Store a per-account `currency` + treat `monthly_fee` as that currency**; do not auto-convert to USD. The fee is a *paid amount*, not an estimate. | [02 §2.3](02-data-model-and-attribution.md), [04 §4.3](04-settings-ux.md) |

## Document index

| # | File | Contents |
|---|------|----------|
| 01 | [01-problem-and-current-state.md](01-problem-and-current-state.md) | What the user wants vs. what exists today: the single global `monthly_fee`, the existing per-account grouping, the existing proportional project split. The exact gap. |
| 02 | [02-data-model-and-attribution.md](02-data-model-and-attribution.md) | How sessions are attributed to accounts (`account_uuid`), where that identity comes from (telemetry + `~/.claude.json` fallback), and the accuracy caveats that bound the whole feature. The config schema change. |
| 03 | [03-distribution-model.md](03-distribution-model.md) | The math. Per-account pool, the proportionality weight, period pro-rating, idle slices, the worked €125/€214 example. |
| 04 | [04-settings-ux.md](04-settings-ux.md) | Settings-tab design: enumerate accounts via `listAccounts`, per-account fee + currency + friendly label, the config round-trip, backward compatibility with the existing `monthly_fee`. |
| 05 | [05-projects-ux.md](05-projects-ux.md) | Projects-tab design: the fee-by-project table + chart, the period selector tie-in, the idle slice, what to show when fees are unconfigured. |
| 06 | [06-implementation-plan.md](06-implementation-plan.md) | Phased plan, file-by-file change list, types, tests, i18n, and the smallest shippable slice. |

## Relationship to existing analysis

This builds directly on the **plan-utilisation** machinery already shipped
(`planUtilization.byAccount` in [dashboard/index.ts](../../../packages/cli/src/dashboard/index.ts)).
That feature answers "is each account good value?"; this feature answers the
complementary question "**which projects is each account's fee being spent on?**"
They share the same `account_uuid` grouping and the same `lookupPlanFee`
auto-detection, so the per-account fee config designed here should also become
the override source for `planUtilization` (today it can only auto-detect a
*default* fee, never the user's real €214). See [06 §6.5](06-implementation-plan.md).
