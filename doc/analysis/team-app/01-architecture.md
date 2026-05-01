# 01 — Architecture Overview

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client Tier                                                        │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
│  │ VS Code Ext  │  │ CLI (claude-  │  │ SPA (React + Tremor)     │ │
│  │ (existing)   │  │ stats)        │  │ CloudFront + S3          │ │
│  └──────┬───────┘  └──────┬────────┘  └──────────┬───────────────┘ │
│         │                 │                       │                  │
│         └────────┬────────┴───────────┬───────────┘                  │
│                  │                    │                               │
│           Local SQLite          AppSync (GraphQL)                    │
│           (offline collection)  (sync + team API)                    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┼─────────────────────────────────┐
│  AWS Backend                      │                                  │
│                                   ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Amazon Cognito                                              │    │
│  │  Magic link auth · Domain-restricted signup · WAF protected  │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                       │
│  ┌───────────────────────────▼──────────────────────────────────┐   │
│  │  AWS AppSync (GraphQL)                                        │   │
│  │  Queries · Mutations · Subscriptions · Conflict resolution    │   │
│  │  VTL resolvers + Lambda resolvers                             │   │
│  └─────┬──────────┬──────────┬──────────────┬───────────────────┘   │
│        │          │          │              │                        │
│        ▼          ▼          ▼              ▼                        │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌───────────────────────┐      │
│  │ DynamoDB │ │ Lambda │ │  SES   │ │ Bedrock AgentCore     │      │
│  │ Tables   │ │ Fns    │ │ Email  │ │ MCP Runtime           │      │
│  └──────────┘ └────────┘ └────────┘ └───────────────────────┘      │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  CloudFront → S3 (SPA hosting)                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  AWS WAF (rate limiting on Cognito + AppSync)                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Cross-Device Sync (Individual)

```
Device A                        AWS                         Device B
────────                     ─────────                     ────────
collect → local SQLite       AppSync API                   local SQLite
  │                             │                              │
  ├── sync push ───────────────►│ mutation: upsertSessions     │
  │                             │ → DynamoDB                   │
  │                             │                              │
  │                             │ subscription: onSessionSync ─┤
  │                             │                              ├── sync pull
  │◄─── subscription ──────────┤                              │
```

### Team Stats Flow

```
User's local DB → selective export → AppSync mutation → team aggregation (Lambda) → DynamoDB
                                                                                      │
Other team members ◄── AppSync subscription / query ◄─────────────────────────────────┘
```

## Service Inventory

| Service | Purpose | CDK Construct |
|---------|---------|---------------|
| Cognito User Pool | Auth, magic links, domain restriction | `aws-cognito.UserPool` |
| AppSync GraphQL API | Sync + team API | `aws-appsync.GraphqlApi` |
| DynamoDB | All persistent data | `aws-dynamodb.Table` |
| Lambda | Auth challenges, aggregation, MCP | `aws-lambda-nodejs.NodejsFunction` |
| SES | Magic link emails | `aws-ses.EmailIdentity` |
| S3 + CloudFront | SPA hosting | `aws-s3` + `aws-cloudfront` |
| WAF | Rate limiting, abuse protection | `aws-wafv2.CfnWebACL` |
| Bedrock AgentCore | MCP server runtime | `@aws-cdk/aws-bedrock-agentcore-alpha` |
| KMS | Magic link token signing | `aws-kms.Key` |
