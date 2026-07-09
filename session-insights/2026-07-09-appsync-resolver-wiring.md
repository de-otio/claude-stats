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
  invite/account/profile/membership) is now live. Remaining P2: **frontend mutation
  forms** (CreateTeam, JoinTeam, TeamSettings, Accounts, Profile still call mocks).
- Both repos pushed through P2 chunk 1: `claude-stats` master `228235a`, twin `ea6f242`.
- All resolver wiring is table-driven in `packages/infra/lib/stacks/api-stack.ts`
  (`unitResolvers` + `pipelineResolvers` spec arrays) — add a row per new resolver.
  Nested field resolvers: `UnitResolverSpec.typeName` widened to `string`, add
  `file` override (filename ≠ `${field}.js`). Construct id stays `${field}Resolver`
  (field names are globally unique; do NOT prefix with typeName or you delete+recreate
  live resolvers and risk a create-before-delete conflict on the same typeName+fieldName).

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
- **P1b**: `myTeams` returns bare membership rows — needs a hydration Step2 (batch-get
  Teams) or `Query.myTeams:[Team!]!` non-null violations. Nested resolvers
  `Team.members`, `TeamMember.stats(period)`, `User.achievements`. `teamDashboard`
  **Lambda** data source (`lambda/api/team-dashboard.ts`). `teamBySlug` Step2. De-mock
  team-page frontend hooks.
- **P2**: author the **10 missing mutation Step-2 writes** (auth Step1 exists, write never
  authored: unlinkAccount, updateAccountSharing, updateTeamSettings, deleteTeam,
  regenerateInviteCode, joinTeam, leaveTeam, removeMember, promoteMember) + `createTeam`
  (has a regex literal AND a two-table `BatchPutItem` needing the placeholder trick +
  role grants on both tables) + wire the mutation forms.
- **P3**: unbuilt challenge/inter-team CRUD (10 fields, no resolver files) + 4 async
  workers (`aggregate-stats`=DDB stream, `challenge-scoring`/`inter-team-scoring`=cron,
  `validate-logo`=S3) + `deleteMyAccount` (Lambda).
- **P4**: admin HTTP→SSM data source (`allowedDomains`/`updateAllowedDomains` — the
  latter has a regex literal) + `requestTeamLogoUpload` Lambda presign.
- Regex-literal offenders still to fix in their phases: `createTeam.js`, `updateAllowedDomains.js`.
