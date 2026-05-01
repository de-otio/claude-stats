# 03 — Authorization

## Roles

Three roles, enforced at the AppSync resolver level via Cognito groups.

| Role | Scope | Description |
|------|-------|-------------|
| **Superadmin** | Global | Manages allowed domains, can view all teams, assign team admins |
| **Team Admin** | Per-team | Creates team, manages members, configures team settings |
| **Team Member** | Per-team | Joins teams, syncs stats, views team dashboard |

A user can hold different roles in different teams (e.g., admin of Team A, member of Team B).

## Permission Matrix

| Action | Superadmin | Team Admin | Member |
|--------|:----------:|:----------:|:------:|
| Manage allowed email domains | Y | - | - |
| View all teams | Y | - | - |
| Promote user to team admin | Y | Y (own team) | - |
| Create team | Y | Y | Y |
| Delete team | Y | Y (own team) | - |
| Invite members | Y | Y (own team) | - |
| Remove members | Y | Y (own team) | - |
| Configure team settings | Y | Y (own team) | - |
| View team dashboard | Y | Y | Y |
| View team leaderboard | Y | Y | Y |
| Sync own stats | Y | Y | Y |
| Choose sharing level | Y | Y | Y |
| View own profile | Y | Y | Y |
| View teammate profile | Y | Y | Y (shared data only) |
| View cross-team comparison | Y | Y | Y (only teams with public_stats or public_dashboard) |
| View another team's dashboard | Y | Y (if team in dashboardReaders) | Y (if team in dashboardReaders) |
| Grant/revoke dashboard access | Y | Y (own team) | - |
| Configure cross-team visibility | Y | Y (own team) | - |
| Upload/delete team logo | Y | Y (own team) | - |
| Create inter-team challenge | Y | Y (own team) | - |
| Join inter-team challenge | Y | Y (own team) | - |
| Delete own account | Y | Y | Y |

## Implementation

### Cognito Groups

```
superadmin          — global admin group
team:{teamId}:admin — per-team admin
team:{teamId}:member — per-team member
```

Users are added to groups via the `PostConfirmation` Lambda (for superadmin seeding) and team management Lambdas (for team roles). The `PreTokenGeneration` Lambda ensures group claims are included in every JWT.

### AppSync Authorization

AppSync uses two auth modes:
- **Primary:** `AMAZON_COGNITO_USER_POOLS` — for all user-facing queries/mutations
- **Additional:** `AWS_IAM` — for Lambda-to-AppSync calls (e.g., aggregation Lambda publishing subscription events)

### Resolver Auth Pattern

Every resolver that accesses team-scoped data performs a two-step check:

```javascript
// AppSync JS resolver — request handler
export function request(ctx) {
  const groups = ctx.identity.claims["cognito:groups"] || [];
  const teamId = ctx.args.teamId;

  // Step 1: JWT group check (fast, covers 99% of cases)
  const isMember = groups.includes(`team:${teamId}:member`)
    || groups.includes(`team:${teamId}:admin`);
  const isSuperadmin = groups.includes("superadmin");

  if (!isMember && !isSuperadmin) {
    util.unauthorized();
  }

  // Step 2: For sensitive mutations (remove member, delete team, change settings),
  // also verify against TeamMemberships table to catch stale JWTs
  // (JWT may be up to 1 hour old if user was removed mid-session)
  return {
    operation: "GetItem",
    key: util.dynamodb.toMapValues({ teamId, userId: ctx.identity.sub }),
  };
}
```

**Why two steps?** JWT group claims are cached for the token's lifetime (1 hour). If a user is removed from a team, their JWT still contains the old group claim until it expires. For read operations this is acceptable (stale read for up to 1 hour). For mutations (remove member, delete team, change settings), the resolver additionally verifies current membership in the TeamMemberships table.

### Superadmin Safety

- Superadmin group membership is managed via CDK config (initial seed) and Cognito Admin API only — not self-service
- All superadmin actions are logged to CloudWatch with full request context
- Superadmin JWT tokens have the same 1-hour TTL as regular users
- Consider: MFA requirement for superadmin actions (Cognito supports TOTP as optional second factor alongside magic links)

### Cognito Groups Scaling Limit

Cognito has a default limit of **25 groups per user** (and a 20 KB access token size limit). Since each team membership adds two potential groups (`team:{teamId}:admin` or `team:{teamId}:member`), a user can belong to at most ~25 teams before hitting the Cognito limit.

**Mitigation approach (if needed):**
- For the current scope (internal company teams), 25 teams per user is sufficient
- If the limit becomes a constraint, migrate team membership checks from Cognito groups to a **resolver-level DynamoDB lookup** pattern: remove `team:*` groups from JWT, keep only `superadmin`, and check TeamMemberships table in every resolver (similar to the existing Step 2 pattern for sensitive mutations, extended to all team-scoped operations)
- This trades slightly higher read latency (~5ms DynamoDB GetItem) for unlimited team membership

### Share Level Field Filtering

Share-level filtering is applied in two places:

1. **Aggregation Lambda** (write-time): When computing TeamStats, fields like `estimatedCost`, `modelsUsed`, `topTools`, and `projectBreakdown` are omitted from the stored stats if the user's `shareLevel` is `minimal`. This ensures sensitive data is never written to the shared table.
2. **Team dashboard Lambda** (read-time): When assembling `TeamDashboard`, the resolver reads each member's `shareLevel` from TeamStats and nulls out restricted fields before returning. This provides defense-in-depth if the aggregation Lambda fails to filter.

| Field | `full` | `summary` | `minimal` |
|-------|:------:|:---------:|:---------:|
| sessions, prompts | Y | Y | Y |
| inputTokens, outputTokens | Y | Y | - |
| estimatedCost | Y | Y | - |
| modelsUsed, topTools | Y | - | - |
| projectBreakdown | Y | Y | - |
| velocityTokensPerMin | Y | Y | Y |
| subagentRatio | Y | Y | - |
| promptText | Y* | - | - |

\* Prompt text requires **both** `full` share level **and** `sharePrompts: true` on the account. If either condition is false, `promptText` is null in team views. Prompt text is always available in the user's own personal dashboard (cross-device sync) regardless of share level.

### Mutations Requiring DB Membership Verification (Step 2)

The following mutations verify current membership in the TeamMemberships table (not just JWT claims):
- `removeMember`, `promoteMember` — admin mutations
- `deleteTeam`, `updateTeamSettings`, `regenerateInviteCode` — admin mutations
- `createChallenge`, `completeChallenge` — admin mutations
- `grantDashboardAccess`, `revokeDashboardAccess` — admin mutations
- `requestTeamLogoUpload`, `deleteTeamLogo` — admin mutations
- `createInterTeamChallenge`, `joinInterTeamChallenge` — admin mutations
- `updateMembership` — own membership, but verifies membership still exists

Read-only queries (`teamDashboard`, `teamMembers`, `teamProjects`, etc.) use JWT-only checks — a stale JWT may allow reads for up to 1 hour after removal, which is acceptable.

### Row-Level Security

DynamoDB items include `teamId` as partition key. Resolvers filter by team membership before returning data. No cross-team data leakage is possible at the resolver level.

User profile data uses ownership-based access: only the owning user (matched by `ctx.identity.sub`) can read `accountUuid` or other private fields. The `UserPublicProfile` type returned to teammates excludes sensitive fields by design (separate GraphQL type, not field-level nulling).

### Token Revocation

For immediate access revocation (e.g., employee offboarding):
1. Superadmin disables user in Cognito (blocks new token issuance)
2. Superadmin calls `globalSignOut` on the user (invalidates all refresh tokens)
3. Existing access tokens remain valid for up to 1 hour (Cognito limitation)
4. For critical cases: enable Cognito token revocation checking (adds latency but enables immediate revocation)
