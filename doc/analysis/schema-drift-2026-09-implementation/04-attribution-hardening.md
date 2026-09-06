# 04 — Attribution Hardening

Implements [§4.4](../schema-drift-2026-09/04-feature-opportunities.md).

Three signals, one per section: `bridge-session` (account attribution),
`promptId` (turn identity), `sourceToolAssistantUUID` (tool-error attribution).

The research for this chapter turned up **a defect larger than any of the three
features** — §4.5. Read that section even if none of the features ship.

## 4.0 Two corrections to the premise

**`packages/core/src/attribution.ts` is *ticket* attribution, not account
attribution.** It holds `extractTicketLinks` / `aggregateTicketCosts` and the
branch→commit→prompt ladder — the subject of [02](02-pr-and-work-items.md).
There is **no core/cli split in account attribution**: the whole chain lives in
`packages/cli/src/attribution/`, with one core dependency
(`packages/core/src/parser/telemetry.ts` `collectAccountMap`). Adding
`bridge-session` therefore has no package boundary to negotiate — parse in core,
rank in cli.

**The `otel` rank is dead code in production.** `assign.ts:129-140` reads
`input.otelMap`, but `otelMap` is supplied **only** in tests
(`__tests__/attribution.test.ts:202`, `:409`). Neither `aggregator/index.ts:344-349`
nor `reattribute.ts:121-126` passes it. The shipped chain is effectively
`override > telemetry > anchor > observation > backfill > unknown`. §4.4's claim
that the chain "tops out at weak proxies" is therefore *more* true than stated.

## 4.1 Current precedence chain

| Rank | Signal | Source of truth | Resolving code | source / confidence | Failure mode |
|---|---|---|---|---|---|
| 0 | Owner-rule override | `account_owner_rules` (`store/index.ts:462`), glob on `project_path` / `repo_url` | `attribution/ownership.ts` `resolveOwner`; applied *after* the chain at `aggregator/index.ts:376-393`, `reattribute.ts:252-255`, via `store.applyOwnerOverride` (`store:3964-3990`) | `override` / `authoritative` | Unconditional `UPDATE … WHERE session_id = ?` — **no monotonic guard**, so it silently overwrites a *correct* telemetry attribution. `--dry-run` reports this as `displaced` (`account-commands.ts:371-375`); a real run does it without prompting. Rules are path-shaped, so a monorepo shared by two accounts is inexpressible (only `split`, which produces no override at all). |
| 1 | OTel | — | `assign.ts:129-140` | `otel` / `authoritative` | **Never populated in production.** Unreachable outside tests. |
| 2 | Telemetry | `GrowthbookExperimentEvent.event_data.user_attributes.accountUUID` | parse `core/src/parser/telemetry.ts:150-180`; map `reattribute.ts:80-91`, `aggregator:328-335`; consumed `assign.ts:142-153` | `telemetry` / `high` | Depends on a **GrowthBook A/B-experiment event** firing — an implementation detail of a feature-flag SDK, not an interface. Coverage is silently zero when no experiment is active. `user_attributes` is JSON-in-JSON; a shape change breaks the parse with no counter. |
| 3 | Anchor pin | `~/.claude/sessions/<pid>.json` → `anchor_pins` (`store:792`) | writer `attribution/anchors.ts:44-101`; read `reattribute.ts:116-119`, `aggregator:339-342`; consumed `assign.ts:155-169` | `anchor` / `high` | Purely **forward-looking**: pins only sessions whose mtime ≥ `currentIntervalStart` (`anchors.ts:76`) with `entrypoint ∈ CLI_SURFACES` (`:91`). Requires `collect` to run *while* the session is live; the files are ephemeral. **Zero retroactive value.** Pins the whole session even across a switch (`assign.ts:110-111`). |
| 4 | Observation interval | `account_observations` (`store:430`), written on account change by `attribution/observer.ts:45-91` | `intervals.ts` `buildCliIntervals` / `intervalAt`; consumed `assign.ts:171-192` | `observation` / `high` | Boundary precision = collect cadence. A switch between two collects puts the whole gap in the *previous* account. CLI surfaces only. Straddle handled by `collectStraddleOverrides` (`assign.ts:241-264`) → `messages.account_uuid`. |
| 5 | Backfill | inference: exactly one CLI account ever observed | `assign.ts:194-210` | `backfill` / `medium` | Fires only when `distinctCliAccounts.size === 1`. On a genuine multi-account machine every pre-observation session → `unknown`. Deliberately `medium` so a later pass can upgrade it. |
| 6 | Unknown | — | `assign.ts:214-222` | `unknown` / `none` | Not written (`reattribute.ts:137`, `aggregator:352`); `account_uuid` stays NULL. |

**The monotonicity contract** — the single most breakable invariant here.
`store.applyAttribution` (`store:1610-1641`) writes only when
`account_uuid IS NULL OR account_source IS NULL OR account_confidence IN ('low','medium')`
**and** the existing source ∉ `{override, otel, telemetry, anchor}`.
`resetAttributableSessions` (`store:1589-1600`) mirrors that set. **Any new rank
must be added to both lists** or it is silently wiped on the next `reattribute`.

Message-level: `messages.account_uuid` (`store:446`) is written *only* by the
straddle path (`applyMessageOverrides`, `store:1690+`).

## 4.2 What the live data says

All figures [live], read-only, redacted to shapes and percentages.

### `bridge-session`

- **16 of 927 transcript files (1.7%)** carry one.
- The entry is a **bare sidecar record, not a full envelope** — no `uuid`, no
  `parentUuid`, **no `timestamp`**, no `version`/`cwd`/`gitBranch`:
  `{ type, sessionId, bridgeSessionId, lastSequenceNum, ownerAccountUuid, ownerOrganizationUuid }`.
- **All 16 files carry it repeatedly** — 4 to 205 entries per file, spread across
  the whole file. It is a periodic heartbeat, not a one-shot header.
- **One file carried two distinct `ownerAccountUuid` values.** Decisive:
  `bridge-session` is **not session-constant** and cannot be modelled as a single
  session-level fact without a conflict rule.
- 17 distinct `bridgeSessionId` across 16 files — roughly 1:1, with one file
  split across two bridge sessions.
- `lastSequenceNum` is `0` for every entry in some files and monotonic-with-gaps
  in others (`[0,0]`, `[0,54]`, `[0,1568]`). **Not a reliable ordering key** —
  use file line order.

### `promptId` and `sourceToolAssistantUUID` (40 recent files, ~64k user entries)

| Measure | Value |
|---|---|
| `promptId` on user entries | **100.0%** (40/40 files) |
| `promptId` on assistant entries | **0.0%** — user-entry-only |
| `sourceToolAssistantUUID` on tool-result-carrier user entries | **100.0%** |
| `sourceToolAssistantUUID` on all user entries | 87–96% (the gap is exactly the non-carriers) |
| Carrier's pointer resolving to an assistant `uuid` in the same file | **100.0%** |
| …that is *also* the immediately-preceding assistant entry | **96.2%** — the positional heuristic is **wrong on 3.8% of carriers** before replay is even considered |
| `promptSource` values | `sdk` 2322, `typed` 19, `system` 14 (~3.7% of user entries) |
| `origin` values | `{kind:"human"}` 1721, `{kind:"task-notification"}` 641 — **an object, not a string** |
| `toolDenialKind` | **0 occurrences** — UNVERIFIED as a live signal |

## 4.3 Tool-result carriers reuse the parent turn's `promptId` — confirmed

This was the blocking unknown. It is answered.

User entries tagged by promptId group (`P` = plain, `C` = tool-result carrier,
`M` = `isMeta`), three files:

```
file0: #0P #0C #0C #0C #0C #0C #0C  #1P #1C  #2P #2C #2C #2C #2C #2C  #3P #3C #3C …
file1: #0M #0P #0P  #1P #1C #1C #1C #1C #1C #1C …
file2: #0P #0C #0C #0C #0C #0C #0C #0C …
```

Across the 40-file sample: **59,393 carriers, 100% carrying a `promptId`**, and
after removing replay duplicates, **zero `promptId` values carried more than one
human-origin entry**. `promptId` is **exactly 1:1 with a real turn**, so
`isNewTurn = promptId !== lastPromptId` is sound.

Two refinements the data forces:

- **A slash command emits three user entries under one `promptId`** — the
  `isMeta` caveat entry, a command-name entry, and a command-stdout entry. The
  current heuristic counts **two prompts**; `promptId` counts **one**. `promptId`
  is right.
- **`isMeta` entries share the turn's `promptId`.** Grouping by `promptId`
  collapses them for free; the `!isMeta` clause becomes redundant under the new
  rule but must stay in the fallback branch.

## 4.4 The largest defect found: 62.5% of user entries are un-deduped replays

`session.ts:291-307` dedupes **assistant** entries only (`seenAssistantUuids`).
The `user` branch (`:224-256`) has **no dedupe at all**.

| Metric (40 files) | Raw | After uuid-dedupe |
|---|---|---|
| user entries | 63,952 | 23,999 — **62.5% are replays** |
| heuristic `promptCount` | 3,880 | 1,702 |
| distinct `promptId` | 1,255 | 1,255 |

The parser's `SessionRecord.promptCount` is over-reported **~2.3× by replay
alone**.

The database is *mostly* insulated: `prompt_count` is a projection over
`SUM(messages.is_turn_start)` (`store:840-844`), and `is_turn_start` is stamped
on the **assistant** row (`session.ts:347-348`, `:448`) with `MAX(...)` on upsert
(`store:1200`). But the parser-level figure is wrong, and so is anything reading
`ParseResult` before the projection.

This also explains the second tool-error defect (§4.7): the assistant dedupe
`continue`s at `:299` *before* `messages.push`, so on a replayed carrier
`messages.length` has not grown and **the same assistant record is incremented
again**.

> **Recommendation: ship the user-entry replay dedupe as a standalone fix, one
> release ahead of the `promptId` work.** It is the highest value-to-effort item
> in this entire analysis, it is correct independent of every feature here, and
> shipping it separately means the two prompt-count corrections are attributable
> to separate CHANGELOG entries instead of arriving as one unexplained drop.

The headline number for the migration story is therefore **−26.3%**
(`promptId` 1,255 vs dedupe-corrected heuristic 1,702), *not* the −67.7% against
the raw heuristic. The residual −26.3% is slash-command triples and
command-stdout entries — real over-counting the heuristic cannot see.

## 4.5 Design: `bridge` at rank 1.5

| Rank | Signal | confidence | Change |
|---|---|---|---|
| 0 | `override` | authoritative | unchanged |
| 1 | `otel` | authoritative | unchanged (still unwired) |
| **1.5** | **`bridge`** | **`high`** | **NEW** |
| 2 | `telemetry` | high | unchanged |
| 3 | `anchor` | high | unchanged |
| 4 | `observation` | high | unchanged |
| 5 | `backfill` | medium | unchanged |
| 6 | `unknown` | none | unchanged |

**Above `telemetry`:** `bridge-session` is a first-class product record written
by the session runtime. Telemetry depends on a GrowthBook experiment happening to
fire and on a nested JSON-in-JSON string. Bridge is strictly better-typed, and it
carries `ownerOrganizationUuid` natively — telemetry's `organizationUUID` is
optional, and anchor/observation carry no org at all.

**Not `authoritative`:** `ownerAccountUuid` is the *bridge owner* — the account
owning the remote/desktop link — which is not provably the account billed for the
tokens. `high` is the honest grade until that is confirmed. **UNVERIFIED: bridge
owner == billing account.**

**The coverage argument is the real one.** Unlike `anchor` and `observation`,
bridge carries its own account, so it applies to *any* `entrypoint` — including
the IDE/extension surfaces that
[07-schema-reference](../07-schema-reference.md) declares un-attributable from
disk. Bridge is **the first non-CLI-surface signal that works offline**. 1.7% of
files is small, but on exactly the surface that previously had nothing.

### Conflict rule (required by the two-owner observation)

Collect all `bridge-session` entries in **file order**. If every
`ownerAccountUuid` agrees → one session-level fact. If they disagree → emit **no
bridge assignment**, set `bridge_conflict = 1`, fall through to `telemetry`.

Do **not** pick last-wins: there is no `timestamp` on the entry and
`lastSequenceNum` is unreliable (§4.2). A conflicting session is a candidate for
the message-level straddle machinery later; not in V23.

### Code changes

| File | Change |
|---|---|
| `packages/core/src/parser/session.ts` (~`:224`) | `case "bridge-session"`. Accumulate `Set`s of `bridgeSessionId` / `ownerAccountUuid` / `ownerOrganizationUuid`. **No timestamp — do not push to `allTimestamps`.** Short-circuit once ≥2 distinct owners are seen (files carry up to 205 entries). |
| `packages/core/src/types.ts` (`SessionRecord`) | `bridgeSessionId`, `bridgeAccountUuid`, `bridgeOrganizationUuid: string \| null`; `bridgeConflict: boolean`. Resolve at end-of-parse: single-valued set → the value; ≥2 → `null` + conflict. |
| `packages/cli/src/store/index.ts` V23 | the four columns; write in `upsertSession`/`upsertSessionIncremental` with **`COALESCE(excluded.x, sessions.x)`** — a byte-range continuation that sees no bridge entry must not null a good value. |
| `packages/cli/src/attribution/assign.ts` | new `AssignInput.bridgeMap`; new block between `:140` and `:142` emitting `source: "bridge"`, `confidence: "high"`, `organizationUuid` populated. |
| **`packages/cli/src/store/index.ts:1589-1600` and `:1610-1641`** | **Add `'bridge'` to both strong-source lists.** Missing this is the one change that silently breaks on the next `reattribute`. |
| `attribution/reattribute.ts` (~`:110`), `aggregator/index.ts` (~`:338`) | build `bridgeMap` from a new `store.getSessionsWithBridge()` over the `sessions` columns — no extra table; the fact is intrinsically session-scoped. |
| `attribution/observer.ts` / `store.upsertAccount` | when a bridge fact resolves an account not yet in `accounts`, upsert a row with `organization_uuid` from the entry and `first/last_observed_at` from the session timestamps, so `account` CLI output and `applyOwnerOverride`'s org lookup (`store:3972-3975`) work for bridge-only accounts. |

**No new table for bridge.** `bridgeSessionId` shows no cross-session value
(17 ids / 16 files); store it for diagnostics only.

## 4.6 Design: `promptId` and the mixed-data boundary

### Three cohorts

| Cohort | Size (this machine) | Signal |
|---|---|---|
| **A** — no transcript | ~936 of 1168 sessions (`store:579-586`) | only the V18 `prompt_text IS NOT NULL` proxy, ~68% accurate. **Frozen forever.** |
| **B** — transcript, pre-`promptId` | the remainder of history | `is_turn_start` from the heuristic, over-counted by replay + slash commands |
| **C** — transcript with `promptId` | all new data (100% coverage) | exact |

`prompt_count` is a projection guarded by
`WHEN SUM(is_turn_start) > 0 … ELSE s.prompt_count` (`store:840-844`), so cohort
A is already pinned. The discontinuity risk is entirely **B → C**, and only for
sessions that get **re-parsed** after V23 — a session whose bytes are already
checkpointed keeps its stored value.

### Turn rule

```ts
// promptId present → exact. A carrier reuses its turn's promptId, so a change of
// promptId is precisely a new turn (verified: 0 promptIds span >1 human entry).
// promptId absent  → legacy heuristic, unchanged, so cohort B never moves.
let isNewTurn =
  promptId !== null
    ? promptId !== lastPromptId
    : (!entry.isMeta && !isToolResultCarrier);

// A compaction summary is a replayed turn, never a new one.
if (entry.isCompactSummary === true) isNewTurn = false;
```

Two additions the data requires:

1. **Dedupe user entries by uuid**, mirroring `seenAssistantUuids`
   (`session.ts:296-300`) — §4.4. Under the `promptId` branch the dedupe is
   implicit (`promptId === lastPromptId` on a replay), but the **fallback branch
   needs it explicitly**.
2. `lastPromptId` resets per file and is `undefined`-initialised, not `null`, so
   a first entry with `promptId === null` does not read as a new turn.

### Avoiding a user-visible discontinuity

A −26.3% shift on re-parse (or −2.3× with the replay dedupe) is too large to
absorb silently. **Grade it per session; do not re-baseline globally.**

- Add `sessions.prompt_count_source TEXT ∈ {'promptId','heuristic','proxy'}`,
  derived at parse time (`'promptId'` when ≥1 message carried a `prompt_id`;
  `'proxy'` for cohort A; else `'heuristic'`).
- `prompt_count` stays a **projection** over `SUM(messages.is_turn_start)` per
  the `upsertSessionIncremental` constraint ([01 §1.8](01-foundation.md)).
  `messages.prompt_id` is written alongside `is_turn_start` on the assistant row
  that answers the turn (`session.ts:448`), with
  `COALESCE(excluded.prompt_id, messages.prompt_id)` in the upsert.
- **Do not backfill cohort B.** Sessions re-parse only when their bytes change; a
  mixed corpus is honest, and the grade column makes it legible.
- **Surface the mix, don't hide it.** Any aggregate spanning cohorts gets a
  footnote driven by the grade distribution — the same honesty pattern already
  used by `TicketCoverage.byConfidence`
  (`packages/core/src/attribution.ts:344-350`) and by `prompt_count`'s own
  `ELSE s.prompt_count` guard.
- **A one-time reconciliation note** in `diagnose` and the CHANGELOG when the
  grade distribution first shifts, so a user whose prompt counts drop after an
  upgrade has an in-product explanation.

`session_turns` (one row per real turn) is the right home for per-turn metadata
and makes "count turns" a `COUNT(*)` that is idempotent by construction (PK
collision on replay). It also gives `origin` / `promptSource` a home — enabling
**human vs task-notification vs sdk turn segmentation**, a genuinely new axis
(1,721 human vs 641 task-notification in the sample).

## 4.7 Design: tool-error attribution

### Two defects in the current path

`session.ts:232-242` counts `tool_result` blocks with `is_error === true` into
`messages[messages.length - 1].toolErrorCount`.

1. **Positional mis-attribution** — the last-pushed message is the correct target
   only **96.2%** of the time (§4.2). The remaining 3.8% are interleaved or
   parallel tool calls pointing at an earlier assistant message.
2. **Replay multiplication** — the assistant dedupe `continue`s at `:299`
   *before* `messages.push`, so on a replayed carrier `messages.length` has not
   grown and the **same** assistant record is incremented again. With a 62.5%
   duplicate rate this is systematic, and non-idempotent across re-parses.

### Algorithm

Per the settled decision, **do not rewrite `toolErrorCount` in place.**

```
seenUserUuids:       Set<string>
seenToolResultUuids: Set<string>   // key = tool_use_id, else `${carrierUuid}#${blockIndex}`

for each user entry:
  if entry.uuid ∈ seenUserUuids: continue        // NEW: user-entry replay dedupe
  seenUserUuids.add(entry.uuid)
  for each tool_result block b at index i:
    key = b.tool_use_id ?? `${entry.uuid}#${i}`
    if key ∈ seenToolResultUuids: continue
    seenToolResultUuids.add(key)
    emit ToolResultRecord {
      uuid:           key,
      sessionId,
      promptId,                                   // free — carriers reuse the turn's promptId
      assistantUuid:  entry.sourceToolAssistantUUID ?? <positional fallback>,
      timestamp:      ts,
      isError:        b.is_error === true,
      denialKind:     entry.toolDenialKind ?? null,
    }
  // LEGACY, UNCHANGED: the positional accumulation at session.ts:232-242
  // stays byte-identical so no shipped toolErrorCount figure moves.
```

`tool_results` is `INSERT … ON CONFLICT(uuid) DO UPDATE` — idempotent by PK, like
`messages`.

The corrected count is a **projection** in `recomputeSessionAggregatesSql`
(`store:820-849`), never an additive delta:

```sql
tool_error_count_v2 = (SELECT COUNT(*) FROM tool_results tr
                        WHERE tr.session_id = s.session_id AND tr.is_error = 1)
```

with a per-message equivalent joined on `tool_results.assistant_uuid`.

### Interaction with the assistant dedupe

The new emission lives in the **user** branch, so the assistant dedupe does not
gate it — but it depends on `sourceToolAssistantUUID` naming an assistant `uuid`
that the dedupe has already collapsed to one `messages` row. Since `messages` is
uuid-keyed and the dedupe preserves the first occurrence, `assistant_uuid`
always resolves (100% in-file resolution, §4.2). **The two dedupes are
independent and compose correctly** — which is precisely why the uuid-keyed
design is right: positional attribution is *coupled* to the dedupe's `continue`,
and that coupling is the bug.

One guard: emit the row **even when `sourceToolAssistantUUID` names an assistant
entry that produced no `messages` row** (a no-uuid or zero-usage entry). Store
it and let the projection's join drop it, rather than discarding evidence at
parse time.

## 4.8 DDL

```sql
-- sessions (additive)
ALTER TABLE sessions ADD COLUMN bridge_session_id        TEXT;
ALTER TABLE sessions ADD COLUMN bridge_account_uuid      TEXT;
ALTER TABLE sessions ADD COLUMN bridge_organization_uuid TEXT;
ALTER TABLE sessions ADD COLUMN bridge_conflict          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN prompt_count_source      TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_bridge_account
  ON sessions (bridge_account_uuid) WHERE bridge_account_uuid IS NOT NULL;  -- partial: 1.7% of rows

-- messages (additive)
ALTER TABLE messages ADD COLUMN prompt_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_prompt ON messages (session_id, prompt_id);

CREATE TABLE IF NOT EXISTS session_turns (
  session_id         TEXT NOT NULL,
  prompt_id          TEXT NOT NULL,
  first_timestamp    INTEGER,                     -- nullable: entries can lack a parseable ts
  last_timestamp     INTEGER,                     -- turn duration / engaged-time input
  origin             TEXT,                        -- flattened from origin.kind — origin is an OBJECT
  prompt_source      TEXT,                        -- 'typed' | 'sdk' | 'system'
  permission_mode    TEXT,
  is_compact_summary INTEGER NOT NULL DEFAULT 0,
  is_meta_only       INTEGER NOT NULL DEFAULT 0,  -- all entries isMeta: excludable without a regex
  entry_count        INTEGER NOT NULL DEFAULT 0,  -- the audit trail for the −26.3% delta
  PRIMARY KEY (session_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_time ON session_turns (first_timestamp);

CREATE TABLE IF NOT EXISTS tool_results (
  uuid           TEXT PRIMARY KEY,  -- tool_use_id, else '<carrier uuid>#<block index>'
  session_id     TEXT NOT NULL,
  assistant_uuid TEXT,              -- NULLABLE: sourceToolAssistantUUID absent on old data
  prompt_id      TEXT,              -- per-turn error rate with no join through messages
  timestamp      INTEGER,
  is_error       INTEGER NOT NULL DEFAULT 0,
  denial_kind    TEXT,
  tool_name      TEXT               -- if cheaply available from the matching tool_use
);
CREATE INDEX IF NOT EXISTS idx_tool_results_session   ON tool_results (session_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_assistant ON tool_results (assistant_uuid)
  WHERE assistant_uuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_results_error     ON tool_results (session_id) WHERE is_error = 1;
```

> **`origin` is an object** (`{kind:"human"}`), not a string. Flatten to
> `origin.kind` or the column stores `[object Object]`. `first_timestamp` must be
> nullable — `bridge-session` entries carry no timestamp, and turn-opening
> entries occasionally lack a parseable one.

## 4.9 Surfaces

**CLI** — `claude-stats account` (`account-commands.ts:76-135`) gains a `bridge`
row in the known-accounts table and in the per-source breakdown;
`account reattribute --dry-run` picks up `bridge` in `bySource`
(`reattribute.ts:130`) for free, but it must be added to the printed summary; a
new `claude-stats account bridge --list` shows sessions with a bridge fact **and
the conflicting ones**, so the two-owner case is visible rather than silently
dropped; `diagnose` reports the `prompt_count_source` distribution and the
one-time reconciliation note (§4.6).

**MCP** — `get_account_info` / `get_status` gain a `bridgeAttributed` count and
the source histogram; `get_session_detail` exposes `promptCountSource` and
per-turn rows from `session_turns`; `get_efficiency_hints` takes
`tool_error_count_v2`, a strictly better input than the positional count.

**Dashboard** — a `bridge` band on the attribution-provenance card; an "exact
turns" vs "estimated turns" marker in the session list, driven by
`prompt_count_source`.

**Do not surface** `bridgeSessionId`, `ownerOrganizationUuid`, or a raw
`ownerAccountUuid` in any exported or synced artifact — §4.10.

## 4.10 Privacy: `ownerOrganizationUuid`

The binding constraint is **in code**, not in
[data-planes/](../data-planes/) (which discusses zero-knowledge posture at the
architecture level and says nothing specific about org uuids):

- `packages/cli/src/sync/hmac.ts:4-15` — *"The raw account_uuid never leaves the
  user's device. Only a one-way [HMAC] … `accountId = HMAC-SHA-256(account_uuid,
  userSalt).slice(0,32)`"*.
- `sync/index.ts:345` filters sessions to linked account uuids and stamps the
  **derived** id.
- **`organization_uuid` appears in no sync payload today** — a grep over
  `packages/cli/src/sync/` returns nothing.

**Rule:** storing `bridge_organization_uuid` locally is fine — it is the same
class of local-only identifier as the existing `sessions.organization_uuid`
(`store:289`), already written by `applyOwnerOverride` (`store:3972-3975`). It
must **not** enter any sync or export path in raw form. If a team-plane use case
emerges it goes through the same HMAC-with-user-salt derivation, or it is
omitted.

An org uuid is **more** re-identifying than an account uuid across users — it is
shared by everyone in the org, so it is a join key linking otherwise-unlinkable
users. The bar is higher, not equal.

Also: [05-privacy-security.md:325](../05-privacy-security.md) flags `accountUuid`
as a column that reaches CSV export. The same review applies to every new bridge
column before it touches an export path.

## 4.11 i18n

| Key | Purpose |
|---|---|
| `cli:account.sourceBridge` | label for the `bridge` provenance |
| `cli:account.bridgeConflict` | "N sessions carry conflicting bridge owners" |
| `cli:account.bridge.description`, `.listOption` | the new subcommand |
| `cli:doctor.promptCountExact` / `.promptCountHeuristic` / `.promptCountProxy` | grade labels |
| `cli:doctor.promptCountShift` | the one-time reconciliation notice |
| `dashboard:attribution.bridge` | chart band label |
| `dashboard:session.turnsExact` / `.turnsEstimated` | session-list marker |

> `cli:account.sourceBridge` and `dashboard:attribution.bridge` both want to be
> the literal word "Bridge" in several locales, and `locales:check` **rejects a
> value byte-identical to `en`**. Give the dashboard band a longer form
> ("Bridge-Sitzung" and equivalents) rather than fighting the check.

## 4.12 Tests

**Unit** (`packages/cli/src/__tests__/`)

- `attribution.test.ts`: bridge outranks telemetry; bridge loses to override;
  bridge applies on a **non-CLI entrypoint** (the coverage win); conflicting
  owners → no bridge assignment, `bridge_conflict = 1`, falls through to
  telemetry.
- Store: `resetAttributableSessions` does **not** clear a `bridge` row;
  `applyAttribution` does **not** downgrade a `bridge` row to `observation`.
  *These two are the regressions most likely to ship.*
- Parser: a `bridge-session` entry with no `uuid`/`timestamp` does not perturb
  `firstTimestamp` / `lastTimestamp` / `allTimestamps`.
- `promptId`: carrier reuses parent promptId → one turn; slash-command triple →
  one turn; `isCompactSummary` → zero turns; **missing `promptId` → legacy
  heuristic result byte-identical to today's** (a golden-fixture regression on a
  pre-promptId transcript).
- Replay dedupe: a transcript with a 3× duplicated user block yields the same
  `promptCount` as its de-duplicated twin.
- Tool results: a carrier whose `sourceToolAssistantUUID` names a *non-adjacent*
  assistant targets that assistant, not the last-pushed one; **legacy
  `toolErrorCount` is unchanged by the new path** — the explicit no-move
  assertion.
- `filter-symmetry.test.ts`: if `getSessions` gains a bridge/account-source
  narrowing dimension, add the matching `MessageFilter` dimension or the test
  fails by design.

**Property-based (fast-check)**

1. **Turn-count idempotence** — for any generated entry sequence, parsing twice,
   or parsing a prefix then the remainder as a byte-range continuation, yields
   the same `session_turns` row set. Targets the `upsertSessionIncremental`
   non-idempotence class directly.
2. **Replay invariance** — inserting arbitrary duplicate-uuid copies at arbitrary
   positions must not change `COUNT(session_turns)` or
   `COUNT(tool_results WHERE is_error)`. **This property alone would have caught
   the 62.5% defect.**
3. **Precedence is a total order** — for any subset of available signals,
   `assignAccounts` picks the max-rank present; assert against a reference table.
4. **Monotonicity** — for any sequence of `applyAttribution` calls the final
   `account_confidence` rank is non-decreasing and a strong source is never
   replaced.
5. **Projection totality** — `SUM(sessions.prompt_count)` over a scope equals
   `COUNT(session_turns)` in that scope, for every session graded `'promptId'`.

## 4.13 Effort, risks, open questions

| Work | Size |
|---|---|
| `bridge-session` parse + 4 columns + `assign.ts` rank | S (~½ day) |
| Adding `'bridge'` to the two strong-source lists + tests | XS, but load-bearing |
| `promptId` capture + `messages.prompt_id` + turn rule | S–M |
| `session_turns` + projection + `prompt_count_source` | M |
| **User-entry replay dedupe** (standalone) | S — **highest value/effort in this analysis** |
| `tool_results` + projection, legacy path frozen | M |
| Surfaces + 10-locale i18n | M (i18n is the long pole) |

**Risks**

- **R1 (high, cheap to avoid).** Forgetting `'bridge'` in
  `resetAttributableSessions` / `applyAttribution` → bridge attributions silently
  wiped on the next `reattribute`. Covered by a named test.
- **R2 (medium).** The prompt-count shift: −26.3% on re-parsed sessions, or −2.3×
  if the replay dedupe lands simultaneously. Mitigated by the per-session grade
  and by not backfilling — but a user who re-parses a large corpus sees a real
  drop. **Ship the replay dedupe one release ahead** so the two corrections are
  separately attributable.
- **R3 (medium).** The owner-rule override is unconditional and would displace a
  `bridge` attribution as freely as it displaces `telemetry`. Extend the
  `--dry-run` `displaced` count (`account-commands.ts:371-375`) to include
  `bridge`.
- **R4 (low).** 1.7% file coverage means bridge cannot be validated broadly here.
  The one two-owner file is 6% of the bridge sample — a real conflict rate, not a
  curiosity.
- **R5 (low).** Up to 205 bridge entries per file; use a `Set` and short-circuit
  at ≥2 distinct owners.

**Open questions / UNVERIFIED**

1. **Does `ownerAccountUuid` equal the billed account?** This separates `high`
   from `authoritative`. Test: find a session with both a bridge fact and a
   telemetry fact and check agreement — needs a maintainer check, since it
   involves handling real account uuids.
2. **What does a two-owner file mean** — a genuine mid-session account switch, or
   a bridge reconnect under a second link? Determines whether V24 routes
   conflicts through the message-level straddle machinery.
3. **`lastSequenceNum` semantics** — `0` throughout some files, monotonic-with-
   gaps in others. Do not build on it.
4. **`bridgeSessionId` cross-session identity** — 17 ids / 16 files suggests 1:1,
   but one file split. Unknown whether one bridge session can span multiple
   transcript files, which would make it a grouping key rather than a
   diagnostic.
5. **`toolDenialKind`** — zero occurrences in a 40-file sample. The column is
   cheap, but the friction metric it feeds ([06](06-friction.md)) is UNVERIFIED
   as populated.
6. **Cohort A (~936 sessions) can never gain `promptId`.** Is a permanently
   three-grade prompt count acceptable in the UI, or should cohort A report
   "unknown" rather than a 68%-accurate proxy? **A product call, not a technical
   one** — [09 §9.5](09-sequencing.md).
