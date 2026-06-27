# 04 — Settings-tab UX

The Settings tab today has a single **Plan Type** dropdown and a single **Monthly
Fee** field, plus cost thresholds. The change: replace the single fee with a
**per-account fee table**, populated from the accounts actually present in the
store.

## 4.1 Populating the account list

Use the existing [`Store.listAccounts()`](../../../packages/cli/src/store/index.ts#L941)
— it already returns `{ accountUuid, subscriptionType, sessionCount }` for every
distinct account, ordered by session count. No new query.

For the **current** account, enrich with the email from
[`readClaudeAccount()`](../../../packages/cli/src/account.ts#L17) so the user sees
a recognisable label without typing. Other accounts show their truncated UUID
(`acctKey.slice(0, 8) + "..."`, matching
[dashboard/index.ts:852](../../../packages/cli/src/dashboard/index.ts#L852))
until the user assigns a `label`.

This means the panel needs to send the account list to the webview. Two options:

- **Bundle into `getConfig`'s reply** — extend the `configResult` payload with an
  `accounts` array alongside the config. Cheapest; the form already waits on
  `getConfig`.
- A dedicated `getAccounts` message. More moving parts; not needed.

**Recommendation:** piggyback on `getConfig`. The handler in
[panel.ts](../../../packages/cli/src/extension/panel.ts) already calls
`loadConfig()`; add a `store.listAccounts()` call beside it and merge the email
for the current account. Mirror in the HTTP `GET /api/config`
([server/index.ts](../../../packages/cli/src/server/index.ts)).

## 4.2 The form

```
Subscriptions

  Account            Plan            Monthly fee   Currency   Label
  ───────────────────────────────────────────────────────────────────
  you@work.com       team_premium    [ 125    ]    [ EUR ▾]   [ Work     ]   (current)
  3f9a1c2e…          (max_20x?)      [ 214    ]    [ EUR ▾]   [ Personal ]
                                                                ↑ 1,204 sessions

  Total configured: €339 / month

  Cost alert thresholds          [ existing fields unchanged ]
  [ Save ]   Saved ✓
```

Per row:
- **Account** — email (current) or truncated UUID; full UUID in a tooltip.
- **Plan** — the detected `subscriptionType` shown read-only as a hint (it drives
  the `lookupPlanFee` default if the fee is left blank).
- **Monthly fee** — `number`, the amount the user actually pays. Pre-filled with
  the `lookupPlanFee` default ([pricing.ts:110](../../../packages/core/src/pricing.ts#L110))
  as a *placeholder*, not a value, so the user knows the auto-detected guess but
  must confirm the real figure.
- **Currency** — small select (default USD; user picks EUR). [03 §3.5](03-distribution-model.md).
- **Label** — free text; persisted so non-current accounts get a human name.

Sessions-count caption per row gives confidence the user is configuring a real,
active account and not a stale one.

## 4.3 Persistence and round-trip

Reuse the existing `saveConfig` plumbing unchanged in shape — only the payload
grows. On submit, collect the table into:

```ts
config.accountFees = {
  "<work-uuid>":     { monthlyFee: 125, currency: "EUR", label: "Work" },
  "<personal-uuid>": { monthlyFee: 214, currency: "EUR", label: "Personal" },
};
```

The extension-side merge currently shallow-merges per top-level key
([panel.ts](../../../packages/cli/src/extension/panel.ts) `saveConfig` handler).
Add `accountFees` to that merge list so a save that omits it doesn't wipe it, and
so a partial update (one account) merges rather than replaces:

```ts
accountFees: incoming.accountFees !== undefined
  ? { ...current.accountFees, ...incoming.accountFees }
  : current.accountFees,
```

Mirror the same key in the HTTP `POST /api/config` merge
([server/index.ts](../../../packages/cli/src/server/index.ts)). Both paths must
stay in sync — they are two front doors to the same config file.

After save, the panel already calls `refresh()`, which re-runs `buildDashboard`
with the new config — the Projects tab fee view updates immediately.

## 4.4 Backward compatibility

- If the user never opens the new table, `accountFees` stays absent and behaviour
  is **unchanged**: single `plan.monthly_fee` or `lookupPlanFee` auto-detection.
- The old `cfg-monthly-fee` field can remain as a labelled "Default fee
  (single-account / fallback)" so existing single-account users are undisturbed.
- Resolution order when distributing (codified in [03 §3.7](03-distribution-model.md)):
  `accountFees[uuid].monthlyFee` → `plan.monthly_fee` (only if one account) →
  `lookupPlanFee(subscriptionType)` → treat as 0 (account contributes no pool but
  still shows usage).

## 4.5 i18n

Every new string (`Subscriptions`, `Monthly fee`, `Currency`, `Label`,
`Idle subscription`, `Total configured`, …) is user-facing and must be added to
**every** locale, generated locally — the repo's parity check fails on drift (see
the project's translation policy). Budget for this in the implementation
([06 §6.4](06-implementation-plan.md)); it is the single largest source of "looks
done but CI is red."
