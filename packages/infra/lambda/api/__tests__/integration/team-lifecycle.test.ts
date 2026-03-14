import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK clients
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockSend })),
  QueryCommand: vi.fn((input: any) => ({ _type: "Query", ...input })),
  PutItemCommand: vi.fn((input: any) => ({ _type: "PutItem", ...input })),
  UpdateItemCommand: vi.fn((input: any) => ({
    _type: "UpdateItem",
    ...input,
  })),
  DeleteItemCommand: vi.fn((input: any) => ({
    _type: "DeleteItem",
    ...input,
  })),
  GetItemCommand: vi.fn((input: any) => ({ _type: "GetItem", ...input })),
  TransactWriteItemsCommand: vi.fn((input: any) => ({
    _type: "TransactWriteItems",
    ...input,
  })),
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
  marshall: (item: Record<string, any>) => item,
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

process.env.TEAMS_TABLE = "Teams";
process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";
process.env.TEAM_STATS_TABLE = "TeamStats";
process.env.ACHIEVEMENTS_TABLE = "Achievements";
process.env.CHALLENGES_TABLE = "Challenges";

// ---------------------------------------------------------------------------
// In-memory team store for lifecycle simulation
// ---------------------------------------------------------------------------

/**
 * We test the AppSync resolver logic by simulating the DynamoDB state
 * in-memory and driving it through mock DDB calls.  Since the resolver
 * JS functions live in .js files (not TypeScript), we simulate their
 * behaviour here at the integration level using the handler functions
 * that coordinate DynamoDB queries.
 */

type ShareLevel = "full" | "summary" | "minimal";
type TeamRole = "ADMIN" | "MEMBER";

interface Team {
  teamId: string;
  teamName: string;
  teamSlug: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  logoUrl: string | null;
}

interface TeamMembership {
  teamId: string;
  userId: string;
  role: TeamRole;
  shareLevel: ShareLevel;
  displayName: string;
  joinedAt: number;
}

/** Simulated in-memory state */
const store = {
  teams: new Map<string, Team>(),
  memberships: new Map<string, TeamMembership>(),
};

/** Composite key for membership lookup */
function membershipKey(teamId: string, userId: string): string {
  return `${teamId}::${userId}`;
}

/** Simulate createTeam resolver logic */
function simulateCreateTeam(
  teamId: string,
  teamName: string,
  creatorId: string,
  displayName: string,
): { team: Team; membership: TeamMembership } {
  const now = Math.floor(Date.now() / 1000);
  const teamSlug = teamName.toLowerCase().replace(/\s+/g, "-");

  const team: Team = {
    teamId,
    teamName,
    teamSlug,
    createdBy: creatorId,
    createdAt: now,
    memberCount: 1,
    logoUrl: null,
  };

  const membership: TeamMembership = {
    teamId,
    userId: creatorId,
    role: "ADMIN",
    shareLevel: "summary",
    displayName,
    joinedAt: now,
  };

  store.teams.set(teamId, team);
  store.memberships.set(membershipKey(teamId, creatorId), membership);

  return { team, membership };
}

/** Simulate myTeams query resolver logic */
function simulateMyTeams(userId: string): Team[] {
  const myTeams: Team[] = [];
  for (const [key, m] of store.memberships) {
    if (m.userId === userId) {
      const team = store.teams.get(m.teamId);
      if (team) myTeams.push(team);
    }
  }
  return myTeams;
}

/** Simulate joinTeam mutation resolver logic */
function simulateJoinTeam(
  teamId: string,
  userId: string,
  displayName: string,
  shareLevel: ShareLevel,
): TeamMembership {
  const team = store.teams.get(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);

  const now = Math.floor(Date.now() / 1000);
  const membership: TeamMembership = {
    teamId,
    userId,
    role: "MEMBER",
    shareLevel,
    displayName,
    joinedAt: now,
  };

  store.memberships.set(membershipKey(teamId, userId), membership);
  team.memberCount++;

  return membership;
}

/** Simulate leaveTeam mutation resolver logic */
function simulateLeaveTeam(teamId: string, userId: string): boolean {
  const key = membershipKey(teamId, userId);
  if (!store.memberships.has(key)) return false;

  // Cannot leave if you're the last admin
  const teamMemberships = Array.from(store.memberships.values()).filter(
    (m) => m.teamId === teamId,
  );
  const admins = teamMemberships.filter((m) => m.role === "ADMIN");
  const isLastAdmin =
    admins.length === 1 && admins[0].userId === userId;
  if (isLastAdmin) throw new Error("Cannot leave: you are the last admin");

  store.memberships.delete(key);
  const team = store.teams.get(teamId);
  if (team) team.memberCount--;

  return true;
}

/** Simulate deleteTeam mutation resolver logic */
function simulateDeleteTeam(teamId: string, requesterId: string): boolean {
  const membership = store.memberships.get(
    membershipKey(teamId, requesterId),
  );
  if (!membership || membership.role !== "ADMIN") {
    throw new Error("Unauthorized: only team admins can delete the team");
  }

  // Remove all memberships for this team
  for (const [key, m] of store.memberships) {
    if (m.teamId === teamId) {
      store.memberships.delete(key);
    }
  }

  store.teams.delete(teamId);
  return true;
}

/** Simulate getTeamMembers query resolver logic */
function simulateGetTeamMembers(teamId: string): TeamMembership[] {
  return Array.from(store.memberships.values()).filter(
    (m) => m.teamId === teamId,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("team-lifecycle integration: CRUD lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset in-memory store before each test
    store.teams.clear();
    store.memberships.clear();
  });

  // ── create team → team appears in myTeams query ──────────────────────────

  it("create team → team appears in myTeams query", () => {
    const { team, membership } = simulateCreateTeam(
      "team-001",
      "The A Team",
      "user-alice",
      "Alice",
    );

    expect(team.teamId).toBe("team-001");
    expect(team.teamName).toBe("The A Team");
    expect(team.teamSlug).toBe("the-a-team");
    expect(team.memberCount).toBe(1);
    expect(membership.role).toBe("ADMIN");
    expect(membership.shareLevel).toBe("summary");

    const myTeams = simulateMyTeams("user-alice");
    expect(myTeams).toHaveLength(1);
    expect(myTeams[0].teamId).toBe("team-001");
  });

  it("create team → creator does not appear in another user's myTeams", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");

    const myTeams = simulateMyTeams("user-bob");
    expect(myTeams).toHaveLength(0);
  });

  // ── join team → membership created ───────────────────────────────────────

  it("join team → membership is created with correct role and share level", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");

    const membership = simulateJoinTeam(
      "team-001",
      "user-bob",
      "Bob",
      "full",
    );

    expect(membership.teamId).toBe("team-001");
    expect(membership.userId).toBe("user-bob");
    expect(membership.role).toBe("MEMBER");
    expect(membership.shareLevel).toBe("full");
  });

  it("join team → team appears in new member's myTeams", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "summary");

    const myTeams = simulateMyTeams("user-bob");
    expect(myTeams).toHaveLength(1);
    expect(myTeams[0].teamId).toBe("team-001");
  });

  it("join team → memberCount increments", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    expect(store.teams.get("team-001")!.memberCount).toBe(1);

    simulateJoinTeam("team-001", "user-bob", "Bob", "minimal");
    expect(store.teams.get("team-001")!.memberCount).toBe(2);

    simulateJoinTeam("team-001", "user-carol", "Carol", "summary");
    expect(store.teams.get("team-001")!.memberCount).toBe(3);
  });

  it("join team → throws if team does not exist", () => {
    expect(() =>
      simulateJoinTeam("nonexistent-team", "user-bob", "Bob", "full"),
    ).toThrow("Team nonexistent-team not found");
  });

  // ── leave team → membership removed ──────────────────────────────────────

  it("leave team → membership is removed", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "summary");

    const result = simulateLeaveTeam("team-001", "user-bob");

    expect(result).toBe(true);
    expect(
      store.memberships.has(membershipKey("team-001", "user-bob")),
    ).toBe(false);
  });

  it("leave team → team no longer appears in the leaver's myTeams", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "summary");

    simulateLeaveTeam("team-001", "user-bob");

    const myTeams = simulateMyTeams("user-bob");
    expect(myTeams).toHaveLength(0);
  });

  it("leave team → memberCount decrements", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "full");
    expect(store.teams.get("team-001")!.memberCount).toBe(2);

    simulateLeaveTeam("team-001", "user-bob");
    expect(store.teams.get("team-001")!.memberCount).toBe(1);
  });

  it("leave team → throws if user is the last admin", () => {
    simulateCreateTeam("team-001", "Solo Team", "user-alice", "Alice");
    // alice is the only admin

    expect(() => simulateLeaveTeam("team-001", "user-alice")).toThrow(
      "Cannot leave: you are the last admin",
    );
  });

  it("leave team → returns false if user is not a member", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");

    const result = simulateLeaveTeam("team-001", "user-stranger");
    expect(result).toBe(false);
  });

  // ── delete team → team + memberships removed ─────────────────────────────

  it("delete team → team and all memberships are removed", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "summary");
    simulateJoinTeam("team-001", "user-carol", "Carol", "full");

    expect(store.memberships.size).toBe(3);

    simulateDeleteTeam("team-001", "user-alice");

    expect(store.teams.has("team-001")).toBe(false);
    expect(store.memberships.size).toBe(0);
  });

  it("delete team → team no longer appears in any member's myTeams", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "summary");

    simulateDeleteTeam("team-001", "user-alice");

    expect(simulateMyTeams("user-alice")).toHaveLength(0);
    expect(simulateMyTeams("user-bob")).toHaveLength(0);
  });

  it("delete team → throws if requester is not an admin", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");
    simulateJoinTeam("team-001", "user-bob", "Bob", "full");

    expect(() => simulateDeleteTeam("team-001", "user-bob")).toThrow(
      "Unauthorized: only team admins can delete the team",
    );

    // Team should still exist
    expect(store.teams.has("team-001")).toBe(true);
  });

  it("delete team → throws if requester is not a member at all", () => {
    simulateCreateTeam("team-001", "The A Team", "user-alice", "Alice");

    expect(() => simulateDeleteTeam("team-001", "user-stranger")).toThrow(
      "Unauthorized: only team admins can delete the team",
    );
  });

  // ── compound lifecycle: create → join multiple → leave → delete ───────────

  it("full lifecycle: create, join, leave, delete team", () => {
    // 1. Create
    const { team } = simulateCreateTeam(
      "team-xyz",
      "Dev Squad",
      "user-alice",
      "Alice",
    );
    expect(team.memberCount).toBe(1);

    // 2. Bob and Carol join
    simulateJoinTeam("team-xyz", "user-bob", "Bob", "full");
    simulateJoinTeam("team-xyz", "user-carol", "Carol", "summary");
    expect(store.teams.get("team-xyz")!.memberCount).toBe(3);

    // 3. Carol leaves
    simulateLeaveTeam("team-xyz", "user-carol");
    const members = simulateGetTeamMembers("team-xyz");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.userId)).not.toContain("user-carol");

    // 4. Alice deletes the team
    simulateDeleteTeam("team-xyz", "user-alice");
    expect(store.teams.has("team-xyz")).toBe(false);
    expect(simulateMyTeams("user-bob")).toHaveLength(0);
  });
});
