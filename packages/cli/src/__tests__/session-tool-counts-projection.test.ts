/**
 * `sessions.tool_use_counts` and `sessions.models` are a projection of
 * `messages` (schema V24).
 *
 * Before V24 both were left out of `recomputeSessionAggregates`, and
 * `upsertSessionIncremental` overwrote them with the parser's result for the
 * appended byte range only — so a session collected in two passes kept just the
 * second pass's tools and models. These tests fail on that build.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import os from "os";
import path from "path";
import fs from "fs";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import { projectModels, projectToolUseCounts } from "../sync-merge/merge.js";
import * as pathsMod from "@claude-stats/core/paths";
import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";

let dbPath: string;
let store: Store;

function tmpPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "s1",
    projectPath: "/tmp/p",
    sourceFile: "/tmp/p/s1.jsonl",
    firstTimestamp: 1_000_000,
    lastTimestamp: 1_005_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: [],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...over,
  };
}

function makeMessage(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid: "m1",
    sessionId: "s1",
    timestamp: 1_000_000,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    filePaths: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    toolErrorCount: 0,
    isTurnStart: false,
    ...over,
  };
}

function rawSession(sessionId = "s1"): { tool_use_counts: string; models: string } {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw
    .prepare("SELECT tool_use_counts, models FROM sessions WHERE session_id = ?")
    .get(sessionId) as { tool_use_counts: string; models: string };
  raw.close();
  return row;
}

beforeEach(() => {
  dbPath = `${tmpPath("cs-toolcounts")}.db`;
  store = new Store(dbPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    store.close();
  } catch {
    /* already closed by a test that reopens the store */
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
});

describe("collect — tool counts and models survive an incremental (append) pass", () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = tmpPath("cs-toolcounts-proj");
    fs.mkdirSync(projectsDir, { recursive: true });
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...original, projectsDir });
  });

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  function line(uuid: string, model: string, tools: string[]): string {
    return JSON.stringify({
      type: "assistant",
      sessionId: "sess-tc",
      version: "2.1.70",
      timestamp: 1_700_000_000_000,
      uuid,
      message: {
        id: `msg_${uuid}`,
        model,
        stop_reason: "tool_use",
        content: tools.map((name, i) => ({ type: "tool_use", id: `toolu_${uuid}_${i}`, name, input: {} })),
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  it("keeps the first pass's tools and models after the second pass", async () => {
    const projDir = path.join(projectsDir, "-proj-tc");
    fs.mkdirSync(projDir);
    const file = path.join(projDir, "sess-tc.jsonl");

    fs.writeFileSync(file, line("a1", "claude-opus-4-6", ["Read", "Bash"]) + "\n");
    await collect(store);
    fs.appendFileSync(file, line("a2", "claude-sonnet-4", ["Bash", "Edit"]) + "\n");
    await collect(store);

    const row = rawSession("sess-tc");
    expect(JSON.parse(row.tool_use_counts)).toEqual([
      { name: "Bash", count: 2 },
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
    ]);
    expect(JSON.parse(row.models)).toEqual(["claude-opus-4-6", "claude-sonnet-4"]);
  });

  it("does not count a replayed entry twice when it arrives in a later pass", async () => {
    const projDir = path.join(projectsDir, "-proj-tc2");
    fs.mkdirSync(projDir);
    const file = path.join(projDir, "sess-tc.jsonl");

    fs.writeFileSync(file, line("a1", "claude-opus-4-6", ["Read"]) + "\n");
    await collect(store);
    // A resume replays the earlier entry verbatim (same uuid) after new work.
    fs.appendFileSync(file, line("a1", "claude-opus-4-6", ["Read"]) + "\n" + line("a2", "claude-opus-4-6", ["Read"]) + "\n");
    await collect(store);

    expect(JSON.parse(rawSession("sess-tc").tool_use_counts)).toEqual([{ name: "Read", count: 2 }]);
  });
});

describe("recomputeSessionAggregates — tool_use_counts and models", () => {
  it("replaces a chunk-only value with the projection over every message", () => {
    store.upsertSession(makeSession({ toolUseCounts: [{ name: "Edit", count: 1 }], models: ["claude-sonnet-4"] }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", model: "claude-opus-4-6", tools: ["Read", "Bash", "Bash"] }),
      makeMessage({ uuid: "m2", model: "claude-sonnet-4", tools: ["Edit"] }),
    ]);

    store.recomputeSessionAggregates(["s1"]);

    const row = rawSession();
    expect(row.tool_use_counts).toBe(
      '[{"name":"Bash","count":2},{"name":"Edit","count":1},{"name":"Read","count":1}]',
    );
    expect(row.models).toBe('["claude-opus-4-6","claude-sonnet-4"]');
  });

  it("writes an empty list for a session whose messages used no tools", () => {
    store.upsertSession(makeSession({ toolUseCounts: [{ name: "Bash", count: 9 }] }));
    store.upsertMessages([makeMessage({ uuid: "m1", tools: [] })]);

    store.recomputeSessionAggregates(["s1"]);

    expect(rawSession().tool_use_counts).toBe("[]");
  });

  it("leaves a session with no message rows alone", () => {
    store.upsertSession(makeSession({ toolUseCounts: [{ name: "Bash", count: 9 }], models: ["m-x"] }));

    store.recomputeSessionAggregates(["s1"]);

    expect(JSON.parse(rawSession().tool_use_counts)).toEqual([{ name: "Bash", count: 9 }]);
    expect(JSON.parse(rawSession().models)).toEqual(["m-x"]);
  });

  it("skips a malformed tools value instead of failing the whole update", () => {
    store.upsertSession(makeSession());
    store.upsertMessages([
      makeMessage({ uuid: "m1", tools: ["Read"] }),
      makeMessage({ uuid: "m2", tools: ["Bash"] }),
    ]);
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE messages SET tools = 'not json' WHERE uuid = 'm2'").run();
    raw.close();
    store = new Store(dbPath);

    store.recomputeSessionAggregates(["s1"]);

    expect(JSON.parse(rawSession().tool_use_counts)).toEqual([{ name: "Read", count: 1 }]);
  });
});

describe("migration V24 — repairs tool_use_counts and models from messages", () => {
  it("rebuilds both columns for an existing database", () => {
    store.upsertSession(makeSession({ toolUseCounts: [{ name: "Edit", count: 1 }], models: ["claude-sonnet-4"] }));
    store.upsertMessages([
      makeMessage({ uuid: "m1", model: "claude-opus-4-6", tools: ["Read"] }),
      makeMessage({ uuid: "m2", model: "claude-sonnet-4", tools: ["Edit"] }),
    ]);
    store.close();
    // Reproduce the pre-V24 state: chunk-only values and an older schema stamp.
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare("UPDATE sessions SET tool_use_counts = ?, models = ? WHERE session_id = 's1'")
      .run('[{"name":"Edit","count":1}]', '["claude-sonnet-4"]');
    raw.prepare("UPDATE metadata SET value = '23' WHERE key = 'schema_version'").run();
    raw.close();

    store = new Store(dbPath);

    expect(JSON.parse(rawSession().tool_use_counts)).toEqual([
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
    ]);
    expect(JSON.parse(rawSession().models)).toEqual(["claude-opus-4-6", "claude-sonnet-4"]);
  });
});

describe("the SQL projection and the sync-merge mirror agree byte for byte", () => {
  const toolName = fc.constantFrom("Read", "Bash", "Edit", "Write", "Grep", "mcp__srv__x", "Task", "aa", "a");
  const modelName = fc.option(fc.constantFrom("claude-opus-4-6", "claude-sonnet-4", "<synthetic>", "z"), {
    nil: null,
  });

  it("for any set of messages", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ tools: fc.array(toolName, { maxLength: 5 }), model: modelName }), {
          minLength: 1,
          maxLength: 12,
        }),
        (msgs) => {
          const p = `${tmpPath("cs-toolcounts-prop")}.db`;
          const s = new Store(p);
          try {
            s.upsertSession(makeSession());
            s.upsertMessages(
              msgs.map((m, i) => makeMessage({ uuid: `u${i}`, tools: m.tools, model: m.model })),
            );
            s.recomputeSessionAggregates(["s1"]);
            const raw = new DatabaseSync(p, { readOnly: true });
            const row = raw
              .prepare("SELECT tool_use_counts, models FROM sessions WHERE session_id = 's1'")
              .get() as { tool_use_counts: string; models: string };
            raw.close();

            const rows = msgs.map((m) => ({ tools: JSON.stringify(m.tools), model: m.model }));
            expect(row.tool_use_counts).toBe(projectToolUseCounts(rows));
            expect(row.models).toBe(projectModels(rows));
          } finally {
            s.close();
            for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${p}${suffix}`, { force: true });
          }
        },
      ),
      { numRuns: 60, seed: 24 },
    );
  });
});
