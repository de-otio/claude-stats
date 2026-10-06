/**
 * Agent & skill cost — store read (`Store.getMessagesForAgentCost`) and glue
 * (`buildAgentCostReport`), over a real temp SQLite store.
 *
 * Covers:
 *  - the SELECT carries exactly the columns pricing and grouping need — no
 *    session id, uuid, path, prompt text or file paths (LOAD-BEARING: the
 *    result is cast over a raw SQL string, so a column dropped from the SELECT
 *    ships `undefined` with zero type errors);
 *  - carrier rows only: a multi-entry `message.id` group counts once, and a
 *    non-carrier carrying tokens (hand-edited) is still excluded;
 *  - filter conventions mirror the other message-scoped reads (window,
 *    project, account, includeCI, includeDeleted);
 *  - reconciliation: the report's total equals the dashboard headline for the
 *    same window, and an independently computed ground truth;
 *  - the serialized report carries no session id and no project path.
 *
 * Fixture names: `my-reviewer`, `acme-critic`, `example-skill`; `Explore` is a
 * built-in agent type.
 *
 * Design: plans/agent-attribution/IMPLEMENTATION.md §4/C2.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store/index.js";
import { buildAgentCostReport } from "../agentCost/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { estimateCost } from "@claude-stats/core/pricing";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

const T0 = 1_767_571_200_000; // 2026-01-05T00:00:00Z
const MIN = 60_000;
const MODEL = "claude-sonnet-4-6"; // $3/M input, $15/M output

// Sentinels that must never reach the report.
const MAIN_ID = "sess-SENTINEL-main-0001";
const SUB_TYPED_ID = "sess-SENTINEL-sub-0002";
const SUB_UNTYPED_ID = "sess-SENTINEL-sub-0003";
const SUB_BUILTIN_ID = "sess-SENTINEL-sub-0004";
const PROJECT = "/w/SENTINEL-PROJECT-path";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-agentcost-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: PROJECT, sourceFile: `${PROJECT}/${id}.jsonl`,
    firstTimestamp: T0, lastTimestamp: T0 + 60 * MIN, claudeVersion: "2.1.70",
    entrypoint: "claude", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [MODEL],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: T0, claudeVersion: "2.1.70",
    model: MODEL, stopReason: "end_turn",
    inputTokens: 100_000, outputTokens: 20_000, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [`${PROJECT}/src/SENTINEL-file.ts`], thinkingBlocks: 0,
    serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    promptText: "SENTINEL-PROMPT-TEXT", toolErrorCount: 0,
    ...overrides,
  };
}

/** $0.60 per message at the default token counts. */
const COST_PER_MESSAGE = 0.1 * 3 + 0.02 * 15;

/**
 * Main session: 2 carriers, one of which is the carrier of a 2-entry
 * `message.id` group (the second entry is demoted by the store) — both
 * entries run `example-skill`.
 * Subagent `my-reviewer` (depth 1): 2 carriers. Subagent untyped (depth
 * unrecorded): 1 carrier. Subagent `Explore` (depth 2): 1 carrier.
 */
function seed(store: Store): void {
  store.upsertSession(session(MAIN_ID));
  store.upsertSession(session(SUB_TYPED_ID, { isSubagent: true, parentSessionId: MAIN_ID, agentType: "my-reviewer", spawnDepth: 1 }));
  store.upsertSession(session(SUB_UNTYPED_ID, { isSubagent: true, parentSessionId: MAIN_ID }));
  store.upsertSession(session(SUB_BUILTIN_ID, { isSubagent: true, parentSessionId: MAIN_ID, agentType: "Explore", spawnDepth: 2 }));

  store.upsertMessages([
    message("m-main-1", MAIN_ID, { timestamp: T0 + 1 * MIN }),
    // One API response written as two entries, each repeating the usage.
    message("m-main-2a", MAIN_ID, { timestamp: T0 + 2 * MIN, messageId: "msg_group_1", usageCounted: true, skill: "example-skill" }),
    message("m-main-2b", MAIN_ID, { timestamp: T0 + 2 * MIN, messageId: "msg_group_1", usageCounted: true, skill: "example-skill" }),
    message("m-sub-1", SUB_TYPED_ID, { timestamp: T0 + 3 * MIN }),
    message("m-sub-2", SUB_TYPED_ID, { timestamp: T0 + 4 * MIN, skill: "example-skill" }),
    message("m-sub-3", SUB_UNTYPED_ID, { timestamp: T0 + 5 * MIN }),
    message("m-sub-4", SUB_BUILTIN_ID, { timestamp: T0 + 6 * MIN }),
  ]);
}

/** The dashboard headline's own arithmetic, recomputed independently. */
function headlineCost(store: Store, filters: Parameters<Store["getMessageTotals"]>[0] = {}): number {
  let total = 0;
  for (const mt of store.getMessageTotals(filters)) {
    total += estimateCost(mt.model, mt.input_tokens, mt.output_tokens, mt.cache_read_tokens, mt.cache_creation_tokens, undefined, {
      ephemeral5mCacheTokens: mt.ephemeral_5m_cache_tokens,
      ephemeral1hCacheTokens: mt.ephemeral_1h_cache_tokens,
    }).cost;
  }
  return total;
}

describe("Store.getMessagesForAgentCost", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("selects exactly the pricing and attribution columns — no ids, paths or text", () => {
    seed(store);
    const rows = store.getMessagesForAgentCost({});
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        "agent_type",
        "cache_creation_tokens",
        "cache_read_tokens",
        "ephemeral_1h_cache_tokens",
        "ephemeral_5m_cache_tokens",
        "input_tokens",
        "is_subagent",
        "model",
        "output_tokens",
        "skill",
        "spawn_depth",
        "timestamp",
      ]);
    }
    const typed = rows.find((r) => r.agent_type === "my-reviewer");
    expect(typed).toMatchObject({ is_subagent: 1, spawn_depth: 1, model: MODEL, input_tokens: 100_000 });
  });

  it("returns carrier rows only: a two-entry message.id group is one row", () => {
    seed(store);
    const rows = store.getMessagesForAgentCost({});
    // 7 entries written, one demoted to non-carrier by the store.
    expect(rows).toHaveLength(6);
    const db = new DatabaseSync(dbPath);
    const all = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    db.close();
    expect(all.n).toBe(7);
  });

  it("excludes a non-carrier even when a hand edit gives it tokens", () => {
    seed(store);
    const before = buildAgentCostReport(store);
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE messages SET input_tokens = 9000000, output_tokens = 9000000 WHERE uuid = 'm-main-2b'").run();
    const demoted = db.prepare("SELECT usage_counted FROM messages WHERE uuid = 'm-main-2b'").get() as { usage_counted: number };
    db.close();
    expect(demoted.usage_counted).toBe(0);
    const after = buildAgentCostReport(store);
    expect(after.coverage.totalCost).toBe(before.coverage.totalCost);
    expect(after.coverage.messages).toBe(6);
    // Paired positive: the same edit on a CARRIER does move the total.
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("UPDATE messages SET output_tokens = 40000 WHERE uuid = 'm-main-1'").run();
    db2.close();
    expect(buildAgentCostReport(store).coverage.totalCost).toBeGreaterThan(before.coverage.totalCost);
  });

  it("applies the window on the message timestamp, until exclusive", () => {
    seed(store);
    const rows = store.getMessagesForAgentCost({ since: T0 + 3 * MIN, until: T0 + 5 * MIN });
    expect(rows.map((r) => r.timestamp)).toEqual([T0 + 3 * MIN, T0 + 4 * MIN]);
  });

  it("narrows on project, account, includeCI=false and includeDeleted=false", () => {
    seed(store);
    store.upsertSession(session("sess-other-project", { projectPath: "/w/other", accountUuid: "acct-b" }));
    store.upsertSession(session("sess-ci", { isInteractive: false }));
    store.upsertSession(session("sess-deleted", { sourceDeleted: true }));
    store.upsertMessages([
      message("m-other", "sess-other-project", { timestamp: T0 + 10 * MIN }),
      message("m-ci", "sess-ci", { timestamp: T0 + 11 * MIN }),
      message("m-deleted", "sess-deleted", { timestamp: T0 + 12 * MIN }),
    ]);

    expect(store.getMessagesForAgentCost({})).toHaveLength(9);
    expect(store.getMessagesForAgentCost({ projectPath: "/w/other" })).toHaveLength(1);
    expect(store.getMessagesForAgentCost({ accountUuid: "acct-b" })).toHaveLength(1);
    expect(store.getMessagesForAgentCost({ includeCI: false })).toHaveLength(8);
    expect(store.getMessagesForAgentCost({ includeDeleted: false })).toHaveLength(8);
    // undefined / true = no narrowing, same as MessageFilter.
    expect(store.getMessagesForAgentCost({ includeCI: true, includeDeleted: true })).toHaveLength(9);
  });
});

describe("buildAgentCostReport", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("prices each carrier and splits it by main/subagent, type, skill and depth", () => {
    seed(store);
    const r = buildAgentCostReport(store);
    const c = COST_PER_MESSAGE;

    expect(r.coverage.messages).toBe(6);
    expect(r.coverage.mainMessages).toBe(2);
    expect(r.coverage.subagentMessages).toBe(4);
    expect(r.coverage.totalCost).toBeCloseTo(6 * c, 10);
    expect(r.coverage.mainCost).toBeCloseTo(2 * c, 10);
    expect(r.coverage.subagentCost).toBeCloseTo(4 * c, 10);
    expect(r.coverage.knownTypeShare).toBeCloseTo(0.75, 12);
    expect(r.coverage.unpricedMessages).toBe(0);

    expect(r.byAgentType.map((x) => [x.agentType, x.builtIn, x.messages])).toEqual([
      ["my-reviewer", false, 2],
      ["Explore", true, 1],
      [null, false, 1],
    ]);
    // The group's carrier and the subagent row both ran the skill; the demoted
    // entry is not counted a second time.
    expect(r.bySkill).toHaveLength(1);
    expect(r.bySkill[0]!.skill).toBe("example-skill");
    expect(r.bySkill[0]!.messages).toBe(2);
    expect(r.bySkill[0]!.costDuringRun).toBeCloseTo(2 * c, 10);

    expect(r.bySpawnDepth.map((x) => [x.depth, x.messages])).toEqual([
      [1, 2],
      [2, 1],
      [null, 1],
    ]);
  });

  it("reconciles with the dashboard headline over the same window", () => {
    seed(store);
    // Ground truth from the fixture's own tokens, computed outside both paths.
    const expected = 6 * COST_PER_MESSAGE;
    const report = buildAgentCostReport(store);
    expect(report.coverage.totalCost).toBeCloseTo(expected, 10);
    expect(report.coverage.totalCost).toBeCloseTo(headlineCost(store), 10);
    const dashboard = buildDashboard(store, { period: "all" });
    expect(dashboard.summary.estimatedCost).toBeCloseTo(Math.round(report.coverage.totalCost * 100) / 100, 10);

    // A bounded window too.
    const window = { since: T0 + 2 * MIN, until: T0 + 5 * MIN };
    const windowed = buildAgentCostReport(store, window);
    expect(windowed.coverage.messages).toBe(3);
    expect(windowed.coverage.totalCost).toBeCloseTo(headlineCost(store, window), 10);
    expect(windowed.coverage.totalCost).toBeCloseTo(3 * COST_PER_MESSAGE, 10);
  });

  it("reports a model with no rate as unpriced at $0 and passes rate overrides through", () => {
    seed(store);
    store.upsertMessages([message("m-unknown", MAIN_ID, { timestamp: T0 + 7 * MIN, model: "unpriced-model-x" })]);
    const r = buildAgentCostReport(store);
    expect(r.coverage.unpricedMessages).toBe(1);
    expect(r.coverage.totalCost).toBeCloseTo(6 * COST_PER_MESSAGE, 10);

    // A configured rate for that model prices it: $10/M input, $10/M output
    // on 100K + 20K tokens = $1.20.
    const priced = buildAgentCostReport(store, {
      rateOverrides: {
        first_party: {
          "unpriced-model-x": {
            inputPerMillion: 10, outputPerMillion: 10, cacheReadPerMillion: 1,
            cacheWritePerMillion: 12.5, cacheWrite1hPerMillion: 20, ttlRateBasis: "parsed",
          },
        },
      },
    });
    expect(priced.coverage.unpricedMessages).toBe(0);
    expect(priced.coverage.totalCost).toBeCloseTo(6 * COST_PER_MESSAGE + 1.2, 10);
  });

  it("passes limit and periodGranularity through to the core", () => {
    seed(store);
    const r = buildAgentCostReport(store, { limit: 1, periodGranularity: "week" });
    expect(r.byAgentType.map((x) => x.agentType)).toEqual(["my-reviewer", null]);
    expect(r.other.byAgentType).toMatchObject({ buckets: 1, messages: 1 });
    expect(r.coverage.periodGranularity).toBe("week");
  });

  it("carries no session id and no project path in the serialized report", () => {
    seed(store);
    const json = JSON.stringify(buildAgentCostReport(store));
    // Paired positive: the names the report is for ARE there.
    expect(json).toContain("my-reviewer");
    expect(json).toContain("example-skill");
    expect(json).not.toContain("SENTINEL");
    for (const id of [MAIN_ID, SUB_TYPED_ID, SUB_UNTYPED_ID, SUB_BUILTIN_ID]) expect(json).not.toContain(id);
    expect(json).not.toContain(PROJECT);
    expect(json).not.toContain("m-main-1");
    expect(json).not.toContain("msg_group_1");
  });

  it("an empty store gives an all-zero report", () => {
    const r = buildAgentCostReport(store);
    expect(r.coverage.totalCost).toBe(0);
    expect(r.coverage.knownTypeShare).toBe(0);
    expect(r.byAgentType).toEqual([]);
  });
});
