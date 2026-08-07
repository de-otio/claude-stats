/**
 * Efficiency-hygiene (Lane D1) — store query, CLI glue, and the
 * `get_efficiency_hints` MCP tool, over a real SQLite store.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
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
import type { Config } from "../config.js";

// D-2: `get_efficiency_hints` is the ONLY code path that reads
// `config.hygiene.suppressions` — a mutation that severs the wire from
// `loadConfig()` to `buildHygieneReport`'s `suppressions` argument left
// every other hygiene test green. `loadConfig` reads a real file off disk by
// default, so it must be mocked to prove the wiring end-to-end.
const loadConfigMock = vi.fn<() => Config>(() => ({}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: () => loadConfigMock() };
});

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

  // D-4: two messages with the SAME timestamp had no tie-breaker before this
  // fix, so SQLite's tie order was unspecified — order-sensitive detectors
  // (retryLoop/reEntryBurn adjacency, abandonedSpend's "last message") could
  // see either arrangement across runs. `m.uuid` pins it deterministically.
  it("breaks a timestamp tie deterministically by uuid, regardless of insert order", () => {
    store.upsertSession(session("s1", "/w/alpha"));
    store.upsertMessages([
      message("s1-mz", "s1", { timestamp: FIXED_NOW }),
      message("s1-ma", "s1", { timestamp: FIXED_NOW }),
    ]);
    const rows = store.getMessagesForHygiene({});
    expect(rows.map((r) => r.uuid)).toEqual(["s1-ma", "s1-mz"]);
  });

  // D-5: `util.ts`'s SessionGroup doc claims SQLite's `ORDER BY ts ASC`
  // returns NULL timestamps FIRST, and `abandonedSpend` depends on that —
  // it reads the group's LAST row as "the session's last message" and bails
  // when that row's timestamp is null. Verify the real store honors the
  // claim: a null-timestamp row seeded ahead of a real-timestamp row must
  // still come out first, so the real (non-null) row lands last.
  it("returns a null-timestamp row FIRST relative to real-timestamp rows in the same session (SQLite NULLS FIRST under ASC)", () => {
    store.upsertSession(session("s1", "/w/alpha"));
    store.upsertMessages([
      message("s1-real", "s1", { timestamp: FIXED_NOW }),
      message("s1-null", "s1", { timestamp: null }),
    ]);
    const rows = store.getMessagesForHygiene({});
    expect(rows.map((r) => r.uuid)).toEqual(["s1-null", "s1-real"]);
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

  // D-5: end-to-end through the real store (not the pure-function unit
  // test), which is the part the earlier review COULD NOT check — it
  // depends on SQLite's real NULL-ordering behavior, not an assumption about
  // it. A null-timestamp message is seeded so it would sort chronologically
  // between the two real-timestamp messages if timestamps were compared
  // naively; under the documented (and now store-verified) NULLS-FIRST
  // convention it lands at the FRONT of the group instead, so the session's
  // real last message — the one with the tool error — is still read as
  // "last" and the detector still fires.
  it("still detects abandoned spend when the session has a null-timestamp message (store-level, real SQLite ordering)", () => {
    store.upsertSession(session("s1"));
    store.upsertMessages([
      message("s1-m0", "s1", { timestamp: FIXED_NOW, inputTokens: 500_000, outputTokens: 50_000 }),
      message("s1-mnull", "s1", { timestamp: null, inputTokens: 100, outputTokens: 50 }),
      message("s1-m1", "s1", { timestamp: FIXED_NOW + 60_000, toolErrorCount: 1, inputTokens: 1_000, outputTokens: 100 }),
    ]);

    const report = buildHygieneReport(store, {});
    const abandoned = report.digest.active.find((d) => d.detectorId === "abandoned-spend");
    expect(abandoned).toBeDefined();
    expect(abandoned!.findings[0]!.sessionIds).toEqual(["s1"]);
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

// ─── CLI glue: tier-mismatch (D2) over a real store ─────────────────────────

describe("buildHygieneReport — tier-mismatch (D2)", () => {
  let dbPath: string;
  let store: Store;
  const N = 8; // DEFAULT_HYGIENE_THRESHOLDS.tierMismatch.minSessionsPerTier

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  /** N top-tier + N mid-tier sessions, same shape, classified `debug`/`diagnose`
   *  at `high` confidence — the parity fixture, seeded through the REAL store
   *  (setTaskClass + upsertSession/Messages), not a pure-function fixture. */
  function seedParityClass(): void {
    for (let i = 0; i < N; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      store.upsertSession(session(topId));
      store.upsertMessages([
        message(`${topId}-m0`, topId, { timestamp: FIXED_NOW, model: "claude-opus-5" }),
        message(`${topId}-m1`, topId, { timestamp: FIXED_NOW + 1000, model: "claude-opus-5" }),
      ]);
      store.setTaskClass({
        sessionId: topId, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
      });

      store.upsertSession(session(midId));
      store.upsertMessages([
        message(`${midId}-m0`, midId, { timestamp: FIXED_NOW, model: "claude-sonnet-5" }),
        message(`${midId}-m1`, midId, { timestamp: FIXED_NOW + 1000, model: "claude-sonnet-5" }),
      ]);
      store.setTaskClass({
        sessionId: midId, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
      });
    }
  }

  it("finds a real tier-mismatch parity class end-to-end through the store, and prices it into totalEstimatedWaste", () => {
    seedParityClass();
    const report = buildHygieneReport(store, {});
    const tierMismatch = report.digest.active.find((d) => d.detectorId === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    expect(tierMismatch!.findings).toHaveLength(1);
    const finding = tierMismatch!.findings[0]!;
    expect(finding.sessionIds.sort()).toEqual(Array.from({ length: N }, (_, i) => `top-${i}`).sort());
    expect(finding.estimatedWaste).toBeGreaterThan(0);
    expect(report.digest.totalEstimatedWaste).toBeGreaterThanOrEqual(finding.estimatedWaste);
  });

  it("does NOT fire when sessions are never classified — no session_task_class rows at all", () => {
    // Same message shapes as seedParityClass, but no setTaskClass calls.
    for (let i = 0; i < N; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      store.upsertSession(session(topId));
      store.upsertMessages([message(`${topId}-m0`, topId, { timestamp: FIXED_NOW, model: "claude-opus-5" })]);
      store.upsertSession(session(midId));
      store.upsertMessages([message(`${midId}-m0`, midId, { timestamp: FIXED_NOW, model: "claude-sonnet-5" })]);
    }
    const report = buildHygieneReport(store, {});
    const tierMismatch = report.digest.active.find((d) => d.detectorId === "tier-mismatch");
    expect(tierMismatch!.findings).toEqual([]);
  });

  it("is suppressible via config.hygiene.suppressions end-to-end, like the other five detectors", () => {
    seedParityClass();
    const suppressed = buildHygieneReport(store, { suppressions: ["tier-mismatch"] });
    expect(suppressed.digest.active.find((d) => d.detectorId === "tier-mismatch")).toBeUndefined();
    expect(suppressed.digest.suppressedIds).toContain("tier-mismatch");
  });

  it("carries the STORED coarse_class and confidence through the glue — a low-confidence class comes back coarse-labelled", () => {
    // Adversarial review D2-R1: the fine/coarse grain rule was unit-tested on a
    // hand-built map, but the production path that BUILDS that map from
    // `session_task_class` only ever saw high-confidence rows. Both a glue that
    // read `task_class` into the `coarse` slot and one that hardcoded
    // `confidence: "high"` passed the entire suite. This drives the low branch
    // through the real table, so the label proves both columns were read.
    for (let i = 0; i < N; i++) {
      for (const [id, model] of [[`top-${i}`, "claude-opus-5"], [`mid-${i}`, "claude-sonnet-5"]] as const) {
        store.upsertSession(session(id));
        store.upsertMessages([
          message(`${id}-m0`, id, { timestamp: FIXED_NOW, model }),
          message(`${id}-m1`, id, { timestamp: FIXED_NOW + 1000, model }),
        ]);
        store.setTaskClass({
          sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "low",
          rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
        });
      }
    }
    const report = buildHygieneReport(store, {});
    const finding = report.digest.active.find((d) => d.detectorId === "tier-mismatch")!.findings[0]!;
    // Coarse grain (confidence was low) AND the coarse class name (not the fine one).
    expect(finding.rule).toContain("diagnose (coarse class)");
    expect(finding.remedy).toContain("diagnose (coarse class)");
    expect(finding.rule).not.toContain("debug");
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

  afterEach(() => {
    loadConfigMock.mockReturnValue({});
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

  it("honors config.hygiene.suppressions end-to-end — D-2: the only reader of this field must actually wire it through", async () => {
    // Unsuppressed: retry-loop is the only detector that fires on the seeded
    // store (see beforeAll), so it must appear here.
    const unsuppressed = textOf(await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } }));
    const unsuppressedDetectors = unsuppressed["detectors"] as Array<Record<string, unknown>>;
    expect(unsuppressedDetectors.some((d) => d["detectorId"] === "retry-loop")).toBe(true);
    expect(unsuppressed["suppressedDetectors"]).toEqual([]);

    // A developer suppresses it in ~/.claude-stats/config.json.
    loadConfigMock.mockReturnValue({ hygiene: { suppressions: ["retry-loop"] } });

    const suppressed = textOf(await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } }));
    const suppressedDetectors = suppressed["detectors"] as Array<Record<string, unknown>>;
    // Withheld from the active list...
    expect(suppressedDetectors.some((d) => d["detectorId"] === "retry-loop")).toBe(false);
    // ...but the tool must say so, not silently drop it — a suppressed
    // detector that vanishes without a trace is indistinguishable from one
    // that never fired, which is exactly the failure mode a severed wire
    // produces.
    expect(suppressed["suppressedDetectors"]).toEqual(["retry-loop"]);
  });
});

// ─── MCP: tier-mismatch (D2) surfaces through get_efficiency_hints ──────────

describe("get_efficiency_hints (MCP) — tier-mismatch", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-tier-mismatch-test-"));
  let store: Store;
  let client: Client;
  const N = 8;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    for (let i = 0; i < N; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      store.upsertSession(session(topId));
      store.upsertMessages([message(`${topId}-m0`, topId, { timestamp: FIXED_NOW, model: "claude-opus-5" })]);
      store.setTaskClass({
        sessionId: topId, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
      });
      store.upsertSession(session(midId));
      store.upsertMessages([message(`${midId}-m0`, midId, { timestamp: FIXED_NOW, model: "claude-sonnet-5" })]);
      store.setTaskClass({
        sessionId: midId, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
      });
    }

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client-tier-mismatch", version: "1.0.0" });
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

  it("surfaces the tier-mismatch finding, with its rule/threshold/remedy and the top-tier sessionIds, through the real MCP tool call", async () => {
    const data = textOf(await client.callTool({ name: "get_efficiency_hints", arguments: { period: "all" } }));
    const detectors = data["detectors"] as Array<Record<string, unknown>>;
    const tierMismatch = detectors.find((d) => d["detectorId"] === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    const findings = tierMismatch!["findings"] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toHaveProperty("rule");
    expect(findings[0]).toHaveProperty("threshold");
    expect(findings[0]).toHaveProperty("remedy");
    const sessionIds = (findings[0]!["sessionIds"] as string[]).sort();
    expect(sessionIds).toEqual(Array.from({ length: N }, (_, i) => `top-${i}`).sort());
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
