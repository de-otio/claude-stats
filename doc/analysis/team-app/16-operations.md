# 16 — Operations

Lightweight operational procedures for a non-critical application. No on-call rotation — all issues handled during business hours.

## Deployment

### Standard Deployment

```bash
# Always diff first
cd infra && npx cdk diff --all -c env=prod

# Deploy (requires manual approval in pipeline for prod)
npx cdk deploy --all -c env=prod --require-approval broadening
```

### Rollback

CDK deployments use CloudFormation, which auto-rolls back on failure. If a deployment partially succeeds but causes issues:

```bash
# Check stack status
aws cloudformation describe-stacks --stack-name ClaudeStats-prod-Api --query 'Stacks[0].StackStatus'

# Roll back to previous Lambda code (fastest rollback)
aws lambda update-function-code --function-name ClaudeStats-prod-aggregate-stats \
  --s3-bucket <previous-asset-bucket> --s3-key <previous-asset-key>

# Full rollback: redeploy previous git commit
git checkout <previous-commit>
cd infra && npx cdk deploy --all -c env=prod
```

## Runbooks

### Cost Spike

**Trigger:** Budget alert email (50%, 80%, or forecasted 100% threshold).

1. Open AWS Billing Dashboard → Cost Explorer
2. Filter by service to identify the spike source
3. Common causes and responses:

| Cause | Response |
|-------|----------|
| DynamoDB high WCU | Check for user syncing massive data. Add per-user throttle if needed |
| Lambda high invocations | Check aggregate-stats concurrency. Reduce `reservedConcurrentExecutions` to 1 |
| AppSync high requests | Check WAF logs for abuse. Tighten rate limits if needed |
| CloudFront high requests | Check for DDoS. Enable geo-restriction or tighten WAF |

4. **Emergency shutoff** (stops all traffic, use only if costs are spiraling):
   ```bash
   # Pause aggregation
   aws lambda put-function-concurrency --function-name ClaudeStats-prod-aggregate-stats \
     --reserved-concurrent-executions 0

   # Block all AppSync traffic (add block-all WAF rule)
   # This is destructive — users will see errors
   ```

### Aggregate-Stats DLQ Messages

**Trigger:** DLQ alarm (messages > 0).

1. Check DLQ message count:
   ```bash
   aws sqs get-queue-attributes --queue-url <dlq-url> \
     --attribute-names ApproximateNumberOfMessages
   ```

2. Read a sample message to identify the failure:
   ```bash
   aws sqs receive-message --queue-url <dlq-url> --max-number-of-messages 1
   ```

3. Check aggregate-stats Lambda logs for the corresponding error:
   ```bash
   aws logs filter-log-events --log-group-name /aws/lambda/ClaudeStats-prod-aggregate-stats \
     --filter-pattern "ERROR" --start-time <epoch-ms>
   ```

4. Common causes:
   - **Bug in aggregation code** → fix, deploy, then replay DLQ messages
   - **DynamoDB throttling** → check consumed capacity; usually transient
   - **Malformed stream record** → delete the DLQ message (data will be caught up by daily EventBridge schedule)

5. Replay DLQ messages (after fixing the root cause):
   ```bash
   # Redrive DLQ messages back to the source
   aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <source-queue-arn>
   ```

### DynamoDB Stream Lag

**Trigger:** Iterator age alarm (> 5 minutes).

1. Check aggregate-stats Lambda metrics:
   - Concurrent executions near reserved limit → increase `reservedConcurrentExecutions` temporarily
   - High error rate → check logs for the error
   - High duration → check for inefficient queries (likely a code bug)

2. If the Lambda is healthy but overwhelmed:
   ```bash
   # Temporarily increase concurrency
   aws lambda put-function-concurrency --function-name ClaudeStats-prod-aggregate-stats \
     --reserved-concurrent-executions 20
   ```

3. Stream records expire after 24 hours. If lag exceeds 12 hours, the daily EventBridge catch-up will recompute stats, so data is not permanently lost — just delayed.

### WAF Blocking Spike

**Trigger:** WAF blocked requests alarm (> 100 in 5 min).

1. Check WAF sampled requests:
   ```bash
   aws wafv2 get-sampled-requests --web-acl-arn <acl-arn> --rule-metric-name <rule> \
     --scope REGIONAL --time-window '{"StartTime":"...","EndTime":"..."}'
   ```

2. Determine if it's a legitimate attack or a misconfigured client
3. If attack: consider adding IP-based block rule or tightening geo-restriction
4. If false positive: adjust rate limit thresholds in config and redeploy

### User Offboarding (Immediate)

When an employee leaves and needs immediate access revocation:

1. Disable the Cognito user:
   ```bash
   aws cognito-idp admin-disable-user --user-pool-id <pool-id> --username <email>
   ```

2. Sign out all sessions:
   ```bash
   aws cognito-idp admin-user-global-sign-out --user-pool-id <pool-id> --username <email>
   ```

3. Existing access tokens remain valid for up to 1 hour (Cognito limitation). For faster revocation, enable token revocation checking on the User Pool (adds latency to all requests).

4. Remove from teams (optional — can wait):
   ```bash
   # Via AppSync admin mutation or direct DynamoDB delete
   ```

### Account Deletion (GDPR / User Request)

The `deleteMyAccount` mutation performs a cascading delete:

1. **UserProfiles** — delete the user's profile record
2. **TeamMemberships** — delete all membership records (GSI query by userId)
3. **SyncedSessions** — delete all sessions (PK = userId)
4. **SyncedMessages** — delete all messages for user's sessions (requires batch: query sessions first, then delete messages per sessionId)
5. **Achievements** — delete all achievements (PK = userId)
6. **TeamStats** — delete all stats entries containing this userId (GSI query)
7. **Challenges** — delete all challenges where `createdBy = userId`. Active challenges created by this user are ended early (status set to `completed`); other participants' scores are preserved.
8. **InterTeamChallenges** — for challenges where `createdBy = userId`: if active, auto-complete; if pending, delete. The user's team remains as a participant in active/completed challenges (team-level data is preserved).
9. **Cognito** — delete the user from the User Pool

The delete is implemented as a Lambda resolver that processes each table sequentially with batch deletes. Due to the cascading nature, it may take 30-60 seconds for users with extensive history.

**Data that is NOT deleted:**
- Team-level aggregates in TeamStats that included this user's contributions are not retroactively recomputed. The user's individual stats rows are deleted, but the team totals remain as-is (they'll naturally update on next aggregation period).

## Backup & Recovery

### What's Protected

| Resource | Protection | Recovery |
|----------|-----------|----------|
| DynamoDB (prod) | Point-in-Time Recovery (PITR), RemovalPolicy.RETAIN | Restore to any point in last 35 days |
| DynamoDB (dev) | None | Disposable — redeploy + re-sync |
| S3 (SPA assets) | Rebuilt from source | Redeploy from git |
| Cognito users | No automated backup | Users re-register via magic link |
| Secrets Manager | Versioned | AWS-managed versioning |

### PITR Restore Procedure

If data corruption is detected:

```bash
# 1. Identify the table and approximate time before corruption
# 2. Restore to a new table
aws dynamodb restore-table-to-point-in-time \
  --source-table-name ClaudeStats-prod-SyncedSessions \
  --target-table-name ClaudeStats-prod-SyncedSessions-restored \
  --restore-date-time 2026-03-12T10:00:00Z

# 3. Verify restored data
# 4. Swap table references in CDK config (or rename tables)
# 5. Delete corrupted table after verification
```

### No Multi-Region / No Failover

This is a single-region (us-east-1) deployment with no cross-region replication. In the event of a regional AWS outage:
- **Impact:** Application is fully unavailable
- **Mitigation:** Local SQLite continues to work for data collection
- **Recovery:** Wait for AWS to restore the region; data in DynamoDB is durable and survives outages
- **Rationale:** Multi-region adds significant cost and complexity. For a non-critical internal tool, single-region is acceptable.

## Maintenance

### Periodic Tasks

| Task | Frequency | How |
|------|-----------|-----|
| Review AWS bill | Monthly | Cost Explorer, compare to budget |
| Check DLQ | Weekly (or on alarm) | SQS console or CLI |
| Review WAF logs | Monthly | Check for patterns, adjust rules |
| Update CDK dependencies | Monthly | `npm update`, test in dev first |
| Rotate magic link secret | Automatic (90 days) | Secrets Manager auto-rotation |
| Check Cognito Advanced Security reports | Monthly | Cognito console → Analytics |

### CDK Dependency Updates

```bash
# Update CDK and constructs
npm update aws-cdk-lib @aws-cdk/aws-bedrock-agentcore-alpha

# Always test in dev first
npx cdk diff --all -c env=dev
npx cdk deploy --all -c env=dev
npm run test:e2e -- --env=dev

# Then prod
npx cdk diff --all -c env=prod
# ... manual approval ... deploy
```

**Note:** `@aws-cdk/aws-bedrock-agentcore-alpha` is an alpha construct with no stability guarantees. Pin the version and review changelogs carefully before updating.
