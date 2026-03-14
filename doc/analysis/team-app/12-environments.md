# 12 — Environments

Two deployment environments: `dev` and `prod`. Configuration in TypeScript files, consumed by CDK stacks.

## Config Structure

```typescript
// infra/lib/config/types.ts

export interface EnvironmentConfig {
  envName: "dev" | "prod";
  account: string;              // AWS account ID
  region: string;               // AWS region

  // Auth
  allowedEmailDomains: string[];  // Initial seed — updated at runtime via SSM
  magicLinkTtlMinutes: number;
  magicLinkMaxRequestsPerHour: number;
  cognitoAdvancedSecurity: boolean;
  cognitoAccessTokenTtlMinutes: number;
  cognitoRefreshTokenTtlDays: number;

  // WAF
  wafRateLimitSignup: number;   // Requests per IP per 5 min
  wafRateLimitAuth: number;
  wafRateLimitJoinTeam: number;
  wafGeoRestriction: string[];  // ISO country codes to block, empty = allow all

  // Data
  dynamoDbEncryption: "AWS_OWNED" | "CUSTOMER_MANAGED";
  dynamoDbPointInTimeRecovery: boolean;
  dynamoDbDeletionProtection: boolean;
  dynamoDbRemovalPolicy: "RETAIN" | "DESTROY";

  // DNS & Frontend
  domainName: string | null;    // App subdomain, e.g. "stats.acme.com". null = CloudFront default
  parentZoneName: string | null;  // Parent hosted zone, e.g. "acme.com". Required if domainName is set
  parentZoneId: string | null;    // Route 53 hosted zone ID of parent zone (for NS delegation)

  // Branding
  branding: {
    primaryColor: string;           // Tailwind color name or hex, e.g. "indigo" or "#4F46E5"
    accentColor: string;            // Secondary accent, e.g. "emerald"
    logoUrl: string | null;         // URL to organization logo (S3 or external). Shown in nav bar.
    appTitle: string;               // e.g. "Acme Claude Stats". Default: "Claude Stats"
  };

  // MCP
  mcpEnabled: boolean;

  // Monitoring
  alarmEmailSsmPath: string | null;  // SSM path to alarm email (not hardcoded)
  logRetentionDays: number;

  // Cost protection (see 13-cost-protection.md)
  monthlyBudgetUsd: number;          // AWS Budget alert threshold
  lambdaReservedConcurrency: {       // Per-function concurrency caps
    aggregateStats: number;
  };

  // Secrets
  magicLinkHmacSecretArn: string | null;  // Secrets Manager ARN (created out-of-band)
}
```

## Dev Config

```typescript
// infra/lib/config/dev.ts

import { EnvironmentConfig } from "./types";

export const devConfig: EnvironmentConfig = {
  envName: "dev",
  account: process.env.CDK_DEV_ACCOUNT ?? "123456789012",
  region: process.env.CDK_DEV_REGION ?? "us-east-1",

  // Auth — permissive for testing
  allowedEmailDomains: ["acme.com", "acme.io", "example.com"],
  magicLinkTtlMinutes: 60,           // Longer TTL for dev convenience
  magicLinkMaxRequestsPerHour: 20,
  cognitoAdvancedSecurity: false,     // Save cost in dev
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,

  // WAF — relaxed
  wafRateLimitSignup: 50,
  wafRateLimitAuth: 100,
  wafRateLimitJoinTeam: 50,
  wafGeoRestriction: [],

  // Data — disposable in dev
  dynamoDbEncryption: "AWS_OWNED",
  dynamoDbPointInTimeRecovery: false,
  dynamoDbDeletionProtection: false,
  dynamoDbRemovalPolicy: "DESTROY",

  // DNS & Frontend
  domainName: null,                   // Use CloudFront default URL
  parentZoneName: null,
  parentZoneId: null,

  // Branding
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: null,
    appTitle: "Claude Stats (Dev)",
  },

  // MCP
  mcpEnabled: true,

  // Monitoring
  alarmEmailSsmPath: null,            // No alerts in dev
  logRetentionDays: 7,

  // Cost protection
  monthlyBudgetUsd: 20,
  lambdaReservedConcurrency: { aggregateStats: 5 },

  // Secrets
  magicLinkHmacSecretArn: null,       // Auto-generated in dev
};
```

## Prod Config

```typescript
// infra/lib/config/prod.ts

import { EnvironmentConfig } from "./types";

export const prodConfig: EnvironmentConfig = {
  envName: "prod",
  account: process.env.CDK_PROD_ACCOUNT ?? "987654321098",
  region: process.env.CDK_PROD_REGION ?? "us-east-1",

  // Auth — strict
  allowedEmailDomains: ["acme.com"],
  magicLinkTtlMinutes: 15,
  magicLinkMaxRequestsPerHour: 3,
  cognitoAdvancedSecurity: true,
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,

  // WAF — strict
  wafRateLimitSignup: 5,
  wafRateLimitAuth: 10,
  wafRateLimitJoinTeam: 10,
  wafGeoRestriction: [],              // Configure if needed

  // Data — protected
  dynamoDbEncryption: "CUSTOMER_MANAGED",
  dynamoDbPointInTimeRecovery: true,
  dynamoDbDeletionProtection: true,
  dynamoDbRemovalPolicy: "RETAIN",

  // DNS & Frontend
  domainName: "stats.acme.com",
  parentZoneName: "acme.com",
  parentZoneId: "Z0123456789ABCDEFGHIJ",  // Hosted zone ID of acme.com

  // Branding
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: "https://cdn.acme.com/logo.svg",  // Organization logo for nav bar
    appTitle: "Acme Claude Stats",
  },

  // MCP
  mcpEnabled: true,

  // Monitoring
  alarmEmailSsmPath: "/claude-stats/prod/alarm-email",
  logRetentionDays: 90,

  // Cost protection
  monthlyBudgetUsd: 50,
  lambdaReservedConcurrency: { aggregateStats: 10 },

  // Secrets
  magicLinkHmacSecretArn: "arn:aws:secretsmanager:us-east-1:987654321098:secret:claude-stats/magic-link-hmac",
};
```

## Secrets Management

| Secret | Storage | Rotation |
|--------|---------|----------|
| Magic link HMAC key | Secrets Manager | Auto-rotation every 90 days |
| Cognito client secrets | Cognito (managed) | N/A (auto-managed) |
| ACM certificate | Created by DnsStack (DNS-validated) | Auto-renewed by ACM |
| Alarm email | SSM Parameter Store | N/A (static reference) |
| Allowed email domains | SSM Parameter Store | Updated via admin API |
| KMS key for DynamoDB | KMS (customer-managed) | Auto-rotation enabled |

Secrets are never hardcoded in config files. The config references SSM paths or Secrets Manager ARNs. CDK stacks resolve them at deploy time or runtime (Lambda cold start).

## CDK App Entry Point

```typescript
// infra/bin/app.ts

import * as cdk from "aws-cdk-lib";
import { devConfig } from "../lib/config/dev";
import { prodConfig } from "../lib/config/prod";
import { AuthStack } from "../lib/stacks/auth-stack";
import { DataStack } from "../lib/stacks/data-stack";
import { ApiStack } from "../lib/stacks/api-stack";
import { FrontendStack } from "../lib/stacks/frontend-stack";
import { McpStack } from "../lib/stacks/mcp-stack";
import { DnsStack } from "../lib/stacks/dns-stack";
import { MonitoringStack } from "../lib/stacks/monitoring-stack";

const app = new cdk.App();
const envName = app.node.tryGetContext("env") as "dev" | "prod" ?? "dev";
const config = envName === "prod" ? prodConfig : devConfig;

const env = { account: config.account, region: config.region };
const prefix = `ClaudeStats-${config.envName}`;

// All cross-stack references resolved via SSM parameters (see 09-infrastructure.md)
// Each stack receives only { env, config } — resource ARNs/IDs read from SSM at deploy time

const data = new DataStack(app, `${prefix}-Data`, { env, config });

const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });
auth.addDependency(data);

const api = new ApiStack(app, `${prefix}-Api`, { env, config });
api.addDependency(auth);
api.addDependency(data);

if (config.domainName && config.parentZoneName) {
  new DnsStack(app, `${prefix}-Dns`, { env, config });
}

const frontend = new FrontendStack(app, `${prefix}-Frontend`, { env, config });
frontend.addDependency(api);

if (config.mcpEnabled) {
  const mcp = new McpStack(app, `${prefix}-Mcp`, { env, config });
  mcp.addDependency(api);
}

const monitoring = new MonitoringStack(app, `${prefix}-Monitoring`, { env, config });
monitoring.addDependency(api);
monitoring.addDependency(data);
```

## Deployment

```bash
# Deploy dev (account ID from env var or config)
cd infra && npx cdk deploy --all -c env=dev

# Deploy prod (requires MFA / assume-role)
cd infra && npx cdk deploy --all -c env=prod --require-approval broadening

# Diff before deploying (always do this for prod)
npx cdk diff --all -c env=prod
```

## CI/CD Pipeline

```
main branch push → CodePipeline
  ├── Source (CodeCommit or GitHub connection)
  ├── Build stage:
  │   ├── npm ci && npm run build (SPA)
  │   ├── npm ci && npm run build (Lambda)
  │   └── npx cdk synth -c env=dev && npx cdk synth -c env=prod
  ├── Deploy dev (-c env=dev)
  ├── Integration tests against dev
  ├── Manual approval gate (required for prod)
  └── Deploy prod (-c env=prod)
```

Pipeline itself defined in CDK (`pipelines.CodePipeline`), avoiding ClickOps. The pipeline role uses least-privilege IAM with explicit permissions for each stack's resource types.

### Deployment Role

```typescript
// Pipeline self-mutation role has:
//   - cloudformation:* on ClaudeStats-* stacks
//   - iam:PassRole for Lambda execution roles
//   - s3:* on SPA bucket
//   - dynamodb:* on ClaudeStats-* tables
//   - cognito-idp:* on ClaudeStats-* user pools
//   - appsync:* on ClaudeStats-* APIs
//   - NO iam:CreateUser, iam:CreateAccessKey, etc. (no credential escalation)
```
