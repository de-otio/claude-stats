/**
 * Local MCP server for claude-stats.
 *
 * Exposes read-only tools that query the local SQLite database
 * (~/.claude-stats/stats.db) over stdio. No network access or
 * authentication required — all data is local.
 *
 * Usage:
 *   claude-stats mcp          # started by Claude Code as a child process
 *
 * Client configuration (.mcp.json or settings):
 *   { "mcpServers": { "claude-stats": { "command": "claude-stats", "args": ["mcp"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { estimateCost } from "@claude-stats/core/pricing";
import { searchHistory } from "../history/index.js";
import type { ReportOptions } from "../reporter/index.js";

function periodToReportOpts(period?: string): ReportOptions {
  return {
    period: (period ?? "week") as ReportOptions["period"],
  };
}

function formatResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Create and configure an MCP server with all tools wired to the given store.
 * Exported separately from `startMcpServer` for testability.
 */
export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({
    name: "claude-stats",
    version: "1.0.0",
  });

  // ── get_stats ─────────────────────────────────────────────────────────────
  server.tool(
    "get_stats",
    "Get your Claude Code usage stats for a period — tokens, cost, sessions, velocity, cache efficiency, streaks",
    {
      period: z.enum(["day", "week", "month", "all"]).default("week")
        .describe("Time period for aggregation"),
    },
    async ({ period }) => {
      const data = buildDashboard(store, periodToReportOpts(period));
      return formatResult({
        period: data.period,
        since: data.sinceIso,
        ...data.summary,
      });
    },
  );

  // ── list_sessions ─────────────────────────────────────────────────────────
  server.tool(
    "list_sessions",
    "List recent Claude Code sessions with token counts and estimated cost",
    {
      period: z.enum(["day", "week", "month", "all"]).default("week")
        .describe("Time period to filter sessions"),
      project: z.string().optional()
        .describe("Filter by project path"),
      limit: z.number().int().min(1).max(100).default(20)
        .describe("Maximum number of sessions to return"),
    },
    async ({ period, project, limit }) => {
      const filters: Parameters<Store["getSessions"]>[0] = {};
      if (project) filters.projectPath = project;
      if (period !== "all") {
        const { periodStart } = await import("../reporter/index.js");
        filters.since = periodStart(period, Intl.DateTimeFormat().resolvedOptions().timeZone);
      }
      const sessions = store.getSessions(filters).slice(0, limit).map((s) => ({
        sessionId: s.session_id,
        project: s.project_path,
        firstTimestamp: s.first_timestamp ? new Date(s.first_timestamp).toISOString() : null,
        lastTimestamp: s.last_timestamp ? new Date(s.last_timestamp).toISOString() : null,
        prompts: s.prompt_count,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        cacheReadTokens: s.cache_read_tokens,
        estimatedCost: estimateCost(
          "claude-sonnet-4-20250514", // approximate — sessions span models
          s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_creation_tokens,
        ),
        models: s.models,
        entrypoint: s.entrypoint,
      }));
      return formatResult(sessions);
    },
  );

  // ── get_session_detail ────────────────────────────────────────────────────
  server.tool(
    "get_session_detail",
    "Get detailed messages and token usage for a specific session",
    {
      sessionId: z.string().describe("Full or partial session ID"),
    },
    async ({ sessionId }) => {
      const session = store.findSession(sessionId);
      if (!session) {
        return formatResult({ error: `No session found matching "${sessionId}"` });
      }
      const messages = store.getSessionMessages(session.session_id);
      return formatResult({
        session: {
          sessionId: session.session_id,
          project: session.project_path,
          firstTimestamp: session.first_timestamp,
          lastTimestamp: session.last_timestamp,
          promptCount: session.prompt_count,
        },
        messages: messages.map((m) => ({
          model: m.model,
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          cacheReadTokens: m.cache_read_tokens,
          estimatedCost: estimateCost(
            m.model ?? "unknown",
            m.input_tokens ?? 0,
            m.output_tokens ?? 0,
            m.cache_read_tokens ?? 0,
            m.cache_creation_tokens ?? 0,
          ),
          timestamp: m.timestamp,
          tools: m.tools,
        })),
      });
    },
  );

  // ── list_projects ─────────────────────────────────────────────────────────
  server.tool(
    "list_projects",
    "List projects with usage breakdown — sessions, tokens, and cost per project",
    {
      period: z.enum(["day", "week", "month", "all"]).default("week")
        .describe("Time period for aggregation"),
    },
    async ({ period }) => {
      const data = buildDashboard(store, periodToReportOpts(period));
      return formatResult(data.byProject);
    },
  );

  // ── get_status ────────────────────────────────────────────────────────────
  server.tool(
    "get_status",
    "Get database health — session count, message count, database size, last collection time",
    {},
    async () => {
      const status = store.getStatus();
      return formatResult(status);
    },
  );

  // ── search_history ────────────────────────────────────────────────────────
  server.tool(
    "search_history",
    "Search your Claude Code prompt history by keyword",
    {
      query: z.string().describe("Search query (case-insensitive substring match)"),
      limit: z.number().int().min(1).max(50).default(10)
        .describe("Maximum number of results"),
    },
    async ({ query, limit }) => {
      const results = searchHistory({ query, limit });
      return formatResult(
        results.map((r) => ({
          prompt: r.entry.display,
          timestamp: r.entry.timestamp,
          project: r.entry.project,
          sessionId: r.entry.sessionId,
        })),
      );
    },
  );

  // ── get_ruflo_insights ─────────────────────────────────────────────────
  server.tool(
    "get_ruflo_insights",
    "Get insights about ruflo agent orchestration usage — adoption, cost, method breakdown, and A/B comparison vs baseline sessions",
    {
      period: z.enum(["day", "week", "month", "all"]).default("week")
        .describe("Time period for aggregation"),
    },
    async ({ period }) => {
      const data = buildDashboard(store, periodToReportOpts(period));
      if (!data.ruflo) {
        return formatResult({ detected: false, message: "No ruflo MCP tool usage detected in this period" });
      }
      return formatResult(data.ruflo);
    },
  );

  return server;
}

/**
 * Entry point: create a store, collect fresh data, wire up MCP tools,
 * and connect over stdio.
 */
export async function startMcpServer(): Promise<void> {
  const { Store } = await import("../store/index.js");
  const { collect } = await import("../aggregator/index.js");

  const store = new Store();
  await collect(store);

  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
