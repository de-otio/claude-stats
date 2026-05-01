/**
 * Token spending analysis — tool cost attribution, MCP server grouping,
 * and anomaly detection.
 * See doc/analysis/09-token-spending-analysis.md for design.
 */
import { estimateCost } from "@claude-stats/core/pricing";
import type { SpendingMessageRow, McpMessageRow } from "./store/index.js";

export interface ToolCostEntry {
  tool: string;
  totalInput: number;
  totalOutput: number;
  totalCacheWrite: number;
  invocationCount: number;
  estimatedCost: number;
  isMcp: boolean;
  mcpServer: string | null;
}

export interface McpServerCost {
  server: string;
  estimatedCost: number;
  totalCalls: number;
  avgTokensPerCall: number;
  tools: string[];
}

export interface AnomalyResult {
  message: SpendingMessageRow;
  totalTokens: number;
  avgCost: number;
  timesAvg: number;
}

/**
 * Attribute token costs to individual tools from message-level data.
 *
 * Each message's full cost is attributed to every tool it invoked
 * (full attribution — intentional over-count, documented in the analysis).
 */
export function attributeToolCosts(messages: SpendingMessageRow[]): ToolCostEntry[] {
  const toolMap = new Map<string, ToolCostEntry>();

  for (const msg of messages) {
    let tools: string[];
    try {
      tools = JSON.parse(msg.tools) as string[];
    } catch {
      continue;
    }
    if (tools.length === 0) continue;

    const { cost } = estimateCost(
      msg.model ?? "unknown",
      msg.input_tokens,
      msg.output_tokens,
      msg.cache_read_tokens,
      msg.cache_creation_tokens,
    );

    for (const tool of tools) {
      const existing = toolMap.get(tool);
      const isMcp = tool.startsWith("mcp__");
      const mcpServer = isMcp ? parseMcpServer(tool) : null;

      if (existing) {
        existing.totalInput += msg.input_tokens;
        existing.totalOutput += msg.output_tokens;
        existing.totalCacheWrite += msg.cache_creation_tokens;
        existing.invocationCount++;
        existing.estimatedCost += cost;
      } else {
        toolMap.set(tool, {
          tool,
          totalInput: msg.input_tokens,
          totalOutput: msg.output_tokens,
          totalCacheWrite: msg.cache_creation_tokens,
          invocationCount: 1,
          estimatedCost: cost,
          isMcp,
          mcpServer,
        });
      }
    }
  }

  return Array.from(toolMap.values()).sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/** Extract the server name from an MCP tool name: mcp__<server>__<method> → server */
function parseMcpServer(toolName: string): string | null {
  const parts = toolName.split("__");
  return parts.length >= 3 ? parts[1]! : null;
}

/**
 * Group tool costs by MCP server.
 */
export function groupByMcpServer(toolCosts: ToolCostEntry[]): McpServerCost[] {
  const serverMap = new Map<string, McpServerCost>();

  for (const tc of toolCosts) {
    if (!tc.isMcp || !tc.mcpServer) continue;

    const existing = serverMap.get(tc.mcpServer);
    if (existing) {
      existing.estimatedCost += tc.estimatedCost;
      existing.totalCalls += tc.invocationCount;
      existing.tools.push(tc.tool);
    } else {
      serverMap.set(tc.mcpServer, {
        server: tc.mcpServer,
        estimatedCost: tc.estimatedCost,
        totalCalls: tc.invocationCount,
        avgTokensPerCall: 0, // computed below
        tools: [tc.tool],
      });
    }
  }

  // Compute avg tokens per call
  for (const tc of toolCosts) {
    if (!tc.isMcp || !tc.mcpServer) continue;
    const entry = serverMap.get(tc.mcpServer)!;
    entry.avgTokensPerCall += (tc.totalInput + tc.totalOutput + tc.totalCacheWrite);
  }
  for (const entry of serverMap.values()) {
    entry.avgTokensPerCall = entry.totalCalls > 0
      ? Math.round(entry.avgTokensPerCall / entry.totalCalls)
      : 0;
  }

  return Array.from(serverMap.values()).sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/**
 * Detect anomalously expensive messages (> threshold * stddev above mean).
 */
export function detectAnomalies(
  messages: SpendingMessageRow[],
  threshold: number = 2.0,
): AnomalyResult[] {
  if (messages.length < 2) return [];

  const costs = messages.map(m => m.input_tokens + m.output_tokens);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const variance = costs.reduce((sum, c) => sum + (c - mean) ** 2, 0) / costs.length;
  const stddev = Math.sqrt(variance);
  const cutoff = mean + threshold * stddev;

  const anomalies: AnomalyResult[] = [];
  for (const msg of messages) {
    const totalTokens = msg.input_tokens + msg.output_tokens;
    if (totalTokens > cutoff) {
      anomalies.push({
        message: msg,
        totalTokens,
        avgCost: mean,
        timesAvg: mean > 0 ? totalTokens / mean : 0,
      });
    }
  }

  return anomalies
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);
}

// ── MCP server usage from all messages ────────────────────────────────────

export interface McpServerUsage {
  server: string;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  callCount: number;
  tools: Array<{ method: string; calls: number }>;
  projects: string[];
}

/**
 * Aggregate MCP server token usage from all MCP-bearing messages.
 * Each message's full token cost is attributed to every MCP tool it contains.
 */
export function aggregateMcpServerUsage(rows: McpMessageRow[]): McpServerUsage[] {
  const serverMap = new Map<string, McpServerUsage>();

  for (const row of rows) {
    let tools: string[];
    try {
      tools = JSON.parse(row.tools) as string[];
    } catch {
      continue;
    }

    const mcpTools = tools.filter(t => t.startsWith("mcp__"));
    if (mcpTools.length === 0) continue;

    const { cost } = estimateCost(
      row.model ?? "unknown",
      row.input_tokens, row.output_tokens,
      row.cache_read_tokens, row.cache_creation_tokens,
    );

    for (const tool of mcpTools) {
      const server = parseMcpServer(tool);
      if (!server) continue;
      const method = tool.split("__").slice(2).join("__");

      const existing = serverMap.get(server);
      if (existing) {
        existing.estimatedCost += cost;
        existing.inputTokens += row.input_tokens;
        existing.outputTokens += row.output_tokens;
        existing.cacheReadTokens += row.cache_read_tokens;
        existing.cacheCreationTokens += row.cache_creation_tokens;
        existing.messageCount++;
        existing.callCount++;
        if (!existing.projects.includes(row.project_path)) {
          existing.projects.push(row.project_path);
        }
        const existingTool = existing.tools.find(t => t.method === method);
        if (existingTool) existingTool.calls++;
        else existing.tools.push({ method, calls: 1 });
      } else {
        serverMap.set(server, {
          server,
          estimatedCost: cost,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheCreationTokens: row.cache_creation_tokens,
          messageCount: 1,
          callCount: 1,
          tools: [{ method, calls: 1 }],
          projects: [row.project_path],
        });
      }
    }
  }

  // Sort tools within each server by calls desc
  for (const entry of serverMap.values()) {
    entry.tools.sort((a, b) => b.calls - a.calls);
  }

  return Array.from(serverMap.values()).sort((a, b) => b.estimatedCost - a.estimatedCost);
}
