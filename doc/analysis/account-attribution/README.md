# Account Attribution

**Question:** Claude Code only supports one logged-in account at a time, and a
single machine is often used by more than one account over its lifetime (e.g. a
work account and a personal account, swapped via logout/login). The session
transcripts claude-stats ingests **do not record which account produced them**.
Can we attribute each session's usage to the correct account *reliably*, using
only the signals already present on disk?

**Answer:** Yes — going forward — and with a clear, bounded reliability story:

- **Reliable forward attribution** is achievable by recording the logged-in
  account (`~/.claude.json` → `oauthAccount`) on every collection run and
  building an *account-observation timeline*, then assigning each
  timestamped message to the account whose observation interval covers it.
  Account switches are rare and message timestamps are precise, so once
  claude-stats is observing, attribution is effectively exact.
- **Authoritative attribution** (100%, per-event) is available opt-in via
  Claude Code's OpenTelemetry export, whose events carry
  `user.account_uuid` + `session.id` + tokens + model + timestamp together.
- **Legacy backfill** (sessions that predate observation) is *best-effort*
  and confidence-scored — the config file keeps no account history, so the
  past cannot be fully reconstructed from it.

> ⚠️ **Per-surface caveat (see [07](07-multi-surface-accounts.md)).** "One
> account at a time" holds only for the **CLI**. The CLI and the IDE extension
> authenticate independently (separate credential stores) and can be logged into
> **different accounts concurrently**, and the extension's account is **not
> stored on disk**. So local inference attributes the **CLI surface only**;
> `claude-vscode` usage needs **OTEL** or a user label. This makes OTEL the only
> mechanism that covers every surface.

This folder is a feasibility + design analysis. It is grounded in direct
inspection of the data on a real machine (see [02](02-signal-inventory.md));
every "present / absent / constant" claim was verified, not assumed.

> Privacy note: an account UUID and email are personal data. This analysis
> keeps all account data **local** to the existing `~/.claude-stats/` store and
> recommends hashing the email at rest. No account identifiers are sent
> anywhere. See [05](05-reliability-validation-and-limitations.md).

## Contents

1. [Problem and goal](01-problem-and-goal.md) — why per-account attribution
   matters, the core obstacle, and the reliability bar.
2. [Signal inventory](02-signal-inventory.md) — every on-disk signal, verified,
   with a cardinality/reliability rating. What discriminates and what doesn't.
3. [Attribution methods](03-attribution-methods.md) — the observation timeline,
   anchor pins, OTEL ingestion, and legacy backfill — and how they triangulate.
4. [Data model and algorithm](04-data-model-and-algorithm.md) — schema
   additions and the interval-assignment algorithm; reconciles the already-present
   `accountUuid`/`organizationUuid`/`subscriptionType` null fields.
5. [Reliability, validation and limitations](05-reliability-validation-and-limitations.md)
   — confidence scoring, cross-checks, failure modes, privacy.
6. [Recommendation and rollout](06-recommendation-and-rollout.md) — a phased
   plan, lowest-effort-first, and the immediate plan-tier win.
7. [Multi-surface accounts](07-multi-surface-accounts.md) — **important
   correction:** the CLI and the IDE extension log in independently and can be on
   different accounts at once; the extension's account is not on disk. Scopes the
   whole method to "per surface."

## TL;DR verdict

| Mechanism | Per-account? | Reliability | Effort | When |
|---|---|---|---|---|
| `oauthAccount` observation timeline | yes (**CLI surface only**) | high (forward) | low | Phase 1 |
| Anchor pins (`projects` map, live `sessions/`) | yes (CLI) | high (forward) | low | Phase 2 |
| OpenTelemetry ingestion | yes (**all surfaces**) | authoritative | medium (opt-in) | Phase 3 |
| IDE-extension account from disk | — | **impossible** (encrypted SecretStorage) | — | needs OTEL / label |
| Legacy switch-point backfill | yes | low–medium | medium | Phase 2 |
| `service_tier` / `inference_geo` clustering | weak | **not usable here** (constant) | — | rejected |

The plan-tier sub-question that motivated this ("is my work plan premium or
standard?") is answered **directly, today** by one field —
`oauthAccount.organizationRateLimitTier` — no attribution required. See
[06](06-recommendation-and-rollout.md#immediate-win).
