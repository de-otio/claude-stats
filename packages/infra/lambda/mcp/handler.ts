/**
 * MCP (Model Context Protocol) server Lambda handler.
 *
 * Exposes 8 tools that proxy to the Claude Stats AppSync GraphQL API using the
 * caller's Cognito JWT (passed via the Authorization header).
 *
 * Protocol: JSON-RPC 2.0 over Lambda Function URL (HTTP).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT!;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
  {
    name: "get_my_stats",
    description: "Get your Claude usage stats for a given period",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "The time period for stats aggregation",
        },
      },
    },
  },
  {
    name: "list_my_sessions",
    description: "List your recent Claude sessions",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "Filter sessions by time period",
        },
      },
    },
  },
  {
    name: "get_session_detail",
    description: "Get detailed messages and usage for a specific session",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to retrieve",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_my_projects",
    description: "List all your tracked Claude projects with usage breakdown",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_teams",
    description: "List all teams you are a member of",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_team_dashboard",
    description:
      "Get the team dashboard with aggregate stats, leaderboard, and member cards for a specific period",
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "The team ID to retrieve the dashboard for",
        },
        period: {
          type: "string",
          description:
            "ISO week period (e.g. '2026-W11'), month ('2026-03'), or date ('2026-03-12')",
        },
      },
      required: ["teamId"],
    },
  },
  {
    name: "list_team_challenges",
    description: "List active and recent challenges for a team",
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "The team ID to list challenges for",
        },
      },
      required: ["teamId"],
    },
  },
  {
    name: "get_achievements",
    description: "Get your unlocked achievements and progress",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// GraphQL query strings
// ---------------------------------------------------------------------------

const QUERIES: Record<string, string> = {
  get_my_stats: `
    query MyStats($period: String) {
      myStats(period: $period) {
        period
        sessions
        prompts
        inputTokens
        outputTokens
        estimatedCost
        activeMinutes
        currentStreak
        longestStreak
        modelsUsed
        topTools
      }
    }
  `,
  list_my_sessions: `
    query MySessions($period: String) {
      mySessions(period: $period) {
        sessionId
        projectId
        firstTimestamp
        lastTimestamp
        promptCount
        inputTokens
        outputTokens
        estimatedCost
        models
      }
    }
  `,
  get_session_detail: `
    query SessionMessages($sessionId: ID!) {
      sessionMessages(sessionId: $sessionId) {
        messageId
        role
        content
        inputTokens
        outputTokens
        estimatedCost
        timestamp
        model
        tools
      }
    }
  `,
  list_my_projects: `
    query MyProjects {
      myProjects {
        projectId
        projectName
        sessions
        prompts
        estimatedCost
        lastActiveAt
      }
    }
  `,
  list_teams: `
    query MyTeams {
      myTeams {
        teamId
        teamName
        teamSlug
        memberCount
        role
        shareLevel
        joinedAt
      }
    }
  `,
  get_team_dashboard: `
    query TeamDashboard($teamId: ID!, $period: String!) {
      teamDashboard(teamId: $teamId, period: $period) {
        team {
          teamId
          teamName
          teamSlug
          memberCount
        }
        period
        aggregate {
          totalSessions
          totalPrompts
          totalEstimatedCost
          activeMemberCount
          avgSessionsPerMember
          avgCostPerMember
        }
        leaderboard {
          categories {
            name
            awardName
            rankings {
              rank
              displayName
              value
              formattedValue
            }
          }
        }
        memberCards {
          userId
          displayName
          streak {
            currentStreak
            longestStreak
          }
          stats {
            sessions
            prompts
            estimatedCost
            velocityTokensPerMin
          }
        }
        superlatives {
          label
          displayName
          value
        }
        computedAt
      }
    }
  `,
  get_achievements: `
    query MyAchievements {
      myAchievements {
        achievementId
        name
        description
        category
        icon
        unlockedAt
        shared
      }
    }
  `,
};

// ---------------------------------------------------------------------------
// GraphQL execution
// ---------------------------------------------------------------------------

async function executeGraphQL(
  query: string,
  variables: Record<string, any>,
  authToken: string,
): Promise<any> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GraphQL request failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json() as {
    data?: Record<string, any>;
    errors?: Array<{ message: string }>;
  };

  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join(", ")}`);
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: Record<string, any>,
  authToken: string,
): Promise<any> {
  switch (name) {
    case "get_my_stats": {
      const data = await executeGraphQL(
        QUERIES.get_my_stats,
        { period: args.period ?? "week" },
        authToken,
      );
      return data?.myStats ?? null;
    }

    case "list_my_sessions": {
      const data = await executeGraphQL(
        QUERIES.list_my_sessions,
        { period: args.period ?? "week" },
        authToken,
      );
      return data?.mySessions ?? [];
    }

    case "get_session_detail": {
      if (!args.sessionId) {
        throw new Error("sessionId is required");
      }
      const data = await executeGraphQL(
        QUERIES.get_session_detail,
        { sessionId: args.sessionId },
        authToken,
      );
      return data?.sessionMessages ?? [];
    }

    case "list_my_projects": {
      const data = await executeGraphQL(
        QUERIES.list_my_projects,
        {},
        authToken,
      );
      return data?.myProjects ?? [];
    }

    case "list_teams": {
      const data = await executeGraphQL(
        QUERIES.list_teams,
        {},
        authToken,
      );
      return data?.myTeams ?? [];
    }

    case "get_team_dashboard": {
      if (!args.teamId) {
        throw new Error("teamId is required");
      }
      const period = args.period ?? getCurrentISOWeek();
      const data = await executeGraphQL(
        QUERIES.get_team_dashboard,
        { teamId: args.teamId, period },
        authToken,
      );
      return data?.teamDashboard ?? null;
    }

    case "list_team_challenges": {
      // Placeholder — challenge listing is not yet exposed via GraphQL
      if (!args.teamId) {
        throw new Error("teamId is required");
      }
      return {
        teamId: args.teamId,
        challenges: [],
        message: "Challenge listing coming soon. Use the team dashboard for active challenge info.",
      };
    }

    case "get_achievements": {
      const data = await executeGraphQL(
        QUERIES.get_achievements,
        {},
        authToken,
      );
      return data?.myAchievements ?? [];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// ISO week helper
// ---------------------------------------------------------------------------

function getCurrentISOWeek(): string {
  const date = new Date();
  const dayOfWeek = date.getUTCDay();
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - isoDay));
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const ordinal =
    Math.floor((thursday.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const weekNum = Math.floor((ordinal - 1) / 7) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// MCP protocol handling
// ---------------------------------------------------------------------------

function makeResponse(id: number | string | null, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: any,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function handleMessage(
  message: JsonRpcRequest,
  authToken: string | undefined,
): Promise<JsonRpcResponse> {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return makeResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "claude-stats-mcp",
          version: "1.0.0",
        },
      });

    case "tools/list":
      return makeResponse(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name as string | undefined;
      const toolArgs = (params?.arguments ?? {}) as Record<string, any>;

      if (!toolName) {
        return makeError(id, -32602, "Invalid params: missing tool name");
      }

      if (!authToken) {
        return makeError(id, -32001, "Unauthorized: missing Authorization header");
      }

      try {
        const result = await executeTool(toolName, toolArgs, authToken);
        return makeResponse(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        });
      } catch (err: any) {
        return makeResponse(id, {
          content: [
            {
              type: "text",
              text: `Error: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        });
      }
    }

    default:
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (event: {
  body: string;
  headers: Record<string, string>;
}): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> => {
  const responseHeaders = {
    "Content-Type": "application/json",
  };

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(event.body) as JsonRpcRequest;
  } catch {
    const errorResponse = makeError(null, -32700, "Parse error: invalid JSON");
    return {
      statusCode: 400,
      headers: responseHeaders,
      body: JSON.stringify(errorResponse),
    };
  }

  if (parsed.jsonrpc !== "2.0" || !parsed.method) {
    const errorResponse = makeError(
      parsed.id ?? null,
      -32600,
      "Invalid Request: must be JSON-RPC 2.0",
    );
    return {
      statusCode: 400,
      headers: responseHeaders,
      body: JSON.stringify(errorResponse),
    };
  }

  // Extract Authorization header (case-insensitive)
  const authToken =
    event.headers["Authorization"] ??
    event.headers["authorization"] ??
    undefined;

  const response = await handleMessage(parsed, authToken);

  return {
    statusCode: 200,
    headers: responseHeaders,
    body: JSON.stringify(response),
  };
};
