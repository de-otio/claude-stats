# TeamStats org-plane fan-in chain — wired end-to-end (2026-07-10)

Made the team app's org plane actually work: client aggregate sync →
`userAggregates` → DynamoDB stream → `aggregate-stats` worker → weekly
`TeamStats` → team readers + scoring crons. All of it was dead or broken
before. Deployed to prod (infra `0.1.24`), full-chain e2e green.

## Bugs fixed / gotchas (the expensive-to-rediscover ones)

### 1. `ddb.query` sugar emits an INVALID placeholder for `#`-containing attr names
`TeamStats` sort key is the attribute literally named `period#userId`. The
`@aws-appsync/utils/dynamodb` `ddb.query({query:{["period#userId"]:{beginsWith}}})`
sugar auto-generates the ExpressionAttributeNames placeholder `#period#userId`
— a second `#` — which DynamoDB rejects: `ExpressionAttributeNames contains
invalid key: Syntax error`. `ddb.get({key:{["period#userId"]:...}})` is fine
(GetItem keys aren't expressions). Verified against the real table with two
`aws dynamodb query` calls.
**Fix:** the three `begins_with` readers use the RAW Query form with a clean
placeholder: `expressionNames:{"#sk":"period#userId"}`. `evaluate-code` alone
does NOT catch this (it doesn't bind a table); you must test against DynamoDB.

### 2. `evaluate-code` masks real errors under `--query`
Run it RAW. `--query '{errors:codeErrors}'` returns `codeErrors:null` even on a
genuine failure (the real error sits under a top-level `error` key).

### 3. syncAggregate wrote `projectId: {NULL}` → AggregatesByProject GSI rejects it
`userAggregates` has a GSI keyed on `projectId`. DynamoDB rejects a NULL value
for a GSI key attribute (`Type mismatch for Index Key projectId Expected: S
Actual: NULL`). The CLI (Phase 1) always sends `projectId=null` (per-day
totals), so EVERY sync write would have failed in prod. The empty table hid it;
the fan-in e2e surfaced it. **Fix:** `syncAggregate.js` omits projectId when
null (sparse-index write). Same rule applies to any direct `put-item` in tests.

### 4. The worker tests never actually ran
`vitest.config.ts` `include` was `lib/__tests__/**` only, so
`lambda/**/__tests__` (the aggregate-stats worker + scoring worker tests) were
dead — which is a big reason bugs 1 & 3 survived. Broadened include to
`lambda/**/__tests__/**`. The old worker test asserted the OLD `Key.SK` bug;
rewritten.

### 5. Consumer bundling needs `@aws-crypto/sha256-js` DECLARED
The worker SigV4-signs its `refreshTeamStats` call → imports
`@aws-crypto/sha256-js`. In this monorepo it resolves via a hoisted transitive
dep so local synth passes, but the twin's `cdk synth` fails to bundle it
(`--external:@aws-sdk/*` leaves it non-external, and it isn't installed).
Declare it as a direct infra dependency.

## Worker design (aggregate-stats)
- Consumes the `userAggregates` stream (NEW_AND_OLD images). `period` on those
  rows is a **day** (`YYYY-MM-DD`); `TeamStats` is keyed by **ISO week**
  (`YYYY-Www`). The worker rolls day-rows → weekly per-member rows.
- **Read-recompute-write:** on any changed day-row, re-query the user's whole
  ISO week (`period BETWEEN monday AND sunday`, day strings are lexicographic =
  chronological) and recompute — so partial/out-of-order batches can't clobber.
- Per (user, week) × membership: keep only day-rows whose `accountId` is in
  `membership.sharedAccounts`; write `TeamStats {teamId, "period#userId":
  "<week>#<userId>", stats: <MemberStats>}`. `minimal` share strips cost/models/
  tools/projectBreakdown.
- REMOVE events recompute from OldImage too.

## Reader contract (single source of truth = per-member rows)
There is NO team-level rollup row. `teamMemberStats` reads one member row;
`teamProjects`/`teamProjectInsights` query `begins_with "<period>#"` and sum;
`teamDashboardAsReader` sums per-member rows into a `TeamAggregate` (leaderboard/
chemistry/superlatives are null/[] in the reader view). `teamsComparison` can't
BatchGet (needs exact SKs) → uses ONE `StatsByPeriod` GSI query on `period`,
grouped by team.

## refreshTeamStats
NONE-datasource resolver echoing `{teamId, period, computedAt}`; resolving the
IAM-only mutation is what fans out `onTeamStatsUpdated`. The worker calls it
best-effort after each write.

## Deploy notes
- Enabling a DynamoDB stream on an existing table is an IN-PLACE update (no
  replacement) — safe even on the RETAIN/deletion-protected prod Data stack.
- `cdk deploy` bundles all Lambdas each time (slow); it blows past a 2-min
  tool timeout. Run detached and wait on `aws cloudformation
  wait stack-update-complete` / poll `describe-stacks`.
- Full-chain e2e without Cognito: seed a membership + a `userAggregates` row
  via `aws dynamodb put-item` (omit projectId!), poll `TeamStats`, clean up.
  Latency stream→TeamStats ≈ 25s. Script in the session scratchpad.

## Still open / deferred
- Per-project `TeamStats`/`myProjects` fidelity: Phase 1 sends per-day totals
  with projectId omitted, so project breakdown collapses to one "(unlinked)"
  bucket. Per-project SK/attribution is deferred.
- CLI public npm release (Phase 1 CLI reconcile is committed but unreleased).
- VS Code extension still calls a nonexistent `syncSessions` mutation.
