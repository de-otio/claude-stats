# 13 — Cost Protection

Low cost is the primary non-functional requirement. This is not a business-critical application — availability and DR are secondary to keeping AWS bills minimal.

## Design Philosophy

1. **Prevent runaway costs** — hard caps and circuit breakers on every scalable resource
2. **Detect anomalies early** — budget alerts before bills arrive
3. **Prefer throttling over spending** — it's better to degrade service than to overspend
4. **No idle costs** — everything serverless and pay-per-use

## AWS Budget

```typescript
// In MonitoringStack
new budgets.CfnBudget(this, "MonthlyBudget", {
  budget: {
    budgetName: `${prefix}-monthly`,
    budgetType: "COST",
    timeUnit: "MONTHLY",
    budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
  },
  notificationsWithSubscribers: [
    {
      notification: {
        notificationType: "ACTUAL",
        comparisonOperator: "GREATER_THAN",
        threshold: 50,    // 50% of budget
        thresholdType: "PERCENTAGE",
      },
      subscribers: [{ subscriptionType: "EMAIL", address: alarmEmail }],
    },
    {
      notification: {
        notificationType: "ACTUAL",
        comparisonOperator: "GREATER_THAN",
        threshold: 80,    // 80% of budget
        thresholdType: "PERCENTAGE",
      },
      subscribers: [{ subscriptionType: "EMAIL", address: alarmEmail }],
    },
    {
      notification: {
        notificationType: "FORECASTED",
        comparisonOperator: "GREATER_THAN",
        threshold: 100,   // Forecasted to exceed budget
        thresholdType: "PERCENTAGE",
      },
      subscribers: [{ subscriptionType: "EMAIL", address: alarmEmail }],
    },
  ],
});
```

Budget thresholds (from [12-environments.md](12-environments.md)):
- **Dev:** $20/month
- **Prod:** $50/month

## Lambda Cost Controls

### Reserved Concurrency

Every Lambda function has a reserved concurrency limit to prevent runaway scaling:

| Lambda | Timeout | Memory | Reserved Concurrency | Rationale |
|--------|---------|--------|---------------------|-----------|
| Auth Lambdas (5 functions) | 10s | 256 MB | 20 each | Auth is low-throughput; 20 concurrent is plenty |
| aggregate-stats | 60s | 512 MB | 10 (configurable) | Most critical to cap — triggered by streams |
| team-dashboard | 30s | 256 MB | 10 | Read-only, low frequency |
| challenge-scoring | 30s | 256 MB | 5 | Runs infrequently |
| achievement-check | 30s | 256 MB | 5 | Runs infrequently |

**Why reserved concurrency matters:** Without it, a burst of DynamoDB stream events could spawn hundreds of aggregate-stats Lambda invocations simultaneously. At $0.0000166667/GB-second, 100 concurrent Lambdas at 512 MB for 60 seconds = $0.05 per burst. Sustained, this adds up. The cap of 10 means at most 10 concurrent executions — excess stream events queue and are processed as capacity frees up.

### No Recursive Lambda Patterns

The architecture has no Lambda-to-Lambda call chains by design:
- aggregate-stats Lambda writes to TeamStats table (no stream on TeamStats)
- All other Lambdas write to DynamoDB directly or call AppSync
- The only stream trigger is SyncedSessions → aggregate-stats (one hop)

### Dead-Letter Queue

The aggregate-stats Lambda has an SQS DLQ for failed stream events:

```typescript
const dlq = new sqs.Queue(this, "AggregateStatsDLQ", {
  retentionPeriod: Duration.days(14),
  encryption: sqs.QueueEncryption.SQS_MANAGED,
});

// Alarm when DLQ receives messages
new cloudwatch.Alarm(this, "DLQAlarm", {
  metric: dlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

Without a DLQ, failed stream events retry until they expire (24 hours), burning Lambda compute. With a DLQ, failed events are captured after 2 retries and the Lambda stops processing them.

## DynamoDB Cost Controls

### On-Demand with TTL Cleanup

All tables use on-demand billing (no idle cost). TTL attributes automatically purge old data:

| Table | TTL Field | Retention |
|-------|-----------|-----------|
| MagicLinkTokens | expiresAt | 15 min (prod) |
| SyncedMessages | expiresAt | 1 year |
| TeamStats | expiresAt | 1 year |
| Challenges | expiresAt | 90 days |

### Per-User Write Throttling

To prevent a single user from generating excessive DynamoDB writes:

```javascript
// syncSessions resolver — per-user daily sync limit
export function request(ctx) {
  const items = ctx.args.input;
  if (items.length > 25) {
    util.error("Maximum 25 sessions per sync call", "ValidationError");
  }
  // Additional check: query user's daily sync count from a counter
  // Max 20 sync calls per user per day (= 500 sessions/day max)
  // Counter stored in UserProfiles as dailySyncCount + dailySyncDate
  // Reset when date changes
}
```

Limits:
- Max 25 sessions per `syncSessions` call (resolver-enforced)
- Max 100 messages per `syncMessages` call (resolver-enforced)
- Max 20 sync calls per user per day (500 sessions/day is far above normal usage of ~50/day)

### No Scan Operations

All access patterns use key conditions or GSI lookups — no table scans anywhere. This is verified in [04-data-model.md](04-data-model.md) access patterns.

## AppSync Cost Controls

AppSync pricing: $4/million queries, $2/million mutations, $0.08/million real-time connection minutes.

### WAF Rate Limiting

Two WAF WebACLs provide layered protection:

1. **Cognito WAF** — per-mutation limits on auth operations (see [02-authentication.md](02-authentication.md))
2. **AppSync WAF** — blanket 100 mutations per IP per 5 min, plus AWS managed rules

Both apply; the stricter limit wins for any given request.

### Subscription Limits

AppSync subscriptions cost money per connection-minute. Limits:
- SPA clients: maximum 4 concurrent subscriptions per session (team stats, achievements, challenges, cross-device sync)
- Subscriptions auto-disconnect on page navigation (React cleanup in useEffect)
- AppSync default connection timeout: 24 hours (then client reconnects)

## CloudFront / S3 Cost Controls

- S3 stores only build artifacts (~5 MB) — negligible storage cost
- CloudFront has AWS Shield Standard (free) for basic DDoS protection
- CloudFront caching reduces origin requests (SPA assets are immutable with content hashes)
- No Shield Advanced (cost: $3,000/month — far exceeds the entire app budget)

## Bedrock AgentCore (MCP) Cost Controls

The MCP server is a passthrough to AppSync — it does not invoke LLMs.

Cost is based on AgentCore compute (container runtime):
- Container is idle when no requests are active (scale-to-zero if supported)
- All data fetching goes through AppSync, which is WAF-protected
- The MCP gateway inherits Cognito auth — unauthenticated requests are rejected before reaching the container
- If AgentCore costs become significant, the MCP stack can be disabled via `config.mcpEnabled = false`

## SES Cost Controls

SES pricing: $0.10 per 1,000 emails.

- Magic link rate limit: 3 per email per hour (prod)
- WAF rate limit: 10 `InitiateAuth` per IP per 5 min
- SES sending quota: AWS default is 200/day for new accounts; request increase only as needed
- SES bounce/complaint rate monitored (high rates can trigger AWS suspension)

## Cost Estimation

Expected monthly costs for a team of 10 active users:

| Service | Estimate | Notes |
|---------|----------|-------|
| DynamoDB | $0.50 | On-demand, ~500 sessions/day total, reads for dashboard |
| AppSync | $0.10 | ~25K queries/month, ~5K mutations/month |
| Lambda | $0.20 | ~5K invocations/month, mostly short-running |
| Cognito | $0.50 | $0.0055/MAU after 50K free tier |
| SES | $0.01 | ~100 magic link emails/month |
| S3 + CloudFront | $0.50 | Minimal traffic, mostly cached |
| WAF | $6.00 | $5 WebACL + $1/rule (2 WebACLs) |
| KMS | $1.00 | $1/key/month |
| Secrets Manager | $0.40 | $0.40/secret/month |
| **Total** | **~$9/month** | Well within $50 budget |

At 100 users: ~$25/month. At 500 users: ~$60/month (may need budget increase).

## Emergency Cost Shutoff

If costs spike unexpectedly, manual intervention steps (see [16-operations.md](16-operations.md)):

1. Set aggregate-stats Lambda reserved concurrency to 0 (stops all processing)
2. Enable WAF "block all" rule on AppSync (stops all API traffic)
3. Disable MCP stack (`mcpEnabled: false`, redeploy)
4. Investigate root cause via CloudWatch logs and billing dashboard
