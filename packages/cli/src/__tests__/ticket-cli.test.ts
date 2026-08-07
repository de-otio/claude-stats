/**
 * `claude-stats ticket <session> [key]` — the CLI verb Lane L adds over the
 * Phase 0 storage seam (`addTicketLink` / `removeTicketLink` /
 * `negateTicketLink` / `getTicketLinksForSession`).
 *
 * Kept in its OWN file, separate from `ticket-corrections.test.ts`: this file
 * `vi.mock`s `../store/index.js` so `new Store()` (what the CLI command
 * itself constructs) opens a throwaway temp file instead of the real
 * `~/.claude-stats` database — and `vi.mock` is file-scoped, so mixing it
 * into a file that also constructs `Store` directly with an explicit path
 * would leak the mock across describes and silently redirect THOSE tests at
 * the real database too (caught by running this suite: the "store" tests
 * returned live production data before the split).
 *
 * Design: doc/analysis/ticket-attribution/02-local-data-model.md §2.4, §2.6.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import type { MessageRecord } from "@claude-stats/core/types";
import { runTicketExtraction, getTicketCostReport } from "../ticketing/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

/**
 * Cost (02 §2.5) is never stored on the session row — it's computed on read
 * from per-message tokens × pricing, so the coverage/per-ticket-sum test
 * needs real `messages` rows, not just session-level aggregate columns.
 */
function seedMessage(sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid: `${sessionId}-m-${Math.random().toString(36).slice(2)}`,
    sessionId,
    timestamp: FIXED_NOW,
    claudeVersion: null,
    model: "claude-sonnet-4-6",
    stopReason: "end_turn",
    inputTokens: 500,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    ...overrides,
  };
}

function seedSession(
  store: Store,
  sessionId: string,
  overrides: Partial<Parameters<Store["upsertSession"]>[0]> = {},
): void {
  store.upsertSession({
    sessionId,
    projectPath: "/tmp/nonexistent-project",
    sourceFile: `/tmp/${sessionId}.jsonl`,
    firstTimestamp: FIXED_NOW,
    lastTimestamp: FIXED_NOW + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-cli",
    gitBranch: "feature/PROJ-1-work",
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
    ...overrides,
  });
}

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

describe("claude-stats ticket (CLI verb)", () => {
  let realStore: Store;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cliDbPath = path.join(os.tmpdir(), `cs-ticket-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    // `Store` (imported above) is the mocked subclass that always opens
    // `cliDbPath` — so seeding through it here seeds the exact file the CLI
    // command's own `new Store()` will open.
    realStore = new Store();
    seedSession(realStore, "abc123def456");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    realStore.close();
    try { fs.unlinkSync(cliDbPath); } catch { /* ok */ }
    vi.restoreAllMocks();
  });

  async function run(...args: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
    const { buildCli } = await import("../cli/index.js");
    const program = await buildCli();
    process.exitCode = undefined;
    await program.parseAsync(["node", "claude-stats", "ticket", ...args]);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    const code = process.exitCode;
    process.exitCode = undefined;
    return { out, err, code };
  }

  it("links a session to a key, and the link is queryable afterward", async () => {
    await run("abc123def456", "PROJ-99");
    const links = realStore.getTicketLinksForSession("abc123def456");
    expect(links).toContainEqual(
      expect.objectContaining({ ticket_key: "PROJ-99", source: "tag", confidence: "high", negated: 0 }),
    );
  });

  it("accepts a lowercase key and normalizes it (matches requireTicketKey)", async () => {
    await run("abc123def456", "proj-5");
    const links = realStore.getTicketLinksForSession("abc123def456");
    expect(links.some((l) => l.ticket_key === "PROJ-5")).toBe(true);
  });

  it("rejects a malformed key and writes nothing", async () => {
    const { code, err } = await run("abc123def456", "not-a-key!!");
    expect(code).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(realStore.getTicketLinksForSession("abc123def456")).toHaveLength(0);
  });

  it("errors on an unknown session and writes nothing", async () => {
    const { code } = await run("no-such-session", "PROJ-1");
    expect(code).toBe(1);
    expect(realStore.getTicketKeys()).toHaveLength(0);
  });

  it("--negate tombstones the key without deleting the automatic row that disagrees with it", async () => {
    runTicketExtraction(realStore, realStore.findSession("abc123def456")!, { allowlist: ["PROJ"] });
    const before = realStore.getTicketLinksForSession("abc123def456");
    const branchRow = before.find((l) => l.source === "branch")!;
    expect(branchRow).toBeDefined();

    await run("abc123def456", "PROJ-1", "--negate");

    const after = realStore.getTicketLinksForSession("abc123def456");
    // The automatic branch row still exists, unmodified — negation records
    // disagreement, it does not rewrite what the extractor found.
    const branchRowAfter = after.find((l) => l.source === "branch")!;
    expect(branchRowAfter).toEqual(branchRow);
    // But the key no longer counts as active anywhere it's read.
    expect(realStore.getTicketKeys().some((k) => k.ticket_key === "PROJ-1")).toBe(false);
    expect(
      realStore.getActiveTicketLinks().some((l) => l.session_id === "abc123def456" && l.ticket_key === "PROJ-1"),
    ).toBe(false);
  });

  it("re-running automatic extraction after --negate does not resurrect the key", async () => {
    seedSession(realStore, "extract-me", { gitBranch: "feature/PROJ-1-work" });
    runTicketExtraction(realStore, realStore.findSession("extract-me")!, { allowlist: ["PROJ"] });
    expect(realStore.getTicketLinksForSession("extract-me").some((l) => l.ticket_key === "PROJ-1")).toBe(true);

    await run("extract-me", "PROJ-1", "--negate");
    runTicketExtraction(realStore, realStore.findSession("extract-me")!, { allowlist: ["PROJ"] });

    expect(realStore.getTicketKeys().some((k) => k.ticket_key === "PROJ-1")).toBe(false);
  });

  it("a manual link survives any number of subsequent automatic extraction passes", async () => {
    seedSession(realStore, "manual-wins", { gitBranch: "feature/PROJ-2-unrelated" });
    await run("manual-wins", "PROJ-77");
    for (let i = 0; i < 3; i++) {
      runTicketExtraction(realStore, realStore.findSession("manual-wins")!, { allowlist: ["PROJ"] });
    }
    const manualRow = realStore.getTicketLinksForSession("manual-wins").find((l) => l.source === "tag")!;
    expect(manualRow.ticket_key).toBe("PROJ-77");
    expect(manualRow.confidence).toBe("high");
    expect(manualRow.negated).toBe(0);
  });

  it("--remove deletes only the manual link, leaving the negation rule and other sources untouched", async () => {
    await run("abc123def456", "PROJ-3");
    await run("abc123def456", "PROJ-3", "--remove");
    expect(realStore.getTicketLinksForSession("abc123def456")).toHaveLength(0);
  });

  it("--list prints existing links with source/confidence/status without mutating anything", async () => {
    await run("abc123def456", "PROJ-4");
    const before = realStore.getTicketLinksForSession("abc123def456");
    const { out } = await run("abc123def456", "--list");
    expect(out).toContain("PROJ-4");
    expect(out).toContain("tag/high");
    // The status column is the whole point of `--list`: without it a user
    // cannot tell a live link from a tombstone. Assert the status is actually
    // ON the row (dropping the column entirely leaves every assertion above
    // still passing) and that it flips after a negation.
    const rowOf = (text: string): string =>
      text.split("\n").filter((l) => l.includes("PROJ-4") && l.includes("tag/high")).pop()!.trim();
    // "PROJ-4  tag/high  <status>" — three double-space-separated columns.
    // Dropping the status column leaves two, which every other assertion here
    // would happily accept.
    const rowBefore = rowOf(out);
    expect(rowBefore.split(/\s{2,}/)).toHaveLength(3);
    expect(realStore.getTicketLinksForSession("abc123def456")).toEqual(before);

    await run("abc123def456", "PROJ-4", "--negate");
    const { out: afterNegate } = await run("abc123def456", "--list");
    const rowAfter = rowOf(afterNegate);
    expect(rowAfter.split(/\s{2,}/)).toHaveLength(3);
    // The status must actually track the tombstone, not be a constant string.
    expect(rowAfter).not.toBe(rowBefore);
  });

  it("the coverage figure and per-ticket totals stay consistent after a correction (per-ticket sum + unattributed === period total)", async () => {
    seedSession(realStore, "cov-1", { firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 1_000 });
    seedSession(realStore, "cov-2", { firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 1_000 });
    realStore.upsertMessages([
      seedMessage("cov-1", { inputTokens: 1000, outputTokens: 500 }),
      seedMessage("cov-2", { inputTokens: 2000, outputTokens: 800 }),
    ]);

    await run("cov-1", "PROJ-10");
    const reportAfterOne = getTicketCostReport(realStore, { since: FIXED_NOW - 10_000, until: FIXED_NOW + 10_000 });
    const sumAfterOne = reportAfterOne.tickets.reduce((s, t) => s + t.cost, 0);
    // per-ticket sum + unattributed === period total, where "unattributed" is
    // totalCost - attributedCost (the coverage denominator's own definition).
    expect(sumAfterOne + (reportAfterOne.coverage.totalCost - reportAfterOne.coverage.attributedCost))
      .toBeCloseTo(reportAfterOne.coverage.totalCost, 6);
    expect(sumAfterOne).toBeCloseTo(reportAfterOne.coverage.attributedCost, 6);

    await run("cov-2", "PROJ-10");
    const reportAfterTwo = getTicketCostReport(realStore, { since: FIXED_NOW - 10_000, until: FIXED_NOW + 10_000 });
    const sumAfterTwo = reportAfterTwo.tickets.reduce((s, t) => s + t.cost, 0);
    expect(sumAfterTwo).toBeCloseTo(reportAfterTwo.coverage.attributedCost, 6);
    // Linking a second session strictly increases (never decreases) coverage.
    expect(reportAfterTwo.coverage.attributedCost).toBeGreaterThan(reportAfterOne.coverage.attributedCost);

    // Now negate cov-1's link — coverage must drop back down, and the
    // invariant must still hold, not just happen to hold at the extremes.
    await run("cov-1", "PROJ-10", "--negate");
    const reportAfterNegate = getTicketCostReport(realStore, { since: FIXED_NOW - 10_000, until: FIXED_NOW + 10_000 });
    const sumAfterNegate = reportAfterNegate.tickets.reduce((s, t) => s + t.cost, 0);
    expect(sumAfterNegate).toBeCloseTo(reportAfterNegate.coverage.attributedCost, 6);
    expect(reportAfterNegate.coverage.attributedCost).toBeLessThan(reportAfterTwo.coverage.attributedCost);
  });
});
