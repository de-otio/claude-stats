# Option 2: DynamoDB (Middle Ground)

**How it works:** Store sessions/messages in DynamoDB tables. Each device writes directly. DynamoDB handles concurrent writes with conditional expressions. Optionally use DynamoDB Streams + Lambda for push notifications.

## Implementation sketch

1. DynamoDB table: `PK = user_id`, `SK = session_id` (or `message_uuid`)
2. Each device writes new records with conditional puts (don't overwrite existing)
3. Each device queries for records newer than its last sync timestamp
4. DynamoDB Streams can trigger Lambda to push notifications via SNS/SQS

## Pros

- Managed, serverless, scales automatically
- Conditional writes provide basic conflict avoidance
- DynamoDB Streams enable near-real-time sync if desired
- Generous free tier (25 GB, 25 WCU/25 RCU always free)

## Cons

- More infrastructure to manage (tables, IAM, optional Lambda)
- No built-in client-side offline queue
- Query patterns must be designed upfront (partition/sort key schema)
- Still need to write sync orchestration code

## Cost

Free tier covers small usage easily. On-demand: $1.25/M writes, $0.25/M reads.

## Complexity

Medium. ~500-800 lines of sync code plus CloudFormation/CDK for infra.

## Best for

Multi-user support, structured queries, or when you want a real database backend.
