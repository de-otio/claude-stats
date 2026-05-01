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
// Import handler after mocks
// ---------------------------------------------------------------------------

import { handler } from "../../../api/team-dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ShareLevel = "full" | "summary" | "minimal";

function makeEvent(teamId: string, period: string, callerId: string): any {
  return {
    arguments: { teamId, period },
    identity: { sub: callerId },
  };
}

function makeMemberItem(
  userId: string,
  displayName: string,
  shareLevel: ShareLevel,
  role = "MEMBER",
) {
  return {
    userId,
    teamId: "team-share-test",
    displayName,
    role,
    shareLevel,
    joinedAt: 1700000000,
  };
}

function makeTeamMetadata() {
  return {
    teamName: "Share Level Test Team",
    teamSlug: "share-level-test",
    logoUrl: null,
    leaderboardEnabled: false,
    leaderboardCategories: [],
    challengesEnabled: false,
    minMembersForAggregates: 1, // allow aggregate with even 1 member
    crossTeamVisibility: "PRIVATE",
  };
}

function makeStatRow(userId: string, overrides: Record<string, any> = {}) {
  return {
    userId,
    period: "2026-W11",
    sessions: 15,
    prompts: 75,
    inputTokens: 30000,
    outputTokens: 15000,
    estimatedCost: 2.5,
    activeMinutes: 180,
    modelsUsed: ["claude-sonnet-4-20250514", "claude-haiku-4-20250307"],
    topTools: ["Read", "Edit", "Bash", "Glob"],
    velocityTokensPerMin: 150,
    subagentRatio: 0.2,
    cacheReadTokens: 8000,
    cacheCreationTokens: 2000,
    currentStreak: 7,
    longestStreak: 14,
    weekendGraceEnabled: true,
    freezeTokensRemaining: 2,
    lastActiveDate: "2026-03-11",
    lastSyncedAt: 1741737600,
    activeHours: [9, 10, 11, 12, 14, 15, 16, 20, 21],
    longestConversationMinutes: 90,
    longestConversationPrompts: 60,
    mostExpensiveTurnCost: 0.25,
    fastestSessionPrompts: 30,
    fastestSessionMinutes: 5,
    biggestCacheSavePercent: 72,
    biggestCacheSaveDollars: 1.2,
    maxToolsInOneTurn: 12,
    projectBreakdown: [
      { projectId: "proj-alpha", sessions: 8, prompts: 40, estimatedCost: 1.5 },
      { projectId: "proj-beta", sessions: 7, prompts: 35, estimatedCost: 1.0 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test: minimal share level
// ---------------------------------------------------------------------------

describe("share-level integration: minimal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("minimal share level: only streak and aggregate counts are visible", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    // Members: viewer + alice (minimal) + bob (full) + carol (full)
    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "minimal"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({
      Items: [makeTeamMetadata()],
    });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer"),
        makeStatRow("user-alice"),
        makeStatRow("user-bob"),
        makeStatRow("user-carol"),
      ],
    });

    // Achievements (4 members)
    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const aliceCard = result.memberCards.find(
      (c) => c.userId === "user-alice",
    );
    expect(aliceCard).toBeDefined();

    // Streak should always be visible regardless of share level
    expect(aliceCard!.streak).not.toBeNull();
    expect(aliceCard!.streak!.currentStreak).toBe(7);
    expect(aliceCard!.streak!.longestStreak).toBe(14);

    // Core counts visible at minimal level
    expect(aliceCard!.stats).not.toBeNull();
    expect(aliceCard!.stats!.sessions).toBe(15);
    expect(aliceCard!.stats!.prompts).toBe(75);

    // Sensitive fields MUST be null at minimal level
    expect(aliceCard!.stats!.inputTokens).toBeNull();
    expect(aliceCard!.stats!.outputTokens).toBeNull();
    expect(aliceCard!.stats!.estimatedCost).toBeNull();
    expect(aliceCard!.stats!.activeMinutes).toBeNull();
    expect(aliceCard!.stats!.modelsUsed).toBeNull();
    expect(aliceCard!.stats!.topTools).toBeNull();
    expect(aliceCard!.stats!.velocityTokensPerMin).toBeNull();
    expect(aliceCard!.stats!.subagentRatio).toBeNull();
    expect(aliceCard!.stats!.projectBreakdown).toBeNull();
  });

  it("minimal share level: member does not contribute to project summary", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "minimal"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer", {
          projectBreakdown: [
            { projectId: "proj-viewer", sessions: 5, prompts: 20, estimatedCost: 0.8 },
          ],
        }),
        makeStatRow("user-alice", {
          projectBreakdown: [
            { projectId: "proj-alice-exclusive", sessions: 10, prompts: 50, estimatedCost: 2.0 },
          ],
        }),
        makeStatRow("user-bob", {
          projectBreakdown: [
            { projectId: "proj-shared", sessions: 3, prompts: 12, estimatedCost: 0.5 },
          ],
        }),
        makeStatRow("user-carol", {
          projectBreakdown: [
            { projectId: "proj-shared", sessions: 2, prompts: 8, estimatedCost: 0.3 },
          ],
        }),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const projectIds = result.projectSummary.map((p) => p.projectId);

    // Alice is minimal — her project should NOT appear
    expect(projectIds).not.toContain("proj-alice-exclusive");

    // Bob and Carol's shared project should be aggregated
    const sharedProject = result.projectSummary.find(
      (p) => p.projectId === "proj-shared",
    );
    expect(sharedProject).toBeDefined();
    expect(sharedProject!.sessions).toBe(5);
    expect(sharedProject!.prompts).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Test: summary share level
// ---------------------------------------------------------------------------

describe("share-level integration: summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("summary share level: project breakdown is visible, prompts and tokens visible but cost hidden", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "summary"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer"),
        makeStatRow("user-alice"),
        makeStatRow("user-bob"),
        makeStatRow("user-carol"),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const aliceCard = result.memberCards.find(
      (c) => c.userId === "user-alice",
    );
    expect(aliceCard).toBeDefined();

    // Sessions, prompts, tokens, velocity visible at summary level
    expect(aliceCard!.stats!.sessions).toBe(15);
    expect(aliceCard!.stats!.prompts).toBe(75);
    expect(aliceCard!.stats!.inputTokens).toBe(30000);
    expect(aliceCard!.stats!.outputTokens).toBe(15000);
    expect(aliceCard!.stats!.velocityTokensPerMin).toBe(150);
    expect(aliceCard!.stats!.subagentRatio).toBe(0.2);

    // These fields are hidden at summary level (according to filterStatsByShareLevel)
    expect(aliceCard!.stats!.estimatedCost).toBeNull();
    expect(aliceCard!.stats!.modelsUsed).toBeNull();
    expect(aliceCard!.stats!.topTools).toBeNull();
    expect(aliceCard!.stats!.projectBreakdown).toBeNull();
  });

  it("summary share level: member contributes to project summary", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "summary"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer", {
          projectBreakdown: [],
        }),
        makeStatRow("user-alice", {
          projectBreakdown: [
            { projectId: "proj-alice", sessions: 6, prompts: 30, estimatedCost: 1.1 },
          ],
        }),
        makeStatRow("user-bob", {
          projectBreakdown: [],
        }),
        makeStatRow("user-carol", {
          projectBreakdown: [],
        }),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    // Summary members DO contribute to project summary (unlike minimal)
    const projectIds = result.projectSummary.map((p) => p.projectId);
    expect(projectIds).toContain("proj-alice");
  });
});

// ---------------------------------------------------------------------------
// Test: full share level
// ---------------------------------------------------------------------------

describe("share-level integration: full", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("full share level: all fields are visible", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "full"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer"),
        makeStatRow("user-alice"),
        makeStatRow("user-bob"),
        makeStatRow("user-carol"),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const aliceCard = result.memberCards.find(
      (c) => c.userId === "user-alice",
    );
    expect(aliceCard).toBeDefined();

    // All fields should be present at full level
    expect(aliceCard!.stats!.sessions).toBe(15);
    expect(aliceCard!.stats!.prompts).toBe(75);
    expect(aliceCard!.stats!.inputTokens).toBe(30000);
    expect(aliceCard!.stats!.outputTokens).toBe(15000);
    expect(aliceCard!.stats!.estimatedCost).toBe(2.5);
    expect(aliceCard!.stats!.activeMinutes).toBe(180);
    expect(aliceCard!.stats!.modelsUsed).toBe(
      JSON.stringify(["claude-sonnet-4-20250514", "claude-haiku-4-20250307"]),
    );
    expect(aliceCard!.stats!.topTools).toEqual(["Read", "Edit", "Bash", "Glob"]);
    expect(aliceCard!.stats!.velocityTokensPerMin).toBe(150);
    expect(aliceCard!.stats!.subagentRatio).toBe(0.2);
    expect(aliceCard!.stats!.projectBreakdown).toHaveLength(2);
  });

  it("full share level: streak is visible with all streak fields", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "full"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer"),
        makeStatRow("user-alice"),
        makeStatRow("user-bob"),
        makeStatRow("user-carol"),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const aliceCard = result.memberCards.find(
      (c) => c.userId === "user-alice",
    );

    expect(aliceCard!.streak).not.toBeNull();
    expect(aliceCard!.streak!.currentStreak).toBe(7);
    expect(aliceCard!.streak!.longestStreak).toBe(14);
    expect(aliceCard!.streak!.weekendGraceEnabled).toBe(true);
    expect(aliceCard!.streak!.freezeTokensRemaining).toBe(2);
    expect(aliceCard!.streak!.lastActiveDate).toBe("2026-03-11");
  });

  it("full share level: project breakdown is included in project summary", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-viewer");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-viewer", "Viewer", "full"),
        makeMemberItem("user-alice", "Alice", "full"),
        makeMemberItem("user-bob", "Bob", "full"),
        makeMemberItem("user-carol", "Carol", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-viewer", {
          projectBreakdown: [
            { projectId: "proj-x", sessions: 3, prompts: 15, estimatedCost: 0.6 },
          ],
        }),
        makeStatRow("user-alice", {
          projectBreakdown: [
            { projectId: "proj-x", sessions: 5, prompts: 25, estimatedCost: 1.0 },
            { projectId: "proj-y", sessions: 2, prompts: 10, estimatedCost: 0.4 },
          ],
        }),
        makeStatRow("user-bob", {
          projectBreakdown: [
            { projectId: "proj-y", sessions: 4, prompts: 20, estimatedCost: 0.8 },
          ],
        }),
        makeStatRow("user-carol", {
          projectBreakdown: [],
        }),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    const projX = result.projectSummary.find((p) => p.projectId === "proj-x");
    const projY = result.projectSummary.find((p) => p.projectId === "proj-y");

    expect(projX).toBeDefined();
    expect(projX!.sessions).toBe(8); // viewer(3) + alice(5)
    expect(projX!.prompts).toBe(40); // viewer(15) + alice(25)

    expect(projY).toBeDefined();
    expect(projY!.sessions).toBe(6); // alice(2) + bob(4)
    expect(projY!.prompts).toBe(30); // alice(10) + bob(20)
  });
});

// ---------------------------------------------------------------------------
// Test: mixed share levels in the same team
// ---------------------------------------------------------------------------

describe("share-level integration: mixed share levels in same team", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("each member's card shows only fields appropriate for their own share level", async () => {
    const event = makeEvent("team-share-test", "2026-W11", "user-alice");

    mockSend.mockResolvedValueOnce({
      Items: [
        makeMemberItem("user-alice", "Alice", "minimal"),
        makeMemberItem("user-bob", "Bob", "summary"),
        makeMemberItem("user-carol", "Carol", "full"),
        makeMemberItem("user-dave", "Dave", "full"),
      ],
    });

    mockSend.mockResolvedValueOnce({ Items: [makeTeamMetadata()] });

    mockSend.mockResolvedValueOnce({
      Items: [
        makeStatRow("user-alice"),
        makeStatRow("user-bob"),
        makeStatRow("user-carol"),
        makeStatRow("user-dave"),
      ],
    });

    mockSend.mockResolvedValue({ Items: [] });

    const result = await handler(event);

    // Alice: minimal
    const aliceCard = result.memberCards.find((c) => c.userId === "user-alice")!;
    expect(aliceCard.stats!.estimatedCost).toBeNull();
    expect(aliceCard.stats!.inputTokens).toBeNull();
    expect(aliceCard.stats!.modelsUsed).toBeNull();
    expect(aliceCard.stats!.sessions).toBe(15);

    // Bob: summary — tokens visible, cost hidden
    const bobCard = result.memberCards.find((c) => c.userId === "user-bob")!;
    expect(bobCard.stats!.estimatedCost).toBeNull();
    expect(bobCard.stats!.inputTokens).toBe(30000);
    expect(bobCard.stats!.velocityTokensPerMin).toBe(150);
    expect(bobCard.stats!.modelsUsed).toBeNull();

    // Carol: full — everything visible
    const carolCard = result.memberCards.find((c) => c.userId === "user-carol")!;
    expect(carolCard.stats!.estimatedCost).toBe(2.5);
    expect(carolCard.stats!.inputTokens).toBe(30000);
    expect(carolCard.stats!.modelsUsed).not.toBeNull();
    expect(carolCard.stats!.topTools).toEqual(["Read", "Edit", "Bash", "Glob"]);
    expect(carolCard.stats!.projectBreakdown).toHaveLength(2);
  });
});
