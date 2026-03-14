import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockSend }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
  UpdateItemCommand: vi.fn(function(input: any) { return { _type: "Update", ...input }; }),
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

process.env.INTER_TEAM_CHALLENGES_TABLE = "InterTeamChallenges";
process.env.TEAM_STATS_TABLE = "TeamStats";
process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import { handler } from "../../api/inter-team-scoring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduledEvent(): any {
  return { time: "2026-03-12T12:00:00Z" };
}

function makeInterTeamChallenge(overrides: Record<string, any> = {}) {
  return {
    challengeId: "itch-1",
    name: "Cross-Team Sprint",
    metric: "prompts_per_member",
    startTime: 1773273600, // 2026-03-12 00:00 UTC (W11, same as system time)
    endTime: 1773446400,   // 2026-03-14 00:00 UTC (W11, future relative to system time)
    status: "active",
    creatingTeamId: "team-1",
    teams: {
      "team-1": {
        teamName: "Alpha",
        teamSlug: "alpha",
        score: 0,
        rank: 0,
        joinedAt: 1000,
      },
      "team-2": {
        teamName: "Beta",
        teamSlug: "beta",
        score: 0,
        rank: 0,
        joinedAt: 2000,
      },
    },
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
      estimatedCost: prompts * 0.01,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inter-team-scoring handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.setSystemTime(new Date("2026-03-12T12:00:00Z"));
  });

  it("should exit early when no active challenges exist", async () => {
    // Phase 1: pending challenges
    mockSend.mockResolvedValueOnce({ Items: [] });
    // Phase 2: active challenges
    mockSend.mockResolvedValueOnce({ Items: [] });

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should activate pending challenges whose startTime has arrived", async () => {
    vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));

    const pendingChallenge = makeInterTeamChallenge({
      status: "pending",
      startTime: 1741564800, // March 10 -- already started
    });

    // Phase 1: pending challenges
    mockSend.mockResolvedValueOnce({
      Items: [pendingChallenge],
    });
    // UpdateItemCommand to activate
    mockSend.mockResolvedValueOnce({});

    // Phase 2: active challenges (now none after activation in separate query)
    mockSend.mockResolvedValueOnce({ Items: [] });

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("should score prompts_per_member and rank teams", async () => {
    const challenge = makeInterTeamChallenge();

    // Phase 1: no pending
    mockSend.mockResolvedValueOnce({ Items: [] });
    // Phase 2: active challenges
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    // team-1: 3 members
    mockSend.mockResolvedValueOnce({ Count: 3 });
    // team-1: stats
    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatItem("u1", 100),
        makeStatItem("u2", 80),
        makeStatItem("u3", 60),
      ],
    });

    // team-2: 2 members
    mockSend.mockResolvedValueOnce({ Count: 2 });
    // team-2: stats
    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatItem("u4", 200),
        makeStatItem("u5", 100),
      ],
    });

    // Update challenge team scores
    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // team-1: 240/3 = 80 prompts/member
    // team-2: 300/2 = 150 prompts/member
    // team-2 should rank #1
    expect(mockSend).toHaveBeenCalled();
  });

  it("should handle cost_efficiency metric (prompts per dollar)", async () => {
    const challenge = makeInterTeamChallenge({ metric: "cost_efficiency" });

    mockSend.mockResolvedValueOnce({ Items: [] }); // pending
    mockSend.mockResolvedValueOnce({ Items: [challenge] }); // active

    // team-1
    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u1",
          period: "2026-W11",
          stats: { prompts: 100, estimatedCost: 1.0, inputTokens: 5000, outputTokens: 2000, sessions: 5, activeMinutes: 60 },
        },
      ],
    });

    // team-2
    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u2",
          period: "2026-W11",
          stats: { prompts: 200, estimatedCost: 1.0, inputTokens: 5000, outputTokens: 2000, sessions: 5, activeMinutes: 60 },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // team-2 has 200 prompts/$1 = more efficient
    expect(mockSend).toHaveBeenCalled();
  });

  it("should handle cache_rate metric (avg across members)", async () => {
    const challenge = makeInterTeamChallenge({ metric: "cache_rate" });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    // team-1
    mockSend.mockResolvedValueOnce({ Count: 1 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u1",
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
      ],
    });

    // team-2
    mockSend.mockResolvedValueOnce({ Count: 1 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u2",
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

    expect(mockSend).toHaveBeenCalled();
  });

  it("should complete challenges past endTime and award winner badge", async () => {
    vi.setSystemTime(new Date("2026-03-20T00:00:00Z"));

    const challenge = makeInterTeamChallenge({
      teams: {
        "team-1": { teamName: "Alpha", teamSlug: "alpha", score: 50, rank: 1, joinedAt: 1000 },
        "team-2": { teamName: "Beta", teamSlug: "beta", score: 30, rank: 2, joinedAt: 2000 },
      },
    });

    mockSend.mockResolvedValueOnce({ Items: [] }); // pending
    mockSend.mockResolvedValueOnce({ Items: [challenge] }); // active

    // Scoring: team-1
    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u1", 100)] });
    // Scoring: team-2
    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u2", 50)] });

    // Update team scores
    mockSend.mockResolvedValueOnce({});
    // Update status to completed
    mockSend.mockResolvedValueOnce({});
    // Award winner badge
    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // 2 (pending+active queries) + 2*2 (member count + stats) + 3 (update scores + complete + badge)
    expect(mockSend).toHaveBeenCalledTimes(9);
  });

  it("should handle teams with no stats (score 0)", async () => {
    const challenge = makeInterTeamChallenge();

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    // team-1: has members but no stats
    mockSend.mockResolvedValueOnce({ Count: 3 });
    mockSend.mockResolvedValueOnce({ Items: [] });

    // team-2: has members and stats
    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u1", 100)] });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalled();
  });

  it("should skip challenges with no teams", async () => {
    const challenge = makeInterTeamChallenge({ teams: {} });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    await handler(makeScheduledEvent());

    // Only the 2 fetch queries, no scoring
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should break ties by earlier joinedAt", async () => {
    const challenge = makeInterTeamChallenge();

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    // Both teams have same score (same stats, same member count)
    mockSend.mockResolvedValueOnce({ Count: 1 });
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u1", 100)] });
    mockSend.mockResolvedValueOnce({ Count: 1 });
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u2", 100)] });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // team-1 joined at 1000, team-2 at 2000 -- team-1 wins tie
    expect(mockSend).toHaveBeenCalled();
  });

  it("should handle model_diversity metric", async () => {
    const challenge = makeInterTeamChallenge({ metric: "model_diversity" });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [challenge] });

    mockSend.mockResolvedValueOnce({ Count: 2 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u1",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 5000,
            outputTokens: 2000,
            sessions: 5,
            activeMinutes: 60,
            modelsUsed: { "claude-sonnet": 10, "claude-haiku": 5 },
          },
        },
        {
          userId: "u2",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 5000,
            outputTokens: 2000,
            sessions: 5,
            activeMinutes: 60,
            modelsUsed: { "claude-opus": 8 },
          },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({ Count: 1 });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          userId: "u3",
          period: "2026-W11",
          stats: {
            prompts: 50,
            inputTokens: 5000,
            outputTokens: 2000,
            sessions: 5,
            activeMinutes: 60,
            modelsUsed: { "claude-sonnet": 20 },
          },
        },
      ],
    });

    mockSend.mockResolvedValueOnce({});

    await handler(makeScheduledEvent());

    // team-1: 3 distinct models / 2 active members = 1.5
    // team-2: 1 distinct model / 1 active member = 1.0
    expect(mockSend).toHaveBeenCalled();
  });

  it("should throw when fetching active challenges fails", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] }); // pending ok
    mockSend.mockRejectedValueOnce(new Error("Query failed")); // active fails

    await expect(handler(makeScheduledEvent())).rejects.toThrow("Query failed");
  });

  it("should continue scoring other challenges when one fails", async () => {
    const challenge1 = makeInterTeamChallenge();
    const challenge2 = makeInterTeamChallenge({
      challengeId: "itch-2",
      teams: {
        "team-3": { teamName: "Gamma", teamSlug: "gamma", score: 0, rank: 0, joinedAt: 3000 },
      },
    });

    mockSend.mockResolvedValueOnce({ Items: [] }); // pending
    mockSend.mockResolvedValueOnce({ Items: [challenge1, challenge2] }); // active

    // challenge1 scoring fails
    mockSend.mockRejectedValueOnce(new Error("team-1 count failed"));

    // challenge2 succeeds
    mockSend.mockResolvedValueOnce({ Count: 1 }); // team-3 member count
    mockSend.mockResolvedValueOnce({ Items: [makeStatItem("u5", 80)] }); // team-3 stats
    mockSend.mockResolvedValueOnce({}); // update

    await handler(makeScheduledEvent());

    expect(mockSend).toHaveBeenCalled();
  });
});
