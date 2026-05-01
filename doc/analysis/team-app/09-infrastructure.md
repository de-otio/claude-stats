# 09 — Infrastructure (CDK)

All infrastructure managed with AWS CDK in TypeScript. No Amplify CLI.

## CDK App Structure

```
infra/
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/
│   ├── stacks/
│   │   ├── auth-stack.ts         # Cognito + WAF + magic link Lambdas
│   │   ├── api-stack.ts          # AppSync + resolvers + Lambda functions
│   │   ├── data-stack.ts         # DynamoDB tables + GSIs
│   │   ├── dns-stack.ts           # Route 53 hosted zone + ACM certificate
│   │   ├── frontend-stack.ts     # S3 + CloudFront + SPA deployment
│   │   ├── mcp-stack.ts          # Bedrock AgentCore MCP runtime
│   │   └── monitoring-stack.ts   # CloudWatch dashboards + alarms
│   ├── constructs/
│   │   ├── magic-link-auth.ts    # L3 construct: Cognito + Lambdas + KMS
│   │   ├── team-api.ts           # L3 construct: team-related resolvers
│   │   └── sync-api.ts           # L3 construct: sync-related resolvers
│   └── config/
│       ├── types.ts              # EnvironmentConfig interface
│       ├── dev.ts                # Dev environment config
│       └── prod.ts               # Prod environment config
├── lambda/
│   ├── auth/
│   │   ├── define-challenge.ts
│   │   ├── create-challenge.ts
│   │   ├── verify-challenge.ts
│   │   ├── pre-signup.ts
│   │   └── pre-token-generation.ts  # Injects group claims into JWT
│   ├── api/
│   │   ├── team-dashboard.ts
│   │   ├── aggregate-stats.ts    # Triggered by DynamoDB Streams + EventBridge
│   │   ├── challenge-scoring.ts
│   │   ├── inter-team-scoring.ts # Triggered by EventBridge (hourly during active challenges)
│   │   ├── validate-logo.ts      # Triggered by S3 event (team logo upload)
│   │   └── achievement-check.ts
│   └── mcp/
│       └── server.ts
├── graphql/
│   ├── schema.graphql
│   └── resolvers/
│       └── js/                   # AppSync JS resolvers (preferred over VTL)
├── cdk.json
├── package.json
└── tsconfig.json
```

## Stacks

### AuthStack

```typescript
export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    // Reads from SSM: /{prefix}/data/table-arns/magicLinkTokens
    //
    // Cognito User Pool with custom auth triggers:
    //   - DefineAuthChallenge, CreateAuthChallenge, VerifyAuthChallenge
    //   - PreSignUp (domain restriction)
    //   - PreTokenGeneration (group claims injection)
    //
    // WAF WebACL with rate limiting rules (attached to Cognito)
    // KMS key for magic link HMAC signing (auto-rotation enabled)
    // SES email identity for magic link delivery
    // Lambda functions for auth challenge flow (NodejsFunction, bundled with esbuild)
    //
    // Cognito config:
    //   - ALLOW_CUSTOM_AUTH only (no password auth)
    //   - Email as required unique alias
    //   - Access token TTL: 1h, Refresh token TTL: 30d
    //
    // Publishes to SSM (all under /{prefix}/auth/):
    //   user-pool-id         — Cognito User Pool ID
    //   user-pool-arn        — Cognito User Pool ARN
    //   spa-client-id        — SPA User Pool Client ID
    //   mcp-client-id        — MCP User Pool Client ID
    //   cognito-domain       — Cognito custom domain (if configured)
  }
}
```

### DataStack

```typescript
export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    // All DynamoDB tables with GSIs (see 04-data-model.md)
    //
    // All tables:
    //   billingMode: PAY_PER_REQUEST
    //   encryption: TABLE_DEFAULT (AWS-owned key) for dev, CUSTOMER_MANAGED for prod
    //   removalPolicy: RETAIN for prod, DESTROY for dev
    //   pointInTimeRecovery: enabled for prod
    //   deletionProtection: enabled for prod
    //
    // TTL enabled on:
    //   magicLinkTokens.expiresAt
    //   syncedMessages.expiresAt
    //   teamStats.expiresAt
    //   challenges.expiresAt
    //   interTeamChallenges.expiresAt
    //
    // DynamoDB Streams enabled on syncedSessions (for aggregation Lambda trigger)
    //
    // Publishes to SSM (all under /{prefix}/data/):
    //   table-arns/{tableName}  — ARN for each table (used by other stacks for IAM grants)
    //   table-names/{tableName} — physical name for each table
    //   synced-sessions-stream-arn — DynamoDB Streams ARN for aggregation trigger
  }
}
```

### ApiStack

```typescript
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    // Reads from SSM:
    //   /{prefix}/auth/user-pool-id
    //   /{prefix}/data/table-arns/* (for resolver data sources and IAM grants)
    //   /{prefix}/data/synced-sessions-stream-arn (for aggregation Lambda trigger)
    //
    // AppSync GraphQL API
    //   Primary auth: AMAZON_COGNITO_USER_POOLS
    //   Additional auth: AWS_IAM (for Lambda → AppSync and MCP → AppSync)
    //
    // JS resolvers for simple CRUD (preferred over VTL)
    // Lambda resolvers for complex operations (team dashboard, aggregation, challenges)
    //
    // WAF WebACL attached to AppSync (separate from Cognito WAF)
    //   Blanket rate limit: 100 mutation requests per IP per 5 min (catch-all)
    //   Per-mutation limits (lower thresholds) defined in AuthStack WAF rules
    //   Both layers apply — the stricter limit wins per request
    //   AWS managed rules (IP reputation, known bots)
    //
    // DynamoDB Stream trigger:
    //   syncedSessions stream → aggregate-stats Lambda → refreshTeamStats
    //
    // Lambda configuration (all functions):
    //   timeout: 30s (auth Lambdas: 10s, aggregate-stats: 60s)
    //   memorySize: 256 MB (aggregate-stats: 512 MB)
    //   runtime: Node.js 20.x
    //
    // aggregate-stats Lambda (stream-triggered):
    //   reservedConcurrentExecutions: config.lambdaReservedConcurrency.aggregateStats
    //   retryAttempts: 2 (DynamoDB Streams event source)
    //   bisectBatchOnFunctionError: true (isolate bad records)
    //   maxBatchingWindow: 5 seconds (batch stream records for efficiency)
    //   onFailure: SQS dead-letter queue (preserves failed events for investigation)
    //
    // aggregate-stats Lambda logic:
    //   1. Receives DynamoDB Stream event (INSERT/MODIFY on SyncedSessions)
    //   2. For each changed session:
    //      a. Look up user's team memberships (TeamMemberships table, GSI by userId)
    //      b. For each team: check sharedAccounts includes session's accountId
    //      c. Read user's shareLevel for that team
    //   3. Group sessions by (teamId, period, userId)
    //   4. Compute aggregates: SUM tokens, COUNT sessions/prompts, MAX velocity
    //   5. Compute projectBreakdown: group by projectId, SUM sessions/prompts/cost per project
    //      - Sessions with null projectId are grouped under "(unlinked)"
    //      - projectBreakdown is omitted entirely if shareLevel = "minimal"
    //   6. Write TeamStats item with conditional update (idempotent via computedAt)
    //   7. Call refreshTeamStats mutation (IAM auth) to trigger subscriptions
    //
    // DLQ: SQS queue with 14-day retention, alarm on message count > 0
    //
    // inter-team-scoring Lambda (EventBridge-triggered):
    //   timeout: 60s, memorySize: 256 MB
    //   EventBridge rule: rate(1 hour), enabled only when active inter-team challenges exist
    //     (Lambda checks InterTeamChallenges GSI for status="active" and skips if none)
    //   retryAttempts: 2
    //   onFailure: same DLQ as aggregate-stats (shared)
    //   Logic:
    //     1. Query InterTeamChallenges GSI (PK="active")
    //     2. For each active challenge:
    //        a. For each participating team: query TeamStats for the challenge period
    //        b. Compute team-level metric (normalized per active member count)
    //        c. Rank teams by score descending; ties broken by earlier join time
    //        d. Update InterTeamChallenges.teams map with new scores and ranks
    //     3. Auto-complete challenges past endTime (set status="completed")
    //     4. For completed challenges: call completeInterTeamChallenge mutation (IAM auth)
    //   Status transitions: "pending" → "active" at startTime; "active" → "completed" at endTime
    //   Enum case: DynamoDB stores lowercase ("pending"), GraphQL resolver converts to UPPERCASE (PENDING)
    //
    // Team logos S3 bucket:
    //   bucketName: {prefix}-team-logos
    //   blockPublicAccess: BLOCK_ALL (served via CloudFront OAC)
    //   lifecycle: expire objects > 1 year (stale logos)
    //   S3 event notification → validate-logo Lambda (on PutObject)
    //   CloudFront distribution with OAC for public read
    //
    // validate-logo Lambda:
    //   Triggered by S3 PutObject on team-logos bucket
    //   Validates: file size ≤ 256 KB, content-type is image/png|svg|jpeg, dimensions ≤ 512x512
    //   On success: updates Teams.logoUrl with CloudFront URL
    //   On failure: deletes the S3 object
    //
    // Publishes to SSM (all under /{prefix}/api/):
    //   graphql-endpoint    — AppSync GraphQL URL
    //   graphql-api-id      — AppSync API ID
    //   graphql-api-arn     — AppSync API ARN (for IAM grants)
    //   dlq-url             — aggregate-stats DLQ URL (for monitoring)
    //   team-logos-bucket   — S3 bucket name for team logos
    //   team-logos-cdn-url  — CloudFront URL for team logos
  }
}
```

### DnsStack

Created only when `config.domainName` is set. Creates a dedicated Route 53 hosted zone for the app and delegates from the parent zone.

```typescript
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    // App hosted zone: e.g. "stats.acme.com"
    //   This zone owns all DNS records for the app
    //   Isolated from the parent zone — the app can manage its own records
    //   without needing write access to the parent zone
    //
    // NS delegation in parent zone:
    //   Looks up parent zone by config.parentZoneId
    //   Creates NS record in parent zone pointing to the app zone's name servers
    //   This is the only record written to the parent zone
    //
    // ACM certificate:
    //   DnsValidatedCertificate for config.domainName
    //   Validated via DNS (CNAME record auto-created in the app zone)
    //   Region: us-east-1 (required for CloudFront)
    //   Auto-renewed by ACM — no manual rotation
    //
    // Cognito custom domain (optional):
    //   auth.stats.acme.com → Cognito hosted UI
    //   CNAME record in the app zone
    //
    // Publishes to SSM (all under /{prefix}/dns/):
    //   hosted-zone-id      — Route 53 hosted zone ID
    //   hosted-zone-name    — Route 53 hosted zone name
    //   certificate-arn     — ACM certificate ARN
  }
}
```

**Why a separate zone?**
- The CDK deployment role only needs `route53:*` on the app zone, not the parent zone (except for the one-time NS delegation)
- Multiple environments can have independent zones (e.g., `stats-dev.acme.com`, `stats.acme.com`)
- If the app is torn down, deleting the app zone cleanly removes all its records without touching the parent

### FrontendStack

```typescript
export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    // Reads from SSM:
    //   /{prefix}/api/graphql-endpoint
    //   /{prefix}/auth/user-pool-id, /{prefix}/auth/spa-client-id
    //   /{prefix}/dns/hosted-zone-id, /{prefix}/dns/certificate-arn (if domain configured)
    //
    // S3 bucket:
    //   blockPublicAccess: BLOCK_ALL
    //   encryption: S3_MANAGED
    //   removalPolicy: DESTROY (static assets are rebuilt from source)
    //   autoDeleteObjects: true (for clean stack deletion)
    //
    // CloudFront distribution:
    //   OAC (Origin Access Control) for S3
    //   SPA routing: custom error responses (403/404 → /index.html, status 200)
    //   Custom domain + ACM certificate from DnsStack (if configured)
    //   Route 53 A/AAAA alias records in app zone → CloudFront distribution
    //   Security headers via response headers policy
    //
    // BucketDeployment from built SPA assets
    //
    // Publishes to SSM (all under /{prefix}/frontend/):
    //   distribution-url    — CloudFront distribution URL
    //   distribution-id     — CloudFront distribution ID (for cache invalidation)
  }
}
```

### McpStack

```typescript
export class McpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: McpStackProps) {
    // Reads from SSM:
    //   /{prefix}/api/graphql-endpoint, /{prefix}/api/graphql-api-arn
    //   /{prefix}/auth/user-pool-id, /{prefix}/auth/mcp-client-id
    //
    // ECR repository for MCP server container (ARM64)
    // Bedrock AgentCore Runtime (see 08-mcp-server.md)
    // AgentCore Gateway with Cognito OAuth2
    // IAM role for MCP server:
    //   - appsync:GraphQL on api (query + mutation)
    //   - No direct DynamoDB access (all data via AppSync)
    //
    // Publishes to SSM (all under /{prefix}/mcp/):
    //   gateway-url     — AgentCore Gateway endpoint for MCP clients
  }
}
```

### MonitoringStack

See [14-monitoring.md](14-monitoring.md) for the full observability design.

```typescript
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    // Reads from SSM:
    //   /{prefix}/api/graphql-api-id, /{prefix}/api/dlq-url
    //   /{prefix}/data/table-names/* (for CloudWatch metric dimensions)
    //
    // CloudWatch Dashboard:
    //   - AppSync latency, errors, requests
    //   - DynamoDB consumed capacity, throttled requests
    //   - Lambda duration, errors, concurrent executions
    //   - Cognito sign-in success/failure rates
    //   - DynamoDB Streams iterator age (aggregate-stats Lambda)
    //   - Estimated charges (AWS/Billing namespace)
    //
    // Alarms (prod only):
    //   - AppSync 5xx error rate > 1% for 5 min
    //   - Lambda error rate > 5% for 5 min
    //   - DynamoDB throttled requests > 0 for 5 min
    //   - WAF blocked requests spike
    //   - DynamoDB Streams iterator age > 5 min
    //   - Aggregate-stats DLQ messages > 0
    //   - Estimated monthly charges > budget threshold (see 13-cost-protection.md)
    //
    // SNS topic for alarm notifications (email from config)
    //
    // Log retention: per-environment (7d dev, 90d prod)
  }
}
```

## Cross-Stack Communication via SSM

Stacks communicate through SSM Parameter Store rather than construct props or CloudFormation exports. Each producing stack writes its outputs to a well-known SSM path; consuming stacks read at deploy time via `ssm.StringParameter.valueForStringParam()`.

### SSM Parameter Namespace

All parameters live under `/${prefix}/`:

```
/ClaudeStats-prod/
├── data/
│   ├── table-arns/userProfiles
│   ├── table-arns/teams
│   ├── table-arns/teamMemberships
│   ├── table-arns/syncedSessions
│   ├── table-arns/syncedMessages
│   ├── table-arns/teamStats
│   ├── table-arns/achievements
│   ├── table-arns/challenges
│   ├── table-arns/interTeamChallenges
│   ├── table-arns/magicLinkTokens
│   ├── table-names/...              (same keys as above)
│   └── synced-sessions-stream-arn
├── auth/
│   ├── user-pool-id
│   ├── user-pool-arn
│   ├── spa-client-id
│   ├── mcp-client-id
│   └── cognito-domain
├── api/
│   ├── graphql-endpoint
│   ├── graphql-api-id
│   ├── graphql-api-arn
│   ├── dlq-url
│   ├── team-logos-bucket
│   └── team-logos-cdn-url
├── dns/
│   ├── hosted-zone-id
│   ├── hosted-zone-name
│   └── certificate-arn
├── mcp/
│   └── gateway-url
└── frontend/
    ├── distribution-url
    └── distribution-id
```

### Why SSM over construct props?

| Concern | Construct props | SSM parameters |
|---------|----------------|----------------|
| Stack coupling | Tight — producer and consumer must be in the same CDK app and deploy together | Loose — stacks can be deployed independently |
| Deletion order | Deleting a producer stack fails if consumers reference its outputs | No dependency — SSM params persist independently |
| Refactoring | Renaming a stack or splitting it requires updating all consumers | Consumers read a stable SSM path, unaffected by stack restructuring |
| Cross-app access | Not possible | Any stack or script in the same account/region can read the params |
| Debugging | Values hidden inside CloudFormation | `aws ssm get-parameters-by-path --path /ClaudeStats-prod/` shows all values |

### Stack Dependencies

Stacks still declare explicit deployment order dependencies. Each stack receives only `{ env, config }` as props — all resource references are resolved from SSM at deploy time.

```typescript
// In bin/app.ts
const data = new DataStack(app, `${prefix}-Data`, { env, config });

const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });
auth.addDependency(data);  // Auth Lambda needs MagicLinkTokens table ARN from SSM

const api = new ApiStack(app, `${prefix}-Api`, { env, config });
api.addDependency(auth);   // Needs user-pool-id for AppSync auth
api.addDependency(data);   // Needs table ARNs for resolvers + stream ARN for trigger

if (config.domainName && config.parentZoneName) {
  const dns = new DnsStack(app, `${prefix}-Dns`, { env, config });
  // No dependency on other stacks — DNS is standalone
}

const frontend = new FrontendStack(app, `${prefix}-Frontend`, { env, config });
frontend.addDependency(api);  // Needs graphql-endpoint, user-pool-id, spa-client-id from SSM
// If DNS is configured, frontend reads dns/* SSM params (deploy DNS stack first)

if (config.mcpEnabled) {
  const mcp = new McpStack(app, `${prefix}-Mcp`, { env, config });
  mcp.addDependency(api);  // Needs graphql-endpoint, graphql-api-arn from SSM
  // Reads auth/user-pool-id, auth/mcp-client-id from SSM
}

const monitoring = new MonitoringStack(app, `${prefix}-Monitoring`, { env, config });
monitoring.addDependency(api);   // Needs api/* SSM params
monitoring.addDependency(data);  // Needs data/table-names/* for CloudWatch dimensions
```

### SSM Parameter Helper

Each stack uses a shared helper to write and read parameters with consistent naming:

```typescript
// infra/lib/ssm-params.ts
export function putParam(stack: cdk.Stack, prefix: string, key: string, value: string) {
  new ssm.StringParameter(stack, `Param-${key.replace(/\//g, "-")}`, {
    parameterName: `/${prefix}/${key}`,
    stringValue: value,
  });
}

export function getParam(stack: cdk.Stack, prefix: string, key: string): string {
  return ssm.StringParameter.valueForStringParam(stack, `/${prefix}/${key}`);
}
```

## Key CDK Decisions

| Decision | Rationale |
|----------|-----------|
| Separate stacks per concern | Independent deployment, clear blast radius |
| `NodejsFunction` for all Lambdas | Auto-bundling with esbuild, TypeScript support |
| DynamoDB on-demand billing | Unpredictable usage patterns, no capacity planning |
| AppSync JS resolvers preferred | TypeScript-like syntax, testable, avoids VTL pain |
| No Amplify CLI anywhere | Full CDK control over all resources |
| SSM parameters over construct props | Loose coupling, independent deployment, easy debugging, no export deletion issues |
| Customer-managed KMS in prod | Required for compliance; AWS-owned key in dev to reduce cost |
| RemovalPolicy.RETAIN for prod data | Prevents accidental data loss on stack deletion |
| Separate Cognito clients for SPA and MCP | Different auth flows, scopes, and callback URLs |
| Dedicated Route 53 zone per app | Isolates app DNS from parent zone; clean teardown; least-privilege IAM |

## IAM Least Privilege

Each Lambda function gets a scoped IAM role:

| Lambda | DynamoDB Access | Other |
|--------|----------------|-------|
| PreSignUp | SSM:GetParameter (`/claude-stats/allowed-domains`) | — |
| CreateAuthChallenge | MagicLinkTokens (read/write) | SES:SendEmail, KMS:Sign |
| VerifyAuthChallenge | MagicLinkTokens (read/write) | KMS:Verify |
| PreTokenGeneration | — (reads from Cognito context) | — |
| aggregate-stats | SyncedSessions (read), TeamStats (write), TeamMemberships (read) | AppSync:GraphQL (for subscriptions) |
| team-dashboard | TeamStats (read), TeamMemberships (read), Achievements (read), Challenges (read) | — |
| challenge-scoring | Challenges (read/write), TeamStats (read) | — |
| inter-team-scoring | InterTeamChallenges (read/write), TeamStats (read) | — |
| validate-logo | Teams (write: logoUrl field only) | S3:GetObject, S3:DeleteObject on team-logos bucket |
| achievement-check | Achievements (write), SyncedSessions (read) | — |
