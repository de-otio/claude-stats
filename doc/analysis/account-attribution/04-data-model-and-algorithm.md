# 04 — Data model and algorithm

The good news: most of the storage already exists. This phase mostly *fills in*
columns the schema already declares and adds two small tables.

## What already exists (verified in `packages/cli/src/store/index.ts`)

- `sessions.account_uuid`, `sessions.organization_uuid`,
  `sessions.subscription_type` — added in **migration V3**, currently always
  `NULL` (the parser never sets them).
- `usage_windows.account_uuid` — added in **V7**. **Important:** windows are
  keyed on `window_start` only and carry the account of the first session in the
  window; they are **not** split per account today. Per-account window keying is
  explicitly out of scope (documented in ASSUMPTIONS.md §7). Attribution's
  `reattribute` command will recompute windows in the affected range so they
  reflect corrected session accounts.
- `updateSessionAccounts(mapping)` — already backfills those session columns,
  and deliberately only writes **where `account_uuid IS NULL`** (idempotent;
  never clobbers a known value). This is the exact hook attribution needs.
- Query layer already accepts an `accountUuid` filter.
- Migration framework: `PRAGMA user_version`, sequential `migrateToVN()`;
  schema is at **V12**, so account-attribution work lands as **V13**.

So the engine has been wired for per-account data from the start — only the
*population* path is missing.

## New tables (migration V13)

```sql
-- One row per distinct account ever observed locally.
CREATE TABLE IF NOT EXISTS accounts (
  account_uuid        TEXT PRIMARY KEY,
  organization_uuid   TEXT,
  email_hash          TEXT,            -- sha256(email); raw email never stored
  email_label         TEXT,            -- optional user-set display label
  organization_type   TEXT,            -- e.g. claude_max, team
  rate_limit_tier     TEXT,            -- e.g. default_claude_max_20x
  billing_type        TEXT,            -- e.g. stripe_subscription
  first_observed_at   INTEGER,
  last_observed_at    INTEGER
);

-- Append-only log of account snapshots. Deduped on value-change only.
CREATE TABLE IF NOT EXISTS account_observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid        TEXT NOT NULL,
  observed_at         INTEGER NOT NULL,   -- epoch ms
  source              TEXT NOT NULL,      -- 'collect' | 'watch' | 'live-session' | 'backup' | 'otel' | 'manual'
  surface             TEXT,               -- 'cli' | 'vscode' | 'cursor' | … (which login slot; see doc 07)
  rate_limit_tier     TEXT,
  billing_type        TEXT
);
CREATE INDEX IF NOT EXISTS idx_acct_obs_time ON account_observations (observed_at);
```

## New columns (migration V13)

Attribution must record *how sure* it is and *why* — otherwise it is
indistinguishable from the existing always-`NULL` state.

```sql
ALTER TABLE sessions ADD COLUMN account_source     TEXT;   -- see priority order
ALTER TABLE sessions ADD COLUMN account_confidence TEXT;   -- authoritative|high|medium|low|none
-- messages stay attributable via their session; add columns only if a session
-- is observed to straddle a switch (then per-message resolution is needed).
ALTER TABLE messages ADD COLUMN account_uuid TEXT;         -- usually NULL = inherit session
```

`accounts` / `account_observations` are local to `~/.claude-stats/stats.db`; no
new external surface. Email is **hashed** at rest (`email_hash`); a human label
is opt-in (`email_label`). See [05](05-reliability-validation-and-limitations.md).

## The observation writer

```
on collect (and on debounced ~/.claude.json change):
  acct = readClaudeAccount()                 # existing account.ts
  if acct is null: return                    # API-key / unauthenticated → no oauthAccount
  upsert accounts(acct)                       # refresh last_observed_at, tier, billing
  prev = last row of account_observations
  if prev is null or prev.account_uuid != acct.accountUuid:
      insert account_observation(acct, now, source)   # record switches only
  # also snapshot anchors:
  for p in claude.json.projects:
      if p.lastSessionId: record_pin(p.lastSessionId, p.lastSessionModified, acct.accountUuid)
  for s in ~/.claude/sessions/*.json (live):
      record_pin(s.sessionId, now, acct.accountUuid)   # strongest: known-active now
```

Dedupe-on-change keeps the table tiny (one row per *switch*, not per collect)
despite `~/.claude.json` being rewritten constantly.

## The assignment algorithm

```
cli_intervals = build_intervals(observations where surface == 'cli')  # per-surface; see below
pins          = load_anchor_pins()                   # (sessionId → account, time)

for session in sessions where account_uuid is null:
    t0, t1 = session.first_timestamp, session.last_timestamp

    # 1. authoritative
    if otel_has(session): assign(session, otel_account, 'otel', 'authoritative'); continue

    # 2. anchor pin (exact)
    if session.id in pins: assign(session, pins[session.id], 'anchor', 'high'); continue

    # 3. surface gate — the disk timeline only knows the CLI account (doc 07)
    if session.entrypoint == 'claude-vscode':   # IDE extension surface
        # account lives in editor SecretStorage, not on disk → not inferable
        assign(session, None, 'unknown', 'none')   # resolved only by OTEL or user label
        continue

    # 4. observation interval (CLI surface only)
    covering = cli_intervals covering [t0, t1]
    if covering is a single account:
        assign(session, covering, 'observation', 'high')
    elif covering spans a switch:
        split_session_at_boundary(session, covering)   # rare; per-message account_uuid
        assign each part ('observation', 'high')
    else:                                               # before first observation
        a, c = backfill(session)                        # §D of doc 03
        assign(session, a, 'backfill', c)               # c ∈ {medium, low}

# windows: a 5-h UsageWindow inherits the account of the messages it contains;
# a window straddling a switch is split (it already keys on account_uuid).
```

`build_intervals`: sort observations by time; emit `[obs[i].t, obs[i+1].t)` →
`obs[i].account`; final interval `[obs[n].t, +∞)` → current account. Because
**CLI** logins are exclusive, this is a clean partition **for CLI sessions** — no
overlap resolution needed. It must **not** be applied to `claude-vscode`
sessions, whose account is invisible on disk ([07](07-multi-surface-accounts.md)).

### Reusing the existing hook

Steps 1–3 produce exactly the `Map<sessionId, {accountUuid, organizationUuid,
subscriptionType}>` that `updateSessionAccounts()` already consumes. Extend that
method (or a sibling) to also write `account_source` / `account_confidence`.
Because it only updates `WHERE account_uuid IS NULL`, re-running is safe and a
later, higher-confidence pass can be allowed to upgrade low-confidence rows by
relaxing that guard for `account_confidence IN ('low','medium')`.

## Reconciliation with existing implementation

The schema columns `sessions.account_uuid`, `sessions.organization_uuid`, and
`sessions.subscription_type` have existed since **V3** (2023). The
**surface-blind fallback** that previously populated them (stamping the
current-at-first-collect account from `~/.claude.json` onto every session
regardless of surface or timestamp) has been **removed atomically in Phase 1**.
The new attribution engine replaces it with an observation-based method that:

1. **Records observations** in the new `account_observations` table (append-only
   log, deduped on value-change).
2. **Assigns by timeline interval** for CLI-surface sessions only, using the
   canonical precedence: `override > otel > telemetry > anchor > observation >
   backfill > unknown`.
3. **Records confidence and source** in the new `account_source` and
   `account_confidence` columns added to `sessions` in V13.
4. **Handles non-CLI surfaces** by assigning them to `unknown` unless OTEL /
   telemetry / anchor provides an account.
5. **Recomputes windows** using `recomputeWindowsInRange` when accounts are
   corrected, so `usage_windows` reflect the final per-account attribution.

Telemetry is wired as a real source (fixed parser in Phase 2, B2). The `account`
command reads the new `accounts` table to show per-account summaries with
tier/billing/seat labels.
