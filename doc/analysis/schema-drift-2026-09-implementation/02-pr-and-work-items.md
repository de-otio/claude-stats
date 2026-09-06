# 02 — PR Linkage and the Work-Item Key Space

Implements [§4.1](../schema-drift-2026-09/04-feature-opportunities.md).

## 2.0 The live data contradicts the plan's premise

§4.1 calls this *"small. Parse the entry, one table, one join"* and asserts
PR→ticket derivation *"via PR title/branch"*. Both claims need revising.

**Measured** [live], read-only scan of `~/.claude/projects`, 2026-09-01:

| Fact | Value |
|---|---|
| Files containing `pr-link` | 36 |
| Total `pr-link` entries | 7,926 |
| Distinct `(prRepository, prNumber)` | 457 |
| Distinct `(session, PR)` pairs | 460 |
| Date range | 2026-07-27 → 2026-09-01 |
| Field set (all 36 files, no variance) | exactly `{type, sessionId, prNumber, prUrl, prRepository, timestamp}` |
| Entries where `entry.sessionId ≠ filename uuid` | **0** — always self-referential |
| Sessions touching >1 PR | 28 / 36; **max 44 PRs in one session** |
| PRs spanning >1 session | 2; max 2 sessions per PR |
| Consecutive-run structure | 551 runs, avg 14.4 entries/run, **median inter-entry gap 54 s**, median run duration 782 s |
| PRs re-entered later in the same session | 59 / 460 (13%) |
| Entries whose `prRepository` basename matches the session `cwd` basename | 3,615 (46%) — **4,311 (54%) name a different repo** |

Three consequences reshape the design.

**1. `pr-link` is not "the PR this session produced."** It is a repeated,
per-turn stamp of the *currently-active PR context*, emitted roughly once per
turn for a stretch of work. A naive `INSERT` per entry writes 7,926 rows for 460
facts — **17.3× amplification**. Dedup is mandatory, not an optimisation.

**2. The run structure is the feature, not noise.** Consecutive same-PR entries
delimit a contiguous *time range inside* a session. That is the first
attribution signal in this codebase capable of splitting a multi-PR session's
cost with real evidence: branch is session-level and first-seen-only
(`packages/core/src/parser/session.ts:188`), and commit is never message-bound
(`packages/core/src/attribution.ts:194-205`). It maps directly onto the existing
`granularity: "messages"` + `first_uuid`/`last_uuid` model.

**3. There is no PR title and no head branch in the entry.** §4.1's "PR
title/branch → ticket" derivation **cannot be done offline from `pr-link`
alone**. It needs either a network call or an offline proxy (§2.4).

One further correction: §4.1 claims this is *"most of the attribution work
[business-value-visibility](../business-value-visibility/) planned to build."*
That folder's own diagnosis is the opposite —
[01-the-visibility-gap.md:16](../business-value-visibility/01-the-visibility-gap.md):
*"Credibility and grain are largely solved… Surface and cadence are the gap."*
`pr-link` adds a new object on the *solved* axis. **This work belongs to
[ticket-attribution/](../ticket-attribution/), not to business-value-visibility.**

## 2.1 Current state

### Ticket key model

- `TICKET_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/` —
  `packages/core/src/tickets.ts:22`; scan variant `:25`. Validation only;
  extraction lives elsewhere by design (`:1-11`).
- `parseTicketKey` uppercases + validates (`:40-43`); `requireTicketKey` throws
  at trust boundaries (`:49-58`); `matchesProjectAllowlist` strips at the last
  hyphen and compares the prefix (`:68-72`).
- Branded type `TicketKey` — `packages/core/src/types/insight.ts:20`.

The gap is exact: this shape admits Jira **and Linear** (`ABC-123`) and nothing
else. `#123`, `<org>/<repo>#123`, and `AB#123` are all rejected by
`requireTicketKey`, which `Store.addTicketLink` calls unconditionally
(`packages/cli/src/store/index.ts:2629`). **No non-Jira key can reach
`ticket_links` at all today.** (§4.1's "Jira-only" framing is imprecise — Linear
is already covered.)

### Evidence-grade model

`AttributionSource = "tag" | "branch" | "commit" | "prompt"`
(`types/insight.ts:27`); `Confidence = "high" | "medium" | "low"` (`:30`);
`LinkGranularity = "session" | "messages"` (`:37`).

Grades assigned at `packages/core/src/attribution.ts:181-219`:

| source | confidence | granularity | evidence |
|---|---|---|---|
| `branch` | `high` with allowlist, else `medium` | `messages` if uuid-bound, else `session` | branch name |
| `commit` | always `medium` | always `session` | commit subject |
| `prompt` | `medium` if branch/commit agrees, else `low` | uuid-bound | `null` (deliberate) |
| `tag` | `high` (CLI/dashboard only) | `session` | — |

Aggregation (`attribution.ts:280-363`): per `(session, key)` take
`maxConfidence`, then **upgrade one step when `sources.size >= 2`** (`:304-308`).
Multi-key sessions contribute **full cost to every key** — never split
(`:238-242`) — and land in `coverage.ambiguousSessions`. The invariant
`coverage.attributedCost + unattributed === totalCost` holds exactly
(`:267-279`).

### `ticket_links` (schema V19, `store/index.ts:651-670`)

```sql
ticket_links(session_id, ticket_key, source, confidence, granularity DEFAULT 'session',
             first_uuid, last_uuid, evidence, negated DEFAULT 0, created_at,
             PRIMARY KEY (session_id, ticket_key, source),
             FOREIGN KEY (session_id) REFERENCES sessions(session_id))
```

Writes: `addTicketLink` (`:2619-2658`) with the manual-wins guard `WHERE
ticket_links.source != 'tag' OR excluded.source = 'tag'` (`:2643`);
`negateTicketLink` (`:2669-2682`, a tombstone at `source='tag'`);
`removeTicketLink` (`:2660-2665`); `deleteAutomaticTicketLinks` (`:2697-2700`,
`DELETE … WHERE source != 'tag'` — the safety property behind
`repair/ticket-links.ts`).

Readers: `ticketPredicate` (`:48-49`), `getTicketLinkCounts` (`:2706-2716`),
`getTicketLinksForSession` (`:2719-2725`), `getTicketKeys` (`:2736-2751`),
`getActiveTicketLinks` (`:2765-2799`, the aggregation input),
`getActiveTicketLinkDetails` (`:2825-2860`, drill-down),
`getTicketLinkGrades` (`:2880-2895`, calibration input —
`packages/core/src/calibration.ts:244,286`).

Write path: `runTicketExtraction` (`packages/cli/src/ticketing/index.ts:108-166`),
called per upserted session from `collect`; subagent inheritance at `:149-165`.
Query path: `getTicketCostReport` (`ticketing/index.ts:276-379`).

### Git archaeology today

`packages/cli/src/git.ts` is 26 lines and does exactly one thing:
`getGitRemoteUrl(projectPath)` reads `.git/config` textually and returns the
`[remote "origin"]` url (`:13-26`).

`sessions.repo_url` is populated at `aggregator/index.ts:180-186` — resolved once
per *parser-corrected* project path, cached, stamped before upsert; also repaired
by `repair/project-paths.ts:75`. **It is the raw remote URL string**
(`git@host:<org>/<repo>.git` or `https://…`), never normalised to
`<org>/<repo>`. That normalisation does not exist anywhere yet.

`packages/cli/src/recap/git.ts` shells out: `getCommitSubjectsInWindow`
(`:282-306`, `git log --since --until --format=%s`, capped, memoized per
project-day at `:329-400`) and `getMergedPrCountToday`, which shells `gh pr list
… --json=number` and returns `null` silently on any failure. **That is the
precedent that a best-effort `gh` call is already acceptable in this tree** — but
only in recap, never in the attribution path.

**What `pr-link` replaces: nothing.** There is no branch→PR, no PR→ticket, no PR
anything in the attribution path. This is purely additive.

## 2.2 New table

Do **not** put PRs into `ticket_links`. Three reasons: `addTicketLink`
hard-validates against the Jira regex (`store/index.ts:2629`); the PK
`(session_id, ticket_key, source)` cannot hold two disjoint time ranges for two
PRs in one session; and a PR is an *observation*, not a graded claim. Keep the
observation table separate and **derive** graded links from it.

```sql
-- V23: session→PR observations, from transcript `pr-link` entries.
CREATE TABLE IF NOT EXISTS pr_links (
  session_id    TEXT    NOT NULL,
  pr_repository TEXT    NOT NULL,   -- '<org>/<repo>', verbatim from the entry
  pr_number     INTEGER NOT NULL,
  run_index     INTEGER NOT NULL,   -- 0-based; a session may re-enter the same PR
  first_ts      INTEGER NOT NULL,   -- epoch ms, first entry of this run
  last_ts       INTEGER NOT NULL,   -- epoch ms, last entry of this run
  entry_count   INTEGER NOT NULL,   -- raw entries collapsed into this run
  first_uuid    TEXT,               -- nearest message uuid at/after first_ts
  last_uuid     TEXT,               -- nearest message uuid at/before last_ts
  pr_url        TEXT,               -- LOCAL-ONLY, like ticket_links.evidence
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_repository, pr_number, run_index),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_links_pr      ON pr_links (pr_repository, pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_links_session ON pr_links (session_id);
```

Sizing from live data: 551 rows for 36 sessions over five weeks. Trivial.

The FK is kept here — unlike the event tables in
[01 §1.4](01-foundation.md) — because this writer runs after the session upsert
inside the same transaction and never sees an empty session id, matching
`ticket_links`.

Additive, idempotent, **zero backfill** (V19/V20 precedent,
`store/index.ts:649`, `:680-687`). Transcripts predating 2026-07-27 carry no
`pr-link` at all.

## 2.3 Parser capture and run collapse

`packages/core/src/parser/session.ts` gains a `pr-link` case
([01 §1.3 step 1](01-foundation.md)) emitting a `prLinkEvents: PrLinkEvent[]`
channel on `ParseResult`, mirroring `apiErrorEvents` (`session.ts:35-37`).

**Run collapse must happen at the store, not the parser.** `parseSessionFile` is
called with a `startOffset` (`aggregator/index.ts:167-171`), so a session parsed
across several `collect` runs yields *fragments* of a run — a parser-side
collapse would produce a different answer depending on where the byte boundary
fell.

Store-side rule: an incoming event within `RUN_GAP_MS` of an existing run's
`last_ts` for the same `(session, repo, number)` **extends** that run
(`last_ts = max`, `entry_count += 1`); otherwise it opens `run_index + 1`.

`RUN_GAP_MS = 30 * 60 * 1000`. Basis: the observed p90 inter-entry gap *inside* a
run is 306 s, so 30 min is ~6× headroom and still well inside the 782 s median
run duration. Document the measured basis in the migration docstring the way
`COMMIT_WINDOW_PAD_MS` does (`ticketing/index.ts:30-37`).

`first_uuid`/`last_uuid`: one
`SELECT uuid FROM messages WHERE session_id = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1`
per run boundary, batched; `NULL` when the range falls outside recorded
messages.

## 2.4 PR → work item: three derivations

`pr-link` carries no title and no branch, so there are exactly three paths.

### D1 — the PR *is* the work item (zero network) — **ship**

For GitHub-native shops, `<org>/<repo>#123` *is* the ticket. No derivation
needed. This is the single biggest real win and it needs no PR metadata at all —
it needs a widened key namespace (§2.5).

New source `"pr"`. Confidence **`high`** when `prRepository` matches the
session's own repo (§2.6), **`medium`** otherwise.

Justification against the ladder in
[ticket-attribution/01 §1.2](../ticket-attribution/): rung 1 is "explicit and
contemporaneous". A `pr-link` entry is emitted *by the tool, during the work* —
contemporaneous and non-inferred, strictly stronger than rung 2 (branch,
first-seen-only) and far stronger than rung 4 (prompt regex). It sits at rung
1.5. Unlike every existing automatic source it is `granularity: "messages"` **by
construction**.

### D2 — offline PR ↔ Jira/Linear bridge via merge-commit subjects — **ship**

GitHub merge commits read `Merge pull request #123 from <org>/<branch>`; squash
merges read `<subject> (#123)`. `getCommitSubjectsInWindow` (`recap/git.ts:282`)
**already pulls exactly these strings into the extraction pass**
(`ticketing/index.ts:111-116`).

So: scan each commit subject for both a `#<n>` PR reference and a Jira/Linear
key. Where both appear in one subject you have an offline `PR#n ↔ PROJ-123`
edge, and every session linked to `PR#n` inherits `PROJ-123` at `source: "pr"`,
`confidence: "medium"` — a merge commit lands *after* the spend, the same
reasoning that caps `commit` at medium (`attribution.ts:199`).

This is the honest, deterministic version of §4.1's "PR title → ticket" claim.

### D3 — `gh pr view <n> --json title,headRefName` — **defer behind a flag**

Precedent exists (`recap/git.ts` `getMergedPrCountToday`). If built: gate behind
a new `tickets.enrichPrs` (default **off**), cache per `(repo, number)` with a
TTL, return `null` silently on failure, grade `high` only when the head branch
also matches `sessions.git_branch`.

**Not on the `collect` hot path.** `runTicketExtraction` runs once per upserted
session and a `backfill` would fan out hundreds of network calls. It would be a
separate `claude-stats repair pr-tickets` pass, mirroring
`repair/ticket-links.ts`.

It also sits against the "no ticket-system API / deterministic and auditable"
non-goal at
[ticket-attribution/04-reporting-and-roi.md:73-82](../ticket-attribution/) — in
spirit, even though the API here is GitHub's. **Open question for the user.**

### Effect on the grade ladder

`AttributionSource` becomes `"tag" | "branch" | "commit" | "prompt" | "pr"`
(`types/insight.ts:27`). The corroboration upgrade (`attribution.ts:306`) then
works unchanged: `branch` + `pr` agreeing on a key is two independent sources and
upgrades one step — exactly the intended mechanic.

## 2.5 Widening the key space

The bottleneck is `requireTicketKey` at `store/index.ts:2629`, which every write
funnels through. Keep `TicketKey` as-is; add a sibling validator in
`packages/core/src/tickets.ts`:

```ts
export const GH_ITEM_RE   = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}#[0-9]{1,7}$/;
export const AZDO_ITEM_RE = /^[A-Z]{1,10}#[0-9]{1,7}$/;   // AB#123
export type WorkItemKey = TicketKey | GhItemKey | AzdoItemKey;
export function parseWorkItemKey(v: string): WorkItemKey | null;
```

**One behavioural fork:** GitHub keys must **not** be uppercased
(`parseTicketKey` uppercases at `tickets.ts:41`) — repo slugs are
case-sensitive. This is the single most regression-prone detail in the chapter.

| System | Key form | Signal source | Network? |
|---|---|---|---|
| GitHub PR | `<org>/<repo>#123` | `pr-link` directly (D1) | no |
| GitHub issue | `<org>/<repo>#123` | commit/branch/prompt scan for `#123`, `Closes/Fixes/Resolves #123`; org/repo half resolved from `sessions.repo_url` | no |
| Cross-repo GH issue | `<org>/<repo>#123` | the fully-qualified form in commit subjects and prompts | no |
| Linear | `ABC-123` | **already covered** by `TICKET_KEY_RE` | no |
| Azure DevOps | `AB#123` | commit-subject / branch / PR-description scan | no |
| Jira/Linear via PR | `PROJ-123` | D2 merge-commit bridge | no |

**A bare `#123` must never become a key on its own.** Without an owning repo it
collides with issue numbers everywhere. Always qualify against
`sessions.repo_url`, and drop the link when `repo_url` is null.

**The allowlist needs an answer.** `matchesProjectAllowlist` (`tickets.ts:68`) is
prefix-based and meaningless for `<org>/<repo>#n`. Proposal: a GitHub key's
allowlist analogue is *"the repo equals the session's own repo"* (§2.6) — a
structurally stronger filter than a configured prefix. So same-repo GH keys may
take `high` with no config, while cross-repo caps at `medium`, exactly as the
no-allowlist Jira case does (`attribution.ts:186`).

Where the logic lives:

- validators + regexes → `packages/core/src/tickets.ts` (extend, don't fork)
- key-space type → `packages/core/src/types/insight.ts:20-27`
- scanning + grading → `attribution.ts` `scanKeys` (`:100-116`) gains a second
  pass; `extractTicketLinks` (`:173`) gains a `prRuns` input alongside
  `branches`/`commits`/`prompts`, staying pure
- `<org>/<repo>` normalisation from a remote URL → **new pure**
  `packages/core/src/repoSlug.ts` (not `packages/cli/src/git.ts`, which is I/O)
- store gate → `addTicketLink` switches `requireTicketKey` → `requireWorkItemKey`

## 2.6 The same-repo test (the authorship discriminator)

**54% of live entries name a repo other than the session's `cwd`.** Without a
discriminator, a session that reviewed 44 PRs across 9 repos attributes its full
cost to all 44 — and the ambiguity rule (`attribution.ts:238-242`) forbids
silently splitting, so it would inflate 44 rows. That is the discrediting
failure mode the tombstone mechanism exists for (`store/index.ts:637-642`).

Needed: a pure `normalizeRepoSlug(remoteUrl): string | null` handling
`git@host:<org>/<repo>.git`, `https://host/<org>/<repo>(.git)`, and
`ssh://git@host/<org>/<repo>`; compare against `pr_links.pr_repository`. Compute
the verdict at read time — do not denormalise.

Same-repo → `high`. Cross-repo → `medium` at best, and **consider excluding
cross-repo runs from cost attribution entirely** until calibration data exists.
`buildAttributionCalibration` (`packages/cli/src/calibration/index.ts`) already
measures exactly this kind of precision.

## 2.7 The cost join

The pricing invariant in this codebase is that a report's total must be summed
from the *same* per-session map its rows derive from (`ticketing/index.ts:266-275`,
`attribution.ts:267-279`). **Do not write a second pricing pass.** Reuse:

1. `store.getSessionIdsWithMessages(filter)` — `store/index.ts:2577`
2. `store.getMessageTotalsBySession(ids, { since, until })` — `:3124`, then
   `estimateCost` per row (`packages/core/src/pricing.ts`), exactly as
   `getTicketCostReport` does at `ticketing/index.ts:301-332`

Then one query against `pr_links`:

```sql
SELECT p.pr_repository, p.pr_number,
       p.session_id, p.first_ts, p.last_ts, p.entry_count,
       s.repo_url, s.git_branch
  FROM pr_links p
  JOIN sessions s ON s.session_id = p.session_id
 WHERE p.session_id IN (<window ids>)
 ORDER BY p.pr_repository, p.pr_number, p.session_id, p.run_index;
```

Fold in TypeScript against the `sessionCosts` map:
`aggregatePrCosts(prRuns, sessionCosts, totalCost)`, a near-clone of
`aggregateTicketCosts` (`attribution.ts:280`) returning the same `coverage`
shape.

**Two costing modes; the choice matters.**

- **Whole-session (default, honest).** A session touching *k* PRs contributes its
  full cost to each; `coverage` counts it once and `ambiguousSessions`
  increments. Zero new machinery, identical semantics to today's ticket rows.
  With 28/36 sessions touching >1 PR, **ambiguity will be the norm, not the
  exception** — the coverage header must say so plainly.
- **Run-bounded (`--split-by-run`, the upgrade `pr-link` uniquely enables).**
  Price only the messages inside `[first_ts, last_ts)`. This is a real split with
  real evidence, not an invented 50/50 — the thing
  [ticket-attribution/01 §1.3](../ticket-attribution/) forbids inventing. **But
  it does not partition the session:** gaps between runs belong to no PR, so
  `sum(pr costs) ≤ session cost` and the residue must be reported as
  unattributed, or the `attributed + unattributed === total` contract breaks.

Ship whole-session first; add run-bounded behind an explicit flag once
calibrated. For the message-range pricing, reuse
`store.getMessageCostInputsByUuids` (`store/index.ts:4106+`) — it is how
`cost-per-task` prices task segments — rather than adding a timestamp-range
aggregate.

## 2.8 Surfaces

| Surface | File | Change |
|---|---|---|
| Parser | `packages/core/src/parser/session.ts:220-291`, `:24-38` | `pr-link` case + `prLinkEvents` channel |
| Migration | `packages/cli/src/store/index.ts` (`migrateToV23`, bump `SCHEMA_VERSION` at `:30`, extend the ladder at `:128-134`) | `pr_links` DDL |
| Store | `packages/cli/src/store/index.ts` | `upsertPrLinkRun`, `getPrLinksForSessions`, `getPrKeys`, `deleteAutomaticPrLinks` |
| Aggregator | `packages/cli/src/aggregator/index.ts:160-200` | persist `prLinkEvents` inside the existing transaction |
| Extraction | `packages/cli/src/ticketing/index.ts:108-166` | feed PR runs into `extractTicketLinks`; subagent inheritance (`:149-165`) must carry `pr` links |
| Pure attribution | `packages/core/src/attribution.ts:173-222`, `:280-363` | new `pr` source + grading |
| Types | `packages/core/src/types/insight.ts:27` | widen `AttributionSource` |
| Repair | `packages/cli/src/repair/ticket-links.ts` | re-derive `pr` links; **must preserve `source='tag'`** (`store/index.ts:2698`) |
| CLI `ticket` | `packages/cli/src/cli/index.ts:1061-1132` | accept a `<org>/<repo>#n` key; `--list` shows `pr/<grade>` rows |
| CLI `report` | `packages/cli/src/reporter/index.ts:997-1060` | accept the qualified key on `--ticket`, or add `--pr` |
| MCP | `packages/cli/src/mcp/index.ts:586-700` | `get_cost_per_ticket` describes the `pr` source; drill-down surfaces PR URL + run window. **Fold rather than add `get_cost_per_pr`** — two competing coverage numbers on one screen is worse than one |
| Dashboard table | `packages/cli/src/server/ticketTable.ts` | PR rows render `<org>/<repo>#n`, link out to `pr_url` |
| Dashboard card | `packages/cli/src/server/ticketCard.ts` | manual link/negate accepts a PR key |
| Nav / gating | `packages/cli/src/server/nav.ts:87-95`, `packages/cli/src/config.ts:107-120`, `:498-502` | `tickets.showUi` still gates (default off) |
| Dashboard data | `packages/cli/src/dashboard/index.ts` | `DashboardTicketRow` key field must tolerate the longer PR form |
| Recap | `packages/cli/src/recap/types.ts:107-112`, `recap/corrections.ts:166-197`, guard at `:19` | `recap correct ticket` accepts a PR key |
| Pack | `packages/core/src/types/pack.ts:39-48` | **blocked — see §2.9** |
| Schema monitor | `packages/cli/src/schema/monitor.ts:35-40` | records unknown types generically; no change needed |

`cost-per-task` has no PR awareness today — only a comment at
`packages/cli/src/cost-per-task/index.ts:199` and a "PR review" future-signal
note at `outcome-types.ts:28`. A `pr-link` run is a real mechanical outcome
signal; **worth a follow-up, out of scope here.**

## 2.9 Org-plane blocker

`prRepository` and `prUrl` are free text under the structural no-free-text
guarantee, stated in four places
([ticket-attribution/03-org-plane-and-backend.md:12-16](../ticket-attribution/),
`packages/cli/src/sync/index.ts:7-15`,
[05-privacy-security.md:136-140](../05-privacy-security.md), and the
`syncAggregate.js` resolver header). A repo slug is at least as disclosive as a
Jira project prefix
([05-privacy-security.md:98-99](../05-privacy-security.md)).

`pr_url` is local-only, like `ticket_links.evidence`. But a **repo-qualified key
in `PackTicketRow` would sail past `HasNoForbiddenPackFields`** — which checks
field *names*, not values (`packages/core/src/types/pack.ts:312-313`) — and ship
a repo name into a document.

**Either keep PR keys out of the pack and every sync shape, or add an explicit
alias/hash mapping first.** This needs a decision before any of §2.2 is written;
it is [09 §9.5 Q1](09-sequencing.md).

## 2.10 i18n

~14 new keys × 10 locales ≈ 140 strings, plus two rewordings.

`common.json` — `insight.source.pr` (joins the `insight.confidence.*` family used
by `tierBadge`, `server/ticketTable.ts:56-59`).

`cli.json` — `commands.reportPr`; **reword** `commands.ticketKeyArg` (currently
"Ticket key (e.g. PROJ-123)…", must mention `<org>/<repo>#123`);
`report.prTitle`, `report.prNotFound`, `report.prSessionsLabel`,
`report.prRunWindowLabel`; `ticket.invalidWorkItemKey`.

> `requireTicketKey`'s throw text is a **hardcoded English `Error`** today
> (`tickets.ts:52-56`) — not translated. Widening the key space is the moment to
> fix that.

`dashboard.json` — `tickets.prColumnLabel`, `tickets.prOpenLink`,
`tickets.prCrossRepoNote`, `tickets.prAmbiguousNote`, `tickets.prRunSplitNote`
(only with run-bounded costing), `ticketCard.prPlaceholder`;
`settings.enrichPrs` + hint only if D3 ships.

`extension.json` — the ticket block at `:276` needs the same placeholder
wording if the webview card is reused.

## 2.11 Tests

**Pure** (`packages/cli/src/__tests__/attribution.test.ts`):

- `parseWorkItemKey` accepts `<org>/<repo>#1`, `AB#123`, `PROJ-123`; rejects bare
  `#123`, `…#0`, an 8-digit number, a 40-char org, a `/`-less slug.
- **Case preservation for GH keys vs uppercasing for Jira keys** — the one
  behavioural fork, and the one a regression would silently break.
- `repoSlug.ts`: fast-check property — `normalizeRepoSlug` is invariant across
  the four remote-URL forms for the same repo, `null` for non-GitHub hosts.
- `pr` source grading (same-repo `high`, cross-repo `medium`); corroboration
  upgrade fires for `branch` + `pr`; a `pr` link never overwrites `tag`;
  multi-PR session lands in `ambiguousSessions`; **`attributed + unattributed
  === totalCost` still holds exactly** with `pr` links in the mix.

**Parser** (`__tests__/parser.test.ts`): a `pr-link` line yields one
`prLinkEvents` entry; a malformed one (missing/non-numeric `prNumber`, no
timestamp) is *dropped, not defaulted*; an **incremental parse splitting a run
across two `startOffset` calls still yields one merged run after the store
upsert** — the failure mode the run-merge rule exists for.

**Store** (new `__tests__/pr-links.test.ts`): 17 duplicate entries collapse to
one row (use the measured shape — ~14 entries, 54 s apart); a gap > `RUN_GAP_MS`
opens `run_index = 1`, under it extends run 0; `first_uuid`/`last_uuid` resolve
to real uuids and `NULL` outside range; the FK requires the session to exist
first; re-running `collect` over an unchanged file changes no row.

**Integration** (extend `__tests__/ticket-attribution.test.ts`): fixture
transcript with `pr-link` → `pr_links` → derived `ticket_links` at `source='pr'`
→ visible in `getTicketCostReport`; D2 bridges `PROJ-9: thing (#123)` at
`medium`; a `tag` row survives repair re-derivation; subagent inheritance carries
`pr` links; a cross-repo run does **not** produce a `high` link.

**CLI/MCP** (`ticket-cli.test.ts`, `ticket-table.test.ts`,
`ticket-ui-visibility.test.ts`): a PR key round-trips, renders with its tier
badge, and stays hidden when `tickets.showUi` is false.

## 2.12 Effort, risks, open questions

**Effort — not "small".**

| Piece | Estimate |
|---|---|
| Parser + `pr_links` + aggregator wiring + run-merge | ~1 day |
| `WorkItemKey` widening across `tickets.ts` / `insight.ts` / `addTicketLink` / recap corrections | ~1 day (touches every write funnel) |
| `repoSlug.ts` + same-repo grading + `pr` source | ~0.5 day |
| D2 merge-commit bridge | ~0.5 day (reuses `getCommitSubjectsInWindow` verbatim) |
| Surfaces (CLI, MCP, 2 dashboard files, reporter, recap) | ~1.5 days |
| i18n ~140 strings, generated locally | ~0.5 day |
| Tests | ~1.5 days |
| **Total** | **≈ 6–7 days** |

The transcript→table half really is small. The key-space widening and the
surface fan-out are not.

**Risks**

1. **Attribution inflation.** 28/36 sessions touch >1 PR (max 44). Shipping
   whole-session costing without the same-repo filter produces visibly absurd
   rows. Mitigation: same-repo filter *and* ambiguity note, both before first
   release.
2. **Row amplification** if dedup is wrong: 17.3× measured.
3. **Org-plane leak** (§2.9) — blocking for the pack and any sync shape.
4. **Key-space widening is a trust-boundary change.** `requireTicketKey` is
   currently the single narrow gate every stored key passes (`tickets.ts:1-11`
   states this is the module's purpose). Widen the gate; do not remove it.
5. **Run-bounded costing does not partition a session.** Shipping it as if it did
   breaks the invariant `aggregateTicketCosts` exists to guarantee.
6. **Prevalence is unmeasured beyond this machine.** A user who never opens a PR
   from Claude Code gets zero coverage.

**Open questions** — see [09 §9.5](09-sequencing.md):

1. Do PR keys enter the justification pack / any sync shape at all, or stay
   strictly local? (Blocks §2.2's `pr_url` handling and `PackTicketRow`.)
2. Whole-session or run-bounded as the default?
3. Ship D3 (`gh pr view`) at all?
4. Is a GitHub PR a *ticket* (one key space, one table, one coverage figure) or a
   separate business object? **Recommend one key space** — the coverage
   denominator is the same spend.
5. Does `tickets.showUi` gate PR rows too? **Recommend yes**, until
   `buildAttributionCalibration` has data on the `pr` source.

**UNVERIFIED**

- `RUN_GAP_MS = 30 min` is inferred from this machine's gap distribution only.
- The emission trigger for `pr-link` is not established — whether it fires on PR
  *creation* or is an ambient current-PR stamp. Sampling was inconclusive.
- Whether `prNumber` is ever absent (a `pull/new/<branch>`-style reference). Not
  observed in 36 files, which is not proof.
- Whether `pr-link` appears in subagent sidechain files. All 36 sampled files had
  `entry.sessionId == filename`, but they were not classified as subagent vs
  parent.
