# Cross-Device Sync: AWS Options Analysis

claude-stats stores usage data in a local SQLite database (`~/.claude-stats/stats.db`). Users who work across multiple machines (e.g., laptop + desktop, work + personal) currently have no way to see unified stats. This analysis explores AWS services for cross-device sync, ordered from simplest to most luxurious.

## What needs to sync

| Data | Portable? | Notes |
|------|-----------|-------|
| Sessions & messages | Yes | Core usage data, keyed by session_id/UUID |
| Session tags | Yes | User-created labels |
| Usage windows | Yes | Cost tracking aggregates |
| File checkpoints | No | Device-specific (file paths, mtimes) |
| Collection state | No | Which local files have been imported |

## Options

| | S3 File Sync | DynamoDB | AppSync | Amplify DataStore |
|---|---|---|---|---|
| **Complexity** | Low | Medium | Medium-High | Low (dev) |
| **Real-time** | No (poll) | DIY (Streams) | Yes (WebSocket) | Yes (via AppSync) |
| **Offline** | DIY | DIY | SDK support | First-class |
| **Conflict resolution** | DIY | Conditional writes | 3 built-in strategies | 3 strategies + custom |
| **Infra to manage** | S3 bucket | DynamoDB table(s) | AppSync + DynamoDB | Amplify manages all |
| **Cost (low volume)** | ~$0/month | ~$0/month | ~$0-1/month | ~$0-1/month |
| **Lines of sync code** | ~200-400 | ~500-800 | ~300-500 | ~50-100 |
| **Auth required** | Optional | Yes (IAM/Cognito) | Yes (Cognito/API key) | Yes (Cognito) |

1. [S3 File-Based Sync](./01-s3-file-sync.md) -- Simplest. Export/import JSON files to S3.
2. [DynamoDB](./02-dynamodb.md) -- Middle ground. Managed database with optional Streams.
3. [AppSync + GraphQL](./03-appsync.md) -- Full-featured. Real-time subscriptions + conflict resolution.
4. [Amplify DataStore](./04-amplify-datastore.md) -- Most luxurious. Local-first with transparent sync.

## Recommendation

See [recommendation.md](./recommendation.md) for the suggested approach.
