/**
 * Constraint before/after (Lane M) — CLI glue over a real SQLite store.
 *
 * Design: doc/analysis/constraint-impact/.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TASK_CLASS_VERSION } from "@claude-stats/core/taskClass";
import type { PolicyEvent } from "@claude-stats/core/types/insight";
import { Store } from "../store/index.js";
import { buildConstraintImpactReport } from "../constraintImpact/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import type { Config } from "../config.js";

const loadConfigMock = vi.fn<() => Config>(() => ({}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: () => loadConfigMock() };
});

const DAY_MS = 86_400_000;
/** Mirrors core's `DEFAULT_MIN_SESSIONS_PER_CLASS` — kept as a local literal
 *  rather than imported so a fixture count typo shows up as a failing
 *  assertion here instead of silently tracking a future default change. */
const MIN = 8;

const POLICY: PolicyEvent = { date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" };
const BOUNDARY_MS = Date.UTC(2026, 4, 1, 0, 0, 0, 0);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function tmpDb(): string {
  // A `mkdtempSync` SUBDIRECTORY, never `os.tmpdir()` itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-constraint-impact-"));
  tmpDirs.push(dir);
  return path.join(dir, "store.db");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function session(id: string, ts: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: ts, lastTimestamp: ts + 60_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: 5 * 60_000, medianResponseTimeMs: 2000,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, ts: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: ts, claudeVersion: "2.1.70",
    model: "claude-sonnet-5", stopReason: "end_turn",
    inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

/** Seed `n` classified sessions, one message each, at `ts`. */
function seedClass(
  store: Store,
  prefix: string,
  n: number,
  ts: number,
  opts: { classifierVersion?: number; taskClass?: string } = {},
): void {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    store.upsertSession(session(id, ts));
    store.upsertMessages([message(`${id}-m0`, id, ts)]);
    store.setTaskClass({
      sessionId: id,
      taskClass: opts.taskClass ?? "debug",
      coarseClass: "diagnose",
      confidence: "high",
      rule: "diagnosis",
      classifierVersion: opts.classifierVersion ?? TASK_CLASS_VERSION,
      classifiedAt: ts,
    });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildConstraintImpactReport", () => {
  it("splits sessions at the policy boundary using message timestamps", () => {
    const store = new Store(tmpDb());
    try {
      seedClass(store, "before", MIN, BOUNDARY_MS - DAY_MS);
      seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS);

      const { report, coverage } = buildConstraintImpactReport(store, POLICY);

      expect(report.classes).toHaveLength(1);
      expect(report.classes[0]!.nBefore).toBe(MIN);
      expect(report.classes[0]!.nAfter).toBe(MIN);
      expect(report.classes[0]!.verdict).toBe("compared");
      expect(coverage.unclassified).toBe(0);
      expect(coverage.staleClassifierVersion).toBe(0);
    } finally {
      store.close();
    }
  });

  it("excludes sessions classified by a STALE classifier version from the class map and reports the count", () => {
    const store = new Store(tmpDb());
    try {
      seedClass(store, "before", MIN, BOUNDARY_MS - DAY_MS);
      // "after" sessions were classified before the current classifier
      // version shipped — must not be silently mixed into the delta
      // (03 §3.2 Gap 1: "reclassify before quoting a per-class delta").
      seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS, { classifierVersion: TASK_CLASS_VERSION - 1 });

      const { report, coverage } = buildConstraintImpactReport(store, POLICY);

      expect(coverage.staleClassifierVersion).toBe(MIN);
      expect(coverage.classifierVersionsSeen).toEqual([TASK_CLASS_VERSION - 1, TASK_CLASS_VERSION]);
      // The stale-version sessions never reach the comparison at all.
      const [c] = report.classes;
      expect(c!.nBefore).toBe(MIN);
      expect(c!.nAfter).toBe(0);
      expect(c!.verdict).toBe("insufficient-data");
    } finally {
      store.close();
    }
  });

  it("counts sessions with no stored classification as unclassified, not as a class member", () => {
    const store = new Store(tmpDb());
    try {
      seedClass(store, "before", MIN, BOUNDARY_MS - DAY_MS);
      // "after" sessions exist but were never classified.
      for (let i = 0; i < MIN; i++) {
        const id = `after-${i}`;
        store.upsertSession(session(id, BOUNDARY_MS + DAY_MS));
        store.upsertMessages([message(`${id}-m0`, id, BOUNDARY_MS + DAY_MS)]);
      }

      const { coverage } = buildConstraintImpactReport(store, POLICY);
      expect(coverage.unclassified).toBe(MIN);
    } finally {
      store.close();
    }
  });

  it("prices sessions through the SAME message rows hygiene uses (cost/tokens/turns/errors)", () => {
    const store = new Store(tmpDb());
    try {
      for (let i = 0; i < MIN; i++) {
        const id = `before-${i}`;
        store.upsertSession(session(id, BOUNDARY_MS - DAY_MS));
        store.upsertMessages([
          message(`${id}-m0`, id, BOUNDARY_MS - DAY_MS, { inputTokens: 1000, outputTokens: 500, toolErrorCount: 1 }),
          message(`${id}-m1`, id, BOUNDARY_MS - DAY_MS + 1000, { inputTokens: 1000, outputTokens: 500 }),
        ]);
        store.setTaskClass({
          sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
          rule: "diagnosis", classifierVersion: TASK_CLASS_VERSION, classifiedAt: BOUNDARY_MS - DAY_MS,
        });
      }
      seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS);

      const { report } = buildConstraintImpactReport(store, POLICY);
      const [c] = report.classes;
      expect(c!.avgTurnsBefore).toBe(2); // two messages per session
      expect(c!.avgTokensBefore).toBe(3000); // 1000+500 twice
      // Every session contributes 1 error over 2 turns: MIN errors / (2*MIN) turns.
      expect(c!.toolErrorRateBefore).toBeCloseTo(0.5, 10);
      expect(c!.avgCostBefore).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("respects project/account filters symmetrically on both sides", () => {
    const store = new Store(tmpDb());
    try {
      seedClass(store, "alpha-before", MIN, BOUNDARY_MS - DAY_MS);
      seedClass(store, "alpha-after", MIN, BOUNDARY_MS + DAY_MS);
      // A different project — must not leak into the report when filtered.
      for (let i = 0; i < MIN; i++) {
        const id = `beta-before-${i}`;
        store.upsertSession(session(id, BOUNDARY_MS - DAY_MS, { projectPath: "/w/beta" }));
        store.upsertMessages([message(`${id}-m0`, id, BOUNDARY_MS - DAY_MS)]);
        store.setTaskClass({
          sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
          rule: "diagnosis", classifierVersion: TASK_CLASS_VERSION, classifiedAt: BOUNDARY_MS - DAY_MS,
        });
      }

      const { report } = buildConstraintImpactReport(store, POLICY, { projectPath: "/w/alpha" });
      expect(report.classes[0]!.nBefore).toBe(MIN); // only the alpha sessions
    } finally {
      store.close();
    }
  });

  it("classifies a session straddling the boundary once, not once per side", () => {
    // A session with messages on both sides of the boundary appears in BOTH
    // `beforeRows` and `afterRows` (same sessionId) — the classification join
    // must not double-count it in the coverage tallies, and both rows must
    // still see the same stored class.
    const store = new Store(tmpDb());
    try {
      const id = "straddler";
      store.upsertSession(session(id, BOUNDARY_MS - DAY_MS, { lastTimestamp: BOUNDARY_MS + DAY_MS }));
      store.upsertMessages([
        message(`${id}-before`, id, BOUNDARY_MS - DAY_MS),
        message(`${id}-after`, id, BOUNDARY_MS + DAY_MS),
      ]);
      store.setTaskClass({
        sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: TASK_CLASS_VERSION, classifiedAt: BOUNDARY_MS - DAY_MS,
      });
      // Enough OTHER sessions on each side to clear the sample floor.
      seedClass(store, "before", MIN - 1, BOUNDARY_MS - DAY_MS);
      seedClass(store, "after", MIN - 1, BOUNDARY_MS + DAY_MS);

      const { report, coverage } = buildConstraintImpactReport(store, POLICY);
      expect(coverage.unclassified).toBe(0);
      const [c] = report.classes;
      expect(c!.nBefore).toBe(MIN);
      expect(c!.nAfter).toBe(MIN);
    } finally {
      store.close();
    }
  });

  it("M-2: a straddling session's active duration is NOT attributed to both sides", () => {
    // The straddler carries a session-level `activeDurationMs` for its WHOLE
    // lifetime (60 minutes) — huge next to the 5-minute default every other
    // seeded session gets. `getSessions({ activeSince })` matches this
    // session on BOTH the before and after query (it overlaps both windows),
    // so if the whole 60 minutes were joined onto each side, it would blow
    // both `avgActiveMinutes*` figures far past 5 and inflate the dev-time
    // cost half of the ledger — the exact regression this guards. The fix
    // excludes (not approximates) `activeDurationMs`/`medianResponseTimeMs`
    // for a straddling session, so both sides' averages stay pinned to the
    // known-good 5-minute sessions and the straddler drops OUT of coverage.
    const store = new Store(tmpDb());
    try {
      const id = "straddler";
      store.upsertSession(
        session(id, BOUNDARY_MS - DAY_MS, {
          lastTimestamp: BOUNDARY_MS + DAY_MS,
          activeDurationMs: 60 * 60_000,
          medianResponseTimeMs: 999_000,
        }),
      );
      store.upsertMessages([
        message(`${id}-before`, id, BOUNDARY_MS - DAY_MS),
        message(`${id}-after`, id, BOUNDARY_MS + DAY_MS),
      ]);
      store.setTaskClass({
        sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
        rule: "diagnosis", classifierVersion: TASK_CLASS_VERSION, classifiedAt: BOUNDARY_MS - DAY_MS,
      });
      // Enough OTHER 5-minute sessions on each side to clear the sample floor.
      seedClass(store, "before", MIN - 1, BOUNDARY_MS - DAY_MS);
      seedClass(store, "after", MIN - 1, BOUNDARY_MS + DAY_MS);

      const { report } = buildConstraintImpactReport(store, POLICY);
      const [c] = report.classes;
      expect(c!.nBefore).toBe(MIN);
      expect(c!.nAfter).toBe(MIN);
      // Coverage excludes the straddler on both sides — MIN-1, not MIN.
      expect(c!.activeMinutesCoverageBefore).toBe(MIN - 1);
      expect(c!.activeMinutesCoverageAfter).toBe(MIN - 1);
      // Pinned to the 5-minute sessions; a double-counted 60-minute
      // straddler would pull this well above 5 on EITHER side.
      expect(c!.avgActiveMinutesBefore).toBeCloseTo(5, 6);
      expect(c!.avgActiveMinutesAfter).toBeCloseTo(5, 6);
      expect(c!.medianResponseMsBefore).toBe(2000);
      expect(c!.medianResponseMsAfter).toBe(2000);
    } finally {
      store.close();
    }
  });

  it("plumbs the configured hourly rate through to the net-effect channel", () => {
    const store = new Store(tmpDb());
    try {
      seedClass(store, "before", MIN, BOUNDARY_MS - DAY_MS);
      seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS);

      const noRate = buildConstraintImpactReport(store, POLICY);
      expect(noRate.report.netEffectAvailable).toBe(false);

      const withRate = buildConstraintImpactReport(store, POLICY, { hourlyRate: 75 });
      expect(withRate.report.hourlyRate).toBe(75);
      expect(withRate.report.netEffectAvailable).toBe(true);
    } finally {
      store.close();
    }
  });

  it("since/until bound how far the comparison looks on each side", () => {
    const store = new Store(tmpDb());
    try {
      // A session well before the "since" clip must not count on the "before" side.
      seedClass(store, "ancient", MIN, BOUNDARY_MS - 30 * DAY_MS);
      seedClass(store, "recent-before", MIN, BOUNDARY_MS - DAY_MS);
      seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS);

      const { report } = buildConstraintImpactReport(store, POLICY, { since: BOUNDARY_MS - 5 * DAY_MS });
      expect(report.classes[0]!.nBefore).toBe(MIN); // only recent-before, not ancient
    } finally {
      store.close();
    }
  });
});

// ─── MCP: get_constraint_impact ─────────────────────────────────────────────

describe("get_constraint_impact (MCP)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-constraint-impact-mcp-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(path.join(tmpDir, "test.db"));
    seedClass(store, "before", MIN, BOUNDARY_MS - DAY_MS);
    seedClass(store, "after", MIN, BOUNDARY_MS + DAY_MS);

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    loadConfigMock.mockReturnValue({});
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("reports an honest 'nothing declared' state with an enablement path when config has no policyEvents", async () => {
    loadConfigMock.mockReturnValue({});
    const result = await client.callTool({ name: "get_constraint_impact", arguments: {} });
    const data = textOf(result);
    expect(data).toHaveProperty("error");
    expect(data).toHaveProperty("enablementPath");
    expect(data["classes"]).toBeUndefined();
  });

  it("compares around the most recent declared event by default, and reports both sides of the ledger", async () => {
    loadConfigMock.mockReturnValue({ policyEvents: [POLICY] });
    const result = await client.callTool({ name: "get_constraint_impact", arguments: {} });
    const data = textOf(result);

    expect(data["classesCompared"]).toBe(1);
    expect(data["netEffectAvailable"]).toBe(false); // no rate configured
    const classes = data["classes"] as Array<Record<string, unknown>>;
    expect(classes[0]).toHaveProperty("tokenSavingsAtAfterVolume");
    expect(classes[0]).toHaveProperty("devTimeDeltaMinutesAtAfterVolume");
    expect(classes[0]!["devTimeCostAtAfterVolume"]).toBeNull(); // never priced without a rate
    expect(data).toHaveProperty("confoundNote");
    expect(data).toHaveProperty("notMeasured");
  });

  it("prices the net effect once config.rate.hourly is set", async () => {
    loadConfigMock.mockReturnValue({ policyEvents: [POLICY], rate: { hourly: 80 } });
    const result = await client.callTool({ name: "get_constraint_impact", arguments: {} });
    const data = textOf(result);
    expect(data["netEffectAvailable"]).toBe(true);
    expect(data["hourlyRate"]).toBe(80);
  });

  it("rejects a date that does not match any declared event, listing what IS declared", async () => {
    loadConfigMock.mockReturnValue({ policyEvents: [POLICY] });
    const result = await client.callTool({
      name: "get_constraint_impact",
      arguments: { date: "1999-01-01" },
    });
    const data = textOf(result);
    expect(data["error"]).toContain("1999-01-01");
    expect(data["error"]).toContain(POLICY.date);
  });
});
