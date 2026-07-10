import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK modules
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () {
    return { send: mockSend };
  }),
  QueryCommand: vi.fn(function (input: any) {
    return { _type: "Query", ...input };
  }),
  UpdateItemCommand: vi.fn(function (input: any) {
    return { _type: "Update", ...input };
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
});
process.env.AWS_REGION = "us-east-1";

import { handler } from "../../api/aggregate-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a plain record into a DynamoDB image the mock unmarshall understands. */
function image(record: Record<string, any>): Record<string, any> {
  const img: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") img[k] = { S: v };
    else if (typeof v === "number") img[k] = { N: String(v) };
    else if (typeof v === "boolean") img[k] = { BOOL: v };
    else img[k] = v; // arrays / objects pass through
  }
  return img;
}

function streamRecord(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  record: Record<string, any>,
) {
  return {
    eventName,
    dynamodb:
      eventName === "REMOVE"
        ? { OldImage: image(record) }
        : { NewImage: image(record) },
  };
}

function event(records: any[]) {
  return { Records: records } as any;
}

/** A per-(user, day) UserAggregates row. 2025-03-12 is a Wednesday. */
const dayRow = {
  userId: "user-1",
  period: "2025-03-12",
  accountId: "acct-1",
  projectId: null,
  sessionCount: 5,
  subagentSessionCount: 1,
  promptCount: 20,
  inputTokens: 5000,
  outputTokens: 2000,
  cacheCreationTokens: 100,
  cacheReadTokens: 300,
  activeMinutes: 45,
  estimatedCost: 0.15,
  models: ["claude-sonnet-4-20250514"],
  toolUseCounts: { Read: 5, Edit: 3 },
};

const membership = {
  teamId: "team-1",
  userId: "user-1",
  role: "MEMBER",
  shareLevel: "full",
  sharedAccounts: ["acct-1"],
  displayName: "Alice",
};

/** Queue the standard call sequence for one (user, week) with one team. */
function queueOneTeam(opts: {
  member?: Record<string, any>;
  weekDays: Record<string, any>[];
}) {
  mockSend
    .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-1" } }] }) // GSI
    .mockResolvedValueOnce({ Items: [image(opts.member ?? membership)] }) // base
    .mockResolvedValueOnce({ Items: opts.weekDays.map(image) }) // week days
    .mockResolvedValueOnce({}); // UpdateItem
}

/** Find the UpdateItemCommand input among mockSend calls. */
function updateCall() {
  const call = mockSend.mock.calls.find((c) => c[0]?._type === "Update");
  return call?.[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregate-stats handler (UserAggregates stream → weekly TeamStats)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it("skips records with no usable image", async () => {
    await handler(event([{ eventName: "INSERT", dynamodb: {} }]));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("writes a TeamStats member row keyed by the real 'period#userId' attribute", async () => {
    queueOneTeam({ weekDays: [dayRow] });
    await handler(event([streamRecord("INSERT", dayRow)]));

    const cmd = updateCall();
    expect(cmd).toBeTruthy();
    expect(cmd.TableName).toBe("TeamStats");
    // The bug the previous version had: it wrote a bogus "SK" attribute.
    expect(cmd.Key.SK).toBeUndefined();
    expect(cmd.Key.teamId).toBe("team-1");
    expect(cmd.Key["period#userId"]).toMatch(/^2025-W\d{2}#user-1$/);
    // period attribute is the ISO week, not the day.
    expect(cmd.ExpressionAttributeValues[":period"]).toMatch(/^2025-W\d{2}$/);
  });

  it("read-recomputes the WHOLE week, not just the changed day-row", async () => {
    // Stream carries ONE changed day, but the table holds THREE days that week.
    const d1 = { ...dayRow, period: "2025-03-10", sessionCount: 2, promptCount: 4 };
    const d2 = { ...dayRow, period: "2025-03-12", sessionCount: 5, promptCount: 20 };
    const d3 = { ...dayRow, period: "2025-03-14", sessionCount: 3, promptCount: 6 };
    queueOneTeam({ weekDays: [d1, d2, d3] });

    await handler(event([streamRecord("MODIFY", d2)]));

    const stats = updateCall().ExpressionAttributeValues[":stats"];
    expect(stats.sessions).toBe(10); // 2+5+3 — the whole week, not just d2
    expect(stats.prompts).toBe(30); // 4+20+6
  });

  it("skips a membership when the day-row's account is not shared", async () => {
    const notShared = { ...membership, sharedAccounts: ["acct-other"] };
    mockSend
      .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-1" } }] })
      .mockResolvedValueOnce({ Items: [image(notShared)] })
      .mockResolvedValueOnce({ Items: [image(dayRow)] });
    // no UpdateItem queued — none should be issued

    await handler(event([streamRecord("INSERT", dayRow)]));
    expect(updateCall()).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing for a user with no team memberships", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] }); // GSI: no teams
    await handler(event([streamRecord("INSERT", dayRow)]));
    expect(mockSend).toHaveBeenCalledTimes(1); // just the GSI probe
    expect(updateCall()).toBeUndefined();
  });

  it("dedupes multiple stream records for the same (user, week)", async () => {
    queueOneTeam({ weekDays: [dayRow] });
    const other = { ...dayRow, period: "2025-03-13" }; // same ISO week

    await handler(event([
      streamRecord("INSERT", dayRow),
      streamRecord("MODIFY", other),
    ]));

    // GSI + base + weekDays + 1 UpdateItem = 4 (memberships cached, week read once)
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("strips cost/models/tools/projects for a 'minimal' share level", async () => {
    queueOneTeam({
      member: { ...membership, shareLevel: "minimal" },
      weekDays: [dayRow],
    });
    await handler(event([streamRecord("INSERT", dayRow)]));

    const stats = updateCall().ExpressionAttributeValues[":stats"];
    expect(stats.sessions).toBe(5);
    expect(stats.estimatedCost).toBeUndefined();
    expect(stats.modelsUsed).toBeUndefined();
    expect(stats.topTools).toBeUndefined();
    expect(stats.projectBreakdown).toBeUndefined();
  });

  it("notifies AppSync subscribers after a successful write", async () => {
    queueOneTeam({ weekDays: [dayRow] });
    await handler(event([streamRecord("INSERT", dayRow)]));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles ConditionalCheckFailedException without throwing", async () => {
    const conflict = new Error("stale");
    conflict.name = "ConditionalCheckFailedException";
    mockSend
      .mockResolvedValueOnce({ Items: [{ teamId: { S: "team-1" } }] })
      .mockResolvedValueOnce({ Items: [image(membership)] })
      .mockResolvedValueOnce({ Items: [image(dayRow)] })
      .mockRejectedValueOnce(conflict);

    await expect(handler(event([streamRecord("INSERT", dayRow)]))).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled(); // write did not "succeed"
  });

  it("recomputes on REMOVE using the OldImage", async () => {
    queueOneTeam({ weekDays: [dayRow] }); // remaining rows re-summed
    await handler(event([streamRecord("REMOVE", dayRow)]));
    expect(updateCall()).toBeTruthy();
  });
});
