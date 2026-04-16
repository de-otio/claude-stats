import { describe, it, expect } from "vitest";
import {
  isRufloTool,
  isRufloSession,
  extractRufloMethod,
  findRufloSessionIds,
  buildRufloInsights,
  buildRufloComparison,
} from "../ruflo.js";
import type { McpMessageRow, SessionRow } from "../store/index.js";
import type { McpServerUsage } from "../spending.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeMcpRow(overrides: Partial<McpMessageRow> = {}): McpMessageRow {
  return {
    uuid: `m-${Math.random().toString(36).slice(2, 8)}`,
    session_id: "sess-1",
    model: "claude-opus-4-6",
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_read_tokens: 5_000,
    cache_creation_tokens: 500,
    tools: "[]",
    project_path: "/tmp/test-project",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: `s-${Math.random().toString(36).slice(2, 8)}`,
    project_path: "/tmp/test-project",
    source_file: "/tmp/test.jsonl",
    first_timestamp: Date.now() - 3_600_000,
    last_timestamp: Date.now(),
    claude_version: "2.1.0",
    entrypoint: "claude",
    git_branch: "main",
    is_interactive: 1,
    prompt_count: 10,
    assistant_message_count: 10,
    input_tokens: 50_000,
    output_tokens: 10_000,
    cache_creation_tokens: 5_000,
    cache_read_tokens: 20_000,
    web_search_requests: 0,
    web_fetch_requests: 0,
    tool_use_counts: "[]",
    models: '["claude-opus-4-6"]',
    repo_url: null,
    account_uuid: null,
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: 1_200_000,
    median_response_time_ms: 3000,
    ...overrides,
  };
}

function makeRufloUsage(overrides: Partial<McpServerUsage> = {}): McpServerUsage {
  return {
    server: "ruflo",
    estimatedCost: 1.50,
    inputTokens: 80_000,
    outputTokens: 15_000,
    cacheReadTokens: 30_000,
    cacheCreationTokens: 5_000,
    messageCount: 10,
    callCount: 25,
    tools: [
      { method: "agent_spawn", calls: 10 },
      { method: "memory_search", calls: 8 },
      { method: "swarm_init", calls: 4 },
      { method: "hooks_route", calls: 3 },
    ],
    projects: ["/tmp/test-project"],
    ...overrides,
  };
}

// ── isRufloTool ─────────────────────────────────────────────────────────

describe("isRufloTool", () => {
  it("returns true for ruflo MCP tools", () => {
    expect(isRufloTool("mcp__ruflo__agent_spawn")).toBe(true);
    expect(isRufloTool("mcp__ruflo__memory_search")).toBe(true);
    expect(isRufloTool("mcp__ruflo__hooks__route")).toBe(true);
  });

  it("returns false for non-ruflo MCP tools", () => {
    expect(isRufloTool("mcp__doc-search__query")).toBe(false);
    expect(isRufloTool("mcp__github__list_issues")).toBe(false);
  });

  it("returns false for non-MCP tools", () => {
    expect(isRufloTool("Read")).toBe(false);
    expect(isRufloTool("Edit")).toBe(false);
    expect(isRufloTool("Bash")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isRufloTool("")).toBe(false);
  });

  it("returns false for partial prefix", () => {
    expect(isRufloTool("mcp__ruflo")).toBe(false);
    expect(isRufloTool("mcp__ruflo_")).toBe(false);
  });
});

// ── isRufloSession ──────────────────────────────────────────────────────

describe("isRufloSession", () => {
  it("returns true when array contains ruflo tool", () => {
    expect(isRufloSession(["Read", "mcp__ruflo__agent_spawn", "Edit"])).toBe(true);
  });

  it("returns false when no ruflo tools present", () => {
    expect(isRufloSession(["Read", "Edit", "mcp__doc-search__query"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(isRufloSession([])).toBe(false);
  });
});

// ── extractRufloMethod ──────────────────────────────────────────────────

describe("extractRufloMethod", () => {
  it("extracts method from standard ruflo tool name", () => {
    expect(extractRufloMethod("mcp__ruflo__agent_spawn")).toBe("agent_spawn");
    expect(extractRufloMethod("mcp__ruflo__memory_search")).toBe("memory_search");
  });

  it("preserves nested method names", () => {
    expect(extractRufloMethod("mcp__ruflo__hooks__route")).toBe("hooks__route");
  });

  it("returns original for non-standard format", () => {
    expect(extractRufloMethod("Read")).toBe("Read");
    expect(extractRufloMethod("mcp__ruflo")).toBe("mcp__ruflo");
  });
});

// ── findRufloSessionIds ─────────────────────────────────────────────────

describe("findRufloSessionIds", () => {
  it("finds sessions with ruflo tools", () => {
    const rows = [
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__agent_spawn"]' }),
      makeMcpRow({ session_id: "s2", tools: '["mcp__doc-search__query"]' }),
      makeMcpRow({ session_id: "s3", tools: '["mcp__ruflo__memory_search", "Read"]' }),
    ];
    const ids = findRufloSessionIds(rows);
    expect(ids.size).toBe(2);
    expect(ids.has("s1")).toBe(true);
    expect(ids.has("s3")).toBe(true);
    expect(ids.has("s2")).toBe(false);
  });

  it("returns empty set when no ruflo tools", () => {
    const rows = [
      makeMcpRow({ tools: '["mcp__github__list_issues"]' }),
      makeMcpRow({ tools: '["Read", "Edit"]' }),
    ];
    expect(findRufloSessionIds(rows).size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(findRufloSessionIds([]).size).toBe(0);
  });

  it("deduplicates session IDs across multiple messages", () => {
    const rows = [
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__agent_spawn"]' }),
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__memory_search"]' }),
    ];
    expect(findRufloSessionIds(rows).size).toBe(1);
  });

  it("handles invalid JSON gracefully", () => {
    const rows = [
      makeMcpRow({ session_id: "s1", tools: "not json" }),
      makeMcpRow({ session_id: "s2", tools: '["mcp__ruflo__agent_spawn"]' }),
    ];
    const ids = findRufloSessionIds(rows);
    expect(ids.size).toBe(1);
    expect(ids.has("s2")).toBe(true);
  });
});

// ── buildRufloInsights ──────────────────────────────────────────────────

describe("buildRufloInsights", () => {
  it("returns detected: false when no ruflo server in usage", () => {
    const result = buildRufloInsights([], [], [makeSession()], 10.0);
    expect(result.detected).toBe(false);
    expect(result.sessionCount).toBe(0);
    expect(result.totalSessions).toBe(1);
    expect(result.serverUsage).toBeNull();
    expect(result.topMethods).toEqual([]);
    expect(result.costBreakdown.rufloCost).toBe(0);
    expect(result.costBreakdown.totalCost).toBe(10.0);
    expect(result.costBreakdown.rufloSharePct).toBe(0);
    expect(result.comparison).toBeNull();
  });

  it("returns detected: true with correct metrics when ruflo is active", () => {
    const sessions = [
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
      makeSession({ session_id: "s4" }),
      makeSession({ session_id: "s5" }),
      makeSession({ session_id: "s6" }),
    ];
    const mcpMessages = [
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__agent_spawn"]' }),
      makeMcpRow({ session_id: "s2", tools: '["mcp__ruflo__memory_search"]' }),
      makeMcpRow({ session_id: "s3", tools: '["mcp__ruflo__swarm_init"]' }),
    ];
    const usage = [makeRufloUsage()];

    const result = buildRufloInsights(mcpMessages, usage, sessions, 20.0);

    expect(result.detected).toBe(true);
    expect(result.sessionCount).toBe(3);
    expect(result.totalSessions).toBe(6);
    expect(result.adoptionRate).toBe(0.5);
    expect(result.serverUsage).toBeTruthy();
    expect(result.topMethods.length).toBe(4);
    expect(result.topMethods[0]!.method).toBe("agent_spawn");
    expect(result.costBreakdown.rufloCost).toBe(1.50);
    expect(result.costBreakdown.rufloSharePct).toBe(7.5);
  });

  it("computes method-level cost proportionally", () => {
    const sessions = [makeSession({ session_id: "s1" })];
    const mcpMessages = [
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__agent_spawn"]' }),
    ];
    const usage = [makeRufloUsage({ estimatedCost: 10.0, callCount: 25 })];

    const result = buildRufloInsights(mcpMessages, usage, sessions, 100.0);

    // agent_spawn has 10 of 25 calls = 40% of $10 = $4
    const agentSpawn = result.topMethods.find(m => m.method === "agent_spawn");
    expect(agentSpawn).toBeDefined();
    expect(agentSpawn!.estimatedCost).toBe(4.0);
  });

  it("handles zero total cost", () => {
    const sessions = [makeSession({ session_id: "s1" })];
    const mcpMessages = [
      makeMcpRow({ session_id: "s1", tools: '["mcp__ruflo__agent_spawn"]' }),
    ];
    const usage = [makeRufloUsage({ estimatedCost: 0 })];

    const result = buildRufloInsights(mcpMessages, usage, sessions, 0);
    expect(result.detected).toBe(true);
    expect(result.costBreakdown.rufloSharePct).toBe(0);
  });

  it("handles empty session list", () => {
    const result = buildRufloInsights([], [makeRufloUsage()], [], 0);
    expect(result.detected).toBe(true);
    expect(result.adoptionRate).toBe(0);
    expect(result.sessionCount).toBe(0);
  });

  it("ignores non-ruflo servers in usage array", () => {
    const otherServer: McpServerUsage = {
      server: "doc-search",
      estimatedCost: 5.0,
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 1_000,
      cacheCreationTokens: 500,
      messageCount: 5,
      callCount: 10,
      tools: [{ method: "query", calls: 10 }],
      projects: ["/tmp/test"],
    };
    const result = buildRufloInsights([], [otherServer], [makeSession()], 10.0);
    expect(result.detected).toBe(false);
  });
});

// ── buildRufloComparison ────────────────────────────────────────────────

describe("buildRufloComparison", () => {
  it("returns null when ruflo cohort is too small", () => {
    const sessions = [
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
      makeSession({ session_id: "s4" }),
    ];
    // Only 2 ruflo sessions (< MIN_COHORT_SIZE = 3)
    const rufloIds = new Set(["s1", "s2"]);
    expect(buildRufloComparison(sessions, rufloIds)).toBeNull();
  });

  it("returns null when baseline cohort is too small", () => {
    const sessions = [
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
      makeSession({ session_id: "s4" }),
    ];
    // 3 ruflo + 1 baseline (< MIN_COHORT_SIZE = 3)
    const rufloIds = new Set(["s1", "s2", "s3"]);
    expect(buildRufloComparison(sessions, rufloIds)).toBeNull();
  });

  it("returns null when all sessions are ruflo (no baseline)", () => {
    const sessions = [
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2" }),
      makeSession({ session_id: "s3" }),
    ];
    const rufloIds = new Set(["s1", "s2", "s3"]);
    expect(buildRufloComparison(sessions, rufloIds)).toBeNull();
  });

  it("computes comparison with sufficient data", () => {
    const rufloSessions = [
      makeSession({ session_id: "r1", input_tokens: 30_000, output_tokens: 8_000, prompt_count: 20, cache_read_tokens: 15_000, cache_creation_tokens: 3_000 }),
      makeSession({ session_id: "r2", input_tokens: 35_000, output_tokens: 9_000, prompt_count: 22, cache_read_tokens: 18_000, cache_creation_tokens: 4_000 }),
      makeSession({ session_id: "r3", input_tokens: 32_000, output_tokens: 8_500, prompt_count: 21, cache_read_tokens: 16_000, cache_creation_tokens: 3_500 }),
    ];
    const baselineSessions = [
      makeSession({ session_id: "b1", input_tokens: 50_000, output_tokens: 12_000, prompt_count: 15, cache_read_tokens: 10_000, cache_creation_tokens: 5_000 }),
      makeSession({ session_id: "b2", input_tokens: 55_000, output_tokens: 13_000, prompt_count: 14, cache_read_tokens: 11_000, cache_creation_tokens: 5_500 }),
      makeSession({ session_id: "b3", input_tokens: 52_000, output_tokens: 12_500, prompt_count: 13, cache_read_tokens: 10_500, cache_creation_tokens: 5_200 }),
    ];

    const allSessions = [...rufloSessions, ...baselineSessions];
    const rufloIds = new Set(["r1", "r2", "r3"]);

    const result = buildRufloComparison(allSessions, rufloIds);
    expect(result).not.toBeNull();
    expect(result!.rufloSessions.count).toBe(3);
    expect(result!.baselineSessions.count).toBe(3);

    // Ruflo sessions have fewer tokens per prompt (lower is better)
    expect(result!.rufloSessions.avgTokensPerPrompt).toBeLessThan(
      result!.baselineSessions.avgTokensPerPrompt,
    );
    // Delta should be negative (ruflo uses fewer tokens per prompt)
    expect(result!.deltas.tokensPerPrompt).toBeLessThan(0);

    // Ruflo sessions have more prompts per session
    expect(result!.rufloSessions.avgPromptsPerSession).toBeGreaterThan(
      result!.baselineSessions.avgPromptsPerSession,
    );
    expect(result!.deltas.promptsPerSession).toBeGreaterThan(0);
  });

  it("computes per-session cache hit rate (not global ratio)", () => {
    // Session with 50% cache hit rate
    const s1 = makeSession({
      session_id: "r1",
      input_tokens: 1_000,
      cache_read_tokens: 1_000,
      cache_creation_tokens: 0,
    });
    // Session with 0% cache hit rate
    const s2 = makeSession({
      session_id: "r2",
      input_tokens: 5_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    // Session with 100% cache hit rate
    const s3 = makeSession({
      session_id: "r3",
      input_tokens: 0,
      cache_read_tokens: 2_000,
      cache_creation_tokens: 0,
    });

    const baselines = [
      makeSession({ session_id: "b1" }),
      makeSession({ session_id: "b2" }),
      makeSession({ session_id: "b3" }),
    ];

    const allSessions = [s1, s2, s3, ...baselines];
    const rufloIds = new Set(["r1", "r2", "r3"]);
    const result = buildRufloComparison(allSessions, rufloIds);

    expect(result).not.toBeNull();
    // Per-session average: (50% + 0% + 100%) / 3 = 50%
    expect(result!.rufloSessions.avgCacheHitRate).toBe(50.0);
  });

  it("handles sessions with zero prompts", () => {
    const sessions = [
      makeSession({ session_id: "r1", prompt_count: 0, input_tokens: 0, output_tokens: 0 }),
      makeSession({ session_id: "r2", prompt_count: 5 }),
      makeSession({ session_id: "r3", prompt_count: 10 }),
      makeSession({ session_id: "b1" }),
      makeSession({ session_id: "b2" }),
      makeSession({ session_id: "b3" }),
    ];
    const rufloIds = new Set(["r1", "r2", "r3"]);
    const result = buildRufloComparison(sessions, rufloIds);
    expect(result).not.toBeNull();
    // Should not crash on division by zero
    expect(result!.rufloSessions.avgTokensPerPrompt).toBeGreaterThanOrEqual(0);
  });

  it("uses active_duration_ms when available, falls back to timestamp diff", () => {
    const withActive = makeSession({
      session_id: "r1",
      active_duration_ms: 600_000,
      first_timestamp: Date.now() - 7_200_000,
      last_timestamp: Date.now(),
    });
    const withoutActive = makeSession({
      session_id: "r2",
      active_duration_ms: null,
      first_timestamp: Date.now() - 1_800_000,
      last_timestamp: Date.now(),
    });
    const withActive2 = makeSession({
      session_id: "r3",
      active_duration_ms: 900_000,
    });

    const baselines = [
      makeSession({ session_id: "b1", active_duration_ms: 500_000 }),
      makeSession({ session_id: "b2", active_duration_ms: 500_000 }),
      makeSession({ session_id: "b3", active_duration_ms: 500_000 }),
    ];

    const rufloIds = new Set(["r1", "r2", "r3"]);
    const result = buildRufloComparison([withActive, withoutActive, withActive2, ...baselines], rufloIds);
    expect(result).not.toBeNull();

    // r1: 600_000, r2: 1_800_000 (fallback), r3: 900_000
    // avg = (600_000 + 1_800_000 + 900_000) / 3 = 1_100_000
    expect(result!.rufloSessions.avgDurationMs).toBe(1_100_000);
  });

  it("tracks truncation rate from throttle_events", () => {
    const sessions = [
      makeSession({ session_id: "r1", throttle_events: 3 }),
      makeSession({ session_id: "r2", throttle_events: 0 }),
      makeSession({ session_id: "r3", throttle_events: 1 }),
      makeSession({ session_id: "b1", throttle_events: 0 }),
      makeSession({ session_id: "b2", throttle_events: 0 }),
      makeSession({ session_id: "b3", throttle_events: 0 }),
    ];
    const rufloIds = new Set(["r1", "r2", "r3"]);
    const result = buildRufloComparison(sessions, rufloIds);
    expect(result).not.toBeNull();
    // 2 of 3 ruflo sessions have throttle_events > 0
    expect(result!.rufloSessions.truncationRate).toBe(66.7);
    expect(result!.baselineSessions.truncationRate).toBe(0);
    expect(result!.deltas.truncationRate).toBe(66.7);
  });
});
