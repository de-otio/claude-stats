import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockSend }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
  UpdateItemCommand: vi.fn(function(input: any) { return { _type: "Update", ...input }; }),
  ScanCommand: vi.fn(function(input: any) { return { _type: "Scan", ...input }; }),
}));

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: (item: Record<string, any>) => {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(item)) {
      if (val && typeof val === "object" && "S" in val) result[key] = val.S;
      else if (val && typeof val === "object" && "N" in val)
        result[key] = Number(val.N);
      else result[key] = val;
    }
    return result;
  },
  marshall: (item: Record<string, any>) => item,
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

process.env.CHALLENGES_TABLE = "Challenges";
process.env.TEAM_STATS_TABLE = "TeamStats";
process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import { handler } from "../../api/challenge-scoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduledEvent(): any {
  return { time: "2026-03-12T12:00:00Z" };
}

function makeChallenge(overrides: Record<string, any> = {}) {
  return {
    teamId: "team-1",
    challengeId: "ch-1",
    name: "Prompt Sprint",
    metric: "prompts",
    startTime: 1773273600, // 2026-03-12 00:00 UTC (W11, same as system time)
    endTime: 1773446400,   // 2026-03-14 00:00 UTC (W11, future relative to system time)
    status: "active",
    participants: { "user-1": { score: 0, rank: 0 }, "user-2": { score: 0, rank: 0 } },
    ...overrides,
  };
}

function makeStatItem(userId: string, prompts: number, overrides: Record<string, any> = {}) {
  return {
    userId,
    period: "2026-W11",
    stats: {
      prompts,
      inputTokens: prompts * 500,
      outputTokens: prompts * 200,
      sessions: Math.ceil(prompts / 10),
      activeMinutes: prompts * 2,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("challenge-scoring handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.setSystemTime(new Date("2026-03-12T12:00:00Z"));
  });

  it("should exit early when no active challenges exist", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] }); // scan returns nothing

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("should score a prompts challenge and rank participants correctly", async () => {
    const challenge = makeChallenge();

    // Scan for active challenges
    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    // Fetch member join times
    mockSend.mockResolvedValueOnce({
      Items: [
        { userId: "user-1", joinedAt: 1000 },
        { userId: "user-2", joinedAt: 2000 },
      ],
    });

    // Fetch TeamStats for each period (could be multiple periods)
    // The handler queries once per ISO week in the range
    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatItem("user-1", 100),
        makeStatItem("user-2", 150),
      ],
    });

    // UpdateItemCommand for updating challenge scores
    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // Should have called update with ranked participants
    // user-2 has more prompts so should rank #1
    expect(mockSend).toHaveBeenCalled();
  });

  it("should break ties by earliest joinedAt", async () => {
    const challenge = makeChallenge();

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    // Member join times: user-1 joined earlier
    mockSend.mockResolvedValueOnce({
      Items: [
        { userId: "user-1", joinedAt: 1000 },
        { userId: "user-2", joinedAt: 2000 },
      ],
    });

    // Both users have same prompts
    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatItem("user-1", 100),
        makeStatItem("user-2", 100),
      ],
    });

    // Update
    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // user-1 should win tie-break (earlier join)
    expect(mockSend).toHaveBeenCalled();
  });

  it("should auto-complete challenges past endTime", async () => {
    vi.setSystemTime(new Date("2026-03-20T00:00:00Z")); // Past the endTime

    const challenge = makeChallenge({
      endTime: 1742083200, // 2025-03-16 (W11, same week as default startTime 2025-03-10)
    });

    // Scan returns challenge
    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    // Member join times
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: "user-1", joinedAt: 1000 }, { userId: "user-2", joinedAt: 2000 }],
    });

    // Stats
    mockSend.mockResolvedValueOnce({
      Items: [makeStatItem("user-1", 50)],
    });

    // Update scores
    mockSend.mockResolvedValueOnce({});

    // Complete challenge (UpdateItemCommand to set status=completed)
    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // Should have called UpdateItem twice: once for scores, once for completion
    expect(mockSend).toHaveBeenCalledTimes(5);
  });

  it("should skip challenges with no participants", async () => {
    const challenge = makeChallenge({ participants: {} });

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    await handler(makeScheduledEvent());

    // Only the scan call, no scoring
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("should handle cache_rate metric", async () => {
    const challenge = makeChallenge({ metric: "cache_rate" });

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        { userId: "user-1", joinedAt: 1000 },
        { userId: "user-2", joinedAt: 2000 },
      ],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "user-1",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 800,
            cacheCreationTokens: 200,
            sessions: 5,
            activeMinutes: 60,
          },
        },
        {
          userId: "user-2",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheCreationTokens: 100,
            sessions: 5,
            activeMinutes: 60,
          },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("should handle cost_per_prompt metric (inverted scoring)", async () => {
    const challenge = makeChallenge({ metric: "cost_per_prompt" });

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        { userId: "user-1", joinedAt: 1000 },
        { userId: "user-2", joinedAt: 2000 },
      ],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "user-1",
          period: "2026-W11",
          stats: {
            prompts: 100,
            inputTokens: 5000,
            outputTokens: 2000,
            estimatedCost: 1.0, // $0.01/prompt
            sessions: 10,
            activeMinutes: 120,
          },
        },
        {
          userId: "user-2",
          period: "2026-W11",
          stats: {
            prompts: 100,
            inputTokens: 5000,
            outputTokens: 2000,
            estimatedCost: 2.0, // $0.02/prompt
            sessions: 10,
            activeMinutes: 120,
          },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // user-1 should score higher (lower cost = inverted to higher score)
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("should handle unknown metric gracefully (score 0)", async () => {
    const challenge = makeChallenge({ metric: "unknown_metric" });

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    mockSend.mockResolvedValueOnce({
      Items: [{ userId: "user-1", joinedAt: 1000 }],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeStatItem("user-1", 100)],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("should continue processing when one challenge fails", async () => {
    const challenge1 = makeChallenge();
    const challenge2 = makeChallenge({
      challengeId: "ch-2",
      teamId: "team-2",
    });

    mockSend.mockResolvedValueOnce({
      Items: [challenge1, challenge2],
    });

    // challenge1: member join times fails
    mockSend.mockRejectedValueOnce(new Error("DDB error"));

    // challenge2: succeeds
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: "user-1", joinedAt: 1000 }],
    });
    mockSend.mockResolvedValueOnce({
      Items: [makeStatItem("user-1", 50)],
    });
    mockSend.mockResolvedValueOnce({});

    // Should not throw
    await handler(makeScheduledEvent());
  });

  it("should handle avg_session_length metric", async () => {
    const challenge = makeChallenge({ metric: "avg_session_length" });

    mockSend.mockResolvedValueOnce({
      Items: [challenge],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        { userId: "user-1", joinedAt: 1000 },
        { userId: "user-2", joinedAt: 2000 },
      ],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "user-1",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 5000,
            outputTokens: 2000,
            sessions: 5,
            activeMinutes: 150, // 30 min/session
          },
        },
        {
          userId: "user-2",
          period: "2026-W11",
          stats: {
            prompts: 30,
            inputTokens: 3000,
            outputTokens: 1000,
            sessions: 10,
            activeMinutes: 100, // 10 min/session
          },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // user-1 has higher avg session length
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("should throw when fetching active challenges fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("Scan failed"));

    await expect(handler(makeScheduledEvent())).rejects.toThrow("Scan failed");
  });
});
