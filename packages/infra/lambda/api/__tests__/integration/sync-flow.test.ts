import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Integration: UserAggregates stream → aggregate-stats worker → TeamStats.
//
// Complements the single-team unit test (../aggregate-stats.test.ts) with
// MULTI-user / MULTI-team fan-out and read-recompute scenarios. Only the
// worker is exercised (the syncAggregate resolver is APPSYNC_JS and is
// covered by evaluate-code + e2e); this proves the fan-in aggregation across
// several members and teams in one stream batch.
// ---------------------------------------------------------------------------

const mockDdbSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () {
    return { send: mockDdbSend };
  }),
  QueryCommand: vi.fn(function (input: any) {
    return { _type: "Query", ...input };
  }),
  UpdateItemCommand: vi.fn(function (input: any) {
    return { _type: "UpdateItem", ...input };
  }),
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
  SignatureV4: vi.fn(function () {
    return { sign: vi.fn((req: any) => req) };
  }),
}));
vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: vi.fn(() => vi.fn()),
}));
vi.mock("@aws-crypto/sha256-js", () => ({ Sha256: vi.fn() }));
vi.mock("@aws-sdk/protocol-http", () => ({
  HttpRequest: vi.fn(function (opts: any) {
    return opts;
  }),
}));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

vi.hoisted(() => {
  process.env.USER_AGGREGATES_TABLE = "UserAggregates";
  process.env.TEAM_MEMBERSHIPS_TABLE = "TeamMemberships";
  process.env.TEAM_STATS_TABLE = "TeamStats";
  process.env.APPSYNC_ENDPOINT = "https://appsync.example.com/graphql";
  process.env.AWS_REGION = "us-east-1";
});

import { handler } from "../../aggregate-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(record: Record<string, any>): Record<string, any> {
  const img: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") img[k] = { S: v };
    else if (typeof v === "number") img[k] = { N: String(v) };
    else if (typeof v === "boolean") img[k] = { BOOL: v };
    else img[k] = v;
  }
  return img;
}

function insertRecord(row: Record<string, any>) {
  return { eventName: "INSERT", dynamodb: { NewImage: wrap(row) } };
}
function event(records: any[]) {
  return { Records: records } as any;
}

/** A per-(user, day) UserAggregates row (2026-03-11 is a Wednesday, W11). */
function makeRow(over: Record<string, any> = {}) {
  return {
    userId: "user-alice",
    period: "2026-03-11",
    accountId: "acct-001",
    projectId: null,
    sessionCount: 4,
    subagentSessionCount: 0,
    promptCount: 20,
    inputTokens: 10000,
    outputTokens: 5000,
    cacheCreationTokens: 200,
    cacheReadTokens: 800,
    activeMinutes: 60,
    estimatedCost: 0.42,
    models: ["claude-sonnet-4-20250514"],
    toolUseCounts: { Read: 10, Edit: 5, Bash: 3 },
    ...over,
  };
}

function membership(over: Record<string, any> = {}) {
  return {
    teamId: "team-alpha",
    userId: "user-alice",
    role: "MEMBER",
    shareLevel: "full",
    sharedAccounts: ["acct-001"],
    displayName: "Alice",
    ...over,
  };
}

/** All UpdateItem inputs issued, keyed for assertion. */
function updates() {
  return mockDdbSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c?._type === "UpdateItem");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-flow: UserAggregates stream → aggregate-stats → TeamStats", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it("fans one member's week out to every team that shares the account", async () => {
    // user-alice is in two teams; both share acct-001.
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ teamId: { S: "team-alpha" } }, { teamId: { S: "team-beta" } }],
      }) // GSI
      .mockResolvedValueOnce({ Items: [wrap(membership({ teamId: "team-alpha" }))] })
      .mockResolvedValueOnce({ Items: [wrap(membership({ teamId: "team-beta" }))] })
      .mockResolvedValueOnce({ Items: [wrap(makeRow())] }) // week days
      .mockResolvedValue({}); // both UpdateItems

    await handler(event([insertRecord(makeRow())]));

    const u = updates();
    expect(u).toHaveLength(2);
    const teams = u.map((c) => c.Key.teamId).sort();
    expect(teams).toEqual(["team-alpha", "team-beta"]);
    // Correct SK attribute name + ISO-week value.
    u.forEach((c) => {
      expect(c.Key["period#userId"]).toMatch(/^2026-W\d{2}#user-alice$/);
      expect(c.Key.SK).toBeUndefined();
    });
    // One subscription notification per updated (team, week).
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("only writes for the team whose membership shares the row's account", async () => {
    mockDdbSend
      .mockResolvedValueOnce({
        Items: [{ teamId: { S: "team-alpha" } }, { teamId: { S: "team-beta" } }],
      })
      .mockResolvedValueOnce({
        Items: [wrap(membership({ teamId: "team-alpha", sharedAccounts: ["acct-001"] }))],
      })
      .mockResolvedValueOnce({
        Items: [wrap(membership({ teamId: "team-beta", sharedAccounts: ["acct-999"] }))],
      })
      .mockResolvedValueOnce({ Items: [wrap(makeRow())] })
      .mockResolvedValue({});

    await handler(event([insertRecord(makeRow())]));

    const u = updates();
    expect(u).toHaveLength(1);
    expect(u[0].Key.teamId).toBe("team-alpha");
  });

  it("aggregates two distinct users' weeks in one batch", async () => {
    const aliceRow = makeRow();
    const bobRow = makeRow({ userId: "user-bob", sessionCount: 7, promptCount: 30 });

    mockDdbSend
      // user-alice
      .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-alpha" } }] })
      .mockResolvedValueOnce({ Items: [wrap(membership())] })
      .mockResolvedValueOnce({ Items: [wrap(aliceRow)] })
      .mockResolvedValueOnce({}) // alice UpdateItem
      // user-bob
      .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-alpha" } }] })
      .mockResolvedValueOnce({
        Items: [wrap(membership({ userId: "user-bob", displayName: "Bob" }))],
      })
      .mockResolvedValueOnce({ Items: [wrap(bobRow)] })
      .mockResolvedValueOnce({}); // bob UpdateItem

    await handler(event([insertRecord(aliceRow), insertRecord(bobRow)]));

    const u = updates();
    expect(u).toHaveLength(2);
    const byUser: Record<string, any> = {};
    u.forEach((c) => {
      byUser[c.ExpressionAttributeValues[":userId"]] =
        c.ExpressionAttributeValues[":stats"];
    });
    expect(byUser["user-alice"].sessions).toBe(4);
    expect(byUser["user-bob"].sessions).toBe(7);
  });

  it("carries full token/tool/model detail into the member stats blob", async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-alpha" } }] })
      .mockResolvedValueOnce({ Items: [wrap(membership())] })
      .mockResolvedValueOnce({ Items: [wrap(makeRow())] })
      .mockResolvedValueOnce({});

    await handler(event([insertRecord(makeRow())]));

    const stats = updates()[0].ExpressionAttributeValues[":stats"];
    expect(stats.sessions).toBe(4);
    expect(stats.prompts).toBe(20);
    expect(stats.inputTokens).toBe(10000);
    expect(stats.outputTokens).toBe(5000);
    expect(stats.estimatedCost).toBe(0.42);
    expect(stats.activeMinutes).toBe(60);
    expect(stats.topTools).toContain("Read");
    expect(stats.modelsUsed["claude-sonnet-4-20250514"]).toBe(1);
  });
});
