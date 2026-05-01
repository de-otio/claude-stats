# 15 — Testing Strategy

Practical testing approach for a low-cost, non-critical application. Focus on the areas most likely to break.

## Test Pyramid

```
         ┌─────────┐
         │  E2E    │  Few — magic link flow, sync round-trip
         │  (2-3)  │
        ┌┴─────────┴┐
        │Integration │  Medium — resolvers against local DynamoDB
        │ (20-30)    │
       ┌┴────────────┴┐
       │  Unit Tests   │  Many — conflict resolution, aggregation, auth logic
       │  (100+)       │
       └───────────────┘
```

## Unit Tests

Run locally with Vitest. No AWS resources needed.

### What to Unit Test

| Area | Tests | Priority |
|------|-------|----------|
| Conflict resolution logic | MAX, MIN, COALESCE, UNION merge for every field | **Critical** — data correctness |
| Aggregation logic | Team stats computation from session data, share-level filtering | **Critical** — dashboard accuracy |
| HMAC accountId derivation | Deterministic output, salt independence, collision resistance | High |
| Input validation | Array size limits, field length limits, enum values | High |
| Auth challenge flow | Token generation, hash verification, rate limit counter logic | High |
| Permission checks | Role-based access for each resolver pattern | High |
| Streak calculation | Day counting, weekend grace, freeze tokens | Medium |
| Achievement triggers | Threshold checks, de-duplication | Medium |
| Cost estimation | Token-to-cost calculation accuracy | Medium |

### Example: Conflict Resolution Tests

```typescript
describe("session merge", () => {
  it("takes MAX of token counts", () => {
    const local = { inputTokens: 100, outputTokens: 50 };
    const remote = { inputTokens: 80, outputTokens: 60 };
    const merged = mergeSession(local, remote);
    expect(merged.inputTokens).toBe(100);
    expect(merged.outputTokens).toBe(60);
  });

  it("takes MIN of firstTimestamp", () => {
    const local = { firstTimestamp: 1000 };
    const remote = { firstTimestamp: 900 };
    expect(mergeSession(local, remote).firstTimestamp).toBe(900);
  });

  it("COALESCEs parentSessionId (first non-null)", () => {
    const local = { parentSessionId: null };
    const remote = { parentSessionId: "abc" };
    expect(mergeSession(local, remote).parentSessionId).toBe("abc");
  });

  it("UNIONs tags", () => {
    const local = { models: ["opus"] };
    const remote = { models: ["sonnet"] };
    expect(mergeSession(local, remote).models).toEqual(["opus", "sonnet"]);
  });
});
```

## Integration Tests

Run against a local DynamoDB (docker) and mocked AppSync, or against the dev environment.

### Local DynamoDB Setup

```typescript
// vitest.setup.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const localDdb = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "local",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

// Create tables matching 04-data-model.md schema before each test suite
// Tear down after
```

### What to Integration Test

| Area | Tests | Notes |
|------|-------|-------|
| AppSync JS resolvers | Execute resolver code against local DynamoDB | Use `@aws-appsync/utils` test helpers |
| Sync mutations | Push sessions, verify DynamoDB state, check version conflicts | Full round-trip with conditional writes |
| Team stats aggregation | Write sessions, trigger aggregation, verify TeamStats output | Lambda handler with real DynamoDB |
| Authorization | Verify resolvers reject unauthorized requests | Mock JWT with different group claims |
| Account filtering | Sync sessions with different accountIds, verify team stats only include shared accounts | Full data flow |
| Input validation | Verify oversized payloads are rejected | Edge cases at limits |

### Example: Sync Integration Test

```typescript
describe("syncSessions integration", () => {
  it("writes sessions and returns SyncResult", async () => {
    const input = [buildSession({ sessionId: "s1", inputTokens: 100 })];
    const result = await invokeSyncResolver(mockContext("user1"), input);
    expect(result.itemsWritten).toBe(1);

    const stored = await getItem("SyncedSessions", { userId: "user1", sessionId: "s1" });
    expect(stored.inputTokens).toBe(100);
    expect(stored._version).toBe(1);
  });

  it("returns conflict on version mismatch", async () => {
    // Write version 1
    await invokeSyncResolver(mockContext("user1"), [buildSession({ sessionId: "s1", _version: 0 })]);
    // Try to write with same expected version
    const result = await invokeSyncResolver(mockContext("user1"), [
      buildSession({ sessionId: "s1", _version: 0, inputTokens: 200 }),
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].serverVersion).toBe(1);
  });
});
```

## End-to-End Tests

Minimal E2E tests run against the dev environment in CI. These verify the full stack works together.

### E2E Test Cases

| Test | Steps | Verifies |
|------|-------|----------|
| Magic link auth flow | Request magic link → extract token from SES (via test helper) → verify → get JWT | Auth pipeline end-to-end |
| Sync round-trip | Auth → push sessions → query sessions → verify data | Sync pipeline end-to-end |
| Team dashboard | Auth → create team → join team → sync sessions → query dashboard → verify stats | Full team flow |

### SES Test Helper

In dev, magic link emails go to SES with a verified test domain. The E2E test reads the email:

```typescript
// Use SES v2 GetMessage or configure SES to deliver to S3 in dev
// Parse the magic link token from the email body
async function getLatestMagicLinkToken(email: string): Promise<string> {
  // In dev: SES → S3 bucket rule, read latest object for the email
  // Parse HTML body, extract token from verify URL
}
```

## Load Testing

Not needed for initial launch (expected <50 users). If the user base grows significantly:

### Lightweight Load Test (k6)

```javascript
// Simulate 50 users syncing simultaneously (Monday morning scenario)
export const options = {
  scenarios: {
    sync_burst: {
      executor: "shared-iterations",
      vus: 50,
      iterations: 50,
      maxDuration: "2m",
    },
  },
};

export default function () {
  // Auth → push 25 sessions → verify response
}
```

**Key metric:** Verify aggregate-stats Lambda stays within reserved concurrency and DLQ remains empty during burst.

## CI/CD Integration

```
PR → Unit tests (Vitest, ~30s)
     └── Must pass to merge

main push → Unit tests
          → CDK synth (validates infrastructure)
          → Deploy dev
          → Integration tests against dev DynamoDB (~2 min)
          → E2E tests against dev (~3 min)
          → Manual approval → Deploy prod
```

### Test Commands

```bash
# Unit tests (local, fast)
npm test

# Integration tests (requires local DynamoDB)
docker run -d -p 8000:8000 amazon/dynamodb-local
npm run test:integration

# E2E tests (requires deployed dev environment)
npm run test:e2e -- --env=dev

# CDK synth validation
cd infra && npx cdk synth --all -c env=dev
```

## What We Don't Test

Given the low-cost, non-critical nature:
- **No performance/SLA testing** — no latency SLOs to validate
- **No chaos engineering** — single-region, no failover to test
- **No security penetration testing** — WAF + Cognito provide baseline; manual review sufficient
- **No cross-browser testing** — modern browsers only, Tremor handles compatibility
