# 06 — Implementation plan

A phased, file-by-file plan. The work is small and additive; no store migration,
no breaking change to existing config.

## 6.1 Change list by file

| File | Change |
|---|---|
| [packages/cli/src/config.ts](../../../packages/cli/src/config.ts) | Add `AccountFee` interface and `accountFees?: Record<string, AccountFee>` to `Config`. Optionally a `resolveAccountFee(config, uuid, subscriptionType)` helper encoding the resolution order ([04 §4.4](04-settings-ux.md)). |
| [packages/cli/src/dashboard/index.ts](../../../packages/cli/src/dashboard/index.ts) | Add pure `buildFeeAttribution(...)` ([03 §3.7](03-distribution-model.md)); call it in `buildDashboard`; add `feeAttribution` to `DashboardData` and `feeShare` to each `byProject` entry. Thread `accountFees` + period bounds in. |
| [packages/cli/src/dashboard](../../../packages/cli/src/dashboard) (types) | Extend `DashboardData` types per [05 §5.1](05-projects-ux.md). |
| [packages/cli/src/extension/panel.ts](../../../packages/cli/src/extension/panel.ts) | In `getConfig` handler, also send `store.listAccounts()` + current email. In `saveConfig` merge, add `accountFees`. Pass `config.accountFees` into the `buildDashboard` opts. |
| [packages/cli/src/server/index.ts](../../../packages/cli/src/server/index.ts) | Mirror the `getConfig`/`POST /api/config` changes (accounts list in GET, `accountFees` in merge). |
| [packages/cli/src/server/template.ts](../../../packages/cli/src/server/template.ts) | Settings tab: per-account fee table ([04](04-settings-ux.md)). Projects tab: fee-by-project card + chart ([05](05-projects-ux.md)). |
| i18n locale files | Add every new string to all locales, generated locally ([06 §6.4](06-implementation-plan.md)). |
| tests | Unit tests for `buildFeeAttribution`; config round-trip test for `accountFees` merge. |

## 6.2 Phasing

**Phase 0 — config + pure function (no UI).**
Add the `accountFees` schema and `buildFeeAttribution`. Fully unit-testable with
synthetic `rows` and a fixed `accountFees` map. This is the part that must be
*correct*; build it first, behind no UI. Verifies the math from [03](03-distribution-model.md)
including the worked example ([03 §3.6](03-distribution-model.md)) as a test case.

**Phase 1 — Settings tab.**
Per-account fee table, account enumeration via `listAccounts`, `accountFees`
persistence and merge. After this the user can *record* €125 / €214 even before
the Projects view exists; the values immediately improve `planUtilization`
([§6.5](06-implementation-plan.md)).

**Phase 2 — Projects tab.**
The fee-by-project card, chart, idle slice, currency handling, unconfigured/
low-confidence states. This is the user-visible payoff.

**Phase 3 — polish.**
The "API-equivalent vs subscription-fee" dual labelling ([05 §5.5](05-projects-ux.md)),
the `(unknown)`-bucket caption, the monthly run-rate toggle ([03 §3.3](03-distribution-model.md) option B).

The smallest shippable slice that satisfies the literal request is **Phase 0 +
1 + 2**. Phase 3 is refinement.

## 6.3 Tests (the part that must fail when wrong)

`buildFeeAttribution` is a pure function — test it directly:

- **Per-account pooling** ([03 §3.1](03-distribution-model.md)): two accounts,
  disjoint projects → each project draws only from its own account's pool; no
  leakage. Assert `client-api` gets €0 from the personal pool.
- **Reconciliation**: with both accounts active, Σ project shares == Σ pro-rated
  pools (within rounding). Use the [§3.6](03-distribution-model.md) worked numbers
  as a golden test.
- **Idle pool** ([03 §3.4](03-distribution-model.md)): an account with zero
  in-period cost → its pool appears in `idle[]`, **not** spread onto projects.
- **Pro-rating** ([03 §3.3](03-distribution-model.md)): period=week → factor
  7/30.4; period=month → ≈1; period=all → sums across spanned months.
- **Currency** ([03 §3.5](03-distribution-model.md)): mixed currencies →
  per-currency subtotals, never summed.
- **Resolution order** ([04 §4.4](04-settings-ux.md)): explicit fee beats
  `plan.monthly_fee` beats `lookupPlanFee` beats 0.
- **Determinism**: fixed clock / fixed `since` (the repo's testing default for
  nondeterminism) so pro-rating is reproducible.

Config round-trip test: saving `accountFees` for one account must not clobber the
other (the shallow-merge fix in [04 §4.3](04-settings-ux.md)).

## 6.4 i18n

New user-facing strings must land in **every** locale, generated locally — the
parity check fails the build on drift (project translation policy). Enumerate
them up front from [04](04-settings-ux.md)/[05](05-projects-ux.md): subscriptions,
monthly fee, currency, label, account, idle subscription, unattributed,
attributed, pro-rated, subscription fee by project, set fees in settings, etc.

## 6.5 Fold the configured fee back into plan-utilisation

Today `planUtilization.byAccount` can only *auto-detect* a default fee via
`lookupPlanFee` ([dashboard/index.ts:841](../../../packages/cli/src/dashboard/index.ts#L841))
— it has no way to know the personal account really costs €214, so its
"good-value / underusing" verdict ([dashboard/index.ts:843-848](../../../packages/cli/src/dashboard/index.ts#L843-L848))
is computed against a guess. Once `accountFees` exists, make it the **primary**
source for `detectedPlanFee` there too:

```
fee = accountFees[uuid]?.monthlyFee ?? lookupPlanFee(subscriptionType)
```

This is a one-line improvement that makes an existing feature *correct*, and it
unifies the two features on a single source of truth for "what each account
actually costs." It also means the idle-subscription insight ([03 §3.4](03-distribution-model.md))
and the plan-utilisation "underusing" verdict tell the same story from two
angles.

## 6.6 Out of scope (deliberately)

- **FX conversion** — fees stay in their entered currency ([03 §3.5](03-distribution-model.md)).
- **Guessing account identity beyond the existing single-`(unknown)` repair** —
  would fabricate precision ([02 §2.2](02-data-model-and-attribution.md)).
- **Historical fee changes** (the user raised a plan mid-month) — v1 treats the
  current fee as constant. A dated-fee schedule is a clean future extension to
  `AccountFee` (add `effectiveFrom`) but is not needed for the request.
- **Sub-project / per-session billing tags** — that is the value-tag direction in
  [`../value-per-cost/`](../value-per-cost/); this feature stays at project
  granularity.
