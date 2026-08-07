# 02 — Local data model and store changes

Everything in this file is local-only. The principle from
[05-privacy-security.md](../05-privacy-security.md) holds: attribution happens
on the developer's machine; what crosses to the org plane is decided in
[03](03-org-plane-and-backend.md).

## 2.1 Why not reuse `session_tags`

The tagging substrate (`packages/cli/src/store/index.ts:177`, design in
`plans/10-session-tagging.md`) is the obvious vehicle, and rung-1 manual
linking can ride on it today. But it is the wrong *store* for attribution:

- `validateTag` enforces lowercase `[a-z0-9][a-z0-9_-]{0,49}`
  (`store/index.ts:3090`) — a Jira key survives only case-mangled.
- Tags carry no `source`, `confidence`, or evidence — the ladder in
  [01 §1.5](01-attribution-signals.md) has nowhere to live.
- Tags are session-grained; message-range links don't fit.

## 2.2 New table: `ticket_links`

```sql
CREATE TABLE ticket_links (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ticket_key   TEXT NOT NULL,          -- validated ^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$
  source       TEXT NOT NULL,          -- 'tag' | 'branch' | 'commit' | 'prompt'
  confidence   TEXT NOT NULL,          -- 'high' | 'medium' | 'low'
  granularity  TEXT NOT NULL,          -- 'session' | 'messages'
  first_uuid   TEXT,                   -- message range, when granularity='messages'
  last_uuid    TEXT,
  evidence     TEXT,                   -- matched branch name / commit subject (local only)
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, ticket_key, source)
);
CREATE INDEX idx_ticket_links_key ON ticket_links(ticket_key);
```

One row per (session, key, source): a session can accumulate corroborating
rows (branch + commit), and the effective confidence for reporting is the max,
upgraded when independent sources agree ([01 §1.2](01-attribution-signals.md)).

Migration mechanics are cheap and well-precedented: bump `SCHEMA_VERSION`
(currently 18, `store/index.ts:28`), add a `migrateToV19()` with
`CREATE TABLE IF NOT EXISTS`, one ladder line at `store/index.ts:61-78`. V15
(`:404`) is the nine-line new-table precedent.

## 2.3 Per-message branch — the accuracy investment

Today branch is captured **first-seen-only** per session
(`packages/core/src/parser/session.ts:188`:
`if (entry.gitBranch && !gitBranch)`), so a mid-session branch switch
mis-attributes everything after it. The fix:

- `messages.git_branch` column (nullable, `addColumn` helper — precedent at
  `store/index.ts:213-218`); parser records the entry-level `gitBranch` per
  assistant message instead of only the first.
- **Backfill is bounded by transcript survival.** Files already checkpointed
  are skipped by `collect`, and Claude Code prunes old transcripts — the V18
  docstring (`store/index.ts:526-539`) records that a majority of historical
  sessions had already lost theirs and that invalidating checkpoints for a
  full re-parse was deliberately rejected. So: backfill only where the source
  file (or the opt-in archive) still exists, and mark the rest
  session-branch-only. **Recommending the transcript archive**
  (`config.archive.enabled`, gate at `packages/cli/src/config.ts:173`) becomes
  part of this feature's setup guidance — it is what makes future
  re-attribution possible at all.

## 2.4 The extraction pass

Runs inside `collect` (`packages/cli/src/aggregator/index.ts:45`) after
session upsert, per newly-seen session — deterministic, no LLM, no network:

1. **Branch**: extract keys from `sessions.git_branch` (and per-message
   branches once 2.3 lands) → `source='branch'`, high confidence,
   message-granular where per-message data exists.
2. **Commit subjects**: reuse the recap git reader
   (`packages/cli/src/recap/git.ts`) scoped to the session's project and time
   window → `source='commit'`, medium.
3. **Prompt text**: regex over `messages.prompt_text` for the session →
   `source='prompt'`, low.
4. All extraction is filtered through the **project-key allowlist**
   ([01 §1.1](01-attribution-signals.md)) from a new `tickets` block in
   `Config` (`packages/cli/src/config.ts:14`); with no allowlist configured,
   extraction still runs but everything caps at medium confidence.

Manual paths: extend the `tag` CLI with `claude-stats ticket <session> <KEY>`
(writes `source='tag'`, high), and add `{kind: 'ticket'; key: string}` to the
recap `CorrectionAction` union (`packages/cli/src/recap/corrections.ts:30`) so
the dashboard's task-correction surface can assign keys to topic clusters.
Extraction never overwrites a manual row; manual rows can *negate* (an
explicit "not PROJ-123" tombstone suppresses a wrong automatic link — the
discrediting-row insurance).

## 2.5 The filter-symmetry contract

Cost is never stored; it is computed on read from per-message tokens × pricing
(`getMessageCostInputsByUuids`, `store/index.ts:2187`). So per-ticket cost is
"select the messages, price them" — the selection is the work.

The store has an explicit warning (`store/index.ts:3183-3187`): a narrowing
dimension added to `getSessions` (`:1818`) without the matching clause in
`buildMessageFilter` (`:1583`) makes session counts and token/cost headlines
drift apart. A `ticket` filter must land in **both**, as a session-level
condition (an `EXISTS` against `ticket_links`, range-bounded when
`granularity='messages'`) so it flows through both `messageWhereExists` and
`messageWhereJoin`. This ~10-line change is the single highest-leverage step:
it turns ticket links from a session-list filter into real token/cost
aggregation.

## 2.6 Surfaces

**MCP** (`packages/cli/src/mcp/index.ts`):

- `get_cost_per_ticket` — per key: sessions, tokens, cost, confidence tier
  breakdown, evidence sources; plus the headline **coverage figure**
  (attributed vs total spend in the window). Filters: period/project/account,
  mirroring `get_cost_per_task` (`:480`).
- `ticket` filter on `list_sessions` (`:245`); ticket links shown in
  `get_session_detail` (`:294`).

**CLI/report**: `report --ticket PROJ-123` (threading precedent: `--tag`,
`packages/cli/src/reporter/index.ts:30`), and a per-ticket table + coverage
line in the standard report.

**Dashboard**: a ticket card on the session detail (show links + evidence,
one-click correct/negate) — the correction affordance is what makes rung-1
data accumulate.

## 2.7 What deliberately stays out

No Jira API calls from the store — no issue titles, no status, no auth to
manage. That keeps the local-only posture intact
([05-privacy-security.md](../05-privacy-security.md)) and keeps the feature
deterministic. The ticket *key* is the entire interface; everything richer
happens at the join, on the user's side ([04](04-reporting-and-roi.md)).
