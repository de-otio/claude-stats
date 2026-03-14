# 05 — API Design

AppSync GraphQL API.

## Authentication Modes

| Mode | Use Case |
|------|----------|
| `AMAZON_COGNITO_USER_POOLS` (primary) | All user-facing queries, mutations, subscriptions |
| `AWS_IAM` (additional) | Lambda-to-AppSync calls (aggregation Lambda publishing subscription events) |

## Schema (Key Types)

```graphql
type User {
  userId: ID!
  email: String!
  displayName: String!
  avatarUrl: String
  accounts: [LinkedAccount!]!   # Only returned for own profile (ctx.identity.sub == userId)
  preferences: UserPreferences!
  personalityType: String
  streak: StreakInfo!
  achievements: [Achievement!]!
}

# Separate type for teammate views — no sensitive fields
type UserPublicProfile {
  userId: ID!
  displayName: String!
  avatarUrl: String
  personalityType: String
  streak: StreakInfo
  recentAchievements: [Achievement!]  # Only shared achievements
}

type LinkedAccount {
  accountId: ID!
  label: String!
  shareWithTeams: Boolean!
  sharePrompts: Boolean!          # Opt-in: sync prompt text (after client-side secret scanning). Default false.
  # NOTE: accountUuid is never exposed via API — only the derived accountId
}

type Team {
  teamId: ID!
  teamName: String!
  teamSlug: String!
  logoUrl: String               # S3 URL to team logo
  inviteCode: String            # Only returned when ctx.identity is team admin or superadmin
  memberCount: Int!
  settings: TeamSettings!
  members: [TeamMember!]!
  currentChallenge: Challenge
}

type TeamMember {
  userId: ID!
  displayName: String!
  role: TeamRole!
  shareLevel: ShareLevel!
  joinedAt: AWSTimestamp!
  stats(period: String!): MemberStats
  streak: StreakInfo
  recentAchievements: [Achievement!]
}

type MemberStats {
  sessions: Int!
  prompts: Int!
  inputTokens: Long
  outputTokens: Long
  estimatedCost: Float          # Null if shareLevel = minimal
  activeMinutes: Int
  modelsUsed: AWSJSON           # Null if shareLevel = minimal
  topTools: [String!]           # Null if shareLevel = minimal
  velocityTokensPerMin: Float
  subagentRatio: Float
  projectBreakdown: [ProjectStats!]  # Null if shareLevel = minimal
}

type ProjectStats {
  projectId: String!            # GitHub "owner/repo", or "(unlinked)" for sessions without a git remote
  sessions: Int!
  prompts: Int!
  estimatedCost: Float
}

type ProjectInsights {
  projectId: String!            # e.g. "acme/api-gateway"
  period: String!
  totalSessions: Int!
  totalPrompts: Int!
  totalTokens: Long!
  estimatedCost: Float!
  contributors: [ProjectContributor!]!  # Only team members who share this project
  modelsUsed: AWSJSON
  trend: [ProjectTrendPoint!]!  # Daily data points for the period
}

type ProjectContributor {
  displayName: String!
  sessions: Int!
  prompts: Int!
}

type ProjectTrendPoint {
  date: String!                 # ISO date: "2026-03-12"
  sessions: Int!
  prompts: Int!
  estimatedCost: Float!
}

type TeamDashboard {
  team: Team!
  period: String!
  aggregate: TeamAggregate      # Null if < minMembers active
  leaderboard: Leaderboard      # Null if disabled in team settings
  memberCards: [MemberCard!]!
  chemistry: TeamChemistry
  superlatives: [Superlative!]!
  projectSummary: [ProjectStats!]!  # Aggregated across all sharing members
  computedAt: AWSTimestamp!     # Freshness indicator
}

type Leaderboard {
  categories: [LeaderboardCategory!]!
}

type LeaderboardCategory {
  name: String!
  awardName: String!
  rankings: [LeaderboardEntry!]!  # Top 3 only (anti-toxicity)
}

type Challenge {
  challengeId: ID!
  name: String!
  metric: String!
  startTime: AWSTimestamp!
  endTime: AWSTimestamp!
  status: ChallengeStatus!
  participants: [ChallengeParticipant!]!
}

type SyncResult {
  itemsWritten: Int!
  itemsSkipped: Int!            # Already up-to-date (same _version)
  conflicts: [ConflictItem!]!   # Items that need client-side merge
}

type ConflictItem {
  key: String!                  # sessionId or uuid
  serverVersion: Int!
  serverItem: AWSJSON           # Current server state for merge
}

type TeamAggregate {
  totalSessions: Int!
  totalPrompts: Int!
  totalInputTokens: Long!
  totalOutputTokens: Long!
  totalEstimatedCost: Float!
  activeMemberCount: Int!
  avgSessionsPerMember: Float!
  avgCostPerMember: Float!
}

type TeamChemistry {
  score: Int!                       # 0-100 composite score
  breakdown: ChemistryBreakdown!
}

type ChemistryBreakdown {
  diversityBonus: Int!              # Team uses multiple model tiers
  coverageBonus: Int!               # Active across many hours of the day
  syncBonus: Int!                   # All members synced recently
  streakBonus: Int!                 # All streaks above threshold
  challengeBonus: Int!              # Active challenge participation
  balancePenalty: Int!              # Negative if usage is heavily skewed
}

type Superlative {
  label: String!                    # e.g. "Longest conversation"
  displayName: String!              # Winner's display name
  value: String!                    # e.g. "4h 12m, 287 prompts"
}

type LeaderboardEntry {
  rank: Int!
  displayName: String!
  value: Float!                     # The metric value (prompts, velocity, cost, etc.)
  formattedValue: String!           # Human-readable (e.g. "2,341 tok/min")
}

type MemberCard {
  userId: ID!
  displayName: String!
  personalityType: String
  streak: StreakInfo
  stats: MemberStats
  recentAchievements: [Achievement!]
}

type StreakInfo {
  currentStreak: Int!               # Days
  longestStreak: Int!               # Days
  weekendGraceEnabled: Boolean!
  freezeTokensRemaining: Int!       # Earned at 30-day milestones, max 3
  lastActiveDate: String            # ISO date, null if never active
}

type Achievement {
  achievementId: ID!
  name: String!
  description: String!
  category: AchievementCategory!
  icon: String!
  unlockedAt: AWSTimestamp!
  shared: Boolean!                  # User controls visibility to teammates
  context: AWSJSON                  # e.g. { "prompts": 1000 }
}

type AchievementDefinition {
  achievementId: ID!
  name: String!
  description: String!
  category: AchievementCategory!
  icon: String!
  threshold: AWSJSON                # e.g. { "metric": "prompts", "value": 1000 }
  hidden: Boolean!                  # Secret achievements — description hidden until unlocked
}

enum AchievementCategory { PRODUCTIVITY EFFICIENCY TEAM MILESTONES FUN }

type AchievementEvent {
  userId: ID!
  displayName: String!
  achievement: Achievement!
  teamId: ID!
}

type TeamStatsUpdate {
  teamId: ID!
  period: String!
  computedAt: AWSTimestamp!
}

type SyncedSession {
  sessionId: ID!
  projectId: String
  firstTimestamp: AWSTimestamp!
  lastTimestamp: AWSTimestamp!
  claudeVersion: String!
  entrypoint: String!
  promptCount: Int!
  inputTokens: Long!
  outputTokens: Long!
  cacheCreationTokens: Long
  cacheReadTokens: Long
  models: [String!]!
  accountId: String!
  isSubagent: Boolean!
  parentSessionId: String
  estimatedCost: Float!
  updatedAt: AWSTimestamp!
}

# Message detail — promptText only returned for own data or team members at "full" share level
type SyncedMessage {
  uuid: ID!
  sessionId: ID!
  timestamp: AWSTimestamp!
  model: String!
  stopReason: String
  inputTokens: Long!
  outputTokens: Long!
  tools: [String!]
  thinkingBlocks: Int
  promptText: String              # Null unless user opted in to prompt sharing
}

type UserPreferences {
  timezone: String!
  weekStartDay: Int!                # 0=Sun, 1=Mon
  defaultShareLevel: ShareLevel!
  streakWeekendGrace: Boolean!
}

type TeamSettings {
  leaderboardEnabled: Boolean!
  leaderboardCategories: [String!]!
  challengesEnabled: Boolean!
  minMembersForAggregates: Int!     # Default 3
  crossTeamVisibility: CrossTeamVisibility!
}

enum CrossTeamVisibility { PRIVATE PUBLIC_STATS PUBLIC_DASHBOARD }

# Summary of another team — visible on the cross-team comparison page
type TeamComparisonEntry {
  teamId: ID!
  teamName: String!
  teamSlug: String!
  logoUrl: String
  memberCount: Int!
  aggregate: TeamAggregate       # Only for teams with PUBLIC_STATS or PUBLIC_DASHBOARD visibility
}

# Inter-team challenge (competition between teams)
type InterTeamChallenge {
  challengeId: ID!
  name: String!
  metric: String!
  startTime: AWSTimestamp!
  endTime: AWSTimestamp!
  status: InterTeamChallengeStatus!
  creatingTeamId: ID!
  inviteCode: String             # Only returned to admins of participating teams
  teams: [InterTeamChallengeTeam!]!
}

type InterTeamChallengeTeam {
  teamId: ID!
  teamName: String!
  teamSlug: String!
  logoUrl: String
  score: Float!
  rank: Int!
}

enum InterTeamChallengeStatus { PENDING ACTIVE COMPLETED }

type ChallengeParticipant {
  userId: ID!
  displayName: String!
  score: Float!
  rank: Int!
}

enum TeamRole { ADMIN MEMBER }
enum ShareLevel { FULL SUMMARY MINIMAL }
enum ChallengeStatus { ACTIVE COMPLETED }
```

## Queries

```graphql
type Query {
  # User
  me: User!                                              @aws_cognito_user_pools
  userProfile(userId: ID!): UserPublicProfile            @aws_cognito_user_pools

  # Teams — all require team membership (checked in resolver)
  myTeams: [Team!]!                                      @aws_cognito_user_pools
  team(teamId: ID!): Team!                               @aws_cognito_user_pools
  teamDashboard(teamId: ID!, period: String!): TeamDashboard!  @aws_cognito_user_pools
  teamMembers(teamId: ID!): [TeamMember!]!               @aws_cognito_user_pools

  # Stats (cross-device sync) — own data only
  mySessions(from: AWSTimestamp, to: AWSTimestamp, limit: Int): [SyncedSession!]!  @aws_cognito_user_pools
  myStats(period: String!): MemberStats!                 @aws_cognito_user_pools
  myProjects(period: String!): [ProjectStats!]!          @aws_cognito_user_pools

  # Project insights — require team membership (checked in resolver)
  teamProjectInsights(teamId: ID!, projectId: String!, period: String!): ProjectInsights!  @aws_cognito_user_pools
  teamProjects(teamId: ID!, period: String!): [ProjectStats!]!  @aws_cognito_user_pools

  # Session detail — own data; team members see promptText only at "full" share level + sharePrompts
  sessionMessages(sessionId: ID!): [SyncedMessage!]!    @aws_cognito_user_pools

  # Achievements — own data only
  myAchievements: [Achievement!]!                        @aws_cognito_user_pools
  availableAchievements: [AchievementDefinition!]!       @aws_cognito_user_pools

  # Challenges — require team membership
  activeChallenge(teamId: ID!): Challenge                @aws_cognito_user_pools
  challengeHistory(teamId: ID!, limit: Int): [Challenge!]!  @aws_cognito_user_pools

  # Cross-team comparison — any authenticated user
  # Resolver filters to teams with crossTeamVisibility IN [PUBLIC_STATS, PUBLIC_DASHBOARD] only
  teamsComparison(period: String!): [TeamComparisonEntry!]!  @aws_cognito_user_pools
  teamBySlug(slug: String!): Team                            @aws_cognito_user_pools
    # Resolves slug → teamId via TeamsBySlug GSI. Returns null if not found or not visible.
  teamDashboardAsReader(teamId: ID!, period: String!): TeamDashboard  @aws_cognito_user_pools
    # Returns null if caller's team is not in the target team's dashboardReaders list

  # Inter-team challenges — require team membership
  activeInterTeamChallenges: [InterTeamChallenge!]!       @aws_cognito_user_pools
  interTeamChallengeHistory(limit: Int): [InterTeamChallenge!]!  @aws_cognito_user_pools

  # Admin — superadmin only (checked in resolver)
  allowedDomains: [String!]!                             @aws_cognito_user_pools
  allTeams: [Team!]!                                     @aws_cognito_user_pools
}
```

## Mutations

```graphql
type Mutation {
  # User — own profile only
  updateProfile(input: UpdateProfileInput!): User!
  linkAccount(input: LinkAccountInput!): LinkedAccount!
  unlinkAccount(accountId: ID!): Boolean!
  updateAccountSharing(accountId: ID!, shareWithTeams: Boolean, sharePrompts: Boolean): LinkedAccount!

  # Teams
  createTeam(input: CreateTeamInput!): Team!
  updateTeamSettings(teamId: ID!, input: TeamSettingsInput!): Team!   # Admin only
  deleteTeam(teamId: ID!): Boolean!                                    # Admin only
  regenerateInviteCode(teamId: ID!): String!                           # Admin only

  # Membership
  joinTeam(inviteCode: String!): Team!                  # Validates code + expiry + WAF rate-limited
  leaveTeam(teamId: ID!): Boolean!
  updateMembership(teamId: ID!, input: MembershipInput!): TeamMember!  # Own membership only
  removeMember(teamId: ID!, userId: ID!): Boolean!      # Admin only, verifies DB membership
  promoteMember(teamId: ID!, userId: ID!): TeamMember!  # Admin only, verifies DB membership

  # Sync — idempotent via _version conditional writes
  syncSessions(input: [SyncSessionInput!]!): SyncResult!
  syncMessages(input: [SyncMessageInput!]!): SyncResult!

  # Stats aggregation — IAM auth (Lambda-only, not user-callable)
  refreshTeamStats(teamId: ID!, period: String!): Boolean!  @aws_iam

  # Achievements — own achievements only
  unlockAchievement(achievementId: ID!, context: AWSJSON): Achievement!
  toggleAchievementVisibility(achievementId: ID!, shared: Boolean!): Achievement!

  # Challenges — require team membership
  createChallenge(teamId: ID!, input: ChallengeInput!): Challenge!  # Admin only
  joinChallenge(challengeId: ID!): Boolean!
  completeChallenge(challengeId: ID!): Challenge!        # Admin or auto (Lambda via EventBridge)

  # Team logo upload
  requestTeamLogoUpload(teamId: ID!): LogoUploadUrl!     # Admin only — returns presigned S3 PUT URL
  deleteTeamLogo(teamId: ID!): Boolean!                  # Admin only

  # Cross-team dashboard sharing
  grantDashboardAccess(teamId: ID!, readerTeamId: ID!): Boolean!   # Admin only
  revokeDashboardAccess(teamId: ID!, readerTeamId: ID!): Boolean!  # Admin only

  # Inter-team challenges
  createInterTeamChallenge(teamId: ID!, input: InterTeamChallengeInput!): InterTeamChallenge!  # Admin only
  joinInterTeamChallenge(teamId: ID!, inviteCode: String!): InterTeamChallenge!  # Admin of joining team
  completeInterTeamChallenge(challengeId: ID!): InterTeamChallenge!  # Auto (Lambda) or creating team admin

  # Account management — own account only
  deleteMyAccount: Boolean!                              # Purges all user data (see 16-operations.md)

  # Admin — superadmin only
  updateAllowedDomains(domains: [String!]!): [String!]!
}

type LogoUploadUrl {
  uploadUrl: String!             # Presigned S3 PUT URL (expires in 5 min)
  logoUrl: String!               # The resulting public URL after upload (available after S3 upload + validation)
}

# Note: requestTeamLogoUpload generates a presigned PUT URL only — it does NOT update Teams.logoUrl.
# After the client uploads to S3, the validate-logo Lambda (S3-event triggered, NOT an AppSync resolver)
# validates the image and writes Teams.logoUrl directly to DynamoDB. The Team.logoUrl field reflects
# the current logo via the standard team(teamId) query.
```

## Subscriptions

```graphql
type Subscription {
  # Real-time team updates — filtered by teamId (only members receive events)
  onTeamStatsUpdated(teamId: ID!): TeamStatsUpdate
    @aws_subscribe(mutations: ["refreshTeamStats"])

  onAchievementUnlocked(teamId: ID!): AchievementEvent
    @aws_subscribe(mutations: ["unlockAchievement"])

  onChallengeUpdated(teamId: ID!): Challenge
    @aws_subscribe(mutations: ["createChallenge", "completeChallenge"])

  # Inter-team challenges — filtered by challengeId
  onInterTeamChallengeUpdated(challengeId: ID!): InterTeamChallenge
    @aws_subscribe(mutations: ["completeInterTeamChallenge"])

  # Cross-device sync — filtered by userId (only own devices receive events)
  onSessionSynced(userId: ID!): SyncedSession
    @aws_subscribe(mutations: ["syncSessions"])
}
```

## Input Types

```graphql
input SyncSessionInput {
  sessionId: ID!
  projectId: String               # GitHub "owner/repo", parsed from git remote. Null if no remote.
  projectPathHash: String         # SHA-256 of local path — fallback grouping when projectId is null
  firstTimestamp: AWSTimestamp!
  lastTimestamp: AWSTimestamp!
  claudeVersion: String!
  entrypoint: String!
  promptCount: Int!
  assistantMessageCount: Int!
  inputTokens: Long!
  outputTokens: Long!
  cacheCreationTokens: Long
  cacheReadTokens: Long
  toolUseCounts: AWSJSON
  models: [String!]!
  accountId: String!              # HMAC-derived (see 11-account-separation.md)
  isSubagent: Boolean!
  parentSessionId: String
  thinkingBlocks: Int
  estimatedCost: Float!
  _version: Int!                  # Expected server version (for conditional write)
}

input SyncMessageInput {
  sessionId: ID!
  uuid: ID!
  timestamp: AWSTimestamp!
  model: String!
  stopReason: String!
  inputTokens: Long!
  outputTokens: Long!
  cacheCreationTokens: Long
  cacheReadTokens: Long
  tools: [String!]
  thinkingBlocks: Int
  serviceTier: String
  promptText: String              # Optional — only sent when user opts in (sharePrompts: true) and passes client-side secret scan
  _version: Int!                  # Expected server version (for conditional write)
}

input UpdateProfileInput {
  displayName: String             # Max 50 chars
  avatarUrl: String
  timezone: String
  weekStartDay: Int               # 0=Sun, 1=Mon
  defaultShareLevel: ShareLevel
  streakWeekendGrace: Boolean
  personalityType: String
}

input LinkAccountInput {
  accountId: String!              # HMAC-derived (see 11-account-separation.md)
  label: String!                  # Max 30 chars, e.g. "Work", "Personal"
  shareWithTeams: Boolean!
  sharePrompts: Boolean           # Default false. When true, prompt text is synced (after client-side secret scan).
}

input CreateTeamInput {
  teamName: String!               # Max 100 chars
  logoUrl: String                 # Optional — can also upload later via requestTeamLogoUpload
}

input TeamSettingsInput {
  leaderboardEnabled: Boolean
  leaderboardCategories: [String!]
  challengesEnabled: Boolean
  minMembersForAggregates: Int    # Min 2, max 10
  crossTeamVisibility: CrossTeamVisibility
}

input InterTeamChallengeInput {
  name: String!                   # Max 100 chars
  metric: String!                 # Same metric options as intra-team challenges
  startTime: AWSTimestamp!
  endTime: AWSTimestamp!          # Max 30 days after startTime, min 1 day
}

input MembershipInput {
  displayName: String             # Max 50 chars — display name for this team
  shareLevel: ShareLevel
  sharedAccounts: [String!]       # accountIds to include in team stats
}

input ChallengeInput {
  name: String!                   # Max 100 chars
  metric: String!                 # One of: "haiku_pct", "prompts", "cache_rate", "avg_session_length", "cost_per_prompt"
  startTime: AWSTimestamp!
  endTime: AWSTimestamp!          # Max 30 days after startTime, min 1 day
}
```

**Subscription authorization:** AppSync subscription filtering ensures that `onTeamStatsUpdated(teamId: X)` only delivers to clients whose JWT contains `team:X:member` or `team:X:admin` group claims. The `onSessionSynced(userId)` filter requires `ctx.identity.sub == userId`. See [AppSync enhanced subscription filtering](https://docs.aws.amazon.com/appsync/latest/devguide/aws-appsync-real-time-enhanced-filtering.html).

## Input Validation

All mutations enforce server-side input limits in AppSync resolvers:

| Mutation | Limit | Rationale |
|----------|-------|-----------|
| `syncSessions` | Max 25 items per call | Matches client batch size; prevents payload abuse |
| `syncMessages` | Max 100 items per call | Messages are smaller; higher batch for efficiency |
| All mutations | AppSync 1 MB request size limit (built-in) | AWS-enforced |
| `createTeam` | `teamName` max 100 chars | Prevent storage abuse |
| `updateProfile` | `displayName` max 50 chars, `label` max 30 chars | Reasonable display limits |
| `createChallenge` | `name` max 100 chars, duration 1-30 days | Prevent unbounded challenges |
| `joinTeam` | Max 50 members per team (hard cap 200) | Prevent unbounded team growth |

Validation is enforced in the AppSync JS resolver `request` handler before the DynamoDB operation:

```javascript
// Example: syncSessions resolver
export function request(ctx) {
  const items = ctx.args.input;
  if (!items || items.length === 0 || items.length > 25) {
    util.error("Input must contain 1-25 items", "ValidationError");
  }
  // ... proceed with batch write
}
```

## Resolver Strategy

| Operation | Resolver Type | Auth Check | Reason |
|-----------|--------------|------------|--------|
| Simple CRUD (profile, teams) | JS resolver → DynamoDB | Ownership or group check | Low latency, no compute cost |
| Sync mutations | JS resolver → DynamoDB | Ownership (`ctx.identity.sub`) | Direct writes with `_version` condition |
| Team dashboard aggregation | Lambda | Group check + DB membership verify | Complex joins across tables |
| Challenge scoring | Lambda | Group check + DB membership verify | Multi-table reads + ranking logic |
| Achievement checks | Lambda | Ownership (`ctx.identity.sub`) | Business logic with multiple conditions |
| Admin operations | Lambda | Superadmin group + audit log | Cognito group management + DynamoDB + CloudWatch |
| Project insights | Lambda | Group check + DB membership verify | Cross-member aggregation by projectId from TeamStats |
| Cross-team comparison | Lambda | Authenticated user | Reads Teams GSI (TeamsByVisibility) + latest TeamStats aggregates |
| Cross-team dashboard read | Lambda | Dashboard reader check | Verifies caller's team in target's dashboardReaders; returns TeamDashboard |
| Team logo upload | Lambda | Admin check + DB verify | Generates S3 presigned PUT URL; updates Teams.logoUrl on confirmation |
| Inter-team challenge ops | Lambda | Admin check + DB verify | Multi-table reads/writes across InterTeamChallenges + TeamStats |
| Stats refresh | Lambda (IAM auth) | N/A (internal) | Triggered by DynamoDB Streams, not user-callable |
