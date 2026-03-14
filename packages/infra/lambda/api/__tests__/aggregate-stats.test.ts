import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK modules
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockSend }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
  UpdateItemCommand: vi.fn(function(input: any) { return { _type: "Update", ...input }; }),
}));

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: (item: Record<string, any>) => {
    // Simple mock unmarshall: extract .S / .N / .BOOL / .L / .M or pass through
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

vi.mock("@aws-sdk/signature-v4", () => ({
  SignatureV4: vi.fn(function() { return { sign: vi.fn(function(req: any) { return req; }) }; }),
}));

vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: vi.fn(() => vi.fn()),
}));

vi.mock("@aws-crypto/sha256-js", () => ({
  Sha256: vi.fn(),
}));

vi.mock("@aws-sdk/protocol-http", () => ({
  HttpRequest: vi.fn(function(opts: any) { return opts; }),
}));

// Mock global fetch for AppSync notification
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Environment — set before module imports via vi.hoisted
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";
  process.env.TEAM_STATS_TABLE = "TeamStats";
  process.env.APPSYNC_ENDPOINT = "https://appsync.example.com/graphql";
});
process.env.AWS_REGION = "us-east-1";

// ---------------------------------------------------------------------------
// Import handler after mocks are set up
// ---------------------------------------------------------------------------

import { handler } from "../../api/aggregate-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDynamoDBImage(record: Record<string, any>): Record<string, any> {
  // Wrap values so the mock unmarshall can extract them
  const img: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") img[k] = { S: v };
    else if (typeof v === "number") img[k] = { N: String(v) };
    else if (typeof v === "boolean") img[k] = { BOOL: v };
    else img[k] = v; // arrays, objects passed through
  }
  return img;
}

function makeStreamRecord(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  record: Record<string, any>,
) {
  return {
    eventName,
    dynamodb: {
      NewImage: eventName !== "REMOVE" ? makeDynamoDBImage(record) : undefined,
    },
  };
}

function makeStreamEvent(records: any[]) {
  return { Records: records } as any;
}

const baseSession = {
  userId: "user-1",
  sessionId: "sess-1",
  accountId: "acct-1",
  projectId: "proj-1",
  firstTimestamp: 1741737600000, // 2025-03-12 00:00:00 UTC (a Wednesday)
  lastTimestamp: 1741741200000, // +1 hour
  promptCount: 10,
  inputTokens: 5000,
  outputTokens: 2000,
  cacheCreationTokens: 100,
  cacheReadTokens: 300,
  estimatedCost: 0.15,
  models: ["claude-sonnet-4-20250514"],
  isSubagent: false,
  toolUseCounts: { Read: 5, Edit: 3 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregate-stats handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it("should skip batch with no actionable records (REMOVE events only)", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("REMOVE", baseSession),
    ]);

    await handler(event);

    // No DynamoDB queries should be made for memberships
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("should process INSERT events and write TeamStats", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
    ]);

    // Mock: GSI query returns one team membership
    mockSend
      .mockResolvedValueOnce({
        // GSI MembershipsByUser query
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        // Base table query for full membership
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Alice",
          },
        ],
      })
      .mockResolvedValueOnce({
        // UpdateItemCommand for TeamStats write
      });

    await handler(event);

    // Should have made 3 DynamoDB calls: GSI query, base table query, update
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("should process MODIFY events the same as INSERT", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("MODIFY", baseSession),
    ]);

    mockSend
      .mockResolvedValueOnce({
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Bob",
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("should skip sessions when accountId is not in sharedAccounts", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("INSERT", { ...baseSession, accountId: "acct-other" }),
    ]);

    mockSend
      .mockResolvedValueOnce({
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Alice",
          },
        ],
      });

    await handler(event);

    // Only 2 calls (GSI + base table), no UpdateItem because session doesn't match
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("should handle users with no team memberships", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
    ]);

    mockSend.mockResolvedValueOnce({
      Items: [], // No memberships
    });

    await handler(event);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("should group multiple sessions for the same team/period/user", async () => {
    const session2 = {
      ...baseSession,
      sessionId: "sess-2",
      promptCount: 5,
      inputTokens: 2000,
      outputTokens: 1000,
    };

    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
      makeStreamRecord("INSERT", session2),
    ]);

    mockSend
      .mockResolvedValueOnce({
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Alice",
          },
        ],
      })
      .mockResolvedValueOnce({}); // Single UpdateItem for the group

    await handler(event);

    // GSI query (1 user) + base table query + 1 UpdateItem
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("should handle ConditionalCheckFailedException gracefully (stale update)", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
    ]);

    const conditionalError = new Error("ConditionalCheckFailedException");
    conditionalError.name = "ConditionalCheckFailedException";

    mockSend
      .mockResolvedValueOnce({
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Alice",
          },
        ],
      })
      .mockRejectedValueOnce(conditionalError);

    // Should not throw
    await expect(handler(event)).resolves.toBeUndefined();
  });

  it("should notify AppSync subscribers after successful update", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
    ]);

    mockSend
      .mockResolvedValueOnce({
        Items: [{ teamId: "team-1" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            teamId: "team-1",
            userId: "user-1",
            role: "MEMBER",
            shareLevel: "full",
            sharedAccounts: ["acct-1"],
            displayName: "Alice",
          },
        ],
      })
      .mockResolvedValueOnce({}); // UpdateItem success

    await handler(event);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should handle multiple users across multiple teams", async () => {
    const session2 = {
      ...baseSession,
      userId: "user-2",
      sessionId: "sess-2",
    };

    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
      makeStreamRecord("INSERT", session2),
    ]);

    // user-1 GSI (call 1)
    mockSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-1" }],
    });
    // user-1 base table for team-1 (call 2) — processed before user-2 GSI
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-1",
          userId: "user-1",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-1"],
          displayName: "Alice",
        },
      ],
    });
    // user-2 GSI (call 3)
    mockSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-1" }, { teamId: "team-2" }],
    });
    // user-2 base table for team-1 (call 4)
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-1",
          userId: "user-2",
          role: "MEMBER",
          shareLevel: "summary",
          sharedAccounts: ["acct-1"],
          displayName: "Bob",
        },
      ],
    });
    // user-2 base table for team-2
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-2",
          userId: "user-2",
          role: "ADMIN",
          shareLevel: "full",
          sharedAccounts: ["acct-1"],
          displayName: "Bob",
        },
      ],
    });
    // 3 UpdateItems (team-1/user-1, team-1/user-2, team-2/user-2)
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    await handler(event);

    // 2 GSI + 3 base table + 3 updates = 8
    expect(mockSend).toHaveBeenCalledTimes(8);
  });

  it("should handle missing NewImage gracefully", async () => {
    const event = makeStreamEvent([
      {
        eventName: "INSERT",
        dynamodb: {},
      },
    ]);

    await handler(event);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("should continue processing when membership fetch fails for one user", async () => {
    const session2 = {
      ...baseSession,
      userId: "user-2",
      sessionId: "sess-2",
    };

    const event = makeStreamEvent([
      makeStreamRecord("INSERT", baseSession),
      makeStreamRecord("INSERT", session2),
    ]);

    // user-1 GSI fails
    mockSend.mockRejectedValueOnce(new Error("DynamoDB error"));
    // user-2 GSI succeeds
    mockSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-1" }],
    });
    // user-2 base table
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-1",
          userId: "user-2",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-1"],
          displayName: "Bob",
        },
      ],
    });
    // UpdateItem
    mockSend.mockResolvedValueOnce({});

    await handler(event);

    // Should still process user-2 despite user-1 failure
    expect(mockSend).toHaveBeenCalledTimes(4);
  });
});
