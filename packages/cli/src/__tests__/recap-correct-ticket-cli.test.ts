/**
 * `claude-stats recap correct ticket <item> <key>` — the CLI verb, driven
 * end-to-end through `buildCli`/`parseAsync` (not a re-implementation of its
 * write-through loop).
 *
 * L-5 (second half): `cli/index.ts`'s handler labels the digest item via the
 * recap corrections DB, THEN write-throughs every session the item covers
 * into `ticket_links` (cost aggregation reads `ticket_links`, not the
 * corrections DB — the label alone changes nothing for cost reports). The
 * existing coverage for this (`recap/integration.test.ts`'s Scenario 40)
 * re-implemented that second step inline rather than invoking the CLI
 * action, so deleting the write-through call from the handler left the
 * (green) suite blind to it. This file calls the REAL command instead.
 *
 * Three collaborators are mocked, each for a distinct, deliberate reason —
 * none of them is the code under test:
 *   - `../store/index.js`      → CliTestStore always opens a throwaway temp
 *                                 file (see `ticket-cli.test.ts`'s header for
 *                                 why this needs `vi.mock`, not a constructor
 *                                 arg: the command's own `new Store()` must
 *                                 resolve to it).
 *   - `../aggregator/index.js` → `collect()` walks the real
 *                                 `~/.claude/projects` tree; without a mock a
 *                                 "test" would import the operator's actual
 *                                 session history into the run.
 *   - `../recap/corrections.js`→ `openCorrections()` with no path opens the
 *                                 real `~/.claude-stats/recap-corrections.db`
 *                                 on disk; without a mock this test would
 *                                 write into the operator's real corrections
 *                                 store. `computeSignature` (a pure function)
 *                                 is passed through via `importOriginal`.
 * `buildDailyDigest` (`../recap/index.js`) is ALSO mocked — the `ticket`
 * subcommand hard-codes "today" with no `--date` override, so exercising the
 * real clustering pipeline would make this test's pass/fail depend on the
 * wall-clock date it happens to run on. A canned single-item digest sidesteps
 * that non-determinism while keeping the code actually under test — the CLI
 * action's own body, including its call into `ticketing/index.ts`'s
 * `applyTicketCorrectionWriteThrough` — real and unmocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import type { DailyDigest, DailyDigestItem } from "../recap/types.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

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
    filesProcessed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    sessionsUpserted: 0,
    messagesUpserted: 0,
    accountsMatched: 0,
    messagesStamped: 0,
    ownerOverrides: 0,
    parseErrors: 0,
    schemaChanges: [],
  })),
}));

const stubItem: DailyDigestItem = {
  id: "cli90a1b2c3d4e5f6" as DailyDigestItem["id"],
  project: "/tmp/nonexistent-project",
  repoUrl: null,
  sessionIds: ["cli-ticket-sess-1", "cli-ticket-sess-2"],
  segmentIds: [],
  firstPrompt: "<untrusted-stored-content>fix the billing overflow</untrusted-stored-content>",
  characterVerb: "Shipped",
  duration: { wallMs: 600_000, activeMs: 400_000 },
  estimatedCost: 0.02,
  costByModel: { "claude-sonnet-5": 0.02 },
  toolHistogram: {},
  filePathsTouched: ["src/billing.ts"],
  git: null,
  score: 5,
  confidence: "high",
};

const stubDigest: DailyDigest = {
  date: "2024-01-01",
  tz: "UTC",
  totals: { sessions: 2, segments: 1, activeMs: 400_000, estimatedCost: 0.02, projects: 1 },
  items: [stubItem],
  cached: false,
  snapshotHash: "stub-hash",
  clusteringMethod: "jaccard",
};

vi.mock("../recap/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recap/index.js")>();
  return { ...actual, buildDailyDigest: vi.fn(async () => stubDigest) };
});

let corrDbPath: string;

vi.mock("../recap/corrections.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recap/corrections.js")>();
  return {
    ...actual,
    computeSignature: actual.computeSignature,
    openCorrections: (opts?: { dbPath?: string }) => actual.openCorrections({ dbPath: opts?.dbPath ?? corrDbPath }),
  };
});

function seedSession(store: Store, sessionId: string): void {
  store.upsertSession({
    sessionId,
    projectPath: "/tmp/nonexistent-project",
    sourceFile: `/tmp/${sessionId}.jsonl`,
    firstTimestamp: FIXED_NOW,
    lastTimestamp: FIXED_NOW + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-cli",
    gitBranch: "feature/unrelated",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-5"],
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
  });
}

describe("claude-stats recap correct ticket (CLI verb, end-to-end)", () => {
  let realStore: Store;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Own subdirectory, not `os.tmpdir()` itself: `openCorrections` calls
    // `ensurePrivateDir(path.dirname(dbPath))`, which chmods 0700. Pointed at
    // the OS temp ROOT that raises EPERM — but only where the process does not
    // own it, so this passed under a sandbox with a private TMPDIR and failed
    // on a real machine. `mkdtempSync` also removes the Date.now()/Math.random()
    // the path was using for uniqueness.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-recap-ticket-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    corrDbPath = path.join(tmpRoot, "corrections.db");
    realStore = new Store();
    seedSession(realStore, "cli-ticket-sess-1");
    seedSession(realStore, "cli-ticket-sess-2");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    realStore.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
    vi.restoreAllMocks();
  });

  it("links EVERY session in the resolved item to the key — the real write-through, not a re-implementation of it", async () => {
    const { buildCli } = await import("../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "recap", "correct", "ticket", stubItem.id, "PROJ-77"]);

    for (const sessionId of stubItem.sessionIds) {
      const links = realStore.getTicketLinksForSession(sessionId);
      expect(links).toContainEqual(
        expect.objectContaining({ ticket_key: "PROJ-77", source: "tag", confidence: "high", negated: 0 }),
      );
    }
    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("PROJ-77");
  });
});
