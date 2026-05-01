import { describe, it, expect } from "vitest";
import { attributeToolCosts, groupByMcpServer, detectAnomalies } from "../spending.js";
import type { SpendingMessageRow } from "../store/index.js";

function makeMsg(overrides: Partial<SpendingMessageRow> = {}): SpendingMessageRow {
  return {
    uuid: `m-${Math.random().toString(36).slice(2, 8)}`,
    session_id: "sess-1",
    model: "claude-opus-4-6",
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_read_tokens: 5_000,
    cache_creation_tokens: 500,
    thinking_blocks: 0,
    tools: "[]",
    prompt_text: null,
    timestamp: Date.now(),
    stop_reason: "end_turn",
    ...overrides,
  };
}

describe("attributeToolCosts", () => {
  it("returns empty array when no tools in messages", () => {
    const msgs = [makeMsg({ tools: "[]" }), makeMsg({ tools: "[]" })];
    expect(attributeToolCosts(msgs)).toEqual([]);
  });

  it("attributes cost to a single tool per message", () => {
    const msgs = [makeMsg({ tools: '["Read"]', input_tokens: 1000, output_tokens: 500 })];
    const result = attributeToolCosts(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.tool).toBe("Read");
    expect(result[0]!.invocationCount).toBe(1);
    expect(result[0]!.estimatedCost).toBeGreaterThan(0);
    expect(result[0]!.isMcp).toBe(false);
    expect(result[0]!.mcpServer).toBeNull();
  });

  it("attributes full cost to each tool in multi-tool messages", () => {
    const msgs = [makeMsg({
      tools: '["Read","Edit","Bash"]',
      input_tokens: 10_000,
      output_tokens: 5_000,
    })];
    const result = attributeToolCosts(msgs);
    expect(result).toHaveLength(3);
    // Each tool gets the full message cost (documented over-count)
    const totalPerTool = result[0]!.estimatedCost;
    expect(result[1]!.estimatedCost).toBe(totalPerTool);
    expect(result[2]!.estimatedCost).toBe(totalPerTool);
  });

  it("aggregates across multiple messages for the same tool", () => {
    const msgs = [
      makeMsg({ tools: '["Read"]', input_tokens: 1000, output_tokens: 500 }),
      makeMsg({ tools: '["Read"]', input_tokens: 2000, output_tokens: 1000 }),
    ];
    const result = attributeToolCosts(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.invocationCount).toBe(2);
    expect(result[0]!.totalInput).toBe(3000);
    expect(result[0]!.totalOutput).toBe(1500);
  });

  it("detects MCP tools and extracts server name", () => {
    const msgs = [makeMsg({ tools: '["mcp__doc-search__query"]' })];
    const result = attributeToolCosts(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.isMcp).toBe(true);
    expect(result[0]!.mcpServer).toBe("doc-search");
  });

  it("sorts by estimated cost descending", () => {
    const msgs = [
      makeMsg({ tools: '["Bash"]', input_tokens: 100, output_tokens: 50 }),
      makeMsg({ tools: '["Read"]', input_tokens: 50_000, output_tokens: 20_000 }),
    ];
    const result = attributeToolCosts(msgs);
    expect(result[0]!.tool).toBe("Read");
    expect(result[1]!.tool).toBe("Bash");
  });

  it("handles invalid JSON in tools gracefully", () => {
    const msgs = [makeMsg({ tools: "not json" })];
    const result = attributeToolCosts(msgs);
    expect(result).toEqual([]);
  });
});

describe("groupByMcpServer", () => {
  it("returns empty array when no MCP tools", () => {
    const toolCosts = attributeToolCosts([
      makeMsg({ tools: '["Read"]' }),
      makeMsg({ tools: '["Edit"]' }),
    ]);
    expect(groupByMcpServer(toolCosts)).toEqual([]);
  });

  it("groups multiple MCP methods under one server", () => {
    const msgs = [
      makeMsg({ tools: '["mcp__github__list_issues"]', input_tokens: 5000, output_tokens: 1000 }),
      makeMsg({ tools: '["mcp__github__get_issue"]', input_tokens: 3000, output_tokens: 800 }),
      makeMsg({ tools: '["mcp__slack__send_message"]', input_tokens: 1000, output_tokens: 200 }),
    ];
    const toolCosts = attributeToolCosts(msgs);
    const servers = groupByMcpServer(toolCosts);

    expect(servers.length).toBe(2);
    // Sorted by cost desc — github should be first (higher total)
    const github = servers.find(s => s.server === "github");
    expect(github).toBeDefined();
    expect(github!.totalCalls).toBe(2);
    expect(github!.tools).toHaveLength(2);
    expect(github!.tools).toContain("mcp__github__list_issues");
    expect(github!.tools).toContain("mcp__github__get_issue");

    const slack = servers.find(s => s.server === "slack");
    expect(slack).toBeDefined();
    expect(slack!.totalCalls).toBe(1);
  });

  it("computes average tokens per call", () => {
    const msgs = [
      makeMsg({ tools: '["mcp__doc__search"]', input_tokens: 10_000, output_tokens: 2_000, cache_creation_tokens: 500 }),
      makeMsg({ tools: '["mcp__doc__search"]', input_tokens: 20_000, output_tokens: 4_000, cache_creation_tokens: 1_000 }),
    ];
    const toolCosts = attributeToolCosts(msgs);
    const servers = groupByMcpServer(toolCosts);

    expect(servers).toHaveLength(1);
    expect(servers[0]!.totalCalls).toBe(2);
    // avg = (10000+2000+500 + 20000+4000+1000) / 2 = 37500 / 2 = 18750
    expect(servers[0]!.avgTokensPerCall).toBe(18750);
  });
});

describe("detectAnomalies", () => {
  it("returns empty array with fewer than 2 messages", () => {
    expect(detectAnomalies([])).toEqual([]);
    expect(detectAnomalies([makeMsg()])).toEqual([]);
  });

  it("returns empty array when all messages have similar cost", () => {
    const msgs = [
      makeMsg({ input_tokens: 1000, output_tokens: 500 }),
      makeMsg({ input_tokens: 1100, output_tokens: 480 }),
      makeMsg({ input_tokens: 950, output_tokens: 520 }),
    ];
    expect(detectAnomalies(msgs)).toEqual([]);
  });

  it("detects outlier messages", () => {
    // Need enough similar samples so the outlier doesn't dominate the stddev
    const msgs = [
      makeMsg({ input_tokens: 1000, output_tokens: 500 }),
      makeMsg({ input_tokens: 1100, output_tokens: 480 }),
      makeMsg({ input_tokens: 950, output_tokens: 520 }),
      makeMsg({ input_tokens: 1050, output_tokens: 490 }),
      makeMsg({ input_tokens: 980, output_tokens: 510 }),
      makeMsg({ input_tokens: 1020, output_tokens: 505 }),
      makeMsg({ input_tokens: 1070, output_tokens: 470 }),
      makeMsg({ input_tokens: 100_000, output_tokens: 50_000 }), // outlier
    ];
    const anomalies = detectAnomalies(msgs);
    expect(anomalies.length).toBe(1);
    expect(anomalies[0]!.totalTokens).toBe(150_000);
    expect(anomalies[0]!.timesAvg).toBeGreaterThan(1);
  });

  it("respects custom threshold", () => {
    // Many similar messages + one outlier
    const msgs: SpendingMessageRow[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(makeMsg({ input_tokens: 1000, output_tokens: 500 }));
    }
    msgs.push(makeMsg({ input_tokens: 50_000, output_tokens: 25_000 })); // big outlier

    // With default threshold of 2, this should be detected
    const anomaliesDefault = detectAnomalies(msgs, 2.0);
    expect(anomaliesDefault.length).toBe(1);

    // With very high threshold, nothing should be detected
    const anomaliesHigh = detectAnomalies(msgs, 100.0);
    expect(anomaliesHigh.length).toBe(0);
  });

  it("limits results to 10 and sorts by total tokens", () => {
    const msgs: SpendingMessageRow[] = [];
    // 5 normal messages
    for (let i = 0; i < 5; i++) {
      msgs.push(makeMsg({ input_tokens: 1000, output_tokens: 500 }));
    }
    // 12 outliers
    for (let i = 0; i < 12; i++) {
      msgs.push(makeMsg({ input_tokens: 100_000 + i * 1000, output_tokens: 50_000 }));
    }
    const anomalies = detectAnomalies(msgs);
    expect(anomalies.length).toBeLessThanOrEqual(10);
    // Should be sorted descending
    for (let i = 1; i < anomalies.length; i++) {
      expect(anomalies[i - 1]!.totalTokens).toBeGreaterThanOrEqual(anomalies[i]!.totalTokens);
    }
  });
});
