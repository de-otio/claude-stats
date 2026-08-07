/**
 * Efficiency-hygiene (Lane D1) — store query, CLI glue, and the
 * `get_efficiency_hints` MCP tool, over a real SQLite store.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { buildHygieneReport } from "../hygiene/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { FIXED_NOW } from "./fixtures/synthetic.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-hygiene-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, projectPath = "/w/alpha", overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath, sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 60_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(
  uuid: string,
  sessionId: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    uuid, sessionId, timestamp: FIXED_NOW, claudeVersion: "2.1.70",
    model: "claude-sonnet-5", stopReason: "end_turn",
    inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

// ─── Store query ────────────────────────────────────────────────────────────

describe("Store.getMessagesForHygiene", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("returns project_path and tool_error_count alongside the token columns", () => {
    store.upsertSession(session("s1", "/w/alpha"));
    store.upsertMessages([message("s1-m0", "s1", { toolErrorCount: 2, cacheCreationTokens: 500 })]);

    const rows = store.getMessagesForHygiene({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_path).toBe("/w/alpha");
    expect(rows[0]!.tool_error_count).toBe(2);
    expect(rows[0]!.cache_creation_tokens).toBe(500);
  });

  it("scopes strictly by project — a session in a different project contributes nothing", () => {
    store.upsertSession(session("s1", "/w/alpha"));
    store.upsertMessages([message("s1-m0", "s1")]);
    store.upsertSession(session("s2", "/w/beta"));
    store.upsertMessages([message("s2-m0", "s2")]);

    const rows = store.getMessagesForHygiene({ projectPath: "/w/alpha" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("s1");
  });

  it("scopes by account_uuid via the session row (matches buildMessageFilter's predicate)", () => {
    store.upsertSession(session("s1", "/w/alpha", { accountUuid: "acct-aaaa" }));
    store.upsertMessages([message("s1-m0", "s1")]);
    store.upsertSession(session("s2", "/w/alpha", { accountUuid: "acct-bbbb" }));
    store.upsertMessages([message("s2-m0", "s2")]);

    const rows = store.getMessagesForHygiene({ accountUuid: "acct-aaaa" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("s1");
  });

  it("orders by timestamp ascending, across sessions", () => {
    store.upsertSession(session("s1", "/w/alpha"));
    store.upsertMessages([
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 2000 }),
      message("s1-m0", "s1", { timestamp: FIXED_NOW }),
    ]);
    const rows = store.getMessagesForHygiene({});
    expect(rows.map((r) => r.uuid)).toEqual(["s1-m0", "s1-m1"]);
  });
});

// ─── CLI glue: buildHygieneReport ───────────────────────────────────────────

describe("buildHygieneReport", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("finds a real retry-loop over a store-backed session and reports its cost/ratio", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: FIXED_NOW, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
      message("s1-m2", "s1", { timestamp: FIXED_NOW + 2000, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
    ]);

    const report = buildHygieneReport(store, {});
    expect(report.totalCost).toBeGreaterThan(0);
    expect(report.digest.totalFindings).toBe(1);
    const retryLoop = report.digest.active.find((d) => d.detectorId === "retry-loop");
    expect(retryLoop).toBeDefined();
    expect(retryLoop!.findings[0]!.sessionIds).toEqual(["s1"]);
    expect(report.hygieneRatio).not.toBeNull();
    expect(report.hygieneRatio!).toBeGreaterThan(0);
    expect(report.hygieneRatio!).toBeLessThanOrEqual(1);
  });

  it("returns an honest empty digest (never a fabricated finding) for a clean store", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([message("s1-m0", "s1")]);

    const report = buildHygieneReport(store, {});
    expect(report.digest.totalFindings).toBe(0);
    expect(report.digest.totalEstimatedWaste).toBe(0);
  });

  it("applies suppression end-to-end: a suppressed detector's finding is computed but withheld from `active`", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: FIXED_NOW, toolErrorCount: 1 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, toolErrorCount: 1 }),
      message("s1-m2", "s1", { timestamp: FIXED_NOW + 2000, toolErrorCount: 1 }),
    ]);

    const suppressed = buildHygieneReport(store, { suppressions: ["retry-loop"] });
    expect(suppressed.digest.active.find((d) => d.detectorId === "retry-loop")).toBeUndefined();
    expect(suppressed.digest.suppressedIds).toContain("retry-loop");

    const unsuppressed = buildHygieneReport(store, {});
    expect(unsuppressed.digest.active.find((d) => d.detectorId === "retry-loop")).toBeDefined();
  });

  it("reports hygieneRatio as null, never 0, when there is no spend to divide by", () => {
    // I1: a bare 0 reads as "audited, found no waste". An empty window was
    // never audited at all, and the two must not render the same.
    const report = buildHygieneReport(store, {});
    expect(report.totalCost).toBe(0);
    expect(report.hygieneRatio).toBeNull();
  });

  it("looks only BEFORE `since` for the previous window — never back over the current one", () => {
    // Nothing precedes the window, so the trend figure must be null. A
    // previous-window query whose upper bound leaked forward to `until` would
    // re-price the current window's own waste and report it as "last week".
    const start = FIXED_NOW;
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: start, toolErrorCount: 1 }),
      message("s1-m1", "s1", { timestamp: start + 1000, toolErrorCount: 1 }),
      message("s1-m2", "s1", { timestamp: start + 2000, toolErrorCount: 1 }),
    ]);

    const report = buildHygieneReport(store, { since: start, until: start + 3600_000 });
    expect(report.digest.totalFindings).toBe(1); // the current window DID find waste
    expect(report.previousHygieneRatio).toBeNull();
  });

  it("computes previousHygieneRatio over the immediately preceding equal-length window", () => {
    // Previous window: a retry loop (waste). Current window: clean.
    const prevStart = FIXED_NOW - 3600_000;
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: prevStart, toolErrorCount: 1 }),
      message("s1-m1", "s1", { timestamp: prevStart + 1000, toolErrorCount: 1 }),
      message("s1-m2", "s1", { timestamp: prevStart + 2000, toolErrorCount: 1 }),
    ]);
    store.upsertSession(session("s2"));
    store.upsertMessages([message("s2-m0", "s2", { timestamp: FIXED_NOW, inputTokens: 1000, outputTokens: 500 })]);

    const report = buildHygieneReport(store, { since: FIXED_NOW, until: FIXED_NOW + 3600_000 });
    expect(report.digest.totalFindings).toBe(0); // current window is clean
    expect(report.previousHygieneRatio).not.toBeNull();
    expect(report.previousHygieneRatio!).toBeGreaterThan(0);
  });
});

// ─── MCP tool ────────────────────────────────────────────────────────────────

describe("get_efficiency_hints (MCP)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-hygiene-test-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: FIXED_NOW, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 1000, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
      message("s1-m2", "s1", { timestamp: FIXED_NOW + 2000, toolErrorCount: 1, inputTokens: 1000, outputTokens: 100 }),
    ]);

    // A clean session on a NAMED account, so `account` scoping has something
    // to include and something to exclude.
    store.upsertAccount({
      accountUuid: "acct-aaaa-0000", organizationUuid: null, emailHash: null, emailLabel: null,
      organizationType: null, rateLimitTier: null, userRateLimitTier: null, seatTier: null,
      billingType: null, subscriptionType: null, firstObservedAt: FIXED_NOW, lastObservedAt: FIXED_NOW,
    });
    store.upsertSession(session("s2", "/w/beta", { accountUuid: "acct-aaaa-0000" }));
    store.upsertMessages([message("s2-m0", "s2", { timestamp: FIXED_NOW, inputTokens: 1000, outputTokens: 500 })]);

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("is registered and returns a well-shaped digest with the seeded retry-loop", async () => {
    const result = await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } });
    const data = textOf(result);
    expect(data).toHaveProperty("hygieneRatio");
    expect(data).toHaveProperty("detectors");
    expect(data).toHaveProperty("suppressedDetectors");
    const detectors = data["detectors"] as Array<Record<string, unknown>>;
    const retryLoop = detectors.find((d) => d["detectorId"] === "retry-loop");
    expect(retryLoop).toBeDefined();
    const findings = retryLoop!["findings"] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toHaveProperty("rule");
    expect(findings[0]).toHaveProperty("threshold");
    expect(findings[0]).toHaveProperty("remedy");
    expect((findings[0]!["sessionIds"] as string[])).toEqual(["s1"]);
  });

  it("actually APPLIES the resolved account filter — a scoped call excludes the other account's sessions", async () => {
    // The tool description promises "Filter to a specific account UUID". A
    // handler that resolves the account and then forgets to pass it through
    // still answers, still looks well-formed, and quietly reports every
    // account's waste — a silent no-op no other test in this file would see.
    const result = await client.callTool({
      name: "get_efficiency_hints",
      arguments: { period: "all", account: "acct-aaaa-0000" },
    });
    const data = textOf(result);
    const detectors = data["detectors"] as Array<Record<string, unknown>>;
    const retryLoop = detectors.find((d) => d["detectorId"] === "retry-loop")!;
    expect(retryLoop["findings"]).toEqual([]); // honest empty, not the other account's finding
    expect(data["totalFindings"]).toBe(0);
    // ...and the denominator is scoped too, not the whole store's spend.
    const scopedCost = data["totalCost"] as number;
    const allAccounts = textOf(await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } }));
    expect(scopedCost).toBeGreaterThan(0);
    expect(scopedCost).toBeLessThan(allAccounts["totalCost"] as number);
  });

  it("rejects an empty/blank account filter with an honest error, not a silent all-accounts fallback", async () => {
    const result = await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all", account: "  " } });
    const data = textOf(result);
    expect(data).toHaveProperty("error");
  });

  it("summarises a window that DID have spend with money and a percentage, both via insight.ts's formatters", async () => {
    const data = textOf(await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } }));
    expect(data["summary"]).toMatch(/^\$[\d,.]+ of \$[\d,.]+ self-audited as recoverable waste \(\d+%\)\.$/);
  });
});

// ─── MCP: the empty window ──────────────────────────────────────────────────

describe("get_efficiency_hints (MCP) — no usage at all", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-hygiene-empty-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client-empty", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("says there was no usage rather than quoting a fabricated $0.00 / 0% audit result", async () => {
    // I1: "we looked and found no waste" and "there was nothing to look at"
    // are different claims. A `$0.00 … (0%)` summary asserts the first on the
    // evidence of the second.
    const result = await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } });
    const content = (result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(data["summary"]).toBe("No usage recorded for this period.");
    expect(data["hygieneRatio"]).toBeNull();
    expect(data["totalCost"]).toBe(0);
    expect(data["totalFindings"]).toBe(0);
  });
});
