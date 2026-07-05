# 06 — Recommendation and rollout

## Verdict

**Build it — forward attribution is reliable and cheap.** The store is already
wired for per-account data (V3 columns, `usage_windows.account_uuid`,
`updateSessionAccounts()`, account-filtered queries). The only missing piece is
recording the account over time and assigning by timestamp. Do **not** attempt
to derive the account from hidden transcript signals — the fields that could
have done so (`service_tier`, `inference_geo`) are constant on real data.

## Phased plan (lowest effort first)

**Phase 0 — capture now (1 small change).** Start writing `account_observations`
+ `accounts` on every collect, deduped on account change (reuses the existing
`readClaudeAccount()`). Even before any assignment logic ships, this begins
accruing the timeline — every day of delay is history we can never reconstruct.
*This is the single most time-sensitive step.*

**Phase 1 — forward assignment (V13).** Add the two tables, the
`account_source`/`account_confidence` columns, `build_intervals`, and the
assignment pass feeding the existing `updateSessionAccounts()`. Surface a
per-account breakdown + an "unattributed" bucket in the dashboard.

**Phase 2 — sharpen + backfill.** Add the mtime watcher and live-session/`projects`
pins (tighten switch boundaries). Add the legacy backfill rules
([03 §D](03-attribution-methods.md#d-legacy-backfill-best-effort-confidence-scored))
and a **manual range-labelling** UI — the highest-confidence fix for ambiguous
history.

**Phase 3 — OTEL (opt-in, authoritative — and the *only* path for IDE usage).**
Offer a guided `CLAUDE_CODE_ENABLE_TELEMETRY` setup with a local destination
claude-stats ingests. Use it as ground truth, as the validator for Phases 1–2
([05](05-reliability-validation-and-limitations.md)), **and** as the sole
reliable way to attribute IDE-extension (`claude-vscode`) sessions, whose account
is not on disk ([07](07-multi-surface-accounts.md)). For IDE-primary users this
phase is not optional — it is the difference between attributing a few percent of
usage and attributing all of it. Until then, label the extension surface
manually.

> **Surface caveat:** Phases 1–2 attribute the **CLI** surface only. See
> [07](07-multi-surface-accounts.md) — the CLI and the extension can hold
> different accounts at once, and the extension's account is invisible locally.

## Verify before relying

One open item gates a possible shortcut: **does the top-level `userID` (64-hex)
change with the account?** Confirm by reading `~/.claude.json` under a second
account and comparing. If it is account-derived, it becomes a
privacy-preserving per-account fingerprint useful for backfill
([02 A.3](02-signal-inventory.md)). Until confirmed, do not build on it.

## Immediate win

The sub-question that started this — **"is my work plan premium or standard,
and is that why I'm hitting limits?"** — needs no attribution at all. The plan
tier is sitting in plain text in `~/.claude.json`:

```
oauthAccount.organizationType          # e.g. claude_max, team
oauthAccount.organizationRateLimitTier # e.g. default_claude_max_20x
oauthAccount.userRateLimitTier         # per-seat tier (Team)
oauthAccount.seatTier                  # Team seat: premium vs standard
oauthAccount.billingType               # stripe_subscription vs api
oauthAccount.hasExtraUsageEnabled      # overage on/off
```

To answer it: **log into the work account and read those fields** (the value
reflects whoever is logged in). Comparing the two accounts' `*RateLimitTier` /
`seatTier` is a direct, documented answer — no inference, no waiting for a
timeline to accrue. claude-stats should expose this as a one-shot
`account` status command and a dashboard card immediately, independent of the
attribution work above.

> Published limit ratios for context (cite, don't hard-code — they change):
> per Anthropic's plan docs, Team *premium* seats carry materially higher
> weekly/usage limits than *standard* seats, and Max 20x higher still. The
> exact multipliers belong in [pricing.ts](../../../packages/core/src/pricing.ts)
> behind a dated source comment, not scattered in UI copy.

## Sources

Anthropic documentation consulted for this analysis:

- Claude Code — Authentication: https://code.claude.com/docs/en/authentication.md
- Claude Code — Monitoring (OpenTelemetry): https://code.claude.com/docs/en/monitoring-usage.md
- Claude Code — Costs & usage: https://code.claude.com/docs/en/costs
- Claude Code — Models, usage & limits: https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code
- Claude — How usage and length limits work: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- Claude Code with Pro/Max: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Team plan overview: https://support.claude.com/en/articles/9266767-what-is-the-team-plan
- API rate limits: https://platform.claude.com/docs/en/api/rate-limits

> Items flagged by research as **not** documented (treat as heuristics, not
> facts): the exact ~5-hour window duration; the precise Statsig/`userID`
> identifier scheme; whether OTEL emits identifiers for non-OAuth auth.
