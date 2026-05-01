# 14 — Monitoring & Observability

Lightweight observability appropriate for a low-cost, non-critical application. No third-party tools — CloudWatch only.

## Structured Logging

All Lambda functions use a consistent JSON log format:

```typescript
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({
  serviceName: "claude-stats",
  logLevel: process.env.LOG_LEVEL ?? "INFO",
});

// Every log entry includes:
// - timestamp, level, service, function_name (automatic)
// - correlationId: AppSync requestId or DynamoDB stream eventID
// - userId: extracted from Cognito claims or stream record
```

### Correlation IDs

```typescript
// AppSync resolver Lambdas: use ctx.request.headers["x-amzn-requestid"]
// Stream-triggered Lambdas: use the DynamoDB stream eventID
// All downstream calls include the correlationId for tracing

logger.appendKeys({ correlationId, userId });
```

### Log Levels by Environment

| Environment | Default Level | Notes |
|-------------|--------------|-------|
| Dev | DEBUG | Full verbosity for development |
| Prod | INFO | Cost-effective; errors and key events only |

### What Gets Logged

| Event | Level | Fields |
|-------|-------|--------|
| Sync push received | INFO | userId, itemCount, batchNumber |
| Sync conflict | WARN | userId, sessionId, clientVersion, serverVersion |
| Aggregation started | INFO | teamId, period, triggerSource (stream/schedule/manual) |
| Aggregation completed | INFO | teamId, period, memberCount, durationMs |
| Auth rate limit hit | WARN | emailHash (SHA-256, not plaintext), requestCount |
| Permission denied | WARN | userId, action, teamId |
| Unhandled error | ERROR | full error with stack trace, correlationId |

### What Never Gets Logged

- Email addresses (only SHA-256 hashes)
- Account UUIDs
- Session content or file paths
- JWT tokens or secrets

## CloudWatch Dashboard

Single dashboard per environment with four widget rows:

### Row 1: API Health
- AppSync request count (query vs mutation vs subscription)
- AppSync latency (p50, p90, p99)
- AppSync 4xx and 5xx error rates
- WAF blocked request count

### Row 2: Compute
- Lambda invocation count (per function)
- Lambda error count (per function)
- Lambda duration (p50, p90 per function)
- Lambda concurrent executions (aggregate-stats specifically)

### Row 3: Data
- DynamoDB consumed read/write capacity (per table)
- DynamoDB throttled requests
- DynamoDB Streams iterator age (aggregate-stats)
- SQS DLQ message count (aggregate-stats DLQ)

### Row 4: Cost & Auth
- Estimated monthly charges (AWS/Billing metric)
- Cognito sign-in success/failure count
- SES send count, bounce rate, complaint rate

## Alarms

Alarms are prod-only (dev has no alarm email configured). All alarms notify via SNS → email.

### Critical Alarms (Immediate Attention)

| Alarm | Metric | Threshold | Evaluation | Action |
|-------|--------|-----------|------------|--------|
| API errors | AppSync 5xx rate | > 1% for 5 min | 1 of 1 | Check Lambda logs |
| Lambda failures | Error count | > 5% for 5 min | 1 of 1 | Check function logs |
| DLQ messages | SQS visible messages | > 0 | 1 of 1 | Inspect DLQ, check aggregate-stats logs |
| Cost spike | Estimated charges | > 80% of monthly budget | 1 of 1 | Review billing dashboard |

### Warning Alarms (Investigate When Convenient)

| Alarm | Metric | Threshold | Evaluation | Action |
|-------|--------|-----------|------------|--------|
| DynamoDB throttling | Throttled requests | > 0 for 5 min | 2 of 3 | Check hot partitions |
| Stream lag | Iterator age | > 5 min | 2 of 3 | Check aggregate-stats concurrency/errors |
| WAF spike | Blocked requests | > 100 in 5 min | 1 of 1 | Check WAF logs for attack pattern |
| SES bounce rate | Bounce % | > 5% | 1 of 1 | Check email validity, SES reputation |

### Alarm SNS Topic

```typescript
const alarmTopic = new sns.Topic(this, "AlarmTopic");
if (config.alarmEmailSsmPath) {
  const email = ssm.StringParameter.valueForStringParam(this, config.alarmEmailSsmPath);
  alarmTopic.addSubscription(new subscriptions.EmailSubscription(email));
}
```

## AWS X-Ray Tracing

Enabled on AppSync and Lambda for request-level tracing:

```typescript
// AppSync
const api = new appsync.GraphqlApi(this, "Api", {
  xrayEnabled: true,  // Traces resolver execution
});

// Lambda
new NodejsFunction(this, "AggregateStats", {
  tracing: lambda.Tracing.ACTIVE,  // Traces downstream calls (DynamoDB, AppSync)
});
```

X-Ray provides end-to-end request traces: AppSync resolver → Lambda → DynamoDB. Useful for debugging latency issues in the aggregation pipeline.

**Cost note:** X-Ray has a free tier of 100K traces/month. At expected volumes (~30K requests/month), this is free. If volumes grow, switch to `PASS_THROUGH` mode (samples only).

## Log Retention

| Environment | Retention | Monthly Cost |
|-------------|-----------|-------------|
| Dev | 7 days | ~$0 |
| Prod | 90 days | ~$0.50 (at expected log volume) |

## AppSync Request Logging

```typescript
const api = new appsync.GraphqlApi(this, "Api", {
  logConfig: {
    fieldLogLevel: appsync.FieldLogLevel.ERROR,  // Only errors (not ALL — too verbose/expensive)
    role: loggingRole,
  },
});
```

In dev, set to `ALL` for debugging. In prod, `ERROR` only to minimize CloudWatch Logs costs.

## Health Check

No dedicated health check endpoint — the app is serverless and doesn't need synthetic monitoring. If AppSync is responsive and Lambda errors are low, the system is healthy.

For manual verification:
```bash
# Quick smoke test
aws appsync list-graphql-apis --query 'graphqlApis[?name==`ClaudeStats-prod-Api`].uris'
```
