# 01 — The problem and the current state

## 1.1 What the user is asking for

Two coupled features:

1. **Settings tab** — configure a **monthly fee per account**. The user runs
   two Claude accounts (work €125/mo, personal €214/mo) and switches between
   them. Today there is exactly one fee field.
2. **Projects tab** — show the **total fee (€339/mo) distributed across
   projects** for the selected period, so the flat subscription cost is
   attributed to the work it paid for.

The deeper goal stated in the request: *"so that the AI costs can be attributed
to projects proportionally."* The subscription fee is a **sunk, flat cost** —
you pay €339 whether you run one prompt or ten thousand. The feature turns that
undifferentiated number into a per-project, per-period figure the user can
reason about (e.g. bill a client, or decide a side-project isn't worth its share
of the fee).

This is distinct from the **API-equivalent cost** the dashboard already
computes. API-equivalent cost (`estimateCost`, from token counts) is a
*hypothetical* — "what these tokens would have cost on the metered API." The fee
is **what was actually paid**. Both are useful; the user is explicitly asking for
the second, which the tool does not yet attribute.

## 1.2 What already exists (and is reusable)

The good news: the substrate is almost entirely in place.

### Per-session account identity

Every session row carries account columns (schema V3):

```
sessions.account_uuid        TEXT   -- store/index.ts:153
sessions.organization_uuid   TEXT   -- store/index.ts:154
sessions.subscription_type   TEXT   -- store/index.ts:155
```

So usage is already attributable to an account. How that identity is populated
(and how reliable it is) is the subject of [02](02-data-model-and-attribution.md).

### Account enumeration

[`Store.listAccounts()`](../../../packages/cli/src/store/index.ts#L941) already
returns every distinct account in the store with its most-recent
`subscription_type` and session count, filtered by period. This is exactly the
list the Settings UI needs to render a fee field per account — **no new query
required**.

### Per-account cost grouping

[dashboard/index.ts:753-772](../../../packages/cli/src/dashboard/index.ts#L753-L772)
already builds an `accountMap` keyed by `account_uuid`, accumulating each
account's API-equivalent cost via `sessionCostMap`. The
[`byAccount`](../../../packages/cli/src/dashboard/index.ts#L835-L860) array is
already surfaced to the Plan tab.

### Per-account fee auto-detection

[dashboard/index.ts:776-785](../../../packages/cli/src/dashboard/index.ts#L776-L785)
already sums an auto-detected plan fee across accounts via
[`lookupPlanFee(subscriptionType)`](../../../packages/core/src/pricing.ts#L110).
**But** it can only produce *defaults* from the `PLAN_FEES` table
([pricing.ts:96](../../../packages/core/src/pricing.ts#L96)) — `team_premium`
→ $125, etc. It cannot know the user actually pays €214 for the personal account.
That is precisely the gap the Settings feature fills.

### Proportional project distribution

The exact distribution shape the user wants already exists for API-equivalent
cost — [dashboard/index.ts:540-551](../../../packages/cli/src/dashboard/index.ts#L540-L551):

```ts
// Per-project cost: distribute proportionally by output tokens
estimatedCost: Math.round((p.outputTokens / totalOutputForCost) * totalCost * 100) / 100,
```

This is the template for fee distribution. [03](03-distribution-model.md) argues
the weight should change from output tokens to API-equivalent cost, and the
denominator from one global total to one-per-account.

### Settings round-trip

The Settings tab already persists config. The single fee field exists today:

- Config schema: [config.ts:18-21](../../../packages/cli/src/config.ts#L18-L21) —
  `plan: { type?, monthly_fee? }`.
- UI: `cfg-monthly-fee` input in the settings form (server/template.ts).
- Round-trip: webview `postMessage({command:'getConfig'|'saveConfig'})` handled in
  [panel.ts](../../../packages/cli/src/extension/panel.ts) (`getConfig`/`saveConfig`
  handlers), and HTTP `GET`/`POST /api/config` in
  [server/index.ts](../../../packages/cli/src/server/index.ts). The merge is
  shallow per top-level key.

### Period selector

The Day/Week/Month/All selector already flows into `buildDashboard` via
`opts.period`, recomputing every per-project aggregate. The fee view rides this
for free — when the period changes, the fee distribution recomputes with it.

## 1.3 The exact gap

| Capability | Status |
|---|---|
| Session → account attribution | ✅ exists (`account_uuid`) |
| Enumerate accounts for a UI | ✅ exists (`listAccounts`) |
| Group cost per account | ✅ exists (`accountMap`) |
| Auto-detect a *default* fee per account | ✅ exists (`lookupPlanFee`) |
| **Store a user-entered fee per account** | ❌ **missing** — config holds one global `monthly_fee` |
| **Currency per account (EUR vs USD)** | ❌ **missing** |
| **Split each account's fee across its projects** | ❌ **missing** |
| **Period pro-rating of a monthly fee** | ❌ **missing** |
| Settings UI: one fee field per account | ❌ **missing** (single field today) |
| Projects UI: fee-by-project view | ❌ **missing** |

Five missing pieces, all small, none requiring schema migration (the config file
is free-form JSON; the store already has the columns). The design work is in
*how* to split (the model) and *how honest* to be about attribution accuracy —
the next two documents.
