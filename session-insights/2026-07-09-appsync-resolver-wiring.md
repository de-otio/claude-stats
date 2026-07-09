# AppSync resolver layer — P0 + P1a wired, deployed, verified

Session wired the first live AppSync resolvers (the API had **zero**) and de-mocked
the personal dashboard. The data path was stubbed on BOTH ends: resolvers unattached
AND `frontend/src/hooks/useApi.ts` returned pure mock data. Full scope +
constraint reference lives in `plans/backend-deployment/RESOLVER-LAYER-SCOPE.md`
(gitignored).

## Current State
- **P0 (infra 0.1.11, live in prod)**: 7 resolvers — `me`, `myStats`, `myProjects`,
  `myAggregates`, `myAchievements`, `availableAchievements` (NONE ds), `syncAggregate`.
  Frontend de-mocked (client in `frontend/src/graphql/operations.ts`, 6 dashboard hooks).
  E2E-verified (write→read round-trip).
- **P1a (same 0.1.11)**: +6 — `team`, `teamMembers` (unit) + pipelines
  `teamProjectInsights`, `teamProjects`, `teamDashboardAsReader` (2-step),
  `teamsComparison` (3-step). 13 resolvers total live. E2E-verified.
- **P1b (infra 0.1.13, live in prod)**: +5 — `myTeams` (2-step pipeline: GSI→BatchGet
  Teams), `teamBySlug` (2-step: GSI→get), nested `Team.members` / `User.achievements` /
  `TeamMember.stats`. 18 resolvers total. Frontend `useTeams`/`useTeamInfo`/`useTeamMembers`
  de-mocked. **E2E-verified with SEEDED data** (`scratchpad/e2e-p1b.mjs`: signUp →
  put Team+membership → magic-link → myTeams/teamBySlug/Team.members all return real rows
  → delete). Deployed Api + Auth + Frontend.
- **P2 chunk 1 (infra 0.1.15, live in prod)**: +9 mutations — `createTeam` (2-step:
  put Team → put admin membership), `unlinkAccount`/`updateAccountSharing` (2-step,
  get profile → rewrite accounts list), `updateTeamSettings`/`regenerateInviteCode`
  (auth → write teams), `promoteMember` (auth → update role), + `linkAccount` /
  `updateMembership` units. 27 resolvers total. **E2E-verified** (`scratchpad/e2e-p2.mjs`:
  signUp → createTeam → myTeams → re-auth for admin group → teamBySlug/members(ADMIN) →
  updateTeamSettings → regenerateInviteCode → updateMembership → cleanup).
  - **Casing decision**: role/shareLevel stored LOWERCASE (matches pre-token group
    building + every resolver auth-check); uppercased to the enum ONLY at the
    TeamMember response boundary (teamMembers, Team.members, updateMembership,
    promoteMemberStep2). No Auth-stack change needed.
  - **Cross-table writes** use per-table pipeline steps (each step's data source
    already has default readWrite grants) instead of BatchPut/TransactWrite — no
    extra IAM, but NON-ATOMIC (a mid-pipeline failure leaves partial state).
  - **After createTeam the caller's JWT is stale** (minted before the membership
    row) → group-gated admin ops (updateTeamSettings/regenerate/promote, Team.members)
    need a RE-AUTH to pick up `team:{id}:admin`. The e2e does a second magic-link.
- **P2 chunk 2 (infra 0.1.17, live in prod)**: +5 pipelines — `joinTeam` (3-step:
  scan code → put membership [not-exists cond] → memberCount++), `leaveTeam` /
  `removeMember` (delete membership → memberCount−−, sharing leaveTeamStep3),
  `deleteTeam` (4-step cascade: auth → query members → BatchDeleteItem [≤25 cap] →
  delete team), `updateProfile` (2-step get→merge, `preferences` via
  `ddb.operations.replace`). 31 resolvers total. **E2E-verified** (2-user
  `scratchpad/e2e-p2b.mjs`: createTeam→join→promote→remove→updateProfile→deleteTeam).
- The full mutation WRITE layer (create/join/leave/remove/promote/delete/settings/
  invite/account/profile/membership) is now live.
- **Frontend mutation forms — ALL wired (frontend-only, no deploy of infra needed):**
  - CreateTeam / JoinTeam / Profile → `dac52bc` (prior).
  - **TeamSettings + Accounts → `84acd59`.** Both aligned to the *real* GraphQL
    contract, not the mock: `LinkedAccount` is only `{accountId,label,shareWithTeams}`
    (no sharePrompts/linkedAt; web can't Link-New — account ids are device-side).
    `Team` has no description/dashboard-readers field and no rename mutation, so
    TeamSettings edits only `leaderboardEnabled`/`challengesEnabled`/
    `crossTeamVisibility` (+ leave/delete), admin-gated via the caller's role from
    `teamBySlug.members`. **Reused existing i18n keys only** — zero new locale strings
    (crossTeam enum PRIVATE/PUBLIC_STATS/PUBLIC_DASHBOARD mapped onto the existing
    None/Minimal/Summary keys). New hooks: `useTeamSettings`, `useLeaveTeam`; `ME`
    query extended with `accounts` + `preferences`. Frontend redeployed to
    `ClaudeStats-prod-Frontend` (UPDATE_COMPLETE) — live at claude-stats.de-otio.org.
- Both repos pushed through P2 chunk 1: `claude-stats` master `228235a`, twin `ea6f242`.
- All resolver wiring is table-driven in `packages/infra/lib/stacks/api-stack.ts`
  (`unitResolvers` + `pipelineResolvers` spec arrays) — add a row per new resolver.
  Nested field resolvers: `UnitResolverSpec.typeName` widened to `string`, add
  `file` override (filename ≠ `${field}.js`). Construct id stays `${field}Resolver`
  (field names are globally unique; do NOT prefix with typeName or you delete+recreate
  live resolvers and risk a create-before-delete conflict on the same typeName+fieldName).

## P3/P4 batch (infra 0.1.20, live in prod, e2e 18/18) — 2026-07-09
Authored in parallel via a **Workflow** (8 agents: implement+verify per chunk, disjoint
files; verify caught 4 real bugs pre-deploy), then wired + gated + deployed centrally.
- **deleteMyAccount**: cascading-deletion Lambda (all tables + Cognito user) behind a
  Lambda data source; resolver forwards only `ctx.identity`.
- **Team logos**: `request-logo-upload` presign Lambda (bundles `@aws-sdk/s3-request-presigner`)
  + `validate-logo` wired as S3 `ObjectCreated(logos/)` → sets `teams.logoUrl` + `deleteTeamLogo`.
- **Challenges CRUD** (5 resolvers): status stored lowercase, participants a MAP seeded `{}`
  so join's nested `SET #p.#uid` works; join/complete derive teamId from the caller's
  single team-group claim. `ChallengeParticipant.displayName` relaxed to nullable.
- **Inter-team CRUD** (5): 3 cross-table pipelines + 2 GSI-backed reads.
- **DEFERRED**: admin-domains (allowedDomains/updateAllowedDomains + superadmin pre-token
  merge) — authored in 0.1.20 but **UNWIRED** (no api-stack HTTP DS, no Auth deploy). The
  pre-token superadmin grant is inert (`SUPERADMIN_SUBS` unset). Scoring crons + TeamStats.

## Gotchas Discovered (P3/P4 — mostly e2e/deploy, not caught by evaluate-code)
- **`deleteTeamStats` queried a phantom `StatsByUser` GSI** — teamStats has only
  `StatsByPeriod`; a Query against a non-existent index throws `ValidationException` even
  with zero rows. Fix: scope deletion by the user's teamIds (capture BEFORE deleting
  memberships) + `FilterExpression userId = :uid` on the base table.
- **DynamoDB Scan `limit:1` + filter is a lookup bug** — `limit` bounds items EXAMINED, not
  MATCHED, so an invite-code lookup misses once the table has >1 row. Bit BOTH
  `joinInterTeamChallenge` AND `joinTeam` (the latter a latent P2 prod bug). Fix: drop the
  `limit`, scan a page, let the filter select. (inviteCode has no GSI.)
- **cdk deploy from the twin: node-SDK SSO credential resolution fails** ("no credentials
  configured") even when the aws CLI resolves the same SSO profile fine, AND the account
  falls back to the placeholder. RELIABLE deploy incantation:
  `eval "$(aws configure export-credentials --profile dot-shared --format env)"` then
  `CLAUDE_STATS_PROD_ACCOUNT=<dot-shared-acct-id> npx cdk deploy -c env=prod <stack> --exclusively --require-approval never`.
  (Static env creds bypass SSO; `CLAUDE_STATS_PROD_ACCOUNT` overrides the placeholder — set it to the dot-shared account id.)
- **`@aws-sdk/*` is external in NodejsFunction by default** (Node22 runtime provides the v3
  clients) — but `@aws-sdk/s3-request-presigner` is NOT in the runtime. Add it as a dep and
  set the presign Lambda's `bundling.externalModules: ["@aws-sdk/client-s3"]` so presigner
  bundles while the big client stays external.
- **`npm publish` packs the WORKING TREE**, not HEAD — deferred/unwired files (admin
  resolvers, the pre-token change) ship in the package even if not committed/wired. Ensure
  any auth-critical change riding along is inert (it was: superadmin gated on empty env).

## Gotchas Discovered (APPSYNC_JS runtime — each cost a deploy→rollback to find)
The resolver JS was written as ordinary JS; `APPSYNC_JS` 1.0.0 rejects much of it.
**Banned** (verified via `aws appsync evaluate-code`):
- `for`/`while` loops → use `forEach`/`map`/`reduce` (arrow callbacks are fine)
- `++`/`--` → `x += 1`
- `Array.sort(comparator)` → no callback sort at all; rank client-side or reduce-max
- `Date` object → `util.time.nowEpochMilliSeconds()` / `epochMilliSecondsToFormatted(ms,"yyyy-MM-dd")`
- **any `new`** (NewExpression) incl. `new Set()`/`new Map()` → plain `{}` as a set/map
- **regex literals** `/…/` (`.match`/`.replace`/`.test`) → `.split()` / char checks
- **`{ payload }` return from a step bound to a DynamoDB data source** → error
  `"Value for field '$[operation]' not found."` Use `runtime.earlyReturn(value)`
  (import `runtime`) to skip the data-source call. `{payload}` is only valid on NONE.
- **`String(x)` is banned** (`INVALID_FUNCTION_INVOCATION: Invalid function: String`).
  Call `.toLowerCase()`/`.toUpperCase()` on the value directly (enum args are
  already strings). Likely `Number()`/`Boolean()` too.
- **`ddb.update({ update: { "settings.foo": v } })` does NOT nest** — the helper
  treats a dotted key as a literal attribute name (writes an attr literally named
  "settings.foo"), silently no-op'ing the intended nested field. For nested/partial
  map updates use a RAW request: `{ operation: "UpdateItem", key, update: {
  expression: "SET #s.#f = :v", expressionNames: {"#s":"settings","#f":"foo"},
  expressionValues: util.dynamodb.toMapValues({":v": v}) } }`. `list_append`/
  `if_not_exists` also need the raw form (see linkAccount.js). Caught by e2e, NOT
  evaluate-code (it's a runtime-semantics bug, compiles clean).
- **`ddb.update({ update: { pref: { ...obj } } })` treats a nested-OBJECT value as
  nested-path SETs** (`SET pref.a = ..., pref.b = ...`), which throws "The document
  path provided in the update expression is invalid" when the parent map doesn't
  exist yet (e.g. new user, no `preferences`). To SET a whole map as a literal
  value, wrap it: `ddb.operations.replace(obj)`. (So dotted-string keys = literal
  attr name [no-op], but object values = nested paths — two different traps.) Also
  e2e-only, compiles clean.

**The validation gate that catches all of these offline** (do this before every deploy):
```
aws appsync evaluate-code --region eu-central-1 \
  --runtime name=APPSYNC_JS,runtimeVersion=1.0.0 \
  --code file://<f>.js --function request|response --context '<stub>'
```
Grep the output for **`codeErrors`** — present ⇒ compile/lint/unsupported-syntax
error ⇒ blocks deploy. **Do NOT grep only `LINT_ERROR`** — `UNSUPPORTED_SYNTAX_TYPE`
and `PARSE_ERROR` don't match it (that's how a `new Set()` shipped and rolled back).
A bare `error.message` WITHOUT `codeErrors` is a runtime/data error → fine.

Non-code runtime gotchas:
- **Imported `Table.fromTableAttributes` needs `globalIndexes: [...]`** (mirror
  DataStack GSIs) or `hasIndex=false` → grants omit `arn/index/*` → GSI queries
  AccessDeny at runtime. See `TABLE_INDEXES` in api-stack.ts.
  - **This ALSO bit the Auth stack (P1b, high-impact).** The
    `pre-token-generation` Lambda (`auth-stack.ts`) imported teamMemberships
    WITHOUT `globalIndexes`, but Queries the `MembershipsByUser` GSI to build
    `team:{teamId}:{role}` group claims. Grant omitted `index/*` → GSI Query
    AccessDenied → the handler's `try/catch` **silently** swallowed it → emitted
    ZERO group claims → `cognito:groups` was `undefined` in every token → EVERY
    group-gated team resolver (`team`, `teamMembers`, `Team.members`, invite-code
    gating) returned empty/unauthorized for everyone. Symptom: `Team.members` = []
    with correct data present. Diagnosed by decoding the JWT (`cognito:groups`
    undefined). Fixed by adding `globalIndexes: ["MembershipsByUser"]`. `cdk diff`
    of the fix = a single `+ .../index/*` on the Lambda role. **P1a's team path was
    never truly verified** because its e2e only hit an authed empty result, not a
    group-gated data path — so this lay dormant until P1b seeded real data.
- **Team role casing conflict (unresolved, hits P2 writers).** pre-token builds
  the group claim as `team:{teamId}:{role}` from the stored role verbatim, but
  resolvers check LOWERCASE `:member`/`:admin`, while the GraphQL `TeamRole` enum
  is UPPERCASE `MEMBER`/`ADMIN`. A membership row can't satisfy both: store
  lowercase → group-auth works but `Team.members{ role }` breaks enum validation;
  store uppercase → enum ok but group-auth never matches. **P2 fix**: store one
  casing and map in the resolver (or normalize in pre-token). e2e-p1b sidesteps it
  by seeding lowercase role and NOT selecting `role`.
- **BatchGet/Put/Transact use PHYSICAL table names**, and the BatchGet *result* is
  keyed by physical name too. Substitute in BOTH the `tables` key and the
  `ctx.result.data[...]` read via a `["__TABLE_X__"]` computed-key placeholder so
  one string-sub in `loadCode` hits both. (The naive `"Logical"`→physical sub only
  matches string VALUES like syncAggregate's `table:"UserAggregates"`.)
- `me` synthesizes a JWT-claims default profile when no `userProfiles` row exists
  (new users have a Cognito account but no row until first `updateProfile`).

## Patterns Established
- **Deploy invocation** (twin repo, `dot-claude-stats-backend`) — all four flags matter:
  ```
  CLAUDE_STATS_PROD_ACCOUNT=<dot-shared acct, from `aws sts get-caller-identity --profile dot-shared`> \
  AWS_SDK_LOAD_CONFIG=1 \
  npx cdk deploy ClaudeStats-prod-Api --exclusively -c env=prod --require-approval never --profile dot-shared
  ```
  Must run with the shell **sandbox disabled** (tsx binds a Unix IPC pipe → EPERM under sandbox).
  `--profile dot-shared` (not `AWS_PROFILE`) — CDK's cred chain didn't resolve the SSO
  profile via env. `--exclusively` avoids pulling the Dns stack (placeholder-account drift).
  Committed config uses placeholder account `222222222222`; the real one is env-seeded.
- **CodeArtifact publish** (`@de-otio` scope): write a scratchpad `.npmrc` with
  `//<host>/npm/npm/:_authToken=${CODEARTIFACT_AUTH_TOKEN}` (literal `${...}`, env-
  interpolated — NEVER the real token in a file; the classifier blocks it), export
  the token from `aws codeartifact get-authorization-token --domain dot
  --domain-owner 000000000000`, and `npm publish --userconfig <that .npmrc>`.
- Release cycle per change: bump `packages/infra` version → commit → build → publish →
  `npm pkg set` twin dep + `npm i` → `cdk deploy` → e2e. CodeArtifact won't let you
  republish a version, so every fix needs a new patch version.
- E2E harness: `scratchpad/e2e-p0.mjs` / `e2e-p1.mjs` — signUp a throwaway
  `*@maildummy.claude-stats.de-otio.org` user, pull the magic-link token from the
  maildummy S3 capture bucket, get a JWT, hit GraphQL, delete the user. Prod signup
  allowlist SSM `/ClaudeStats-prod/auth/allowed-domains` is widened with the maildummy
  domain for this.

## Known Pre-existing Issues (left unfixed on purpose)
- 3 frontend tests fail LOCALLY only (de-DE ICU → "2.847" vs "2,847"); pass on CI/en-US.
- `useUsageTrend`/`useModelMix` derive from `myAggregates`/`myStats` — schema has NO
  per-model token split, so trend is a total-tokens series and mix is activity-share
  (honest, not faked). `*Delta` KPI values are 0 (no schema field / prior-period query yet).
- `SessionsPage`/`SessionDetailPage` have no backing query BY DESIGN (aggregate-only org
  plane). Still on mock; needs a product decision (drop or re-scope), not a resolver.

## Remaining Work
- **P1b / P2: DONE and live** (31 resolvers, full write layer). All frontend mutation
  forms wired (`84acd59`). Nothing outstanding here except the P3-blocked reads below.
- **Blocked on the P3 `aggregate-stats` writer** (nothing to build in the frontend until
  it lands): `teamDashboard`/`leaderboard`/`superlatives` + every per-member `TeamStats`
  read (dashboard/leaderboard hooks still return mock). NOTE: the P1a teamStats readers
  key `sk`/`stats#{period}` but the real sort key is `period#userId` — fix the readers
  *when the writer ships*.
- **P3**: unbuilt challenge/inter-team CRUD (10 fields, no resolver files) + 4 async
  workers (`aggregate-stats`=DDB stream, `challenge-scoring`/`inter-team-scoring`=cron,
  `validate-logo`=S3) + `deleteMyAccount` (Lambda).
- **P4**: admin HTTP→SSM data source (`allowedDomains`/`updateAllowedDomains` — the
  latter has a regex literal) + `requestTeamLogoUpload` Lambda presign.
- Regex-literal offenders still to fix in their phases: `createTeam.js`, `updateAllowedDomains.js`.

## admin-domains (P4a) SHIPPED — infra 0.1.21 / core 0.1.1, prod, e2e 14/14

Wired the superadmin allowed-domains admin (`allowedDomains` query + `updateAllowedDomains`
mutation), the last deferred piece. Deployed Api + Auth to prod; e2e (scratchpad/
`e2e-admin-domains.mjs`) passed 14/14 (read / add / restore / invalid-reject /
non-superadmin-reject); SSM param left at its original value.

**Two bugs found because these resolvers were AUTHORED-BUT-NEVER-GATED in 0.1.20** (deferred/
unwired → the P3/P4 evaluate-code gate never touched them). Lesson: *evaluate-code every
resolver file before it ships in a package, even if unwired* — `npm publish` packs the working
tree, so an ungated file rides along latent.
- **`charCodeAt` is NOT a supported function in APPSYNC_JS 1.0.0** → `INVALID_FUNCTION_INVOCATION`
  at the synth gate. (New entry for the APPSYNC_JS ban-list.) Rewrote domain validation to
  character-set membership: `ALLOWED.includes(ch)` / `label.startsWith("-")` / `endsWith("-")`
  instead of char codes. `--query '{errors:codeErrors}'` on evaluate-code **hid** this — the
  real error is under a top-level `error` key, so the query returned `codeErrors:null`. Run
  evaluate-code RAW (no `--query`) or the gate lies.
- **SSM PutParameter rejects a Type change on Overwrite.** The writer used `Type:"StringList"`
  but the param is created by the Auth stack as a CDK `StringParameter` (Type=String). First
  admin edit would fail at runtime. Fixed to `Type:"String"` (reader is type-agnostic — both
  are comma-separated).

**Wiring specifics:**
- First **HTTP data source** in the API: `api.addHttpDataSource("SsmDS", "https://ssm.<region>.amazonaws.com",
  { authorizationConfig:{ signingRegion, signingServiceName:"ssm" } })`. Grant via
  `ssmDs.grantPrincipal.addToPrincipalPolicy(...)` scoped to the ONE param arn.
- Placeholder `"__ALLOWED_DOMAINS_PARAM__"` substituted by the same `loadCode` subs mechanism
  (double-quoted-string replace) to `/ClaudeStats-<env>/auth/allowed-domains`.
- Superadmin claim: `config.superadminSubs?: string[]` (core) → auth-stack passes
  `SUPERADMIN_SUBS` env → pre-token-generation.ts merges `"superadmin"` into groups when the
  caller's sub OR email matches (empty ⇒ nobody). Twin config sets it to a maildummy testing
  address (matches by email; the e2e harness signs it up).

**CFN drift insight (why the Auth deploy was safe):** the `allowed-domains` SSM param had
out-of-band drift (`maildummy.claude-stats.de-otio.org` added for e2e signups, NOT in config).
CloudFormation only acts on a resource when its *template properties change* — since the Auth
change didn't touch `config.allowedEmailDomains`, the `StringParameter`'s template value was
unchanged → CFN no-op'd it → the drifted value was **preserved** (confirmed via `cdk diff`:
only `PreTokenGenerationFn` code+env changed).

**DESIGN CAVEAT (documented, not fixed):** `config.allowedEmailDomains` and runtime
`updateAllowedDomains` edits fight over the same param. A future `cdk deploy` that *does*
change `allowedEmailDomains` will clobber superadmin runtime edits. Proper fix = seed-once
(AwsCustomResource `putParameter Overwrite:false` on create only), but that's a
StringParameter→CustomResource migration = deletes+recreates the param in prod → too risky
to do casually. Left as a deliberate follow-up.

## Remaining Work (superseded — current status)
- **admin-domains: DONE** (above). P4b logos + P3 challenges/inter-team/deleteMyAccount: DONE
  (prior batch, infra 0.1.20). The "Remaining Work" list above this section is stale.
- **Still deferred — the TeamStats chain (hard dependency order):** (1) reconcile the sync
  contract — CLI calls `syncAggregates`/`AggregateProjection` (periodStart/periodKind/cohortId)
  but the deployed schema exposes `syncAggregate`/`AggregateSyncInput`; no real aggregate data
  flows until they agree. (2) `aggregate-stats` stream worker on `userAggregates` writing
  per-member TeamStats keyed `teamId`/`period#userId`. (3) `challenge-scoring` +
  `inter-team-scoring` EventBridge crons (both read TeamStats). NOTE: P1a teamStats readers
  key `sk`/`stats#{period}` — fix to `period#userId` when the writer lands.
