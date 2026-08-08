/**
 * `claude-stats constraint-impact` — the CLI verb, driven end-to-end through
 * `buildCli`/`parseAsync` (not a re-implementation of its handler).
 *
 * Three collaborators are mocked, none of them the code under test:
 *   - `../store/index.js`      → CliTestStore always opens a throwaway temp
 *                                 file, so the command's own `new Store()`
 *                                 resolves to a store this test seeded.
 *   - `../aggregator/index.js` → `collect()` walks the real
 *                                 `~/.claude/projects` tree; without a mock a
 *                                 "test" would import the operator's actual
 *                                 session history into the run.
 *   - `../config.js`           → `loadConfig()` reads the real
 *                                 `~/.claude-stats/config.json`; without a
 *                                 mock this test's pass/fail would depend on
 *                                 whatever policyEvents happen to be
 *                                 configured on the machine that runs it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TASK_CLASS_VERSION } from "@claude-stats/core/taskClass";
import { Store } from "../store/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

let tmpRoot: string;
let cliDbPath: string;

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  class CliTestStore extends actual.Store {
    constructor() {
      super(cliDbPath);
    }
  }
  return { ...actual, Store: CliTestStore };
});

vi.mock("../aggregator/index.js", () => ({
  collect: vi.fn(async () => ({
    filesProcessed: 0, filesSkipped: 0, filesDeleted: 0, sessionsUpserted: 0,
    messagesUpserted: 0, accountsMatched: 0, messagesStamped: 0, ownerOverrides: 0,
    parseErrors: 0, schemaChanges: [],
  })),
}));

const loadConfigMock = vi.fn<() => Config>(() => ({}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: () => loadConfigMock() };
});

const DAY_MS = 86_400_000;
const BOUNDARY_MS = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
const MIN = 8;

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

function seedClass(store: Store, prefix: string, n: number, ts: number): void {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    store.upsertSession(session(id, ts));
    store.upsertMessages([message(`${id}-m0`, id, ts)]);
    store.setTaskClass({
      sessionId: id, taskClass: "debug", coarseClass: "diagnose", confidence: "high",
      rule: "diagnosis", classifierVersion: TASK_CLASS_VERSION, classifiedAt: ts,
    });
  }
}

describe("claude-stats constraint-impact (CLI verb, end-to-end)", () => {
  let realStore: Store;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-constraint-impact-cli-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    realStore = new Store();
    seedClass(realStore, "before", MIN, BOUNDARY_MS - DAY_MS);
    seedClass(realStore, "after", MIN, BOUNDARY_MS + DAY_MS);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    realStore.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    loadConfigMock.mockReturnValue({});
  });

  async function run(args: string[]): Promise<void> {
    const { buildCli } = await import("../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "constraint-impact", ...args]);
  }

  function stdoutJson(): Record<string, unknown> {
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;
    const calls = writeSpy.mock.calls as Array<[string]>;
    const text = calls.map((c) => c[0]).join("");
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("refuses with an enablement path when no policy events are declared", async () => {
    loadConfigMock.mockReturnValue({});
    await run([]);
    expect(errorSpy).toHaveBeenCalled();
    const message = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(message).toContain("policyEvents");
  });

  it("compares around the declared event and prints a well-shaped two-sided JSON report", async () => {
    loadConfigMock.mockReturnValue({
      policyEvents: [{ date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" }],
    });
    await run([]);
    const data = stdoutJson();
    expect(data["classesCompared"]).toBe(1);
    expect(data).toHaveProperty("totalTokenSavings");
    expect(data).toHaveProperty("totalDevTimeCost");
    expect(data).toHaveProperty("confoundNote");
    expect(data).toHaveProperty("notMeasured");
  });

  it("refuses a non-numeric --min-sessions instead of silently dropping the sample-size gate", async () => {
    loadConfigMock.mockReturnValue({
      policyEvents: [{ date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" }],
    });
    await run(["--min-sessions", "abc"]);
    const message = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(message).toContain("--min-sessions");
    // Nothing printed: no report may be published under a floor that isn't one.
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;
    expect(writeSpy.mock.calls).toHaveLength(0);
  });

  it("writes the CSV export when --csv is given", async () => {
    loadConfigMock.mockReturnValue({
      policyEvents: [{ date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" }],
    });
    const csvPath = path.join(tmpRoot, "out.csv");
    await run(["--csv", csvPath]);
    const csv = fs.readFileSync(csvPath, "utf-8");
    expect(csv).toContain("classKey,grain,verdict");
    expect(csv).toContain("debug,");
  });
});
