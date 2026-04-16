import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-test-"));
let store: Store;
let client: Client;

beforeAll(async () => {
  store = new Store(join(tmpDir, "test.db"));

  // Insert a test session and message so tools return data
  store.upsertSession({
    sessionId: "test-session-001",
    projectPath: "/tmp/test-project",
    sourceFile: "/tmp/test-project/.claude/conversation.jsonl",
    firstTimestamp: Date.now() - 3600_000,
    lastTimestamp: Date.now(),
    claudeVersion: "1.0.0",
    entrypoint: "cli",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 5,
    assistantMessageCount: 5,
    inputTokens: 10_000,
    outputTokens: 5_000,
    cacheCreationTokens: 1_000,
    cacheReadTokens: 2_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4-20250514"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    throttleEvents: 0,
    sourceDeleted: false,
    activeDurationMs: null,
    medianResponseTimeMs: null,
  });

  store.upsertMessages([{
    uuid: "msg-001",
    sessionId: "test-session-001",
    timestamp: Date.now() - 1800_000,
    claudeVersion: "1.0.0",
    model: "claude-sonnet-4-20250514",
    stopReason: "end_turn",
    inputTokens: 5_000,
    outputTokens: 2_500,
    cacheCreationTokens: 500,
    cacheReadTokens: 1_000,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: "test prompt",
  }]);

  // Create MCP server and connect via in-memory transport
  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => {
  store.close();
});

describe("MCP Server", () => {
  describe("tools/list", () => {
    it("returns all 7 tools", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "get_ruflo_insights",
        "get_session_detail",
        "get_stats",
        "get_status",
        "list_projects",
        "list_sessions",
        "search_history",
      ]);
    });

    it("each tool has a description and inputSchema", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  describe("get_stats", () => {
    it("returns summary with token counts", async () => {
      const result = await client.callTool({ name: "get_stats", arguments: { period: "all" } });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");

      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data).toHaveProperty("sessions");
      expect(data).toHaveProperty("inputTokens");
      expect(data).toHaveProperty("outputTokens");
      expect(data).toHaveProperty("estimatedCost");
    });

    it("defaults period to week", async () => {
      const result = await client.callTool({ name: "get_stats", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data["period"]).toBe("week");
    });
  });

  describe("list_sessions", () => {
    it("returns sessions array with expected fields", async () => {
      const result = await client.callTool({ name: "list_sessions", arguments: { period: "all" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0]!.text) as Array<Record<string, unknown>>;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]).toHaveProperty("sessionId");
      expect(sessions[0]).toHaveProperty("project");
      expect(sessions[0]).toHaveProperty("prompts");
      expect(sessions[0]).toHaveProperty("inputTokens");
      expect(sessions[0]).toHaveProperty("estimatedCost");
      expect(sessions[0]).toHaveProperty("models");
    });

    it("respects limit parameter", async () => {
      const result = await client.callTool({ name: "list_sessions", arguments: { period: "all", limit: 1 } });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0]!.text) as unknown[];
      expect(sessions.length).toBeLessThanOrEqual(1);
    });

    it("filters by period", async () => {
      const result = await client.callTool({ name: "list_sessions", arguments: { period: "day" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const sessions = JSON.parse(content[0]!.text) as unknown[];
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe("get_session_detail", () => {
    it("returns session and messages for a valid session ID", async () => {
      const result = await client.callTool({ name: "get_session_detail", arguments: { sessionId: "test-session-001" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data).toHaveProperty("session");
      expect(data).toHaveProperty("messages");
      const messages = data["messages"] as unknown[];
      expect(messages.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await client.callTool({ name: "get_session_detail", arguments: { sessionId: "nonexistent" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("supports partial session ID match", async () => {
      const result = await client.callTool({ name: "get_session_detail", arguments: { sessionId: "test-session" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data).toHaveProperty("session");
    });

    it("returns message with cost and model fields", async () => {
      const result = await client.callTool({ name: "get_session_detail", arguments: { sessionId: "test-session-001" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as { messages: Array<Record<string, unknown>> };
      const msg = data.messages[0]!;
      expect(msg).toHaveProperty("model");
      expect(msg).toHaveProperty("inputTokens");
      expect(msg).toHaveProperty("outputTokens");
      expect(msg).toHaveProperty("estimatedCost");
      expect(msg).toHaveProperty("timestamp");
    });
  });

  describe("list_projects", () => {
    it("returns project breakdown array", async () => {
      const result = await client.callTool({ name: "list_projects", arguments: { period: "all" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as unknown[];
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("get_status", () => {
    it("returns status with session and message counts", async () => {
      const result = await client.callTool({ name: "get_status", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data).toHaveProperty("sessionCount");
      expect(data).toHaveProperty("messageCount");
      expect(data).toHaveProperty("dbSize");
    });
  });

  describe("search_history", () => {
    it("returns results array (may be empty if no history file)", async () => {
      const result = await client.callTool({ name: "search_history", arguments: { query: "test" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text) as unknown[];
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
