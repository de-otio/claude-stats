# 01 — Foundation: Parser, Schema, Ingestion

Everything in [02](02-pr-and-work-items.md)–[08](08-session-titles.md) depends on
this layer. It is the only chapter that is *not* optional: each feature chapter
assumes the parser emits its signal and the store has somewhere to put it.

Evidence grades follow the parent analysis: **[live]** = observed in real data
on this machine, **[code]** = verified with a `file:line` ref, **[unverified]** =
stated but not confirmed.

## 1.1 Ingestion pipeline, as built

| Stage | `file:line` | What it does | Writes |
|---|---|---|---|
| Discovery | `packages/cli/src/scanner/index.ts:21-71` `discoverSessionFiles()` | walks `paths.projectsDir` only; per-project top level + `<project>/subagents/` (`:54-67`); `lstat`, skips symlinks (`:41-45`, `:90-100`) | — |
| Path constants | `packages/core/src/paths.ts:10-55` | — | — |
| Collect loop | `packages/cli/src/aggregator/index.ts:57` `collect()`, loop `:123-299` | checkpoint compare (`:138-165`): unchanged → skip; first-KB hash match → append from `lastByteOffset`; else rewrite from 0 | — |
| Parse | `packages/core/src/parser/session.ts:106` `parseSessionFile()` | dispatch chain `:224-455`, returns `ParseResult` (`:24-37`) | — |
| Write txn | `aggregator/index.ts:200-282`, one `store.transaction` per file | CAS re-check `:212-216`; `upsertSession`/`upsertSessionIncremental` `:218-225`; `upsertMessages` `:227-237`; `upsertApiErrorEvents` `:239-241`; quarantine `:243-245`; `recomputeSessionAggregates` `:258`; ticket extraction `:265-271`; `upsertCheckpoint` `:274-281` | `sessions`, `messages`, `api_error_events`, `quarantine`, `ticket_links`, `collection_state` |
| Rollup | `aggregator/index.ts:410-412` → `store.recomputeMessageHourly()` (`store/index.ts:884-942`) | per-hour DELETE+INSERT; freshness watermark = `COUNT(*) FROM messages` (`:938-940`) | `message_hourly` |
| Windows | `aggregator/index.ts:414-418`, `:433-499` | greedy 5-hour binning | `usage_windows` |
| Attribution | `aggregator/index.ts:311-395` | observation / telemetry / anchor / owner-rule precedence | `sessions.account_uuid`, `messages.account_uuid` |

`collect()` is the single ingestion entry point and is called from three
concurrent processes — `cli/index.ts:6`, `extension/collector.ts:15`,
`mcp/index.ts:1353`. **Every write must be idempotent.** This is the constraint
that shapes most decisions below.

## 1.2 Corrections to the parent analysis

Three claims in [../schema-drift-2026-09/](../schema-drift-2026-09/) did not
survive verification. They matter because features were scoped against them.

### The schema fingerprinter is dead code, not a working watcher

[02 §2.1](../schema-drift-2026-09/02-transcript-schema-changes.md) says the
fingerprinter "does record" unrecognised entry types and "nothing surfaces it",
and [02 §2.5 rec 5](../schema-drift-2026-09/02-transcript-schema-changes.md)
says it "already sees all of this". **It sees nothing.** `checkSchema` is
imported at `aggregator/index.ts:10` and never called; `entriesByVersion`
(`:104`, `:287-289`) is only ever assigned an empty array. A repo-wide grep
finds `checkSchema`/`buildFingerprint` only in `schema/monitor.ts` and
`__tests__/schema.test.ts`. **`schema_fingerprints` is empty in every real
database.** [code]

Consequence: "surface the fingerprinter's diff" is not a rendering task, it is a
three-step build (§1.7).

### "The V22 pattern" is not a JSON side-column

[02 §2.5 rec 2](../schema-drift-2026-09/02-transcript-schema-changes.md) says
"new DB columns or a JSON side-column per the V22 pattern". V22
(`store/index.ts:763-780`) creates a **separate append-only, entry-uuid-keyed
side table** (`api_error_events`) with a dedicated `upsertApiErrorEvents`
(`store/index.ts:1222-1244`) whose `ON CONFLICT (uuid) DO UPDATE` makes a
re-parsed byte range idempotent. Its docstring states the rule: things that are
not billed turns stay out of `messages`. [code]

The actual JSON side-column pattern is **V10** — `addColumn("messages",
"file_paths", "TEXT NOT NULL DEFAULT '[]'")` (`store/index.ts:331`), plus V1's
`tool_use_counts` / `models` (`:162-163`), guarded on upsert by
`COALESCE(excluded.x, messages.x)` (`:1192`).

Both patterns are used below; the choice rule is in §1.5.

### `packages/cli/src/paths.ts` does not exist

[03 §3](../schema-drift-2026-09/03-new-sidecar-sources.md) says
"`packages/cli/src/paths.ts` centralizes what we do read". The file is
`packages/core/src/paths.ts` (`:10-55`). Its test is
`packages/cli/src/__tests__/paths.test.ts`. [code]

Also confirmed: `paths.changelogFile` (`packages/core/src/paths.ts:21`) has zero
readers — [03 §3.7](../schema-drift-2026-09/03-new-sidecar-sources.md) is
correct. And the archive mirror is *also* unwired: `mirrorSessionRange`
(`packages/cli/src/archive/mirror.ts:113`) has no caller outside
`archive/index.ts`; only `purgeAllData` is imported anywhere. That kills
"backfill from the archive" as a recovery path until it is wired (§1.6). [code]

## 1.3 Parser changes

### Step 0 — convert the dispatch chain to `switch (type)`

`session.ts:224-291` is an `if / else if` chain whose `system` arm is a compound
condition (`type === "system" && subtype === "api_error" && source ∈
{request_retry, connection_retry}`). The subtype expansion in
[06](06-friction.md) needs `case "system":` with a nested subtype switch.
`continue` inside a `switch` inside the `for` still targets the loop, so the
assistant dedupe `continue` (`:305`) is unaffected.

This is a **behaviour-identical refactor and must be verified as one** — snapshot
`ParseResult` over `__tests__/fixtures/synthetic.ts` before, assert identical
after (design default 14, behaviour comparison over code comparison).

> **Do not touch `allTimestamps.push(ts)` at `session.ts:222`.** It runs for
> *every* entry type including `attachment` (~23% of volume) and feeds
> `activeDurationMs` (`:462-472`) and every downstream engaged-time metric. Any
> reordering that changes which entries reach it silently moves a shipped
> number — including the numbers the separately-tracked §4.3 work is built on.

### Step 1 — new top-level branches

All five are small, top-level-field-only, and interact with no existing
heuristic. They go *after* the four hot cases so the common path keeps its
branch order.

| `case` | Capture | `ParseResult` channel |
|---|---|---|
| `"cost-state"` | `totalCostUSD`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalDuration`, `totalLinesAdded/Removed`, `startTime`, `hasUnknownModelCost`, `modelUsage` map | `costState: CostStateRecord \| null` (last wins — a rollup, not an event) |
| `"pr-link"` | `prNumber`, `prUrl`, `prRepository` | `prLinkEvents: PrLinkEvent[]` |
| `"bridge-session"` | `bridgeSessionId`, `ownerAccountUuid`, `ownerOrganizationUuid`, `lastSequenceNum` | `bridge: BridgeSessionRecord \| null` |
| `"ai-title"` / `"custom-title"` / `"agent-name"` | `aiTitle` / `customTitle` / `agentName` | `labels` (last wins) |
| `"mode"` / `"permission-mode"` | `mode` / `permissionMode` + `uuid` + ts | `modeEvents[]` |

`aiTitle`/`customTitle` are model- and user-authored **free text**. They are fine
in the local store but can never enter an org-plane sync shape — see
[08 §8.4](08-session-titles.md).

### Step 2 — assistant-branch field captures

Insert after `session.ts:331`:

```ts
const effort = typeof entry.effort === "string" ? entry.effort : null;
const speed  = typeof usage?.speed === "string" ? usage.speed : null;
const thinkingTokens = usage?.output_tokens_details?.thinking_tokens ?? 0;
```

and add to the `messages.push({...})` object (`:428-452`): `effort`, `speed`,
`thinkingTokens`, `requestId` (already typed at `types.ts:85`, never read),
`attributionMcpServer` / `attributionMcpTool` / `attributionSkill`, `promptId`.
`iterations` is deliberately omitted here — its shape is contested; see
[05 §5.2](05-request-dimensions.md).

Model ids stay untouched (`:333` `modelsSet.add`). Normalising `<synthetic>` and
the `[1m]` suffix belongs in `pricing.ts`
([01-immediate-fixes items 2–3](../schema-drift-2026-09/01-immediate-fixes.md)),
not the parser — see [03 §3.6](03-cost-verification.md).

**`supersedesUuids` interacts with dedupe.** `seenAssistantUuids`
(`session.ts:303-307`) collapses *replays of the same uuid*. A supersede is a
*different* uuid replacing an earlier one, so both rows survive and both are
billed — which is correct, because both API calls were charged. Capture it into
a side channel and surface it as a metric; **do not** exclude superseded rows
from cost, which would move `recomputeSessionAggregatesSql`
(`store/index.ts:820-849`) and `message_hourly` output for already-shipped
figures.

> **The `uuid` dedupe is not sufficient, and this is a correctness defect, not a
> design choice.** Blocks of one API response share a `message.id` but carry
> **distinct** envelope uuids, so `seenAssistantUuids` never sees them. Measured:
> 71–76% of assistant entries repeat a `message.id`, and 59% of multi-entry
> groups carry no repeated uuid at all. Usage must additionally be deduped on
> `message.id`, keeping the **maximum** usage in the group. Full evidence and the
> fix in [03 §3.0](03-cost-verification.md); sequencing in
> [09 §9.2](09-sequencing.md) step 0.4. Keep the `uuid` dedupe — it covers a
> different phenomenon (compaction/resume replay of the same envelope).

### Step 3 — user-branch changes (both touch shipped heuristics)

These are the only two parser changes that can move a number a user has already
seen. Both land as *additional recorded signals first*, with the switchover as a
separate, separately-verified change. Design detail is in
[04 §4.3–4.4](04-attribution-hardening.md).

- **`promptId` vs the turn-start heuristic** (`session.ts:243-257`).
- **`sourceToolAssistantUUID` vs positional tool-error attribution**
  (`session.ts:232-242`), which attributes a failed `tool_result` to
  `messages[messages.length - 1]` — wrong whenever the issuing assistant message
  is in an earlier byte range (incremental parse) or results arrive out of
  order.

Additive, no interaction: `origin`, `promptSource`, per-turn `permissionMode`
(distinct from the session-level first-seen at `:210-211`), `isCompactSummary`,
`isVisibleInTranscriptOnly` → a `turns[]` channel keyed `(sessionId, promptId)`.

### Step 4 — system-subtype expansion

Keep the existing `api_error` arm byte-identical (`:266-290`); add sibling
subtype arms. The observed subtypes are **not** the four signals the parent doc
lists — they are `compact_boundary`, `stop_hook_summary` and
`model_refusal_fallback` (the last carrying fallback, refusal *and* retraction
on one entry), plus `turn_duration`, `away_summary`, `local_command` and
`informational`, which nothing here consumes. Census in
[06 §6.1](06-friction.md); designs in [06 §6.4](06-friction.md) and
[07 §7.8](07-compaction.md).

Two notes that belong here:

- `maxRetries` is typed at `types.ts:99` and never read — add it to the existing
  `apiErrorEvents.push` at `:279-289`, or delete the field.
- **`trigger` is namespace-shared across subtypes.** `compact_boundary` emits
  `trigger: "manual"` 903 times; `model_refusal_fallback` emits
  `trigger: "refusal"` 10 times. Reading `entry.trigger` outside its subtype case
  would record 903 phantom model fallbacks. This is the strongest argument for a
  **nested** subtype switch over any flat field sniff.

### Step 5 — drift instrumentation

Add to `ParseResult`:

- `unknownTypeCounts: Record<string, number>` — incremented in the `default:` case.
- `shapeSample: Array<{ type: string; keys: string[]; usageKeys: string[] }>` — a
  **key-only skeleton**, first occurrence per `(type, keyset-hash)`, capped at
  ~200.

`buildFingerprint` (`schema/monitor.ts:26-59`) only reads `Object.keys(entry)`
and `Object.keys(entry.message.usage)`, so a skeleton is sufficient — and it
keeps prompt text out of the fingerprint path entirely, which a raw-entry sample
would not.

## 1.4 Schema V23

**One migration, `migrateToV23`, purely additive, zero backfill.** `migrate()`
is a linear if-chain (`store/index.ts:113-134`) and every statement here is
independently idempotent (`CREATE TABLE IF NOT EXISTS` + the local `addColumn`
helper), so a single version is atomic enough and cheaper to reason about than
four. Split only if the parser work ships across releases.

**Sidecar ingestion is a separate V24** — `stats-cache.json`, `plans/`, `tasks/`
have different provenance semantics and need their own `source` / `imported_at`
columns. See [03 §3.5](03-cost-verification.md).

```sql
-- ── messages: per-request dimensions. All nullable/defaulted; zero backfill.
ALTER TABLE messages ADD COLUMN effort                 TEXT;
ALTER TABLE messages ADD COLUMN speed                  TEXT;
ALTER TABLE messages ADD COLUMN thinking_tokens        INTEGER;   -- NULL = not reported
ALTER TABLE messages ADD COLUMN attempt_count          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN fallback_from_model    TEXT;
ALTER TABLE messages ADD COLUMN request_id             TEXT;
ALTER TABLE messages ADD COLUMN prompt_id              TEXT;
ALTER TABLE messages ADD COLUMN attribution_mcp_server TEXT;
ALTER TABLE messages ADD COLUMN attribution_mcp_tool   TEXT;
ALTER TABLE messages ADD COLUMN attribution_skill      TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_prompt_id ON messages (prompt_id);
CREATE INDEX IF NOT EXISTS idx_messages_attr_server
  ON messages (attribution_mcp_server) WHERE attribution_mcp_server IS NOT NULL;

-- ── sessions: native labels, native owner, provenance grades.
ALTER TABLE sessions ADD COLUMN ai_title                 TEXT;
ALTER TABLE sessions ADD COLUMN custom_title             TEXT;
ALTER TABLE sessions ADD COLUMN agent_name               TEXT;
ALTER TABLE sessions ADD COLUMN bridge_session_id        TEXT;
ALTER TABLE sessions ADD COLUMN bridge_account_uuid      TEXT;
ALTER TABLE sessions ADD COLUMN bridge_organization_uuid TEXT;
ALTER TABLE sessions ADD COLUMN bridge_conflict          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN prompt_count_source      TEXT;
```

> **Two corrections to an earlier draft of this DDL, both load-bearing.**
>
> **`thinking_tokens` must be NULLABLE.** `output_tokens_details` is absent on
> 32% of the corpus (everything before mid-August 2026). `NOT NULL DEFAULT 0`
> makes *"field not reported"* indistinguishable from *"the model did not
> think"*, fabricating a 0% thinking share for every historical message. This is
> not hypothetical — it produced 23.7% instead of the correct 38.9% for
> `claude-opus-5` during this research. [05 §5.4](05-request-dimensions.md).
>
> **There is no `iterations INTEGER` column.** `usage.iterations` is an **array
> of per-attempt usage records**, not a scalar. An INTEGER can hold only its
> length — 1 for 99.99% of rows — and would discard the fallback from-model, the
> to-model, and the abandoned attempt's tokens, unrecoverably. It is replaced by
> `attempt_count` + `fallback_from_model` above plus a sparse `message_attempts`
> table ([05 §5.4](05-request-dimensions.md)).

Side tables are specified in the chapter that owns them:

| Table | Chapter |
|---|---|
| `pr_links` | [02](02-pr-and-work-items.md) |
| `session_cost_state`, `session_cost_state_model` | [03](03-cost-verification.md) |
| `session_turns`, `tool_results` | [04](04-attribution-hardening.md) |
| `message_attempts` | [05](05-request-dimensions.md) |
| `friction_events`, `friction_retractions`, `model_fallback_events` | [06](06-friction.md) |
| `compaction_events` | [07](07-compaction.md) |

### Deliberate omission: no `FOREIGN KEY (session_id) REFERENCES sessions`

`PRAGMA foreign_keys = ON` (`store/index.ts:90`). `api_error_events` *does*
declare the FK (`:775`) while the parser writes `sessionId: entry.sessionId ??
sessionId ?? ""` (`session.ts:281`, `:318`). An empty string there throws inside
the collector's whole-file transaction, **aborting every write for that file**.
That is a latent bug today, not a hypothetical. New tables enforce membership in
code — the aggregator upserts the session first (`aggregator/index.ts:218-225`)
— and the writer skips rows with an empty session id.

One exception: `pr_links` keeps the FK, matching `ticket_links`
(`store/index.ts:651-670`), because its writer runs after the session upsert in
the same transaction and never sees an empty id. See
[02 §2.1](02-pr-and-work-items.md).

## 1.5 Column vs side table vs JSON

| Kind of signal | Pattern | Why |
|---|---|---|
| Filtered or grouped by (`effort`, `speed`, `prompt_id`, `request_id`) | scalar column on `messages` | a JSON blob cannot be indexed; every effort query would be a full scan |
| An *event* (compaction, fallback, friction, tool result, PR link) | V22 side table, uuid or composite PK, `ON CONFLICT DO UPDATE` | not a billed turn; must stay out of `messages` |
| Genuinely open-ended map (`cost-state.modelUsage`) | normalised child table | it gets joined to `messages` for [03](03-cost-verification.md) |
| Bounded list, never filtered | V10 JSON column | precedent: `file_paths`, `tool_use_counts` |

## 1.6 `message_hourly`: no change in V23

- Every new column is a new dimension or measure, not part of the rollup grain
  `(hour_utc, project_path, model, inference_geo)` (`store/index.ts:365-387`).
- `ALTER TABLE … ADD COLUMN` does not change `COUNT(*) FROM messages`, so the
  freshness watermark (`:938-940`, `isMessageHourlyFresh` `:949-956`) stays
  valid — reads keep hitting the rollup and no rebuild is triggered. Confirmed
  against both readers: `getMessageTotalsFromRollup` (`:1858-1876`) and
  `getEnergyAggregatesFromRollup` (`:3396+`) reference only existing columns.

When an unbounded effort/thinking split is later wanted, that is a *separate*
migration following V12's shape (`DROP TABLE`; `CREATE` with the widened PK;
`recomputeMessageHourly()`). Two costs to state up front:

1. A full rebuild scanning every message row at migration time. V12 already does
   this, so the cost is known, not speculative.
2. **`recomputeMessageHourly`'s `INSERT INTO message_hourly SELECT …`
   (`store/index.ts:896-917`) has no explicit column list — it is positional.**
   Any column added to the table must be added in the same position in the
   `SELECT` or the migration silently writes tokens into the wrong columns. Add
   the explicit column list as part of that change.

Adding `effort`/`speed` to the PK multiplies row count by their cardinality;
adding `thinking_tokens` as a pure `SUM` measure is far cheaper. Prefer the
measure, and serve effort splits from raw `messages` — the pattern
`getMessagesForEfficiency` (`store/index.ts:3192`) already uses.

## 1.7 Backfill and re-collection

State this in the migration docstring, because the next reader will ask:

1. **No migration-time backfill.** This follows the V20 precedent verbatim
   (`store/index.ts:672-697`). V18's docstring (`:591-595`) records why: a
   backfill means re-reading transcripts — a ~0.7 GB re-parse that stalled the
   collector past its timeouts.
2. **`claude-stats backfill` is the opt-in recovery** (`cli/index.ts:1218-1239`):
   `store.resetCheckpoints()` (`store/index.ts:1365-1368`, sets
   `last_offset = 0, last_mtime = 0`) then `collect()`. Because `last_mtime = 0
   ≠ fileStats.mtime`, no file is skipped (`aggregator/index.ts:139-145`);
   `lastByteOffset = 0` forces a re-parse from byte 0 down the full
   `upsertSession` path (`:219-223`), and the CAS skip guard requires
   `startOffset > 0` (`:213`) so it cannot short-circuit. **Adding a column does
   not require a full re-parse to be *correct*, only to be *populated*.**
3. **Ceiling on recovery:** only transcripts still on disk. Per
   `store/index.ts:579-586` and
   [03 §3.1](../schema-drift-2026-09/03-new-sidecar-sources.md), 936 of 1168
   sessions have no transcript left — those rows stay NULL forever. The archive
   mirror would be the second source, but it is not wired into `collect` (§1.2),
   so there is nothing archived to re-parse. Wiring `mirrorSessionRange` is a
   prerequisite for any future archive backfill.
4. `repair/project-paths.ts:47` is the template if a targeted, resumable,
   DB-backed-up per-column repair is ever needed (`--dry-run`, DB copy before
   write, one transaction).

**Needs `backfill` to populate:** every new `messages`/`sessions` column,
`session_turns`, `tool_results`, and all event tables.
**Needs nothing:** `message_hourly`, existing aggregates.

## 1.8 Upsert hazards

**Idempotent already, safe to extend:** `messages` (uuid PK,
`store/index.ts:1153-1216`), `api_error_events` (uuid PK, `:1222-1244`),
`sessions` counters (a projection from `messages`, `:820-849`), `message_hourly`
(per-hour DELETE+INSERT, `:884-942`).

**Not idempotent — never add a counter here:** `upsertSessionIncremental`
(`:1065-1149`) *adds* delta counters. V18's docstring measures the damage: 14×
inflation. Any new session-level count must be a projection in
`recomputeSessionAggregatesSql`, never an additive column.

**Zero-usage replay clobber.** `upsertMessages` treats "all four token fields are
0" as "this copy carries no usage" (`:1165-1169`). `thinking_tokens` / `effort` /
`speed` / `request_id` / `prompt_id` / `attribution_*` all use
`COALESCE(excluded.x, messages.x)` (the `file_paths` pattern, `:1192`) so a
sparser replay cannot null a good value — and for the now-nullable
`thinking_tokens` that COALESCE gives the `keepIfNoUsage()` protection for free.

**A third package: sync-merge.** `packages/cli/src/sync-merge/merge.ts:64-76`
declares `MONOTONIC_COUNTER_FIELDS` (including `thinking_blocks`), and
`sync-merge/apply.ts:59`, `:84` carry the row↔object mappings. Any *session-level*
counter added here must join that list, or two devices' shards will not converge
on it. **A V23 token column touches three packages, not two.**

**`SELECT *` row shapes.** `getSessions` (`:2258`), `findSession` (`:2317`), and
`getChildSessions` (`:3711`) all `SELECT *`; the typed `SessionRow`
(`:4137-4171`) must gain the six new session columns or no caller can see them.
Same for `MessageRow` (`:4173+`).

**Filter-symmetry contract.** `packages/cli/src/__tests__/filter-symmetry.test.ts`
enforces `sessions(message-half) ⊆ sessions(session-half)` with fast-check.
Adding any new *narrowing* dimension to `getSessions` (`--effort`, `--pr`)
requires the matching dimension in `MessageFilter` / `buildMessageFilter`
(`:1898`) or the test fails — by design.

**Sync column lists.** `packages/cli/src/sync-merge/merge.ts:74` and the session
rollup at `:836` carry explicit column lists that must be updated in step with
any column intended to sync — and most of these are *not* (§1.9).

## 1.9 The free-text rule

New fields that carry model- or user-authored free text — `apiRefusalExplanation`,
`hookAdditionalContext`, `hookInfos`, `aiTitle`, `customTitle`, plan-file bodies,
`pastedContents` — **must be dropped at the parser, not filtered downstream.**
The store's guarantee (`store/index.ts:643-648`) is structural: a column
*capable* of carrying free text is the defect, regardless of what is in it
today.

Two consequences worth stating early, because they are load-bearing for
[02](02-pr-and-work-items.md) and [08](08-session-titles.md):

- `HasNoForbiddenPackFields` (`packages/core/src/types/pack.ts:312-313`) checks
  field **names**, not values. A repo-qualified key or a session title would sail
  past it while shipping disclosive text into a document. **`ForbiddenPersonalField`
  (`packages/core/src/types/shard.ts:293-305`) does not cover any title-shaped
  name today** — extending it is mandatory and must land in the same PR that
  stores a title ([08 §8.5](08-session-titles.md)).
- The strongest form of the rule is **compile-time**: a field absent from
  `RawSessionEntry` (`packages/core/src/types.ts:66-125`) cannot be read at all.
  Do not add `hookInfos`, `hookAdditionalContext`, `apiRefusalExplanation`, or
  `toolUseResult` to that type ([06 §6.4](06-friction.md)).
- Repo slugs (`prRepository`) and titles are as disclosive as a Jira project
  prefix ([05-privacy-security §98-99](../05-privacy-security.md)). Neither may
  enter a sync shape or a justification pack without an explicit alias/hash
  mapping.

## 1.10 Sidecar sources (V24 territory)

Not required by any chapter except [03](03-cost-verification.md), and separable
from it. Recorded here so the constraints are in one place:

- `packages/core/src/paths.ts:10-55` gains `statsCacheFile`, `plansDir`,
  `tasksDir`, `fileHistoryDir`, `teamsDir`; `__tests__/paths.test.ts` covers this
  module and needs the new entries.
- `discoverSessionFiles` (`scanner/index.ts:21`) is hard-coded to `projectsDir` +
  `subagents/`. Any new walker must replicate its symlink defence (`:41-45`,
  `:90-100`) exactly.
- `~/.claude/tasks/<uuid>/*.jsonl` are subagent transcripts with **no derivable
  `projectPath`** — the directory is a bare uuid. The parser falls back to
  `cwdFromContent` (`session.ts:212`, `:487`), which should work, but the
  scanner's `SessionFile.projectPath` contract has no value to supply. Open
  design question; resolve before building.
- `~/.claude/sessions/<pid>.<hash>.key` — **never read, never mirror**
  ([03 §3.5](../schema-drift-2026-09/03-new-sidecar-sources.md)).
  `attribution/anchors.ts:44-101` reads only `sessionId` + `entrypoint`; keep it
  that way.
- `stats-cache.json` is a single mutable file with no byte offsets. Its
  ingestion needs a **content-hash checkpoint**, not a byte offset, so it cannot
  reuse `collection_state`.

## 1.11 Surfacing schema drift

[02 §2.5 rec 5](../schema-drift-2026-09/02-transcript-schema-changes.md) is three
steps, in order — not one:

1. Parser emits `shapeSample` + `unknownTypeCounts` (§1.3 step 5).
2. `collect()` actually calls `checkSchema` — the import at
   `aggregator/index.ts:10` is currently unused — and persists via
   `upsertFingerprint` (`store/index.ts:1389`).
3. Render in `diagnose` (`cli/index.ts:870-882`, which today prints only the
   quarantine count) and in `getStatus` / `StatusInfo` (`store/index.ts:3729-3739`,
   `:4447-4453`) for the dashboard.

Note there is **no `doctor` command** in this tool; `diagnose` and `status` are
the two surfaces. `paths.changelogFile` should either be deleted or hashed into
the fingerprint row, so the drift banner can name *which* Claude Code update
coincided with the change.

## 1.12 Test plan

Conventions, verified: all tests live under
`packages/cli/src/__tests__/**/*.test.ts` (`vitest.config.ts:64-67`);
`packages/core` has no test directory — core modules are tested through path
aliases (`vitest.config.ts:28`). Parser tests write **inline JSONL objects to a
temp file** — `tmpFile()` + `writeLines()` + entry factories
(`__tests__/parser.test.ts:8-56`); there are no fixture files for this.
Store tests use `tmpDb()` + a `makeSession()` factory
(`__tests__/store.test.ts:9-47`). `fast-check` is a devDependency
(`package.json:44`) already used in ≥8 suites.

> **New `packages/core` modules need three registrations, not one:** a
> `packages/core/package.json` `exports` entry, a `vitest.config.ts` alias (and
> subpath aliases must precede any bare alias that is a prefix of them — see the
> comments at `vitest.config.ts:47-62`), and usually a re-export from
> `packages/core/src/index.ts`.

1. **`parser-entry-types.test.ts` (new)** — one `it` per new `type`: a minimal
   JSONL line populates the right `ParseResult` channel, and `session`/`messages`
   are byte-identical to a run without that line (the additivity guarantee).
2. **`parser.test.ts` (extend)** — assistant field captures; absent fields yield
   `null`/`0`, never `undefined` leaking into the store.
3. **Golden behaviour comparison** — snapshot `ParseResult` over
   `fixtures/synthetic.ts` before the `switch` refactor, assert identical after.
   This is the only test that protects `allTimestamps` / `activeDurationMs` from
   an accidental reorder.
4. **`store-v23.test.ts` (new)** — construct a `Store`, write rows, close,
   reopen → `PRAGMA table_info` shows all new columns, no row loss; construct
   twice on the same file → the `addColumn` guard makes it a no-op; assert
   `message_hourly` was **not** rebuilt (watermark and row count unchanged) and
   `isMessageHourlyFresh()` is still true.
5. **Upsert semantics** — upsert a message with real usage, then the same uuid
   with all-zero usage and a *missing* `effort`; assert `thinking_tokens` and
   `effort` both survive. This is the test the `keepIfNoUsage`/`COALESCE` choice
   exists for.
6. **Property tests (fast-check):**
   - *P1 split-parse invariant* — for an arbitrary entry sequence,
     `parse(0..n) ≡ parse(0..k) ⊕ parse(k..n)` at any line boundary, for every
     `ParseResult` channel. This encodes the assumption the whole checkpoint
     design rests on and is **currently untested**.
   - *P2 replay idempotence* — upserting an arbitrary prefix twice leaves
     `messages` and all new tables row-identical.
   - *P3 unknown-type tolerance* — an arbitrary object with an unrecognised
     `type` never throws and changes no existing counter; only
     `unknownTypeCounts`.
   - *P4 bound* — `0 ≤ thinking_tokens ≤ output_tokens` per message.
   - *P5* — extend `filter-symmetry.test.ts`'s arbitrary the moment any new
     dimension reaches `getSessions`.
7. **`schema.test.ts` (extend)** — a shape-sample skeleton fingerprints
   identically to the equivalent full entry; a new `type` shows up in
   `SchemaDiff.addedTypes`; and **`schema_fingerprints` is non-empty after a
   collect over a fixture tree** — a test that fails today (§1.2).

## 1.13 i18n rule

Ten locales: `de, en, es, fr, ja, pl, pt-BR, ru, uk, zh-CN`
(`packages/core/src/locales/`). `npm run locales:check`
(`scripts/check-locale-parity.mjs`) enforces identical namespace files,
identical flattened key sets, identical `{{placeholders}}`, identical
`$(codicon)` tokens, **and a per-(locale, namespace) ratchet on values
byte-identical to `en`** against `scripts/locale-identity-baseline.json`
(`check-locale-parity.mjs:22-40`).

**Copying the English string into all ten locales fails the build.** Real
translations are generated locally with `npm run locales:fill`
(`scripts/fill-locales.mjs`, which drives `claude -p`); CI auto-fill was removed.
`locale-parity.test.ts` and `locales-fill.test.ts` cover new keys automatically.

The per-chapter string budgets are rolled up in
[09 §9.4](09-sequencing.md).
