# 03 — Org plane and backend changes

This file answers: what must change in the sync client and the backend
(`packages/infra`) so a team can **automate** per-ticket reporting by
connecting local claude-stats installations to the org's backend — without
breaking the privacy guarantees the org plane is built on.

## 3.1 What the org plane is today (the constraints)

- **One wire shape.** The only session-data write is `syncAggregate` with
  `AggregateSyncInput` (`packages/core/src/types/api.ts:110`, mirrored in
  `packages/infra/graphql/schema.graphql:473`): per-**day** token sums, counts,
  models, tool counts, HMAC-derived account id, estimated cost, `_version`.
  No prompt text, paths, session ids, or branch names.
- **The guarantee is structural, not a filter.** The per-session/per-message
  sync path was deleted, not gated; the narrow shape "has no field capable of
  carrying" content. Stated in four places:
  [05-privacy-security.md](../05-privacy-security.md) §"structural guarantee",
  `schema.graphql:290-299`, `packages/cli/src/sync/index.ts:6-16`, and the
  `syncAggregate.js` resolver header. Any design that widens
  `AggregateSyncInput` with free text breaks a documented claim four times.
- **One row per user-day.** The deployed `UserAggregates` table is keyed
  `(userId, period)` (`packages/infra/lib/stacks/data-stack.ts:204`); this is
  why `projectId` is always `null` today
  (`packages/cli/src/org/aggregate.ts:319`, comment at `:228-230`). A second
  grain cannot ride on this key.
- **Push-only, event-driven, off by default.** No scheduler exists; sync runs
  manually or via `claude-stats.autoSync` (default `false`) hooked to
  collection (`packages/cli/src/extension/sync-integration.ts:264`). Reads
  happen in the hosted SPA, not the CLI.
- **k-anonymity is a backend responsibility**: `minMembersForAggregates` in
  `TeamSettings` (`schema.graphql:78`), enforced org-side by design
  (`org/aggregate.ts:6-8`).

## 3.2 The wire shape: a new, separate narrow aggregate

Following the structural-guarantee pattern, ticket data gets its **own shape
and mutation**, not a widening of the existing one:

```graphql
input TicketAggregateSyncInput {
  period: String!          # "YYYY-MM-DD"
  ticketKey: String!       # server-validated ^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$
  inputTokens: Int!
  outputTokens: Int!
  cacheCreationTokens: Int!
  cacheReadTokens: Int!
  estimatedCost: Float!
  confidence: TicketConfidence!   # HIGH | MEDIUM | LOW — the max tier backing this row
  sessionCount: Int!
  _version: Int!
}
syncTicketAggregates(input: [TicketAggregateSyncInput!]!): TicketSyncResult!
```

Deliberate properties:

- **`ticketKey` is the only non-numeric field**, and it is
  pattern-validated in the resolver (rejecting anything that could smuggle
  free text) — defence-in-depth exactly like `assertShallowCountMap` /
  `assertModelsList` in `syncAggregate.js`. Cap batch rows per request and
  keys per user-day (e.g. 200) to bound abuse.
- **No evidence, no branch names, no session ids** cross the wire — evidence
  stays local ([02 §2.2](02-local-data-model.md)). What syncs is the same
  genus as `AggregateSyncInput`: locally-computed numeric aggregates, plus one
  validated identifier.
- **Coverage syncs too**: add `attributedCost` / `totalCost` (or an
  `unattributed` pseudo-row) so the org dashboard can render coverage honestly
  ([04 §4.2](04-reporting-and-roi.md)) instead of implying the ticket rows are
  the whole spend.
- Client side, this is a second projection alongside `projectUserAggregates()`
  (`org/aggregate.ts:260`) — same purity/determinism contract, same
  `--dry-run` inspectability via a `buildTicketAggregatePayload()` twin of
  `sync/index.ts:331`, same 25-row batching and `_version` conflict protocol.

## 3.3 Backend storage: a new table

`UserTicketAggregates`, PK `userId`, SK `period#ticketKey` — in
`data-stack.ts` next to `UserAggregates`. A composite-SK migration of the
existing table was considered and rejected: it changes the key shape of live
data for zero benefit, and the two grains have different retention and access
rules. GSI `TicketAggregatesByTicket` (`ticketKey` / `period`) serves the
team-level "cost of PROJ-123 across all developers" query. Prod inherits the
stack posture (KMS, PITR, RETAIN); TTL for retention (§3.6).

**Rollup**: mirror the existing stream-worker pattern —
`packages/infra/lambda/api/aggregate-stats.ts` already fans
`UserAggregates` stream events into weekly per-member `TeamStats`. A
`ticket-stats` worker on the new table's stream maintains
`TeamTicketStats (teamId, period#ticketKey)` so the dashboard reads one row
per ticket instead of scanning per-user rows. Alternatively resolve
team-level sums on demand through the GSI; the stream worker wins once teams
are larger than a handful.

**API**: `myTicketAggregates(period)`, `teamTicketCosts(teamId, period)`
(admin/lead-gated), and a `ticketCostExport(teamId, period)` query returning
rows shaped for the Jira join ([04](04-reporting-and-roi.md)). Subscriptions
analogous to `onAggregateSynced` are optional polish.

## 3.4 The privacy analysis — where this design must be honest

**A ticket is usually one developer's work.** Per-ticket rows are therefore
per-developer data in all but name, and `minMembersForAggregates`-style
k-anonymity is *meaningless* at this granularity — a cohort threshold over a
one-person cohort protects nothing. The design must not pretend otherwise:

1. **The gate is consent, not cohort math.** Ticket sync is a separate opt-in
   on top of org sync (its own flag in `PersistedSyncConfig` and setting next
   to `claude-stats.autoSync`), and the membership `ShareLevel`
   (`FULL | SUMMARY | MINIMAL`, `schema.graphql`) gates who can see per-ticket
   rows with the developer's identity attached: `FULL` → per-dev per-ticket;
   `SUMMARY` → the developer's rows appear only in team-level ticket sums;
   `MINIMAL` → no ticket rows sync at all.
2. **Readable keys are the point.** Hashing ticket keys (the `projectId`
   "hashed by default" precedent, 05 §sync rules) would defeat the Jira join
   that motivates the feature. So readable keys are an explicit **team policy
   plus per-user opt-in** — the escape-hatch pattern 05 already uses for git
   branch names ("opt-in only"). A hashed mode (HMAC under a team-held salt)
   remains available for orgs that want cost curves without legible work
   items, but it is the degraded mode, not the default posture to hide behind.
3. **Sensitivity classification**: 05's table already rates branch names
   Medium *because* they "may reveal feature names, ticket IDs". A ticket key
   joined with cost reveals per-work-item spend; keep Medium, and say plainly
   in 05 that enabling ticket sync shares per-work-item, per-person cost with
   team admins.
4. **Amend [05-privacy-security.md](../05-privacy-security.md) in place** (the
   doc's own precedent: the prompt-text correction): the "what is synced"
   list gains the ticket aggregate shape; the "never synced" list is
   unchanged — evidence text, branch names (still opt-in), prompt text, and
   session ids still never cross.

The adoption argument closes the loop: a per-ticket figure can flip from "dev
justifies budget" to "manager surveils per-ticket efficiency". The two-plane
model's answer stands — attribution is computed locally and **the developer
decides what goes up**. A tool developers refuse to run produces no ROI data
for anyone; the consent gate is what makes the numbers exist at all.

## 3.5 Automation — what "connect and forget" requires

- **Push**: the existing event-driven `autoSync` already gives automation once
  the ticket projection joins the same engine — no scheduler needed locally.
  Ticket rows piggyback on every post-collection sync.
- **Reporting cadence**: a scheduled EventBridge rule invoking the export
  query (or the SPA's team dashboard) covers "weekly report to the manager".
  Pushing *into* Jira (a comment/field per ticket) is possible against the
  export API but belongs in a separate integration outside store and backend —
  neither should hold Jira credentials.
- **Fleet setup**: endpoint discovery via `/.well-known/claude-stats.json`
  (`sync/index.ts:214`) and env-var overrides already support org-managed
  provisioning; the ticket allowlist (project keys) should be distributable
  the same way — a team-level setting the client pulls at `link` time, so
  extraction quality is uniform across the fleet without per-dev config.

## 3.6 Retention and frontend

Per-ticket rows are finer than the day rows, so retention should be at most as
long: the suggested 05 posture (90 days detailed, 1 year rollups) maps to TTL
on `UserTicketAggregates` (90d) with `TeamTicketStats` monthly rollups kept a
year. Frontend: a "Tickets" section on `TeamDashboard` (per-ticket table,
coverage headline, confidence tiers) and on the personal `Dashboard`; the
per-dev drill-down renders only for `FULL`-share members and admins.
