import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Covers the four license-advisor MCP surfaces (plan §"MCP surface"):
 *  - `get_stats`'s new `planAdvice` field, with email stripped from
 *    `planAdvice.planUtilization.byAccount`.
 *  - `get_account_info` (new tool).
 *  - `get_plan_mechanics_reference` (new tool).
 *  - `size_seats` (new tool).
 *
 * Headcounts below are fictional round numbers (400/200/50) per the plan's
 * public-repo confidentiality convention (assumption 8).
 */

const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-plan-advisor-test-"));
let store: Store;
let client: Client;

beforeAll(async () => {
  store = new Store(join(tmpDir, "test.db"));

  // A single recent session/message is enough to make `byWeek.length > 0`,
  // which is the only gate on `planUtilization` (and therefore `planAdvice`)
  // being non-null — see dashboard/index.ts's plan-utilization block.
  store.upsertSession({
    sessionId: "plan-advisor-session-001",
    projectPath: "/tmp/test-project",
    sourceFile: "/tmp/test-project/.claude/conversation.jsonl",
    firstTimestamp: Date.now() - 3600_000,
    lastTimestamp: Date.now(),
    claudeVersion: "1.0.0",
    entrypoint: "cli",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4-20250514"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    throttleEvents: 0,
    sourceDeleted: false,
    activeDurationMs: null,
    medianResponseTimeMs: null,
  });

  store.upsertMessages([{
    uuid: "plan-advisor-msg-001",
    sessionId: "plan-advisor-session-001",
    timestamp: Date.now() - 1800_000,
    claudeVersion: "1.0.0",
    model: "claude-sonnet-4-20250514",
    stopReason: "end_turn",
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: "test prompt",
  }]);

  // A second account row, observed via the accounts table only (never a raw
  // session's `accountUuid`), so `get_account_info`'s `accounts` array has a
  // row to assert on independent of whatever `~/.claude.json` happens to
  // contain on the machine running the test.
  store.upsertAccount({
    accountUuid: "11111111-2222-3333-4444-555555555555",
    organizationUuid: "org-aaaaaaaa",
    emailHash: "deadbeef",
    // Seed a RAW email in email_label (observer.ts stores account.emailAddress
    // here verbatim) so the redaction assertion below exercises the real leak
    // path, not a pre-masked value.
    emailLabel: "dev@example.com",
    organizationType: "enterprise",
    rateLimitTier: "default",
    userRateLimitTier: "default",
    seatTier: "premium",
    billingType: "seat",
    subscriptionType: "team_premium",
    firstObservedAt: Date.now() - 86_400_000,
    lastObservedAt: Date.now(),
  });

  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => {
  store.close();
});

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("get_stats planAdvice", () => {
  it("includes planAdvice.planUtilization and planAdvice.recommendations", async () => {
    const result = await client.callTool({ name: "get_stats", arguments: { period: "all" } });
    const data = textOf(result);
    expect(data).toHaveProperty("planAdvice");
    const planAdvice = data["planAdvice"] as Record<string, unknown> | null;
    expect(planAdvice).not.toBeNull();
    expect(planAdvice).toHaveProperty("planUtilization");
    expect(planAdvice).toHaveProperty("recommendations");
    expect(Array.isArray(planAdvice!["recommendations"])).toBe(true);
  });

  it("never exposes a raw emailAddress in planAdvice.planUtilization.byAccount", async () => {
    const result = await client.callTool({ name: "get_stats", arguments: { period: "all" } });
    const data = textOf(result);
    const planAdvice = data["planAdvice"] as Record<string, unknown>;
    const planUtilization = planAdvice["planUtilization"] as Record<string, unknown>;
    const byAccount = planUtilization["byAccount"] as Array<Record<string, unknown>>;
    expect(byAccount.length).toBeGreaterThan(0);
    for (const account of byAccount) {
      expect(account).not.toHaveProperty("emailAddress");
      expect(account).toHaveProperty("emailPresent");
      expect(typeof account["emailPresent"]).toBe("boolean");
      expect(account).toHaveProperty("accountId");
    }
    // The raw JSON text must never contain the field name at all — a
    // stronger guarantee than per-key property absence.
    expect(JSON.stringify(planUtilization)).not.toContain("emailAddress");
  });

  it("existing flat get_stats fields are unchanged (additive-only extension)", async () => {
    const result = await client.callTool({ name: "get_stats", arguments: { period: "all" } });
    const data = textOf(result);
    expect(data).toHaveProperty("sessions");
    expect(data).toHaveProperty("inputTokens");
    expect(data).toHaveProperty("outputTokens");
    expect(data).toHaveProperty("estimatedCost");
  });
});

describe("get_account_info", () => {
  it("returns currentAccount (or null) and an accounts array, never a raw email", async () => {
    const result = await client.callTool({ name: "get_account_info", arguments: {} });
    const data = textOf(result);
    expect(data).toHaveProperty("currentAccount");
    expect(data).toHaveProperty("accounts");
    expect(Array.isArray(data["accounts"])).toBe(true);

    const currentAccount = data["currentAccount"];
    if (currentAccount !== null) {
      expect(currentAccount).not.toHaveProperty("emailAddress");
      expect(currentAccount).toHaveProperty("emailPresent");
      expect(typeof (currentAccount as Record<string, unknown>)["emailPresent"]).toBe("boolean");
    }

    // The seeded accounts-table row must round-trip with its email_hash, and
    // never with a raw email field (the table itself never stores one).
    const accounts = data["accounts"] as Array<Record<string, unknown>>;
    const seeded = accounts.find((a) => a["accountUuid"] === "11111111-2222-3333-4444-555555555555");
    expect(seeded).toBeDefined();
    expect(seeded!["emailHash"]).toBe("deadbeef");
    expect(seeded!["seatTier"]).toBe("premium");
    expect(seeded!["billingType"]).toBe("seat");
    expect(seeded).not.toHaveProperty("emailAddress");
    // email_label stores the RAW email (observer.ts); it must never surface.
    expect(seeded).not.toHaveProperty("emailLabel");

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("emailAddress");
    expect(serialized).not.toContain("emailLabel");
    // No raw email anywhere in the response (defense against any future field).
    expect(serialized).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe("get_plan_mechanics_reference", () => {
  it("returns the full snapshot with verifiedDate and staleWarning", async () => {
    const result = await client.callTool({ name: "get_plan_mechanics_reference", arguments: {} });
    const data = textOf(result);
    expect(data["verifiedDate"]).toBe("2026-07-03");
    expect(data["staleWarning"]).toContain("2026-07-03");
    expect(data["staleWarning"]).toContain("claude.com/pricing");
    expect(data).toHaveProperty("teamSeatRange");
    expect(data).toHaveProperty("enterpriseMinimums");
    expect(data).toHaveProperty("seatPricing");
    expect(data).toHaveProperty("procurementMotion");
    expect(data).toHaveProperty("perUserMonthlyBenchmarks");
    expect(data).toHaveProperty("enterpriseAdds");
    expect(Array.isArray(data["enterpriseAdds"])).toBe(true);
    expect((data["enterpriseAdds"] as unknown[]).length).toBeGreaterThan(0);
    expect(data).toHaveProperty("openQuestions");
    expect(Array.isArray(data["openQuestions"])).toBe(true);
  });

  it("the tool description instructs preferring a live pricing check", async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "get_plan_mechanics_reference");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/live/i);
    expect(tool!.description).toContain("claude.com/pricing");
    expect(tool!.description).toMatch(/staleWarning/);
  });
});

describe("size_seats", () => {
  it("projects seat scenarios for a headcount and technical fraction, never a verdict", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: { headcount: 400, technicalFraction: 0.5 },
    });
    const data = textOf(result);
    expect(data["headcount"]).toBe(400);
    expect(data["technicalPopulation"]).toBe(200);
    expect(data["tierMixSource"]).toBe("anthropic-benchmark");
    expect(data["verifiedDate"]).toBe("2026-07-03");
    expect(data["staleWarning"]).toContain("2026-07-03");
    expect(Array.isArray(data["rows"])).toBe(true);
    expect((data["rows"] as unknown[]).length).toBe(4); // default adoption scenarios
    expect(Array.isArray(data["openQuestions"])).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/"verdict"/i);
  });

  it("flags a Team-ceiling-exceeded, sales-assisted row at full adoption of 200 technical seats", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: { headcount: 400, technicalFraction: 0.5, adoptionScenarios: [1.0] },
    });
    const data = textOf(result);
    const rows = data["rows"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["seats"]).toBe(200);
    expect(row["fitsTeamRange"]).toBe(false);
    expect(row["procurementMotion"]).toBe("enterprise-sales-assisted");
  });

  it("labels a caller-supplied measured tierMix as 'measured'", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: {
        headcount: 50,
        technicalFraction: 1,
        tierMix: { light: 0.2, typical: 0.6, power: 0.2 },
        tierMixMeasured: true,
      },
    });
    const data = textOf(result);
    expect(data["tierMixSource"]).toBe("measured");
  });

  it("caps adoptionScenarios at 20 via zod .max(20) before sizeSeats ever runs", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: {
        headcount: 200,
        technicalFraction: 0.5,
        adoptionScenarios: Array.from({ length: 21 }, (_, i) => i / 21),
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects an invalid headcount at the zod schema boundary", async () => {
    // z.number().int().min(1) mirrors sizeSeats()'s own headcount-invalid
    // check exactly, so this is rejected by schema validation before ever
    // reaching sizeSeats() — the SeatSizingError catch branch is defense in
    // depth for inputs the schema can't fully express (see the tierMix-sum
    // test below, which does exercise it).
    const result = await client.callTool({
      name: "size_seats",
      arguments: { headcount: 0, technicalFraction: 0.5 },
    });
    expect(result.isError).toBe(true);
  });

  it("reports a structured SeatSizingError when technicalFraction is out of range", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: { headcount: 100, technicalFraction: 1.5 },
    });
    // zod's own `.max(1)` rejects this before it reaches sizeSeats(), so the
    // error is the framework's schema-validation error rather than our
    // SeatSizingError — assert only the outer isError contract here.
    expect(result.isError).toBe(true);
  });

  it("reports a structured SeatSizingError when a tierMix does not sum to 1", async () => {
    const result = await client.callTool({
      name: "size_seats",
      arguments: {
        headcount: 100,
        technicalFraction: 0.5,
        tierMix: { light: 0.5, typical: 0.5, power: 0.5 },
        tierMixMeasured: true,
      },
    });
    expect(result.isError).toBe(true);
    const data = textOf(result);
    expect(data["code"]).toBe("tiermix-sum");
  });
});

describe("tool list", () => {
  it("includes the four license-advisor tools with descriptions and object schemas", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const name of ["get_account_info", "get_plan_mechanics_reference", "size_seats"]) {
      expect(names).toContain(name);
    }
    for (const name of ["get_account_info", "get_plan_mechanics_reference", "size_seats"]) {
      const tool = result.tools.find((t) => t.name === name)!;
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});
