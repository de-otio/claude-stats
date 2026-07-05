# Plan — Manual account labelling (historical split)

**Status:** proposed · **Depends on:** the merged attribution engine (#25) + its
follow-ups (backfill #29, anchor pins #31). **Precedence rank:** `override` — the
one rank the engine already reserves but does not yet produce.

> **Role:** hand-labelling ~960 sessions is impractical, so this is the **seed /
> fallback** for the automatic **seed-and-propagate** method in doc
> [09](09-historical-split-without-labelling.md) — used at *project* granularity
> for the residual projects propagation can't resolve, not for the bulk. Read 09
> first.

## Why

The observation timeline attributes **forward** usage; single-account backfill
(doc 03 §D.1) attributes pre-observation history **only when one account was ever
seen**. Neither can split a machine's *historical* usage across **two or more**
accounts (e.g. a personal Max plan and a work Team plan used before claude-stats
started observing). For that history the only honest signal is the **user's own
knowledge**, expressed as a label.

Manual labelling is doc 03 §D.5 — "the highest-confidence backfill of all and the
correct escape hatch for ambiguous history." It writes `source=override,
confidence=authoritative`, which the store already **preserves** across reattribute
and **never lets inference overwrite**. This plan adds the missing producer.

Goal, concretely: the user paints a **date range** (optionally scoped to a
project) → "this was Account A" → every session in that range is attributed to A,
authoritatively, and stays that way through re-collection and re-attribution.

## Model

A **label rule** is a durable statement `predicate → account`, stored so it (1)
applies to existing sessions at once, (2) re-applies to sessions collected later
that match, and (3) survives `reattribute`. Rules are the source of truth;
`sessions.account_uuid` (source `override`) is the derived write.

Predicate kinds (v1):

| kind | matches a session when… | typical use |
|---|---|---|
| `range` | `first_timestamp ∈ [from, to)` | "all of June was work" |
| `range` + `project` | in range **and** `project_path = P` | "project X in June was personal" |
| `session` | `session_id = S` | fix one misattributed session |

Dates are parsed in the user's timezone; `--to` is inclusive by day (stored as the
next day's 00:00 exclusive). `[from, to)` is matched on `first_timestamp` (session
start day) — whole-session, no per-message split in v1 (see Deferred).

**Overlap resolution** (deterministic): most-specific wins — `session` >
`range+project` > `range`; ties broken by most-recent `created_at`. The chosen
rule per session is computed in pure code and unit-tested.

## Data model — migration V15

```sql
CREATE TABLE IF NOT EXISTS account_label_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,              -- 'range' | 'session'
  account_uuid TEXT NOT NULL,
  from_ms      INTEGER,                    -- range start (inclusive), null for session
  to_ms        INTEGER,                    -- range end (exclusive), null for session
  project_path TEXT,                       -- optional scope for range rules
  session_id   TEXT,                       -- set for session rules
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_label_rules_range ON account_label_rules (from_ms, to_ms);
```

Additive + idempotent (`CREATE IF NOT EXISTS`), zero backfill — mirrors V13/V14.

## Store methods

- `createLabelRule(rule)` → id. `listLabelRules()` → rows. `deleteLabelRule(id)`.
- `applyOverride(mapping, now)` — writes `account_uuid / organization_uuid /
  source='override' / confidence='authoritative' / updated_at` for the given
  sessions **unconditionally** (a new statement WITHOUT the monotonic guard — an
  explicit label outranks every inferred *and* external source, per the
  precedence). This is the one deliberate exception to the guard; documented.
- `clearOverridesForRule(ruleId)` is **not** needed: `unlabel` deletes the rule
  then `reattribute` recomputes — sessions no longer covered by any rule fall
  back to inference (reset clears `override` too **only** when no rule re-asserts
  it; see reattribute wiring).

Note: `resetAttributableSessions` currently preserves `override`. For `unlabel`
to actually revert a session, reattribute must reset override rows **and** then
re-apply surviving rules. Adjust the reset to also clear `override` (rules are
re-applied immediately after in the same transaction, so a still-labelled session
is re-asserted and a no-longer-labelled one reverts to inference). This keeps
rules — not the derived column — the source of truth.

## Pure core — `attribution/labels.ts`

```
computeOverrides(sessions, rules) -> Map<sessionId, accountUuid>
```

Pure, clockless: for each session pick the highest-precedence matching rule
(specificity then recency) and emit its account. No I/O, no dates parsing (rules
already carry epoch-ms). Fully unit-testable; property test: idempotent and
order-independent w.r.t. rule input order (resolution is total).

Date parsing lives in the CLI layer (`parseLocalDate(s, tz) -> ms`), tested
separately, so the core stays clockless.

## Wiring

- **reattribute** (authoritative): reset inferred **and override** rows → apply
  label rules via `applyOverride` (they win) → run the normal inference pass
  (its guard skips the now-override rows) → recompute windows. Order: overrides
  first so inference never fights them.
- **collect** (incremental): after the existing assignment seam, apply label
  rules for the run's sessions via `applyOverride` so a freshly-collected session
  that falls in a labelled range is stamped immediately.

## CLI (`account` subcommands)

```
account label   --account <uuid|email> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--project <path>]
account label   --account <uuid|email> --session <id>
account labels                      # list rules: id · predicate · account · #sessions affected
account unlabel <ruleId>            # delete a rule, then reattribute to revert
```

- Account resolution accepts a UUID or an email/label, resolved via the
  `accounts` table; ambiguous/unknown → error listing known accounts (reuses the
  `account` command's lookup). No interactive prompts (unattended-safe).
- After `label` / `unlabel`, run the reattribution recompute + print how many
  sessions changed (reuse `reattribute`'s summary). `--dry-run` on `label`.

## Dashboard UI (phase 2, optional)

A "label a range" control in Settings → Accounts: date-range inputs + account
picker + Apply, and a list of existing rules with delete. The CLI is the MVP;
the UI calls the same store methods via the existing panel message channel. Split
into its own PR after the CLI lands.

## Phases (DAG)

| Phase | Work | Parallel? | Model / effort |
|---|---|---|---|
| **P1** | V15 migration + types + `labels.ts` (pure) + store methods (`createLabelRule`/`list`/`delete`/`applyOverride`) + reset-predicate change | sequential (shared files) | Opus / high — precedence + the guard-bypass write are the risk |
| **P2** | CLI commands (`account label/labels/unlabel`) + account resolution + date parsing | parallel with P3 | Sonnet / medium |
| **P3** | wire into `reattribute` + `collect` | parallel with P2 | Sonnet / medium |
| **P4** | i18n keys → all 10 locales | after P2 | Haiku / low |
| **P5** | tests + coverage + `--dry-run` verification on a copy of the live DB | last | Sonnet / medium |

## Tests (fail-when-wrong; boundary + failure paths)

- **`computeOverrides`**: range match on `first_timestamp` (in/at-boundary/out);
  project scoping; session rule; **precedence** — override beats observation,
  backfill, telemetry, **and otel**; overlap resolution (session > range+project
  > range; recency tiebreak); empty rules → empty map.
- **store**: `applyOverride` overwrites an existing otel/observation row (proves
  the guard bypass); rule CRUD; reset-then-reapply reverts an unlabelled session.
- **reattribute e2e**: label a range → sessions in it become `override`/A and
  survive a second reattribute; `unlabel` → they revert to inference.
- **CLI**: `parseLocalDate` (tz, invalid input); account resolution (uuid,
  email, ambiguous, unknown); `label --dry-run` writes nothing.
- **property**: `computeOverrides` idempotent and order-independent.

Coverage: repo gate (lines/functions/statements ≥ 80, branches ≥ 71);
`attribution/labels.ts` additionally ≥ 80 branches under a scoped run.

## Confidentiality

All fixtures use `00000000-…` UUIDs and `@example.com`; **no customer/employer
names** in the doc, tests, CLI help strings, or i18n values (this repo is public
and the extension is a published artifact). Marker-grep the diff before each PR.

## Deferred (v2)

- **Per-message range splits** — a range boundary mid-session. The
  `messages.account_uuid` column + the straddle writer (#27) already exist, so a
  range rule could split a straddling session at the boundary instead of
  whole-session. Deferred to keep v1 simple; note it in ASSUMPTIONS.
- **Import a labelling from an OTLP/`~/.claude.json.backup` anchor** to seed
  ranges automatically (doc 03 §D.2–D.4).

## Human checkpoints

None. This feature is local code + tests only — no deploy, publish, or prod
mutation. Unlike a release, the whole plan is safe to run unattended.
