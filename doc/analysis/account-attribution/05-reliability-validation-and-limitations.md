# 05 — Reliability, validation, and limitations

## Confidence model

Every attributed session/window carries `account_source` and
`account_confidence`. The contract:

| Confidence | Meaning | Produced by |
|---|---|---|
| `authoritative` | Account came from a record that *names* it | OTEL event; user override |
| `high` | Inferred from a disjoint single-account interval or an exact pin | observation interval; anchor pin |
| `medium` | Inferred from a defensible backfill rule | single-account fast-path; differing backup anchor |
| `low` | Inferred from a weak heuristic | switch-point/gap inference |
| `none` | Could not attribute | pre-observation, no rule applies |

Dashboards must **show** confidence, not bury it — e.g. a small badge on
per-account totals, and an explicit "unattributed" bucket for `none`. This is the
"no verification theatre" rule: a guess is labelled a guess.

## Validation strategy

Attribution is testable, and must be tested before any per-account number is
shown as fact:

1. **OTEL as oracle.** When OTEL is enabled, compute the inferred attribution
   *ignoring* OTEL, then diff against OTEL ground truth. Any mismatch = a missed
   switch or a boundary error → log it, lower confidence, and (in dev) fail a
   test. This is the strongest check and the reason to recommend OTEL even to
   users who don't otherwise need it.
2. **Totals reconciliation.** `~/.claude/stats-cache.json` holds Claude Code's
   own account-*mixed* daily/model rollups. Sum claude-stats' per-account
   attribution back to a machine total and assert it matches stats-cache within
   tolerance. Catches *dropped* or *double-counted* usage even though it can't
   validate the *split*.
3. **Boundary sanity.** No session may be assigned an account whose interval
   doesn't cover its timestamps. No two overlapping intervals (would violate the
   single-login invariant — a parser/observation bug).
4. **Throttle/limit correlation.** The parser already records `throttleEvents`
   and `UsageWindow.throttled`. The account that hit a wall is the one logged in
   then; a throttle cluster should fall inside that account's interval. A
   throttle attributed to an idle account is a red flag for a missed switch.
5. **Property tests.** Pin sources of nondeterminism (freeze the clock, fixed
   observation fixtures) and assert: intervals partition the line; assignment is
   stable; re-running attribution is idempotent; a synthesized switch is detected
   to within the observation gap. (Aligns with the repo's testing defaults.)

## Failure modes and mitigations

| Failure | Cause | Mitigation |
|---|---|---|
| Usage between a switch and the next read mis-attributed | observation gap | tighten with the mtime watcher / live-session pins; allow manual range fix |
| All legacy data lumped to one account | no recorded history before observation | single-account fast-path only with user confirmation; otherwise `low`/`none`, never silent `high` |
| `service_tier`/`inference_geo` assumed to separate accounts | they're **constant** on real data ([02](02-signal-inventory.md)) | do **not** build on them; documented as rejected |
| `userID` used as an account key but it's machine-derived | unverified ([02 A.3](02-signal-inventory.md)) | gate any use behind a confirmed cross-account observation |
| Two accounts, one never logged in while observing | tool only ever sees one | clearly mark the machine "single account observed"; don't fabricate a second |
| `oauthAccount` absent (API-key auth) | no snapshot exists | attribute `none`; never assign by proximity |

## Limitations (state them plainly)

0. **IDE-extension usage is unattributable from disk** (the hard one — see
   [07](07-multi-surface-accounts.md)). The CLI and the extension authenticate
   independently and can be on **different accounts at once**; the extension's
   account lives in encrypted editor SecretStorage, never in `~/.claude.json`.
   So the entire local-inference method covers the **CLI surface only**.
   `claude-vscode` sessions can be attributed *only* by OTEL or a user label —
   for many users (IDE-primary) that is the majority of usage. This caps how far
   a disk-only design can go.
1. **The past is not fully recoverable.** `~/.claude.json` keeps **no account
   history** and its lone `.backup` may (and on the inspected machine does) hold
   the *same* account. Pre-observation attribution is therefore best-effort.
   Reliable attribution begins the day claude-stats starts observing.
2. **Forward attribution is exact except in the switch→read gap**, which the
   watcher shrinks but does not eliminate without OTEL.
3. **OTEL is opt-in and forward-only.** It makes attribution authoritative but
   does nothing for history and requires user setup.
4. **No purely-offline link from a transcript to an account exists.** `requestId`
   is backend-resolvable only. Anyone expecting the JSONL alone to reveal the
   account will be disappointed — hence the timeline approach.

## Privacy

- `account_uuid` and email are personal data. Store **email hashed**
  (`email_hash`); keep a raw label only if the user opts in (`email_label`).
- All account data stays in the local `~/.claude-stats/` store. Nothing about
  accounts is transmitted; if/when the team-sync features
  ([../team-app](../team-app/)) sync data, account identifiers must be opt-in and
  follow the existing share-level controls.
- Honour the existing prompt-sanitisation posture: account labels are metadata,
  not prompt content, but the same "local by default" rule applies.
