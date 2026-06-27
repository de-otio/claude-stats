# 02 — Data model and the accuracy that bounds the feature

The whole feature rests on one join: **session → account**. Its quality is the
ceiling on attribution accuracy. This document maps where account identity comes
from, how trustworthy it is, and the config schema that holds the per-account
fees.

## 2.1 Where `account_uuid` comes from

There is no account field in the JSONL transcripts Claude Code writes — the
scanner ([scanner/index.ts](../../../packages/cli/src/scanner/index.ts)) never
sees one. Account identity is attached *after* parsing, from two sources, in
priority order ([aggregator/index.ts:140-152](../../../packages/cli/src/aggregator/index.ts#L140-L152)):

1. **Telemetry (best-effort, accurate-when-present).**
   [`collectAccountMap()`](../../../packages/core/src/parser/telemetry.ts) reads
   `~/.claude/telemetry/1p_failed_events*.json` and extracts
   `accountUUID` / `organizationUUID` / `subscriptionType` keyed by `session_id`.
   This is *correct per session* — it records the account that actually ran the
   session. **But** only *failed-to-send* telemetry events are retained on disk,
   so coverage is partial and non-deterministic.

2. **`~/.claude.json` fallback (current account only).**
   When telemetry has no match, the aggregator stamps the session with
   [`readClaudeAccount()`](../../../packages/cli/src/account.ts#L17) — i.e. the
   account **currently logged in**, which is whatever account is active at
   *collection time*, not necessarily the one that ran the session.

The store preserves whichever value landed first via `COALESCE`
([store/index.ts:465-467](../../../packages/cli/src/store/index.ts#L465-L467)),
so a later collection won't overwrite a good telemetry attribution with the
fallback.

## 2.2 The attribution caveat — and why it matters here more than elsewhere

For a single-account user the fallback is harmless: there is only one account, so
"current account" is always right. **For this user it is the central risk**,
because the feature's whole premise is two accounts.

Failure mode: the user runs work sessions logged into the work account, later
switches to the personal account, then `claude-stats` collects. Any work session
*without* retained telemetry gets stamped with the **personal** account UUID by
the fallback — and its usage (and therefore its fee share) is attributed to the
wrong pool. Work fee under-counts; personal fee over-counts.

Implications for the design:

- **Be honest in the UI.** The fee-by-project view must be able to show an
  `(unknown)` / `(unattributed)` bucket — the code already produces an
  `(unknown)` account key ([dashboard/index.ts:755](../../../packages/cli/src/dashboard/index.ts#L755)).
  Do not hide it; a large unknown bucket is the user's signal that attribution is
  weak for that period.
- **Telemetry coverage is the accuracy dial.** Worth surfacing (even just in
  docs) that better coverage comes from collecting *while logged into each
  account* so the fallback stamps the right one. This is the one operational
  habit that improves the numbers.
- **Don't over-promise precision.** The fee split is "good enough to reason
  about and bill against," not forensic accounting. The currency choice (§2.3)
  reinforces this: the fee is exact (the user typed it), the *split* is an
  estimate.

There is already a transitional repair for the common case: when the store holds
exactly one `(unknown)` account and the current `~/.claude.json` account is
known, the dashboard reassigns it
([dashboard/index.ts:829-834](../../../packages/cli/src/dashboard/index.ts#L829-L834)).
That heuristic is safe for one account but must **not** be extended to guess
between two — guessing would manufacture false precision.

## 2.3 Config schema change

Today ([config.ts:18-21](../../../packages/cli/src/config.ts#L18-L21)):

```ts
plan?: {
  type?: PlanType;
  monthly_fee?: number;   // single global fee, currency-agnostic (assumed USD)
};
```

Proposed — add a keyed-by-account map while keeping the old field for backward
compatibility:

```ts
interface AccountFee {
  /** Monthly subscription fee, in `currency`. The amount actually paid. */
  monthlyFee: number;
  /** ISO 4217, e.g. "EUR" | "USD". Default "USD". Not converted — display only. */
  currency?: string;
  /** Friendly label the user controls, e.g. "Work", "Personal".
   *  Needed because only the *current* account's email is known
   *  (readClaudeAccount); other accounts are known only by UUID. */
  label?: string;
}

interface Config {
  // ...existing...
  plan?: {
    type?: PlanType;
    monthly_fee?: number;                  // kept: global default / single-account fallback
  };
  /** Per-account subscription fees, keyed by account_uuid. */
  accountFees?: Record<string, AccountFee>;
}
```

Design notes:

- **Keyed by `account_uuid`, not email.** UUID is stable and is what the store
  holds for *all* accounts; email is only known for the current one
  ([account.ts:25](../../../packages/cli/src/account.ts#L25)). The `label` field
  exists precisely so the user can put a human name on a non-current account's
  UUID.
- **Currency is per account and never auto-converted.** €125 stays €125. The app
  is internally USD for *estimated* costs, but the fee is a *paid* amount in the
  user's real currency. Mixing a EUR fee into a USD estimate would be a category
  error. If both accounts share a currency (the common case) the Projects tab can
  show a single total (€339); if they differ, show per-currency subtotals rather
  than summing. See [03 §3.5](03-distribution-model.md).
- **Backward compatible.** If `accountFees` is absent, fall back to the existing
  `plan.monthly_fee` applied to the single/dominant account, then to
  `lookupPlanFee` auto-detection — exactly today's behaviour.
- **No store migration.** Config is free-form JSON
  ([config.ts:105-122](../../../packages/cli/src/config.ts#L105-L122)); adding a
  key needs no schema bump. The `account_uuid` columns already exist.
