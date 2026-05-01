# 11 — Account Separation

Users may have multiple Claude accounts (work + personal). They control exactly what gets shared with teams.

## Account Model

Each user links one or more Claude accounts to their profile:

```
User Profile
├── Account: "Work" (acme org, Max 5x plan)
│   ├── shareWithTeams: true
│   └── sharePrompts: true       # Opt-in: sync prompt text (after secret scanning)
└── Account: "Personal" (individual, Pro plan)
    ├── shareWithTeams: false
    └── sharePrompts: false      # Default: off
```

### Linking Accounts

During setup or from the profile page:

```
1. User runs `claude-stats sync --setup`
2. CLI reads ~/.claude.json → detects current account_uuid
3. User labels it: "Work" or "Personal" (free text)
4. CLI derives accountId = HMAC-SHA-256(account_uuid, userSalt).slice(0, 32)
5. CLI uploads { accountId, label, shareWithTeams } to cloud profile
6. CLI stores mapping { accountId ↔ account_uuid } in local SQLite (sync_config table)
7. Repeat for additional accounts (switch Claude accounts, re-run)
```

In the SPA:

```
Profile → Accounts → Link Account
  "Paste your Claude account UUID (from ~/.claude.json):"
  [________________________]  Label: [Work ▼]  [Link Account]

  ℹ The UUID is hashed locally before upload. We never see or store your raw UUID.
```

**Rate limiting:** Max 5 account link operations per user per day (prevents abuse).

### Account ID Privacy

The raw `account_uuid` **never leaves the user's device**. Only a one-way HMAC-derived `accountId` is stored in the cloud.

```
accountId = HMAC-SHA-256(account_uuid, userSalt).slice(0, 32)
```

- `userSalt`: random 32-byte hex string, generated during `sync --setup`, stored in the user's DynamoDB profile
- HMAC (not plain SHA-256): keyed hash prevents rainbow table attacks even if the DynamoDB table leaks
- The salt is per-user, so two users with the same `account_uuid` produce different `accountId` values
- The client maintains the `accountId ↔ account_uuid` mapping locally in SQLite for session-to-account association

### Why Not Store account_uuid in the Cloud?

Previous iterations stored an encrypted `accountUuid` in the UserProfiles table. This was removed because:

1. **No server-side need:** The aggregation Lambda filters by `accountId` (HMAC hash), not the raw UUID. It never needs to decrypt.
2. **Reduced attack surface:** If DynamoDB is compromised, attackers get only one-way hashes, not reversible encrypted UUIDs.
3. **Simpler key management:** No need for per-user encryption keys, KMS key policies, or decryption permissions.
4. **Client-side trust:** The client computes `accountId` from the raw UUID locally. The server trusts the client's derived `accountId` — this is safe because a malicious client could only pollute their own stats (each user writes only to their own PK).

## Sharing Controls

### Per-Account Toggle

Each linked account has a `shareWithTeams` boolean. When `false`, sessions tagged with that `accountId` are excluded from team stats, leaderboards, achievements, and challenges.

```
┌─ My Accounts ─────────────────────────────────┐
│                                                │
│  Work (Acme Corp)           Share: [✓]        │
│  Max 5x · ID: a1b2...      Prompts: [✓]      │
│  142 sessions this month                       │
│                                                │
│  Personal                   Share: [ ]         │
│  Pro · ID: c3d4...          Prompts: [ ]      │
│  67 sessions this month                        │
│                                                │
│  ℹ️ Only shared accounts contribute to team    │
│     leaderboards, challenges, and aggregates.  │
│  ℹ️ Prompt sharing requires "full" share level │
│     and is scanned for secrets before upload.  │
└────────────────────────────────────────────────┘
```

### Per-Team Account Selection

Beyond the global toggle, each team membership specifies which accounts are included:

```sql
-- TeamMemberships
sharedAccounts: ["accountId-work"]  -- Only work account shared with this team
```

This means a user could share their work account with Team A (work team) and their personal account with Team B (side-project group).

### Share Level (Per-Team)

Controls granularity of what team members see:

| Level | What's Visible | Use Case |
|-------|---------------|----------|
| **full** | Sessions, prompts, tokens, cost, models, tools, velocity, achievements, prompt text* | Close-knit teams |
| **summary** | Sessions, prompts, tokens, cost | General team use |
| **minimal** | Sessions and prompts only | Maximum privacy while participating |

\* Prompt text requires `sharePrompts: true` on the account in addition to `full` share level. Secret scanning is applied client-side before sync (see [06-sync-strategy.md § Prompt Text Sync](06-sync-strategy.md)).

## Data Flow with Account Filtering

```
Local SQLite (all accounts)
        │
        ▼
    Sync Push (client-side)
        │
        ├── Client computes accountId for each session
        │   (HMAC of account_uuid + userSalt — done locally)
        ├── All sessions for linked accounts are pushed
        │   (regardless of shareWithTeams — sharing is enforced at team layer)
        │
        ▼
    Cloud (SyncedSessions)
    PK: userId, each session tagged with accountId
        │
        ├── All sessions available for personal dashboard
        │   (cross-device sync includes ALL linked accounts)
        │
        ▼
    Team Stats Aggregation Lambda
        │
        ├── Reads TeamMemberships for user → gets sharedAccounts[]
        ├── Filters SyncedSessions: only sessions where accountId
        │   is in membership.sharedAccounts for this team
        ├── Applies share level: omits fields per shareLevel setting
        │
        ▼
    TeamStats table (pre-filtered, per team × per user × per period)
```

Key: **cross-device sync includes all linked accounts** (personal dashboard shows everything). **Team views only include selected accounts at the selected share level.** The filtering is enforced server-side in the aggregation Lambda — the client cannot bypass it.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User unlinks an account | `accountId` removed from UserProfiles.accounts. Sessions remain in SyncedSessions (keyed by sessionId, not accountId). Next aggregation excludes sessions with that accountId. Previously shared aggregate totals in TeamStats remain until next recomputation |
| User changes shareWithTeams to false | `sharedAccounts` updated in TeamMemberships. Next aggregation excludes those sessions. Audit: `updatedAt` timestamp records when sharing changed |
| User is on multiple teams with different shared accounts | Each team membership has its own `sharedAccounts[]`. Aggregation Lambda reads per-team membership |
| User has no shared accounts | They appear in team member list but with zero stats. Streak and achievements still visible if individually shared |
| Account UUID changes (re-auth) | Client generates new `accountId` from new UUID. Old sessions remain under old accountId. User links new account separately |
| Malicious user fakes accountId | They can only pollute their own data (PK=userId). Team stats are derived from their SyncedSessions, so fabricated accountIds just mean incorrect personal stats — no cross-user impact |

## Personal Dashboard vs Team Dashboard

| View | Data Source | Accounts Shown |
|------|------------|----------------|
| Personal dashboard (SPA) | All SyncedSessions for userId | All linked accounts |
| Personal dashboard (CLI) | Local SQLite | All local sessions |
| Team dashboard | TeamStats (pre-filtered by aggregation Lambda) | Only shared accounts per membership |
| MCP server queries | AppSync (scoped by userId) | "my stats" = all; "team stats" = filtered |
