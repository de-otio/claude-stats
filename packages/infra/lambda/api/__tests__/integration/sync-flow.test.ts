import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK modules
// ---------------------------------------------------------------------------

const mockDdbSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockDdbSend }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
  UpdateItemCommand: vi.fn(function(input: any) { return { _type: "UpdateItem", ...input }; }),
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

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Environment — set before module imports via vi.hoisted
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";
  process.env.TEAM_STATS_TABLE = "TeamStats";
  process.env.APPSYNC_ENDPOINT = "https://appsync.example.com/graphql";
  process.env.AWS_REGION = "us-east-1";
});

// ---------------------------------------------------------------------------
// Import handler after mocks
// ---------------------------------------------------------------------------

import { handler } from "../../aggregate-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap plain JS values into DynamoDB typed attribute values for the mock
 * stream NewImage format.
 */
function wrapDynamoImage(record: Record<string, any>): Record<string, any> {
  const img: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") img[k] = { S: v };
    else if (typeof v === "number") img[k] = { N: String(v) };
    else if (typeof v === "boolean") img[k] = { BOOL: v };
    else img[k] = v;
  }
  return img;
}

/** Build a DynamoDB Streams record for a synced session. */
function makeStreamRecord(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  sessionData: Record<string, any>,
) {
  return {
    eventName,
    dynamodb: {
      NewImage:
        eventName !== "REMOVE" ? wrapDynamoImage(sessionData) : undefined,
    },
  };
}

/** Build a full DynamoDB Streams event. */
function makeStreamEvent(records: ReturnType<typeof makeStreamRecord>[]) {
  return { Records: records } as any;
}

// A typical synced session record written to the SyncedSessions table
const BASE_SESSION = {
  userId: "user-alice",
  sessionId: "sess-abc-001",
  accountId: "acct-001",
  projectId: "proj-api",
  firstTimestamp: 1773187200000, // 2026-03-11 00:00:00 UTC (Wednesday, W11)
  lastTimestamp: 1773190800000, // +1 hour
  promptCount: 20,
  inputTokens: 10000,
  outputTokens: 5000,
  cacheCreationTokens: 200,
  cacheReadTokens: 800,
  estimatedCost: 0.42,
  models: ["claude-sonnet-4-20250514"],
  isSubagent: false,
  toolUseCounts: { Read: 10, Edit: 5, Bash: 3 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-flow integration: syncSessions → aggregate-stats → TeamStats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it("processes a DynamoDB Streams event and writes TeamStats with correct token counts", async () => {
    const event = makeStreamEvent([makeStreamRecord("INSERT", BASE_SESSION)]);

    // GSI query: user-alice belongs to team-alpha
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-alpha" }],
    });

    // Base table query: full membership with sharedAccounts
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-alpha",
          userId: "user-alice",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-001"],
          displayName: "Alice",
        },
      ],
    });

    // Capture the UpdateItem call to inspect what was written
    let capturedUpdate: any = null;
    mockDdbSend.mockImplementationOnce((command: any) => {
      capturedUpdate = command;
      return Promise.resolve({});
    });

    await handler(event);

    // Verify DDB calls: GSI query + base table query + UpdateItem
    expect(mockDdbSend).toHaveBeenCalledTimes(3);

    // The UpdateItem should have been called with the TeamStats table
    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate.TableName).toBe("TeamStats");

    // Key should be teamId = "team-alpha" and SK = "2026-W11#user-alice"
    expect(capturedUpdate.Key.teamId).toBe("team-alpha");
    expect(capturedUpdate.Key.SK).toMatch(/^2026-W\d+#user-alice$/);

    // AppSync notification should be triggered
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("writes TeamStats with correct aggregated token counts for a single session", async () => {
    const event = makeStreamEvent([makeStreamRecord("INSERT", BASE_SESSION)]);

    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-alpha" }],
    });

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-alpha",
          userId: "user-alice",
          role: "ADMIN",
          shareLevel: "full",
          sharedAccounts: ["acct-001"],
          displayName: "Alice",
        },
      ],
    });

    // Capture the UpdateItem expression attribute values
    let capturedValues: any = null;
    mockDdbSend.mockImplementationOnce((command: any) => {
      capturedValues = command.ExpressionAttributeValues;
      return Promise.resolve({});
    });

    await handler(event);

    expect(capturedValues).not.toBeNull();

    // stats should contain aggregated values from the session
    const stats = capturedValues[":stats"];
    expect(stats.sessions).toBe(1);
    expect(stats.prompts).toBe(BASE_SESSION.promptCount);
    expect(stats.inputTokens).toBe(BASE_SESSION.inputTokens);
    expect(stats.outputTokens).toBe(BASE_SESSION.outputTokens);
    expect(stats.estimatedCost).toBe(BASE_SESSION.estimatedCost);
  });

  it("groups two sessions from the same user+team+period and writes a single TeamStats record", async () => {
    const session2 = {
      ...BASE_SESSION,
      sessionId: "sess-abc-002",
      promptCount: 10,
      inputTokens: 5000,
      outputTokens: 2500,
      estimatedCost: 0.21,
    };

    const event = makeStreamEvent([
      makeStreamRecord("INSERT", BASE_SESSION),
      makeStreamRecord("INSERT", session2),
    ]);

    // Single user — one GSI + one base table query
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-alpha" }],
    });

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-alpha",
          userId: "user-alice",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-001"],
          displayName: "Alice",
        },
      ],
    });

    let capturedValues: any = null;
    mockDdbSend.mockImplementationOnce((command: any) => {
      capturedValues = command.ExpressionAttributeValues;
      return Promise.resolve({});
    });

    await handler(event);

    // Should be: GSI query + base table query + 1 UpdateItem (merged group)
    expect(mockDdbSend).toHaveBeenCalledTimes(3);

    // Aggregated across both sessions
    const stats = capturedValues[":stats"];
    expect(stats.sessions).toBe(2);
    expect(stats.prompts).toBe(
      BASE_SESSION.promptCount + session2.promptCount,
    );
    expect(stats.inputTokens).toBe(
      BASE_SESSION.inputTokens + session2.inputTokens,
    );
  });

  it("omits estimatedCost and projectBreakdown from TeamStats for minimal share level", async () => {
    const event = makeStreamEvent([makeStreamRecord("INSERT", BASE_SESSION)]);

    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-beta" }],
    });

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-beta",
          userId: "user-alice",
          role: "MEMBER",
          shareLevel: "minimal", // minimal share level
          sharedAccounts: ["acct-001"],
          displayName: "Alice",
        },
      ],
    });

    let capturedValues: any = null;
    mockDdbSend.mockImplementationOnce((command: any) => {
      capturedValues = command.ExpressionAttributeValues;
      return Promise.resolve({});
    });

    await handler(event);

    const stats = capturedValues[":stats"];

    // Core metrics should be present
    expect(stats.sessions).toBe(1);
    expect(stats.prompts).toBe(BASE_SESSION.promptCount);

    // Sensitive fields should be absent for minimal share level
    expect(stats.estimatedCost).toBeUndefined();
    expect(stats.modelsUsed).toBeUndefined();
    expect(stats.topTools).toBeUndefined();
    expect(stats.projectBreakdown).toBeUndefined();
  });

  it("skips sessions where accountId is not in the member's sharedAccounts", async () => {
    const sessionWithWrongAccount = {
      ...BASE_SESSION,
      accountId: "acct-other",
    };

    const event = makeStreamEvent([
      makeStreamRecord("INSERT", sessionWithWrongAccount),
    ]);

    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-alpha" }],
    });

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-alpha",
          userId: "user-alice",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-001"], // does NOT include "acct-other"
          displayName: "Alice",
        },
      ],
    });

    await handler(event);

    // Only GSI + base table queries — no UpdateItem
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends AppSync notification after writing TeamStats", async () => {
    const event = makeStreamEvent([makeStreamRecord("INSERT", BASE_SESSION)]);

    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: "team-alpha" }],
    });

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          teamId: "team-alpha",
          userId: "user-alice",
          role: "MEMBER",
          shareLevel: "full",
          sharedAccounts: ["acct-001"],
          displayName: "Alice",
        },
      ],
    });

    mockDdbSend.mockResolvedValueOnce({}); // UpdateItem success

    await handler(event);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The fetch call should be a POST to the AppSync endpoint
    const fetchArgs = mockFetch.mock.calls[0];
    expect(fetchArgs[1].method).toBe("POST");
    expect(fetchArgs[1].body).toContain("refreshTeamStats");
    expect(fetchArgs[1].body).toContain("team-alpha");
  });

  it("handles a REMOVE event (no NewImage) gracefully — skips without error", async () => {
    const event = makeStreamEvent([
      makeStreamRecord("REMOVE", BASE_SESSION),
    ]);

    await handler(event);

    // No DynamoDB calls should be made for REMOVE events
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
