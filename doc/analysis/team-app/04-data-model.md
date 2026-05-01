# 04 — Data Model

DynamoDB tables. Separate tables per access pattern domain rather than single-table design, because:
- Each domain (auth, sync, teams, gamification) has distinct access patterns and scaling characteristics
- Separate tables allow independent capacity scaling and IAM scoping per Lambda
- Easier to reason about GSI costs and hot partition risks per domain

## Tables

### UserProfiles

Per-user profile and settings. Synced via AppSync.

```
Table: UserProfiles
PK: userId (Cognito sub)
Attributes:
  email: string
  displayName: string
  avatarUrl: string | null
  createdAt: number
  lastSyncAt: number
  accounts: [                    # Work + personal Claude accounts
    {
      accountId: string,         # HMAC-SHA-256(account_uuid, user_salt).slice(0, 32)
      label: string,             # "Work" or "Personal"
      shareWithTeams: boolean,   # User controls per-account
      sharePrompts: boolean,     # Opt-in: sync prompt text (after client-side secret scanning). Default false.
    }
  ]
  # NOTE: account_uuid is NOT stored in this table.
  # The accountId is a one-way HMAC derived client-side. The client maps
  # accountId ↔ account_uuid locally (in SQLite or secure storage).
  # See 11-account-separation.md for the full derivation flow.
  preferences: {
    timezone: string,
    weekStartDay: number,        # 0=Sun, 1=Mon
    defaultShareLevel: "full" | "summary" | "minimal",
    streakWeekendGrace: boolean,
  }
  personalityType: string | null   # Computed locally, optionally shared
  userSalt: string               # Random 32-byte hex, generated on first setup
  updatedAt: number
```

### Teams

```
Table: Teams
PK: teamId (UUID)
Attributes:
  teamName: string
  teamSlug: string
  logoUrl: string | null          # S3 presigned URL to team logo (max 256 KB, PNG/SVG/JPEG)
  createdBy: string (userId)
  createdAt: number
  inviteCode: string             # 12-char alphanumeric (72 bits entropy), regeneratable
  inviteCodeExpiresAt: number    # Epoch seconds — codes expire after 30 days
  settings: {
    leaderboardEnabled: boolean,
    leaderboardCategories: string[],
    challengesEnabled: boolean,
    minMembersForAggregates: number,  # Default 3
    crossTeamVisibility: "private" | "public_stats" | "public_dashboard",
      # private: default — no data visible to other teams
      # public_stats: aggregate-only stats visible on cross-team comparison page
      # public_dashboard: full dashboard readable by granted teams
  }
  dashboardReaders: string[]     # teamIds granted read access (only applies when crossTeamVisibility = "public_dashboard")
  memberCount: number            # Denormalized for listing
  updatedAt: number

GSI: TeamsBySlug
  PK: teamSlug
  Projection: KEYS_ONLY          # Lookup only — fetch full item from base table

GSI: TeamsByVisibility
  PK: crossTeamVisibility        # "public_stats" or "public_dashboard" — private teams not indexed
  SK: teamId
  Projection: INCLUDE [teamName, teamSlug, logoUrl, memberCount]
```

### TeamMemberships

Join table. Enables multi-team membership and per-team roles.

```
Table: TeamMemberships
PK: teamId
SK: userId
Attributes:
  role: "admin" | "member"
  joinedAt: number
  displayName: string            # Can differ per team
  shareLevel: "full" | "summary" | "minimal"
  sharedAccounts: string[]       # Which accountIds to include in team stats
  updatedAt: number

GSI: MembershipsByUser
  PK: userId
  SK: teamId
  Projection: INCLUDE [role, joinedAt, displayName]
```

### SyncedSessions

Cross-device session sync. Supplements local SQLite (not replaces — see [06-sync-strategy.md](06-sync-strategy.md)).

```
Table: SyncedSessions
PK: userId
SK: sessionId
Attributes:
  projectId: string | null        # GitHub repo identifier, e.g. "acme/api-gateway" (parsed from git remote)
  projectPathHash: string        # SHA-256 of local projectPath — fallback grouping when projectId is null
  firstTimestamp: number
  lastTimestamp: number
  claudeVersion: string
  entrypoint: string
  promptCount: number
  assistantMessageCount: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  toolUseCounts: map[]
  models: string[]
  accountId: string              # HMAC-derived, links to UserProfiles.accounts
  isSubagent: boolean
  parentSessionId: string | null
  thinkingBlocks: number
  estimatedCost: number
  updatedAt: number
  _version: number               # Monotonic counter, incremented server-side on every write
  _lastChangedAt: number

GSI: SessionsByTimestamp
  PK: userId
  SK: firstTimestamp
  Projection: INCLUDE [accountId, projectId, updatedAt, sessionId, promptCount, estimatedCost]

GSI: SessionsByAccount
  PK: accountId
  SK: firstTimestamp
  Projection: INCLUDE [userId, projectId, updatedAt, sessionId, promptCount, estimatedCost]

GSI: SessionsByProject
  PK: projectId                  # Only populated for sessions with a git remote
  SK: firstTimestamp
  Projection: INCLUDE [userId, accountId, sessionId, promptCount, inputTokens, outputTokens, estimatedCost]
```

**Hot partition mitigation:** A single user syncing many sessions hits one PK. Since sessions are written in batches of 25 with exponential backoff (see [06-sync-strategy.md](06-sync-strategy.md)), and DynamoDB on-demand mode handles burst capacity up to 4,000 WCU per partition, this is acceptable for expected usage (<100 sessions per sync).

### SyncedMessages

Per-message detail for cross-device sync.

```
Table: SyncedMessages
PK: sessionId
SK: uuid
Attributes:
  timestamp: number
  model: string
  stopReason: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  tools: string[]
  thinkingBlocks: number
  serviceTier: string | null
  promptText: string | null      # Opt-in; only populated when user has sharePrompts enabled and secret scan passed
  updatedAt: number
  _version: number               # Monotonic counter, server-side
  _lastChangedAt: number

TTL: expiresAt                   # Set to lastTimestamp + 1 year; old messages auto-purge
```

### TeamStats

Pre-aggregated team stats per period. Written by aggregation Lambda.

```
Table: TeamStats
PK: teamId
SK: period#userId                # e.g., "2026-W11#user-abc"
Attributes:
  period: string                 # ISO week: "2026-W11"
  userId: string
  displayName: string
  shareLevel: string
  stats: {
    sessions: number,
    prompts: number,
    inputTokens: number,
    outputTokens: number,
    estimatedCost: number,       # Omitted if shareLevel = "minimal"
    activeMinutes: number,
    modelsUsed: map,             # Omitted if shareLevel = "minimal"
    topTools: string[],          # Omitted if shareLevel = "minimal"
    streakDays: number,
    achievements: string[],
    velocityTokensPerMin: number,
    subagentRatio: number,
    projectBreakdown: [          # Omitted if shareLevel = "minimal"
      {
        projectId: string,       # e.g. "acme/api-gateway", or null for sessions without a repo
        sessions: number,
        prompts: number,
        estimatedCost: number,
      }
    ],
  }
  computedAt: number             # When this aggregate was last recomputed
  updatedAt: number

GSI: StatsByPeriod
  PK: period
  SK: teamId#userId
  Projection: INCLUDE [stats, displayName, shareLevel]

TTL: expiresAt                   # Set to period end + 1 year; old stats auto-purge
```

**Staleness:** TeamStats are recomputed by an aggregation Lambda triggered:
1. After every `syncSessions` mutation (via DynamoDB Streams on SyncedSessions)
2. On a daily EventBridge schedule (catch-up for missed triggers)
3. On-demand via `refreshTeamStats` mutation (IAM-auth only — called by internal Lambdas, not user-callable; see [05-api-design.md](05-api-design.md))

Maximum staleness: aggregation Lambda processes stream events within seconds. Worst case (Lambda failure + retry): ~5 minutes. Dashboard shows `computedAt` timestamp so users see freshness.

### Achievements

```
Table: Achievements
PK: userId
SK: achievementId
Attributes:
  unlockedAt: number
  context: map                   # e.g., { prompts: 100 }
  shared: boolean                # User controls visibility
  updatedAt: number
```

### Challenges

```
Table: Challenges
PK: teamId
SK: challengeId
Attributes:
  name: string
  metric: string
  startTime: number
  endTime: number
  createdBy: string (userId)
  participants: map              # userId → { score, rank }
  status: "active" | "completed"
  updatedAt: number

TTL: expiresAt                   # Set to endTime + 90 days; old challenges auto-purge
```

### InterTeamChallenges

Cross-team competitions. Separate from intra-team Challenges table.

```
Table: InterTeamChallenges
PK: challengeId (UUID)
Attributes:
  name: string
  metric: string                 # Same metrics as intra-team challenges
  startTime: number
  endTime: number
  createdBy: string (userId)
  creatingTeamId: string         # Team whose admin created the challenge
  teams: map                     # teamId → { teamName, teamSlug, logoUrl, score, rank }
  status: "pending" | "active" | "completed"
  inviteCode: string             # 12-char alphanumeric — other team admins use this to join
  inviteCodeExpiresAt: number
  updatedAt: number

GSI: InterTeamChallengesByStatus
  PK: status
  SK: endTime
  Projection: INCLUDE [name, metric, teams, creatingTeamId]

TTL: expiresAt                   # Set to endTime + 90 days
```

### MagicLinkTokens

Authentication tokens for magic link flow. See [02-authentication.md](02-authentication.md) for the full auth flow.

```
Table: MagicLinkTokens
PK: email (lowercase, trimmed)
SK: "TOKEN"
Attributes:
  tokenHash: string             (HMAC-SHA-256 of token)
  expiresAt: number             (epoch seconds — DynamoDB TTL attribute)
  used: boolean
  createdAt: number
  requestCount: number          (rate limiting counter)
  requestWindowStart: number    (epoch seconds — resets hourly)
```

TTL on `expiresAt` ensures automatic cleanup. One active token per email (PK+SK overwrite).

## Version Conflict Resolution

The `_version` field is a **monotonic server-side counter**:

1. Initialized to `1` on first write
2. Every mutation increments `_version` via DynamoDB conditional expression:
   ```
   ConditionExpression: _version = :expectedVersion
   UpdateExpression: SET _version = _version + 1, ...
   ```
3. If the condition fails → `ConditionalCheckFailedException` → client receives version conflict error
4. Client re-fetches the latest item, merges using the resolution strategy in [06-sync-strategy.md](06-sync-strategy.md), and retries with the new `_version`
5. Maximum 3 retries with exponential backoff (100ms, 200ms, 400ms)

The `_lastChangedAt` is set server-side to the current epoch on every write (via `SET _lastChangedAt = :now`).

## Access Patterns

| Pattern | Table | Key Condition |
|---------|-------|---------------|
| Get user profile | UserProfiles | PK = userId |
| List user's teams | TeamMemberships (GSI) | PK = userId |
| List team members | TeamMemberships | PK = teamId |
| Get team stats for period | TeamStats | PK = teamId, SK begins_with period |
| Get user stats across teams | TeamStats (GSI) | PK = period, SK begins_with teamId |
| Sync sessions for user | SyncedSessions | PK = userId |
| Get sessions by time range | SyncedSessions (GSI) | PK = userId, SK between timestamps |
| Get messages for session | SyncedMessages | PK = sessionId |
| List user achievements | Achievements | PK = userId |
| Get active challenges | Challenges | PK = teamId, filter status = active |
| Get sessions by project | SyncedSessions (GSI) | PK = projectId, SK between timestamps |
| Get project breakdown for team | TeamStats | PK = teamId, SK begins_with period → read projectBreakdown from stats |
| List public teams for comparison | Teams (GSI TeamsByVisibility) | PK = "public_stats" or "public_dashboard" |
| Check if team grants dashboard read | Teams | PK = teamId → check dashboardReaders contains requestor's teamId |
| List active inter-team challenges | InterTeamChallenges (GSI) | PK = "active", SK between timestamps |
| Get inter-team challenge by invite | InterTeamChallenges | Scan filter on inviteCode (rare operation, small table) |
