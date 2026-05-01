# 06 — Sync Strategy

Cross-device sync and offline-first architecture.

## Approach: AppSync with Local Cache

Rather than Amplify DataStore (which tightly couples to the Amplify CLI for backend generation), we use **AppSync directly** with a local sync layer managed by the claude-stats client.

### Why Not Amplify DataStore?

| Concern | Detail |
|---------|--------|
| Amplify CLI lock-in | DataStore requires Amplify CLI to generate the AppSync API, resolvers, and DynamoDB tables. This conflicts with CDK-managed infrastructure |
| Schema coupling | DataStore auto-generates GraphQL schema from models. We need custom resolvers and authorization logic that DataStore doesn't support well |
| Limited CDK interop | Connecting DataStore to a CDK-created AppSync API is poorly documented and fragile (multiple open GitHub issues) |
| Delta sync tables | DataStore requires a specific DynamoDB table structure for delta sync that's hard to manage outside Amplify CLI |

### What We Use Instead

**AppSync + custom sync client** — the client manages:
1. Local SQLite database (existing, unchanged for offline collection)
2. Sync state tracking (last sync timestamp per table)
3. Push: batch mutations to AppSync on `sync --push`
4. Pull: queries with `updatedAfter` filter on `sync --pull`
5. Real-time: optional AppSync subscriptions for live updates in SPA

This gives us full CDK control over the backend while preserving the offline-first local SQLite model.

## Data Boundary (What Syncs, What Stays Local)

**Design invariant:** Only structured metadata leaves the device. Conversation content never syncs.

| Data | Synced? | Notes |
|------|:-------:|-------|
| Token counts (input, output, cache) | Yes | Aggregate numbers only |
| Model names, tool names | Yes | e.g. "claude-sonnet-4-6", "Edit" |
| Timestamps, duration | Yes | Session start/end, message timestamps |
| Estimated cost | Yes | Derived from token counts |
| Project identifier | Yes | GitHub `owner/repo` (from git remote) — organizational metadata |
| Project path hash | Yes | SHA-256 of local path — not reversible |
| Account ID | Yes | HMAC-derived — not reversible to account UUID |
| Prompt text | **Opt-in** | Requires `sharePrompts: true` on account + passes client-side secret scan (see below) |
| **Assistant responses** | **No** | Content blocks are never parsed into synced fields |
| **Local file paths** | **No** | `projectPath`, `sourceFile` stay in local SQLite only |
| **Code snippets** | **No** | Tool inputs/outputs are not extracted |
| **Thinking blocks content** | **No** | Only the count (`thinkingBlocks: number`) is synced |
| **Git branch name** | **No** | Could reveal feature names; stays local |

This boundary is enforced structurally: the `SyncSessionInput` and `SyncMessageInput` GraphQL types (see [05-api-design.md](05-api-design.md)) define exactly which fields the server accepts. Fields not in those types cannot be transmitted even if the client is modified.

### Prompt Text Sync (Opt-In)

Prompt text can optionally be synced for team insights (e.g., understanding what types of tasks the team uses Claude for). This is **disabled by default** and requires:

1. **User opt-in**: `sharePrompts: true` on the linked account (see [11-account-separation.md](11-account-separation.md))
2. **Client-side secret scanning**: Every prompt is scanned before sync; prompts containing detected secrets are redacted (see below)
3. **Team share level**: Prompts are only visible to teammates at `full` share level

#### Secret Scanning

The client runs a local secret scanner on each prompt before including it in `SyncMessageInput.promptText`. Prompts that fail the scan are synced with `promptText: null` (metadata still syncs normally).

```typescript
// Patterns matched client-side before sync
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API keys & tokens
  { name: "AWS access key",       pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS secret key",       pattern: /(?:aws_secret|secret_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/ },
  { name: "Generic API key",      pattern: /(?:api[_-]?key|apikey|token|secret|password|credential)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/ },
  { name: "Bearer token",         pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/  },
  { name: "GitHub PAT",           pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack token",          pattern: /xox[bporas]-[A-Za-z0-9-]+/ },
  { name: "Private key header",   pattern: /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PGP)\s+PRIVATE\s+KEY-----/ },
  { name: "JWT",                  pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/ },

  // Connection strings
  { name: "Database URL",         pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/ },
  { name: "SMTP credentials",     pattern: /smtp:\/\/[^\s'"]+/ },

  // High-entropy strings (likely secrets)
  { name: "Hex secret (32+)",     pattern: /(?:secret|key|token|password)\s*[:=]\s*['"]?[a-f0-9]{32,}['"]?/i },
];

interface ScanResult {
  safe: boolean;
  redactedText: string | null;   // Prompt with secrets replaced by "[REDACTED:{name}]"
  detectedSecrets: string[];     // Names of matched patterns
}

function scanPrompt(text: string): ScanResult {
  const detected: string[] = [];
  let redacted = text;

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(redacted)) {
      detected.push(name);
      redacted = redacted.replace(new RegExp(pattern, "g"), `[REDACTED:${name}]`);
    }
  }

  return {
    safe: detected.length === 0,
    redactedText: redacted,
    detectedSecrets: detected,
  };
}
```

**Scan behavior:**
- If no secrets detected: `promptText` is included as-is
- If secrets detected: `promptText` is included with matched patterns replaced by `[REDACTED:{name}]` markers
- Scan runs client-side only — the server never sees unredacted secrets
- Scan results are logged locally for the user to review: `claude-stats sync --status` shows count of redacted prompts

**Why client-side, not server-side?** The whole point is to prevent secrets from leaving the device. Server-side scanning would mean the secret has already been transmitted. The client is the trust boundary.

#### Custom Secret Patterns

Users can add project-specific patterns via config:

```json
// ~/.claude-stats/config.json
{
  "sync": {
    "secretPatterns": [
      { "name": "Internal API", "pattern": "ACME-[A-Z0-9]{24}" },
      { "name": "Internal URL", "pattern": "https://internal\\.acme\\.com/[^\\s]+" }
    ]
  }
}
```

Custom patterns are appended to the built-in list.

## Sync Flow

### Push (Device → Cloud)

```
1. Client queries local SQLite for sessions/messages where updated_at > lastSyncTimestamp
2. Client computes accountId for each session (HMAC of account_uuid + userSalt, done locally)
3. Batches into chunks of 25 items
4. For each batch:
   a. Calls syncSessions mutation with items + expected _version per item
   b. Server performs conditional writes (ConditionExpression: _version = :expected)
   c. Returns SyncResult: { itemsWritten, itemsSkipped, conflicts[] }
5. For conflicts: client fetches serverItem from response, merges (see below), retries once
6. On success: updates lastSyncTimestamp locally
7. On transient failure: exponential backoff (100ms, 200ms, 400ms), max 3 retries per batch
8. On persistent failure: log error, skip batch, continue with remaining batches
   (partial sync is safe — idempotent writes mean retry will catch up)
```

### Pull (Cloud → Device)

```
1. Client calls mySessions(from: lastPullTimestamp)
2. Receives new/updated sessions from other devices
3. For each session:
   a. If session exists locally with higher token counts → skip (local is more current)
   b. Otherwise → upsert into local SQLite (existing COALESCE/MAX logic handles conflicts)
4. Updates lastPullTimestamp to MAX(received session updatedAt timestamps)
```

### Idempotency

Sync mutations are idempotent by design:
- Session upserts use `sessionId` as the key — writing the same session twice is a no-op if `_version` matches
- If `_version` doesn't match, it's a conflict (not a duplicate) and handled via merge
- Network retries are safe: the conditional write either succeeds (idempotent) or returns a conflict (client merges and retries)
- No separate idempotency key needed — the `sessionId + _version` pair is the natural idempotency mechanism

### Conflict Resolution

Sessions are append-mostly (token counts only increase). Strategy:

| Field | Resolution | Rationale |
|-------|-----------|-----------|
| Token counts | MAX(local, remote) | Tokens only increase |
| prompt_count | MAX(local, remote) | Prompts only increase |
| last_timestamp | MAX(local, remote) | Latest activity wins |
| first_timestamp | MIN(local, remote) | Earliest start wins |
| Tags | UNION | Don't lose any tags |
| is_subagent | MAX (true wins) | Once detected, stays true |
| parent_session_id | COALESCE (first non-null wins) | Immutable once set |
| account_uuid | COALESCE (first non-null wins) | Immutable once set |
| projectId | COALESCE (first non-null wins) | Immutable — derived from git remote at session start (see below) |
| estimatedCost | Recompute from token counts | Derived field |

This matches the existing SQLite upsert logic, so the sync layer is a natural extension.

### Project ID Derivation

`projectId` is parsed client-side from the session's working directory git remote at session start:

```typescript
// Extracts "owner/repo" from git remote URL
function parseProjectId(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const ssh = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];

  // HTTPS: https://github.com/owner/repo.git
  const https = remoteUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
  if (https) return https[1];

  return null; // Non-GitHub remote — projectId stays null
}
```

- Runs `git remote get-url origin` in the session's working directory
- If no git remote or non-GitHub remote: `projectId` is null, `projectPathHash` is used as fallback
- The `projectId` is set once at session start and never changes (COALESCE merge)

### Multi-Device Concurrent Sync

When 3+ devices sync simultaneously:

```
Device A pushes session X (_version 1 → 2) ✓
Device B pushes session X (_version 1 → 2) ✗ conflict
Device C pushes session X (_version 1 → 2) ✗ conflict
```

- Device B and C receive conflict responses with the server's current state (Device A's write)
- Each merges independently using the resolution table above
- Device B retries with `_version 2 → 3`, Device C retries with `_version 2 → 3`
- One succeeds, the other gets another conflict → resolves in the next retry
- Maximum 3 retries prevents infinite loops; remaining conflicts are resolved on next sync cycle

Since merges are commutative (MAX, MIN, COALESCE, UNION), the final state is the same regardless of write order.

### Consistency Guarantees

- **Sync push:** strongly consistent (DynamoDB conditional writes)
- **Sync pull:** eventually consistent (DynamoDB reads default to eventually consistent; acceptable since data is append-mostly)
- **Real-time subscriptions:** at-most-once delivery (AppSync WebSocket); missed events caught by next pull
- **Overall:** eventual consistency across devices, with convergence guaranteed by commutative merge operations

## Local SQLite Preserved

The existing offline workflow is unchanged:

```
~/.claude/projects/*.jsonl → collect → local SQLite → report/dashboard
```

Sync is an **additional** step that mirrors data to/from the cloud:

```
local SQLite ←→ AppSync ←→ DynamoDB ←→ other devices
```

Users who never enable sync continue using claude-stats exactly as before.

## Sync State Table (Local)

Added to local SQLite:

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  table_name    TEXT PRIMARY KEY,  -- 'sessions', 'messages', 'tags'
  last_push_at  INTEGER,           -- epoch ms
  last_pull_at  INTEGER,           -- epoch ms
  last_push_count INTEGER DEFAULT 0,
  last_pull_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_config (
  key   TEXT PRIMARY KEY,
  value TEXT
  -- Keys: 'appsync_endpoint', 'cognito_user_pool_id', 'cognito_client_id',
  --        'user_id', 'user_salt', 'enabled'
);
```

## CLI Commands

```bash
claude-stats sync                   # Push + pull all
claude-stats sync --push            # Push local changes to cloud
claude-stats sync --pull            # Pull remote changes to local
claude-stats sync --status          # Show sync state (last sync times, pending items)
claude-stats sync --setup           # Configure AppSync endpoint + Cognito auth
claude-stats sync --disconnect      # Remove cloud connection, keep local data
```

## SPA Real-Time

The web SPA uses AppSync subscriptions for live updates:

```typescript
import { generateClient } from "aws-amplify/api";

const client = generateClient();

// Subscribe to session syncs from other devices
const sub = client.graphql({
  query: onSessionSynced,
  variables: { userId: currentUser.userId },
}).subscribe({
  next: ({ data }) => queryClient.invalidateQueries(["sessions"]),
  error: (err) => console.warn("Subscription error, will reconnect:", err),
});
```

This means the SPA dashboard updates in real-time when a user syncs from CLI or VS Code on another device.

## Bandwidth & Cost

Typical user profile:
- ~50 sessions/day x 365 = ~18K sessions/year
- Each session record: ~500 bytes
- Annual sync payload: ~9 MB

At AppSync pricing ($4/million queries): negligible cost even at scale.

DynamoDB cost (on-demand):
- 18K writes/year x $1.25/million WCU = ~$0.02/year per user
- Read-heavy dashboard queries are more frequent but still negligible
