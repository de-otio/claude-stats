# 02 — Signal inventory

Every candidate signal, **verified by direct inspection** of a real machine
(`~/.claude.json`, `~/.claude/`, and a sample of session JSONL spanning the
oldest and newest files). The point of this page is to separate signals that
actually discriminate accounts from ones that only look like they might.

## A. The authoritative local snapshot — `~/.claude.json` → `oauthAccount`

The single richest source. It describes the **currently logged-in** account
(19 fields observed). The account-relevant ones:

| Field | Example (observed) | Use |
|---|---|---|
| `accountUuid` | UUID (36 ch) | **primary account key** |
| `organizationUuid` | UUID (36 ch) | org key (Team/Max org) |
| `emailAddress` | `<user>@<domain>` | human label (PII — hash at rest) |
| `organizationType` | `claude_max` | plan family |
| `organizationRateLimitTier` | `default_claude_max_20x` | **plan/limit tier** |
| `userRateLimitTier` | `null` | per-seat tier (Team) |
| `seatTier` | `null` | Team seat (premium/standard) |
| `billingType` | `stripe_subscription` | subscription vs API |
| `hasExtraUsageEnabled` | `false` | overage flag |
| `accountCreatedAt`, `subscriptionCreatedAt` | ISO dates | tie-breakers |

**Crucial property and crucial limitation:** this object is overwritten on every
login. `~/.claude.json` is rewritten constantly (its `projects` map and counters
update throughout a session), but `oauthAccount` only *changes value* when the
account changes. So:

- ✅ Reading it **now** gives an exact (account, time-of-read) datapoint.
- ✅ Reading it **repeatedly over time** yields the account-observation timeline
  that the whole method rests on ([03](03-attribution-methods.md)).
- ❌ It contains **no history**. You cannot recover which account was active last
  week from today's file.

### A.1 The lone backup — `~/.claude.json.backup`

Exactly one backup exists, from a past date. On the inspected machine its
`oauthAccount` was the **same** account as current (same `accountUuid`,
`userID`, `machineID`; only `numStartups` differed). So in practice the backup
is a periodic copy, **not** a guaranteed snapshot of the *other* account. Treat
it as a single extra dated anchor — useful if it happens to differ, worthless if
it doesn't. Do not rely on it.

### A.2 `projects` map — per-project last-session pins

`~/.claude.json` → `projects[<path>]` (68 entries observed, 54 with a session)
carries per-project last-run telemetry: `lastSessionId`, `lastSessionModified`,
`lastCost`, `lastModelUsage`, `lastTotal*Tokens`, `lastSessionFirstPrompt`.
There is **no account field per project**. Its value: each entry pins a concrete
`lastSessionId` to a `lastSessionModified` time. Combined with the
account-observation timeline, that yields exact `(sessionId → account)` ground
truth at observed moments — but only for the account that was logged in when the
snapshot was taken (the map persists across logins, so it is **not**
self-stamping with an account).

### A.3 `userID` (top-level, 64-hex) — candidate fingerprint, unverified

`~/.claude.json` has a top-level `userID` that is a 64-char hex hash (distinct
from the separate `machineID`, also 64-hex). On the inspected machine `userID`
was identical between current and backup — but both were the *same* account, so
this does **not** establish whether `userID` is account-derived or
machine-derived. **Hypothesis to verify:** if `userID` is a hash of the account,
it changes on switch and would be a privacy-preserving per-account fingerprint
that could even help backfill. **Must be confirmed by observing it under a
second account before any reliance.** Until then: candidate only.

## B. Event streams

### B.1 OpenTelemetry (OTEL) — authoritative, opt-in

Claude Code can export OTEL metrics + logs (`CLAUDE_CODE_ENABLE_TELEMETRY=1`).
Per Anthropic's monitoring docs, events carry resource attributes
`user.account_uuid`, `organization.id`, `user.email`, `session.id` and metrics
`claude_code.token.usage` / `claude_code.cost.usage`, plus an API-request event
with model + token counts. This gives the **(account_uuid, session_id, tokens,
model, timestamp)** tuple *in one event* — authoritative, no inference. Not on by
default, so it cannot help with past data, but it is the gold standard going
forward. See [03 §OTEL](03-attribution-methods.md#c-otel-authoritative-opt-in).

### B.2 Telemetry — real per-session source when present

Claude Code writes `GrowthbookExperimentEvent` telemetry events carrying
`user_attributes.accountUUID`, `organizationUUID`, and `subscriptionType`. When
these events are present in the session log, they provide a real per-session
account signal. **Important clarification:** earlier assessment noted zero
telemetry-attributed sessions due to a **parser bug** (JSONL files parsed as
single JSON array) — now fixed in Phase 2. With the parser corrected, telemetry
sources account information for sessions where those events exist (currently
sparse, limited to failed-request events, but real when present). This source
ranks above anchor/observation in precedence: `override > otel > **telemetry** >
anchor > observation > backfill > unknown`.

## C. Timeline scaffolding (no account, but essential)

| Source | Path | What it gives |
|---|---|---|
| Session JSONL | `projects/<slug>/<sid>.jsonl` | per-message `timestamp` + `usage`; the records to be attributed |
| Global history | `~/.claude/history.jsonl` | 2085 prompts × {timestamp, project, sessionId} over ~4 months — a master ordering to place switch boundaries against |
| Live sessions | `~/.claude/sessions/<pid>.json` | running sessions: `sessionId`, `pid`, `procStart`, `startedAt`, `status` — enables **real-time** stamping: a live session + current `oauthAccount` = an exact pin |
| Per-session env | `~/.claude/session-env/<sid>.json` | 277 files keyed by sessionId; may capture env at start. **Not inspected deeply — captured env can contain secrets.** Potential but treat with care |

## D. Signals that look useful but are NOT (verified)

| Signal | Why it fails here |
|---|---|
| `message.usage.service_tier` | **Constant `"standard"`** across all sampled sessions. Could in principle differ if one account were on a priority tier, but it does not discriminate on this machine. |
| `message.usage.inference_geo` | **Constant `"not_available"`** — empty everywhere. No signal. |
| `userType` | Constant `"external"`. |
| `machineID` | Per-machine, identical across accounts by definition. Non-signal. |
| `requestId` (`req_…`) | Maps to a backend request; account is known only server-side. Opaque offline. |
| `stats-cache.json` | Claude Code's own 65-day rollup (`dailyActivity`, `modelUsage`, totals). Contains cost/tokens/sessionId but **no account/tier** — it is itself account-*mixed*. Useful only as a totals cross-check ([05](05-reliability-validation-and-limitations.md)). |
| `policy-limits.json` | Only feature restrictions / compliance flags. No rate-limit tier, no account. |
| Statsig cache | **Absent** on this machine (Claude Code uses GrowthBook now — `cachedGrowthBookFeatures`, 374 keys, lives in `~/.claude.json`). The earlier "distinct Statsig user IDs" idea does not apply. |

## E. Surface (`entrypoint`) — and the invisible editor account

`entrypoint` (per session: `cli`/`claude` vs `claude-vscode`) is **the** signal
that splits usage by surface — and it must be applied *before* any account
inference, because the surfaces have **independent logins**:

- **CLI** account → readable (`oauthAccount`, above).
- **IDE-extension** account → **not on disk.** Stored in the editor's encrypted
  SecretStorage (verified: `Code Safe Storage` / `Cursor Safe Storage` keychain
  items exist; the extension's `state.vscdb` globalState holds no plaintext
  account). The extension also runs in **Cursor**, so there are ≥3 login slots.

Full evidence, verdict, and design impact: [07](07-multi-surface-accounts.md).
This is the most consequential finding for the method.

## Summary

- **Exactly one local source knows the account: `oauthAccount`** — and only for
  the **CLI** surface, only for "now." The **IDE-extension** account is not on
  disk at all ([07](07-multi-surface-accounts.md)).
- The discriminating power of per-message fields (`service_tier`,
  `inference_geo`) that *could* have clustered accounts is **nil on real data**.
- Therefore the method cannot be "cluster the transcripts by a hidden account
  signal." It must be "**observe the account over time and assign by
  timestamp**," optionally upgraded to OTEL ground truth.
