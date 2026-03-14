# Team App — Enterprise Backend & SPA Design

Full-featured AWS backend and frontend SPA for team dashboards, cross-device sync, and gamification.

## Documents

| File | Description |
|------|-------------|
| [01-architecture.md](01-architecture.md) | High-level architecture, service map, data flow |
| [02-authentication.md](02-authentication.md) | Cognito, magic links, domain-restricted signup, abuse protection |
| [03-authorization.md](03-authorization.md) | Roles: superadmin, team admin, member. Permission matrix |
| [04-data-model.md](04-data-model.md) | AppSync/DynamoDB schema, tables, indexes |
| [05-api-design.md](05-api-design.md) | GraphQL API: queries, mutations, subscriptions |
| [06-sync-strategy.md](06-sync-strategy.md) | Cross-device sync via AppSync, offline-first, migration from SQLite |
| [07-frontend.md](07-frontend.md) | SPA with Tremor + React, routing, page designs |
| [08-mcp-server.md](08-mcp-server.md) | MCP server on Bedrock AgentCore runtime |
| [09-infrastructure.md](09-infrastructure.md) | CDK stacks, constructs, no Amplify CLI |
| [10-team-features.md](10-team-features.md) | Teams, gamification, fun features, privacy controls |
| [11-account-separation.md](11-account-separation.md) | Work vs personal accounts, selective sharing |
| [12-environments.md](12-environments.md) | Dev/prod config, deployment pipeline |
| [13-cost-protection.md](13-cost-protection.md) | Budget alerts, Lambda caps, DLQs, per-user quotas |
| [14-monitoring.md](14-monitoring.md) | Structured logging, CloudWatch dashboard, alarms, X-Ray |
| [15-testing.md](15-testing.md) | Unit, integration, E2E test strategy |
| [16-operations.md](16-operations.md) | Runbooks, account deletion, backup & recovery |
| [17-client-setup.md](17-client-setup.md) | CLI/extension setup flow, backend discovery, token storage, VS Code integration |

## Design Principles

1. **CDK-managed infrastructure** — no Amplify CLI; all resources defined in TypeScript CDK stacks
2. **Serverless** — Lambda, AppSync, DynamoDB, Cognito, S3, CloudFront
3. **Offline-first** — local collection continues to work without connectivity
4. **Privacy by design** — users choose what to share; work/personal separation enforced
5. **Fun, not surveillance** — gamification motivates; no punitive metrics
6. **Domain-restricted access** — signup limited to approved company email domains
7. **Low cost over high availability** — prefer throttling over spending; single-region, no multi-AZ redundancy beyond what AWS provides by default
8. **Metadata by default** — only structured usage metadata (token counts, model names, timestamps, costs) leaves the device by default; prompt text is opt-in with client-side secret scanning; assistant responses, code, and local file paths are never synced (see [06-sync-strategy.md § Data Boundary](06-sync-strategy.md))
