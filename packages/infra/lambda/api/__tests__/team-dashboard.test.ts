import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockSend }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
}));

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: (item: Record<string, any>) => {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(item)) {
      if (val && typeof val === "object" && "S" in val) result[key] = val.S;
      else if (val && typeof val === "object" && "N" in val)
        result[key] = Number(val.N);
      else if (val && typeof val === "object" && "BOOL" in val)
        result[key] = val.BOOL;
      else result[key] = val;
    }
    return result;
  },
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

process.env.TEAM_STATS_TABLE = "TeamStats";
process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";
process.env.ACHIEVEMENTS_TABLE = "Achievements";
process.env.CHALLENGES_TABLE = "Challenges";

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import { handler } from "../../api/team-dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  teamId: string,
  period: string,
  callerId: string,
): any {
  return {
    arguments: { teamId, period },
    identity: { sub: callerId },
  };
}

function makeMembershipItem(overrides: Record<string, any> = {}) {
  return {
    userId: "user-1",
    teamId: "team-1",
    displayName: "Alice",
    role: "MEMBER",
    shareLevel: "full",
    joinedAt: 1700000000,
    ...overrides,
  };
}

function makeTeamMetadata(overrides: Record<string, any> = {}) {
  return {
    teamName: "Test Team",
    teamSlug: "test-team",
    logoUrl: null,
    leaderboardEnabled: true,
    leaderboardCategories: [],
    challengesEnabled: true,
    minMembersForAggregates: 3,
    crossTeamVisibility: "PRIVATE",
    ...overrides,
  };
}

function makeStatRow(overrides: Record<string, any> = {}) {
  return {
    userId: "user-1",
    period: "2026-W11",
    sessions: 10,
    prompts: 50,
    inputTokens: 25000,
    outputTokens: 12000,
    estimatedCost: 1.5,
    activeMinutes: 120,
    modelsUsed: ["claude-sonnet-4-20250514"],
    topTools: ["Read", "Edit"],
    velocityTokensPerMin: 100,
    subagentRatio: 0.1,
    cacheReadTokens: 5000,
    cacheCreationTokens: 1000,
    currentStreak: 5,
    longestStreak: 10,
    weekendGraceEnabled: false,
    freezeTokensRemaining: 0,
    lastActiveDate: "2026-03-12",
    lastSyncedAt: 1741737600,
    activeHours: [9, 10, 11, 14, 15, 16],
    longestConversationMinutes: 45,
    longestConversationPrompts: 30,
    mostExpensiveTurnCost: 0.12,
    fastestSessionPrompts: 20,
    fastestSessionMinutes: 10,
    biggestCacheSavePercent: 85,
    biggestCacheSaveDollars: 0.5,
    maxToolsInOneTurn: 8,
    projectBreakdown: [
      { projectId: "proj-1", sessions: 5, prompts: 25, estimatedCost: 0.75 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("team-dashboard handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should throw if caller identity is missing", async () => {
    const event = {
      arguments: { teamId: "team-1", period: "2026-W11" },
      identity: {},
    };

    await expect(handler(event as any)).rejects.toThrow(
      "Unauthorized: missing caller identity",
    );
  });

  it("should throw if caller is not a team member", async () => {
    const event = makeEvent("team-1", "2026-W11", "stranger");

    // Query memberships returns members that don't include "stranger"
    mockSend.mockResolvedValueOnce({
      Items: [makeMembershipItem({ userId: "user-1" })],
    });

    // Team metadata query
    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    await expect(handler(event)).rejects.toThrow(
      "Unauthorized: you are not a member of this team",
    );
  });

  it("should return a dashboard for a valid team member", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    const member1 = makeMembershipItem();
    const member2 = makeMembershipItem({
      userId: "user-2",
      displayName: "Bob",
    });
    const member3 = makeMembershipItem({
      userId: "user-3",
      displayName: "Carol",
    });

    // 1. Query memberships (paginated, returns all)
    mockSend.mockResolvedValueOnce({
      Items: [member1, member2, member3],
    });

    // 2. Team metadata
    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    // 3. TeamStats query
    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow(),
        makeStatRow({ userId: "user-2" }),
        makeStatRow({ userId: "user-3" }),
      ],
    });

    // 4. Achievements queries (one per member)
    mockSend.mockResolvedValueOnce({ Items: [] }); // user-1
    mockSend.mockResolvedValueOnce({ Items: [] }); // user-2
    mockSend.mockResolvedValueOnce({ Items: [] }); // user-3

    // 5. Active challenge query
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    expect(result.team.teamId).toBe("team-1");
    expect(result.period).toBe("2026-W11");
    expect(result.team.memberCount).toBe(3);
    expect(result.aggregate).not.toBeNull();
    expect(result.aggregate!.activeMemberCount).toBe(3);
    expect(result.aggregate!.totalSessions).toBe(30);
    expect(result.memberCards).toHaveLength(3);
  });

  it("should return null aggregate when below minMembersForAggregates", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    // Only 2 members but minMembers = 3
    mockSend.mockResolvedValueOnce({
      Items: [
        makeMembershipItem(),
        makeMembershipItem({ userId: "user-2", displayName: "Bob" }),
      ],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata({ minMembersForAggregates: 3 })],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeStatRow(), makeStatRow({ userId: "user-2" })],
    });

    // Achievements
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    // Challenge
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    expect(result.aggregate).toBeNull();
    expect(result.leaderboard).toBeNull();
    expect(result.chemistry).toBeNull();
    expect(result.superlatives).toEqual([]);
  });

  it("should filter stats by share level - minimal hides cost/tools/projects", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    const member1 = makeMembershipItem({ shareLevel: "minimal" });
    const member2 = makeMembershipItem({
      userId: "user-2",
      displayName: "Bob",
      shareLevel: "full",
    });
    const member3 = makeMembershipItem({
      userId: "user-3",
      displayName: "Carol",
      shareLevel: "full",
    });

    mockSend.mockResolvedValueOnce({
      Items: [member1, member2, member3],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow(),
        makeStatRow({ userId: "user-2" }),
        makeStatRow({ userId: "user-3" }),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    const user1Card = result.memberCards.find((c) => c.userId === "user-1");
    expect(user1Card).toBeDefined();
    // Minimal share level hides these fields
    expect(user1Card!.stats!.estimatedCost).toBeNull();
    expect(user1Card!.stats!.modelsUsed).toBeNull();
    expect(user1Card!.stats!.topTools).toBeNull();
    expect(user1Card!.stats!.projectBreakdown).toBeNull();
    // But sessions and prompts remain visible
    expect(user1Card!.stats!.sessions).toBe(10);
    expect(user1Card!.stats!.prompts).toBe(50);
  });

  it("should filter stats by share level - summary hides cost/models/tools/projects", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    const member1 = makeMembershipItem({ shareLevel: "summary" });
    const member2 = makeMembershipItem({
      userId: "user-2",
      displayName: "Bob",
      shareLevel: "full",
    });
    const member3 = makeMembershipItem({
      userId: "user-3",
      displayName: "Carol",
      shareLevel: "full",
    });

    mockSend.mockResolvedValueOnce({
      Items: [member1, member2, member3],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow(),
        makeStatRow({ userId: "user-2" }),
        makeStatRow({ userId: "user-3" }),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    const user1Card = result.memberCards.find((c) => c.userId === "user-1");
    expect(user1Card!.stats!.estimatedCost).toBeNull();
    expect(user1Card!.stats!.modelsUsed).toBeNull();
    expect(user1Card!.stats!.topTools).toBeNull();
    expect(user1Card!.stats!.projectBreakdown).toBeNull();
    // Summary still sees velocity and tokens
    expect(user1Card!.stats!.inputTokens).toBe(25000);
    expect(user1Card!.stats!.velocityTokensPerMin).toBe(100);
  });

  it("should include full stats for full share level", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    const member1 = makeMembershipItem({ shareLevel: "full" });
    const member2 = makeMembershipItem({
      userId: "user-2",
      displayName: "Bob",
      shareLevel: "full",
    });
    const member3 = makeMembershipItem({
      userId: "user-3",
      displayName: "Carol",
      shareLevel: "full",
    });

    mockSend.mockResolvedValueOnce({
      Items: [member1, member2, member3],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow(),
        makeStatRow({ userId: "user-2" }),
        makeStatRow({ userId: "user-3" }),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    const user1Card = result.memberCards.find((c) => c.userId === "user-1");
    expect(user1Card!.stats!.estimatedCost).toBe(1.5);
    expect(user1Card!.stats!.topTools).toEqual(["Read", "Edit"]);
  });

  it("should exclude minimal share-level members from project summary", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    const member1 = makeMembershipItem({ shareLevel: "minimal" });
    const member2 = makeMembershipItem({
      userId: "user-2",
      displayName: "Bob",
      shareLevel: "full",
    });
    const member3 = makeMembershipItem({
      userId: "user-3",
      displayName: "Carol",
      shareLevel: "full",
    });

    mockSend.mockResolvedValueOnce({
      Items: [member1, member2, member3],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow({
          projectBreakdown: [
            { projectId: "proj-A", sessions: 3, prompts: 10, estimatedCost: 0.5 },
          ],
        }),
        makeStatRow({
          userId: "user-2",
          projectBreakdown: [
            { projectId: "proj-B", sessions: 5, prompts: 20, estimatedCost: 1.0 },
          ],
        }),
        makeStatRow({
          userId: "user-3",
          projectBreakdown: [
            { projectId: "proj-B", sessions: 3, prompts: 15, estimatedCost: 0.8 },
          ],
        }),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    // user-1 is minimal, so proj-A should not appear
    const projA = result.projectSummary.find((p) => p.projectId === "proj-A");
    expect(projA).toBeUndefined();

    // proj-B from user-2 and user-3 should be aggregated
    const projB = result.projectSummary.find((p) => p.projectId === "proj-B");
    expect(projB).toBeDefined();
    expect(projB!.sessions).toBe(8);
    expect(projB!.prompts).toBe(35);
  });

  it("should return empty member cards when no stats exist", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    mockSend.mockResolvedValueOnce({
      Items: [makeMembershipItem()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata({ minMembersForAggregates: 1 })],
    });

    // No stats
    mockSend.mockResolvedValueOnce({ Items: [] });

    // Achievements
    mockSend.mockResolvedValueOnce({ Items: [] });

    // Challenge
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    expect(result.memberCards).toHaveLength(1);
    expect(result.memberCards[0].stats).toBeNull();
    expect(result.memberCards[0].streak).toBeNull();
  });

  it("should use default settings when team metadata query fails", async () => {
    const event = makeEvent("team-1", "2026-W11", "user-1");

    mockSend.mockResolvedValueOnce({
      Items: [makeMembershipItem()],
    });

    // Team metadata query returns empty (no METADATA record)
    mockSend.mockResolvedValueOnce({ Items: [] });

    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const result = await handler(event);

    // Should use defaults
    expect(result.team.teamName).toBe("team-1");
    expect(result.team.settings.leaderboardEnabled).toBe(true);
    expect(result.team.settings.minMembersForAggregates).toBe(3);
  });
});
