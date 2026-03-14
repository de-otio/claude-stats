# Implementation Checklist

Parallel work plan for implementing the team-app. Tasks are grouped into **phases** with explicit dependencies. Within each phase, all task groups can run in parallel.

**Model key:**
- **Opus** — complex architecture, security-sensitive, multi-file coordination
- **Sonnet** — straightforward feature implementation, moderate complexity
- **Haiku** — boilerplate, config, types, repetitive patterns

---

## Phase 0 — Project Scaffolding

No dependencies. Sets up the monorepo structure for all subsequent work.

### 0.1 Monorepo setup (Sonnet)
- [ ] Convert to npm workspaces: root `package.json` with `"workspaces": ["packages/*"]`
- [ ] Create `packages/core/` — shared types, parser, pricing logic (extract from current `src/`)
- [ ] Create `packages/cli/` — CLI entrypoint, commander, reporter (extract from current `src/`)
- [ ] Create `packages/extension/` — VS Code extension (move from `extension/` + `src/extension/`)
- [ ] Create `packages/infra/` — CDK stacks (new)
- [ ] Create `packages/lambda/` — Lambda function handlers (new)
- [ ] Create `packages/frontend/` — React SPA (new)
- [ ] Update `tsconfig.json` per package with project references
- [ ] Verify existing tests pass after restructure
- [ ] Update build scripts, CI config

### 0.2 Shared types package (Haiku)
- [ ] `packages/core/src/types/session.ts` — Session, Message types (extract from `src/types.ts`)
- [ ] `packages/core/src/types/team.ts` — Team, TeamMembership, TeamStats, Challenge types
- [ ] `packages/core/src/types/auth.ts` — User, LinkedAccount, MagicLinkToken types
- [ ] `packages/core/src/types/api.ts` — GraphQL input/output types (mirrors 05-api-design.md)
- [ ] `packages/core/src/types/config.ts` — EnvironmentConfig interface (from 12-environments.md)
- [ ] `packages/core/src/pricing/` — pricing logic (extract from current `src/pricing.ts`)
- [ ] `packages/core/src/parser/` — session parser (extract from current `src/parser/`)
- [ ] Export barrel file `packages/core/src/index.ts`

---

## Phase 1 — Infrastructure & Data Layer

Depends on: Phase 0. All groups within Phase 1 run in parallel.

### 1.1 CDK config & base stacks (Sonnet)
_Ref: 09-infrastructure.md, 12-environments.md_
- [ ] `packages/infra/lib/config/types.ts` — EnvironmentConfig (from 12-environments.md)
- [ ] `packages/infra/lib/config/dev.ts` — dev config
- [ ] `packages/infra/lib/config/prod.ts` — prod config
- [ ] `packages/infra/lib/ssm-params.ts` — putParam/getParam helpers
- [ ] `packages/infra/bin/app.ts` — CDK app entry point with stack wiring

### 1.2 DataStack — DynamoDB tables (Sonnet)
_Ref: 04-data-model.md, 09-infrastructure.md §DataStack_
- [ ] UserProfiles table
- [ ] Teams table + TeamsBySlug GSI + TeamsByVisibility GSI
- [ ] TeamMemberships table + MembershipsByUser GSI
- [ ] SyncedSessions table + SessionsByTimestamp GSI + SessionsByAccount GSI + SessionsByProject GSI
- [ ] SyncedMessages table + TTL
- [ ] TeamStats table + StatsByPeriod GSI + TTL
- [ ] Achievements table
- [ ] Challenges table + TTL
- [ ] InterTeamChallenges table + InterTeamChallengesByStatus GSI + TTL
- [ ] MagicLinkTokens table + TTL
- [ ] DynamoDB Streams on SyncedSessions
- [ ] SSM parameter publication for all table ARNs/names + stream ARN
- [ ] Environment-conditional settings (encryption, PITR, deletion protection, removal policy)

### 1.3 DnsStack (Haiku)
_Ref: 09-infrastructure.md §DnsStack_
- [ ] Route 53 hosted zone for app domain
- [ ] NS delegation record in parent zone
- [ ] ACM certificate (DNS-validated, us-east-1)
- [ ] Optional Cognito custom domain CNAME
- [ ] SSM parameter publication (hosted-zone-id, hosted-zone-name, certificate-arn)
- [ ] Conditional creation (only when `config.domainName` is set)

### 1.4 Team logos S3 bucket (Haiku)
_Ref: 09-infrastructure.md §ApiStack, 10-team-features.md §Team Identity_
- [ ] S3 bucket (`{prefix}-team-logos`, BLOCK_ALL, lifecycle 1 year)
- [ ] CloudFront distribution with OAC for public read
- [ ] SSM parameters (team-logos-bucket, team-logos-cdn-url)

---

## Phase 2 — Auth & API Foundation

Depends on: Phase 1. All groups within Phase 2 run in parallel.

### 2.1 AuthStack — Cognito + magic links (Opus)
_Ref: 02-authentication.md, 09-infrastructure.md §AuthStack_
- [ ] Cognito User Pool (ALLOW_CUSTOM_AUTH only, email alias)
- [ ] SPA User Pool Client (access token 1h, refresh 30d)
- [ ] MCP User Pool Client (separate scopes, callback URLs)
- [ ] WAF WebACL with rate limiting rules for Cognito
- [ ] KMS key for HMAC signing (auto-rotation)
- [ ] SES email identity for magic link delivery
- [ ] Lambda: DefineAuthChallenge
- [ ] Lambda: CreateAuthChallenge (generates magic link, HMAC signs, sends via SES)
- [ ] Lambda: VerifyAuthChallenge (HMAC verify, check MagicLinkTokens table)
- [ ] Lambda: PreSignUp (domain restriction via SSM)
- [ ] Lambda: PreTokenGeneration (inject Cognito group claims into JWT)
- [ ] SSM parameter publication (user-pool-id, user-pool-arn, spa-client-id, mcp-client-id, cognito-domain)

### 2.2 AppSync API — schema & base resolvers (Opus)
_Ref: 05-api-design.md, 09-infrastructure.md §ApiStack_
- [ ] AppSync GraphQL API (Cognito primary + IAM additional auth)
- [ ] `schema.graphql` — full schema from 05-api-design.md (all types, enums, queries, mutations, subscriptions)
- [ ] WAF WebACL for AppSync (blanket + per-mutation rate limits)
- [ ] SSM parameter publication (graphql-endpoint, graphql-api-id, graphql-api-arn)

### 2.3 JS resolvers — simple CRUD (Sonnet)
_Ref: 05-api-design.md §Resolver Strategy_
- [ ] `me` query resolver (UserProfiles, ownership check)
- [ ] `userProfile` query resolver (UserPublicProfile — separate type, no sensitive fields)
- [ ] `updateProfile` mutation resolver (ownership, input validation)
- [ ] `linkAccount` / `unlinkAccount` / `updateAccountSharing` mutation resolvers
- [ ] `myTeams` query resolver (TeamMemberships GSI by userId)
- [ ] `team` query resolver (Teams by PK, group check)
- [ ] `teamBySlug` query resolver (TeamsBySlug GSI → Teams base table)
- [ ] `createTeam` mutation resolver (create Teams item + Cognito group + TeamMemberships)
- [ ] `joinTeam` mutation resolver (validate invite code, expiry, team size limit, WAF rate-limited)
- [ ] `leaveTeam` mutation resolver
- [ ] `updateTeamSettings` mutation resolver (admin check + DB verify)
- [ ] `deleteTeam` mutation resolver (admin check + cascading delete)
- [ ] `regenerateInviteCode` mutation resolver (admin check)
- [ ] `removeMember` / `promoteMember` mutation resolvers (admin check + DB verify)
- [ ] `updateMembership` mutation resolver (own membership, DB verify)
- [ ] `teamMembers` query resolver (TeamMemberships by teamId)

### 2.4 Sync resolvers (Sonnet)
_Ref: 05-api-design.md, 06-sync-strategy.md_
- [ ] `syncSessions` mutation resolver (batch conditional writes with `_version`, max 25 items)
- [ ] `syncMessages` mutation resolver (batch conditional writes, max 100 items)
- [ ] `mySessions` query resolver (SyncedSessions by userId, optional time range)
- [ ] `myStats` query resolver (aggregate from SyncedSessions)
- [ ] `myProjects` query resolver (group by projectId)
- [ ] `sessionMessages` query resolver (SyncedMessages by sessionId, share-level + sharePrompts gate for team access)
- [ ] `SyncResult` / `ConflictItem` return type handling
- [ ] Subscription: `onSessionSynced` (filtered by userId)

---

## Phase 3 — Lambda Resolvers & Business Logic

Depends on: Phase 2. All groups within Phase 3 run in parallel.

### 3.1 Aggregate-stats Lambda (Opus)
_Ref: 09-infrastructure.md §ApiStack aggregate-stats logic, 04-data-model.md §TeamStats_
- [ ] DynamoDB Streams event handler (INSERT/MODIFY on SyncedSessions)
- [ ] Look up user's team memberships; check sharedAccounts includes session's accountId
- [ ] Read user's shareLevel per team
- [ ] Group sessions by (teamId, period, userId)
- [ ] Compute aggregates: SUM tokens, COUNT sessions/prompts, MAX velocity
- [ ] Compute projectBreakdown (group by projectId, omit if shareLevel = minimal)
- [ ] Write TeamStats with conditional update (idempotent via computedAt)
- [ ] Call refreshTeamStats mutation (IAM auth) to trigger subscriptions
- [ ] DLQ configuration (SQS, 14-day retention)
- [ ] Reserved concurrency from config
- [ ] Retry/bisect configuration
- [ ] Unit tests with mock DynamoDB stream events

### 3.2 Team dashboard Lambda (Sonnet)
_Ref: 05-api-design.md §TeamDashboard type_
- [ ] `teamDashboard` query resolver (group check + DB verify)
- [ ] Assemble TeamAggregate (SUM across members' TeamStats)
- [ ] Assemble Leaderboard (top 3 per category — anti-toxicity)
- [ ] Assemble MemberCards (per-member stats at their share level)
- [ ] Compute TeamChemistry score (composite of 6 bonuses/penalties)
- [ ] Compute Superlatives (weekly fun stats)
- [ ] Read-time share-level field filtering (defense-in-depth)
- [ ] Include computedAt freshness timestamp
- [ ] Subscription: `onTeamStatsUpdated`

### 3.3 Challenge scoring Lambda (Sonnet)
_Ref: 10-team-features.md §Challenges, 05-api-design.md_
- [ ] `createChallenge` mutation resolver (admin check, input validation)
- [ ] `joinChallenge` mutation resolver
- [ ] `completeChallenge` mutation resolver (admin or auto)
- [ ] EventBridge rule: hourly during active challenges
- [ ] Scoring logic: read TeamStats, compute per-participant score, rank, update Challenges
- [ ] Tie-breaking by earliest join time
- [ ] Auto-completion at endTime
- [ ] Subscription: `onChallengeUpdated`

### 3.4 Inter-team challenge Lambda (Sonnet)
_Ref: 10-team-features.md §Inter-Team Challenges, 09-infrastructure.md_
- [ ] `createInterTeamChallenge` mutation resolver (admin check)
- [ ] `joinInterTeamChallenge` mutation resolver (admin of joining team, invite code validation)
- [ ] `completeInterTeamChallenge` mutation resolver
- [ ] EventBridge rule: hourly scoring (shared with or separate from intra-team)
- [ ] Scoring: read TeamStats per participating team, normalize per active member count
- [ ] Status transitions: pending → active at startTime; active → completed at endTime
- [ ] Enum case conversion: DynamoDB lowercase ↔ GraphQL UPPERCASE
- [ ] Team-level achievement badge on win
- [ ] Subscription: `onInterTeamChallengeUpdated`
- [ ] `activeInterTeamChallenges` / `interTeamChallengeHistory` query resolvers

### 3.5 Achievement check Lambda (Haiku)
_Ref: 10-team-features.md §Achievements_
- [ ] `unlockAchievement` mutation resolver (ownership check)
- [ ] `toggleAchievementVisibility` mutation resolver
- [ ] `myAchievements` / `availableAchievements` query resolvers
- [ ] Achievement definitions (threshold checks for each category)
- [ ] Subscription: `onAchievementUnlocked`

### 3.6 Project insights Lambda (Sonnet)
_Ref: 05-api-design.md §ProjectInsights_
- [ ] `teamProjectInsights` query resolver (group check + DB verify)
- [ ] `teamProjects` query resolver
- [ ] Cross-member aggregation by projectId from TeamStats
- [ ] Trend data (daily data points for the period)

### 3.7 Cross-team Lambdas (Sonnet)
_Ref: 10-team-features.md §Cross-Team Comparison, 05-api-design.md_
- [ ] `teamsComparison` query resolver (filter by crossTeamVisibility via GSI)
- [ ] `teamDashboardAsReader` query resolver (check caller's team in dashboardReaders)
- [ ] `grantDashboardAccess` / `revokeDashboardAccess` mutation resolvers (admin check)
- [ ] `requestTeamLogoUpload` mutation resolver (generate presigned S3 PUT URL)
- [ ] `deleteTeamLogo` mutation resolver (delete S3 object + clear Teams.logoUrl)

### 3.8 Validate-logo Lambda (Haiku)
_Ref: 10-team-features.md §Team Identity, 09-infrastructure.md_
- [ ] S3 event trigger (PutObject on team-logos bucket)
- [ ] Validate file size ≤ 256 KB
- [ ] Validate content-type (image/png, image/svg+xml, image/jpeg)
- [ ] Validate dimensions ≤ 512x512 (sharp or similar library)
- [ ] On success: update Teams.logoUrl with CloudFront URL
- [ ] On failure: delete S3 object

### 3.9 Admin resolvers (Sonnet)
_Ref: 03-authorization.md, 05-api-design.md_
- [ ] `allowedDomains` query resolver (superadmin check)
- [ ] `allTeams` query resolver (superadmin check)
- [ ] `updateAllowedDomains` mutation resolver (superadmin check, write to SSM)
- [ ] `deleteMyAccount` mutation resolver (cascading delete across all 9 tables + Cognito)
- [ ] Audit logging for all admin actions (CloudWatch)

---

## Phase 4 — Frontend SPA

Depends on: Phase 2 (API schema available). Can start in parallel with Phase 3 (mock data).

### 4.1 SPA scaffolding & auth (Sonnet)
_Ref: 07-frontend.md_
- [ ] Vite + React 18 + TypeScript project setup
- [ ] Tailwind CSS + Tremor installation
- [ ] Amplify JS config (API module only)
- [ ] Build-time config generation script (`scripts/generate-config.ts`)
- [ ] ThemeProvider (CSS custom properties from branding config)
- [ ] React Router v6 setup with all routes from 07-frontend.md
- [ ] Auth guard component (`RequireAuth`)
- [ ] Magic link login page (`/login`)
- [ ] Magic link verification page (`/auth/verify`)
- [ ] Silent token refresh via Amplify
- [ ] TanStack Query setup with auth error handling
- [ ] Error boundary + error cards
- [ ] Loading skeletons

### 4.2 Personal dashboard pages (Sonnet)
- [ ] `/dashboard` — KPI cards (sessions, prompts, cost, velocity), usage trend area chart, model mix donut, top projects bar chart, recent achievements
- [ ] `/dashboard/sessions` — session explorer table with filters
- [ ] `/dashboard/session/:id` — session detail (token breakdown, subagents, messages)
- [ ] `/dashboard/projects` — project breakdown page

### 4.3 Profile pages (Haiku)
- [ ] `/profile` — user profile, preferences form
- [ ] `/profile/accounts` — manage linked accounts (share toggles, sharePrompts toggle)
- [ ] `/profile/achievements` — achievement gallery

### 4.4 Team dashboard pages (Sonnet)
- [ ] `/teams` — team list with cards
- [ ] `/teams/join/:code` — join team flow (display name, share level, account selection)
- [ ] `/teams/create` — create team form
- [ ] `/team/:slug` — team dashboard (chemistry score, member cards, leaderboard, trend chart, superlatives)
- [ ] `/team/:slug/projects` — team project insights
- [ ] `/team/:slug/project/:id` — single project detail
- [ ] `/team/:slug/leaderboard` — full leaderboard view
- [ ] `/team/:slug/members` — member list with cards
- [ ] `/team/:slug/challenges` — active + past challenges
- [ ] `/team/:slug/challenge/:id` — challenge detail + live scoreboard
- [ ] `/team/:slug/settings` — team settings (admin only): leaderboard, challenges, visibility, logo upload, dashboard readers

### 4.5 Cross-team & inter-team pages (Sonnet)
- [ ] `/compare` — cross-team comparison (team rankings, grouped bar chart, active inter-team challenges)
- [ ] `/compare/:slug` — view another team's public dashboard
- [ ] `/inter-challenges` — inter-team challenge list
- [ ] `/inter-challenges/:id` — inter-team challenge detail + live scoreboard

### 4.6 Admin pages (Haiku)
- [ ] `/admin` — superadmin panel
- [ ] `/admin/domains` — manage allowed email domains
- [ ] `/admin/teams` — all teams overview

### 4.7 Real-time subscriptions (Sonnet)
- [ ] AppSync subscription setup for team stats updates
- [ ] Achievement unlock toast notifications
- [ ] Challenge update live refresh
- [ ] Inter-team challenge live scoreboard
- [ ] Cross-device sync notification
- [ ] Reconnection handling with banner

---

## Phase 5 — Frontend Deployment & MCP

Depends on: Phase 3 (Lambdas deployed), Phase 4 (SPA built).

### 5.1 FrontendStack (Haiku)
_Ref: 09-infrastructure.md §FrontendStack_
- [ ] S3 bucket (BLOCK_ALL, S3_MANAGED encryption, DESTROY removal)
- [ ] CloudFront distribution (OAC, SPA routing error responses, security headers)
- [ ] Custom domain + ACM cert from DnsStack (conditional)
- [ ] Route 53 A/AAAA alias records (conditional)
- [ ] BucketDeployment from built SPA assets
- [ ] SSM parameters (distribution-url, distribution-id)

### 5.2 McpStack (Sonnet)
_Ref: 08-mcp-server.md, 09-infrastructure.md §McpStack_
- [ ] MCP server implementation (Node.js, all 8 tools from 08-mcp-server.md)
- [ ] Tool authorization (team membership check + AppSync double-check)
- [ ] Dockerfile (ARM64, Node.js 20)
- [ ] ECR repository
- [ ] Bedrock AgentCore Runtime
- [ ] AgentCore Gateway with Cognito OAuth2
- [ ] IAM role (AppSync query + mutation only, no direct DynamoDB)
- [ ] SSM parameter publication (gateway-url)

---

## Phase 6 — Monitoring, Testing & Operations

Depends on: Phase 5. Can partially overlap with Phase 4/5.

### 6.1 MonitoringStack (Haiku)
_Ref: 14-monitoring.md, 09-infrastructure.md §MonitoringStack_
- [ ] CloudWatch Dashboard (AppSync, DynamoDB, Lambda, Cognito, Streams, Billing)
- [ ] Alarms (prod only): 5xx rate, Lambda errors, throttles, WAF spikes, iterator age, DLQ, budget
- [ ] SNS topic for alarm notifications
- [ ] Log retention per environment (7d dev, 90d prod)
- [ ] X-Ray tracing on Lambda functions

### 6.2 Integration tests (Opus)
_Ref: 15-testing.md_
- [ ] Auth flow E2E: magic link request → verify → JWT → API call
- [ ] Sync flow: syncSessions → DynamoDB Stream → aggregate-stats → TeamStats
- [ ] Team lifecycle: create → join → update settings → leave → delete
- [ ] Cross-team: set visibility → comparison query → grant dashboard access → read
- [ ] Inter-team challenge: create → invite → join → scoring → complete
- [ ] Account deletion: cascading delete across all 9 tables + Cognito
- [ ] Share-level filtering: verify minimal/summary/full field visibility
- [ ] Secret scanning: verify prompts with secrets are redacted
- [ ] Version conflict: simulate concurrent writes, verify merge resolution

### 6.3 Lambda unit tests (Sonnet)
- [ ] aggregate-stats: mock stream events, verify TeamStats output
- [ ] team-dashboard: mock TeamStats/Memberships, verify aggregation + share-level filtering
- [ ] challenge-scoring: mock TeamStats, verify ranking + tie-breaking
- [ ] inter-team-scoring: mock InterTeamChallenges + TeamStats, verify normalization
- [ ] validate-logo: mock S3 events, verify accept/reject logic
- [ ] auth Lambdas: mock Cognito context, verify domain restriction + group injection

### 6.4 Frontend tests (Haiku)
- [ ] Component tests with Testing Library (KPI cards, charts, forms)
- [ ] Auth guard tests (redirect on unauthenticated)
- [ ] Subscription reconnection tests
- [ ] Theme provider tests (CSS variable injection)

### 6.5 CI/CD pipeline (Sonnet)
_Ref: 12-environments.md §CI/CD Pipeline_
- [ ] CodePipeline definition in CDK (or GitHub Actions)
- [ ] Build stage: `npm ci && npm run build` for SPA + Lambda + CDK synth
- [ ] Deploy dev → integration tests → manual approval → deploy prod
- [ ] Pipeline IAM role (least-privilege per stack resource types)

---

## Phase 7 — Client Integration

Depends on: Phase 5 (backend fully deployed).

### 7.1 CLI backend connection (Sonnet)
_Ref: 17-client-setup.md_
- [ ] `claude-stats setup` command (authenticate → link account → consent → save config)
- [ ] Backend endpoint discovery (well-known URL, manual, env vars)
- [ ] OAuth2 device flow for CLI auth
- [ ] Token storage (refresh tokens encrypted via OS keychain)
- [ ] Sync command: batch sync local SQLite sessions to AppSync
- [ ] Secret scanning before prompt sync (regex patterns from 06-sync-strategy.md)
- [ ] Custom secret pattern config (`~/.claude-stats/config.json`)
- [ ] `claude-stats disconnect` command

### 7.2 VS Code extension backend integration (Sonnet)
_Ref: 17-client-setup.md §VS Code Integration_
- [ ] Extension settings for backend URL, auto-sync toggle
- [ ] Status bar indicator (sync status, streak)
- [ ] Commands: connect, disconnect, sync now
- [ ] Background sync on session completion
- [ ] Team dashboard webview (embed SPA or custom panel)

---

## Dependency Graph

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 5 ──→ Phase 6
                                  ↘            ↗
                                   Phase 4 ──→
                                                           ↘
                                                            Phase 7
```

## Model Assignment Summary

| Model | Task Count | Rationale |
|-------|-----------|-----------|
| **Opus** | 4 tasks | Security-critical (auth, aggregation), integration tests, complex multi-table logic |
| **Sonnet** | 20 tasks | Feature implementation, moderate complexity, most Lambda resolvers, frontend pages |
| **Haiku** | 9 tasks | Boilerplate (types, config, DNS, S3, monitoring, admin pages, simple resolvers) |

Total: ~33 parallelizable task groups across 7 phases.
