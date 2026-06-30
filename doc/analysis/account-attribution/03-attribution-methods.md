# 03 — Attribution methods

Four methods, layered. Each is independently useful; together they triangulate.
The ordering is by reliability, and conveniently also by implementation effort
(cheapest first).

A key enabling fact makes this tractable **within a single surface**:

> **The CLI allows only one logged-in account at a time.** Switching is an
> explicit logout/login. Therefore CLI account-active intervals are **disjoint** —
> they never overlap. Attribution of CLI sessions reduces to *partitioning a
> timeline into single-account intervals*, far easier than de-mixing concurrent
> streams.

> ⚠️ **This does NOT hold across surfaces.** The CLI and the IDE extension
> authenticate independently and can be logged into **different accounts at the
> same time** ([07](07-multi-surface-accounts.md)). So everything below applies
> **per surface**: first split sessions by `entrypoint` (`cli`/`claude` vs
> `claude-vscode`); the timeline method attributes the **CLI** surface only; the
> extension surface is not attributable from disk and needs OTEL or a user label.
> The `~/.claude.json` observations track the CLI account, **not** the
> extension's.

## A. Account-observation timeline (primary, reliable forward)

The backbone. claude-stats already reads `oauthAccount`
(`packages/cli/src/account.ts`). The change is to **persist what it reads, every
time, with a timestamp**, and to read it often enough to catch switches.

1. **Observe.** On every collection run, and on every change to
   `~/.claude.json` (watch its mtime — see below), read `oauthAccount` and
   append an `account_observation { account_uuid, org_uuid, email_hash,
   rate_limit_tier, billing_type, observed_at, source }` row — but only when the
   `account_uuid` differs from the previous observation (dedupe; the file is
   rewritten constantly for unrelated reasons).
2. **Derive intervals.** Sort observations by `observed_at`. Consecutive
   observations of the same account collapse into one interval; a change in
   `account_uuid` closes the prior interval and opens a new one. The result is a
   disjoint cover: `[t0,t1) → A`, `[t1,t2) → B`, …, `[tn, ∞) → current`.
3. **Assign.** For each message (precise `timestamp`), find the covering
   interval → that account. Roll message attributions up to session and window
   level (a session that straddles a switch — rare — is split at the boundary,
   not force-assigned whole).

**Why this is reliable forward:** switches happen at human cadence (minutes to
weeks apart); messages are millisecond-stamped; the only ambiguity is the gap
between the *true* switch and the *next observation* of it. Shrinking that gap is
the watcher's job.

### Catching switches promptly — the watcher

mtime of `~/.claude.json` is **noisy** (it changes on nearly every interaction),
so it is a *trigger to re-read*, not a switch signal. The switch signal is the
**`account_uuid` value changing** between reads. Options, cheapest first:

- **Poll on collect** (zero new infra): re-read at each collection. Bounds error
  to the collection interval.
- **mtime debounce** (cheap): a lightweight watcher fires on `~/.claude.json`
  writes, debounced; re-reads `oauthAccount`; records only on uuid change.
- **fs event watch** (tightest): native FSEvents/inotify on the one file.

Even the cheapest option is exact *except* for usage produced between a switch
and the next collection — a window the user can also close manually
([04](04-data-model-and-algorithm.md)).

## B. Anchor pins (forward, high-confidence boundary sharpening)

Observations bound *when* a switch happened to within the observation gap.
**Anchors** pin specific sessions to specific accounts at exact moments, tightening
those bounds:

- **`projects` map pins.** When `oauthAccount` is read, also snapshot
  `projects[*].lastSessionId` + `lastSessionModified`. Each is a
  `(sessionId, time, current_account)` pin — ground truth that *this* session
  belonged to *this* account. A pin that lands inside a fuzzy interval boundary
  moves the boundary to it.
- **Live-session pins.** A running `~/.claude/sessions/<pid>.json` gives a
  `sessionId` known to be active *right now*, so it belongs to the
  currently-read account with certainty. Recording these during collection
  yields the strongest forward pins.

Anchors don't replace the timeline; they reduce its uncertainty to near zero at
the points that matter (the boundaries).

## C. OTEL (authoritative, opt-in)

If the user enables `CLAUDE_CODE_ENABLE_TELEMETRY=1` with a destination
claude-stats can read (a local OTLP file/collector, or a metrics endpoint it
scrapes), every API-request event arrives pre-stamped with
`user.account_uuid` + `session.id` + tokens + model + timestamp. That is
attribution with **no inference at all**.

Role in the design:

- When present, OTEL is **ground truth**: it overrides inferred attribution and
  is used to *validate* the timeline method (any disagreement is a bug or a
  missed switch — surface it, [05](05-reliability-validation-and-limitations.md)).
- It is **opt-in and forward-only** (does nothing for past data, needs setup),
  so it is an enhancement, not the baseline. Recommend it to users who want
  certainty or who switch accounts often.

## D. Legacy backfill (best-effort, confidence-scored)

For sessions predating observation there is no recorded account. Honest options,
strongest to weakest:

1. **Single-account fast-path.** If only one account has ever been observed and
   the user confirms the machine was single-account until date *D*, attribute
   all pre-*D* usage to that account at **high** confidence. (Often the real
   situation — a second account was added recently.)
2. **Backup anchor.** If `~/.claude.json.backup` holds a *different* account
   than current, it is one real historical `(account, date)` point. Use it.
   (On the inspected machine it did not differ — so this is opportunistic.)
3. **Switch-point inference.** Partition the `history.jsonl` timeline at
   plausible re-auth boundaries: long idle gaps that coincide with a Claude Code
   restart (`numStartups` increments, new `sessions/` pids, version bumps).
   These are **weak** alone → **low** confidence, never silent.
4. **`userID` fingerprinting** *(only if A.3 is confirmed account-derived).* If
   the 64-hex `userID` proves to change with the account, historical config
   backups / any cached copies bearing old `userID` values become real anchors.
   Verify first.
5. **Manual range labelling.** Let the user paint a date range as "Account A."
   This is the highest-confidence backfill of all and the correct escape hatch
   for ambiguous history.

## How they combine

Per session/message, attribution resolves in priority order:

```
user override always wins   → source=override,      confidence=authoritative
OTEL event                  → source=otel,          confidence=authoritative
telemetry event             → source=telemetry,     confidence=high
live/anchor pin             → source=anchor,        confidence=high
covering interval           → source=observation,   confidence=high
backfill rule               → source=backfill,      confidence=low|medium
else                        → source=unknown,       confidence=none  (surfaced, never hidden)
```

**Canonical precedence:** `override > otel > telemetry > anchor > observation > backfill > unknown`.

The next file specifies the schema and the assignment algorithm.
