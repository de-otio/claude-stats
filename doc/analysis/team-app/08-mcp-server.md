# 08 — MCP Server

MCP server deployed on AWS Bedrock AgentCore Runtime, exposing claude-stats data to Claude Code and other MCP clients.

## Purpose

Allow Claude Code (and other AI agents) to query a user's usage stats directly via MCP tools. Use cases:

- "How many tokens have I used today?"
- "What's my team's leaderboard this week?"
- "Am I close to my rate limit?"
- "Show me my most expensive sessions"

## Architecture

```
Claude Code / MCP Client
        │
        ▼
  Bedrock AgentCore Gateway
        │ (OAuth2 auth → resolves userId from token)
        ▼
  AgentCore MCP Runtime (ARM64)
  ┌─────────────────────┐
  │  MCP Server          │
  │  (Docker container)  │
  │  Node.js + TypeScript│
  │                      │
  │  → AppSync client    │
  │     (IAM auth)       │
  └─────────────────────┘
        │
        ▼
    AppSync API → DynamoDB
```

## MCP Tools Exposed

```typescript
const tools = [
  {
    name: "get_my_stats",
    description: "Get your Claude Code usage stats for a period",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week", "month"], default: "today" },
      },
    },
  },
  {
    name: "get_team_dashboard",
    description: "Get team dashboard with leaderboard and member stats",
    inputSchema: {
      type: "object",
      properties: {
        teamSlug: { type: "string" },
        period: { type: "string", default: "week" },
      },
      required: ["teamSlug"],
    },
  },
  {
    name: "get_leaderboard",
    description: "Get the team leaderboard for a specific category",
    inputSchema: {
      type: "object",
      properties: {
        teamSlug: { type: "string" },
        category: { type: "string", description: "Built-in: prompts, velocity, efficiency, streak, cache, model_diversity, subagent. Teams may configure additional categories." },
      },
      required: ["teamSlug"],
    },
  },
  {
    name: "get_achievements",
    description: "List your achievements, unlocked and available",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_streak",
    description: "Get your current coding streak",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_active_challenge",
    description: "Get the active challenge for a team",
    inputSchema: {
      type: "object",
      properties: {
        teamSlug: { type: "string" },
      },
      required: ["teamSlug"],
    },
  },
  {
    name: "get_my_projects",
    description: "Get your project breakdown (sessions, cost per GitHub repo)",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["week", "month"], default: "week" },
      },
    },
  },
  {
    name: "get_team_projects",
    description: "Get project insights for a team — which repos the team is working on",
    inputSchema: {
      type: "object",
      properties: {
        teamSlug: { type: "string" },
        period: { type: "string", default: "week" },
      },
      required: ["teamSlug"],
    },
  },
];
```

### Tool Authorization

Every tool call follows this pattern:

```typescript
async function handleToolCall(toolName: string, args: unknown, userId: string) {
  // userId is extracted from the OAuth2 token by the gateway — not user-supplied

  if (toolName.startsWith("get_team_")) {
    // Verify team membership via AppSync query before returning data
    const membership = await appSyncClient.query(teamMembers, {
      teamId: resolveTeamId(args.teamSlug),
    });
    if (!membership.find(m => m.userId === userId)) {
      return { error: "You are not a member of this team" };
      // Generic error — don't reveal team existence to non-members
    }
  }

  // Proceed with data fetch
  // ...
}
```

Team-scoped tools are authorized at both the MCP server level (membership check) and the AppSync resolver level (group claim check). Defense in depth.

## Deployment

Container image built from the same TypeScript codebase. **Must be ARM64** per Bedrock AgentCore requirements.

```dockerfile
FROM --platform=linux/arm64 node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/mcp-server/ ./

FROM --platform=linux/arm64 node:20-slim
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 8000
CMD ["node", "server.js"]
```

### CDK Construct

```typescript
import { AgentCoreRuntime } from "@aws-cdk/aws-bedrock-agentcore-alpha";

const mcpServer = new AgentCoreRuntime(this, "McpServer", {
  containerImage: ecr.ContainerImage.fromAsset("./mcp-server", {
    platform: ecr.Platform.LINUX_ARM64,
  }),
  protocol: "MCP",
  environment: {
    APPSYNC_ENDPOINT: api.graphqlUrl,
    AWS_REGION: cdk.Stack.of(this).region,
  },
});

// IAM role for MCP server to call AppSync
api.grantQuery(mcpServer.role);
api.grantMutation(mcpServer.role);

// Gateway with OAuth2 for MCP clients
const gateway = new AgentCoreGateway(this, "McpGateway", {
  authConfig: {
    type: "COGNITO",
    userPoolId: userPool.userPoolId,
    clientId: mcpClient.userPoolClientId,
  },
});

gateway.addMcpServerTarget(mcpServer, {
  scopes: ["mcp-runtime-server/invoke"],
});
```

## Authentication

### MCP Client → Gateway

MCP clients authenticate via OAuth2 using Cognito. The gateway validates the token and passes the `userId` (Cognito `sub`) to the MCP server as a trusted identity.

### MCP Server → AppSync

The MCP server calls AppSync using **IAM auth** (not Cognito user pools). The server's IAM role has permissions to invoke AppSync queries/mutations. It passes the `userId` from the gateway as a variable to scope queries to the authenticated user.

This means the MCP server acts as a trusted backend — it can query any user's data, but only does so for the user identified by the OAuth2 token.

### Client Configuration

Users configure the MCP server in their Claude Code settings:

```json
{
  "mcpServers": {
    "claude-stats": {
      "url": "https://{gateway-id}.bedrock-agentcore.{region}.amazonaws.com/mcp",
      "auth": {
        "type": "oauth2",
        "clientId": "{cognito-mcp-client-id}",
        "authorizationUrl": "https://{cognito-domain}/oauth2/authorize",
        "tokenUrl": "https://{cognito-domain}/oauth2/token",
        "scopes": ["openid", "mcp-runtime-server/invoke"]
      }
    }
  }
}
```

A separate Cognito User Pool Client is configured for MCP (with `openid` and custom scopes), distinct from the SPA client.
