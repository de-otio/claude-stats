/**
 * A3 — memoize the ticket-attribution `git log` lookups.
 *
 * `runTicketExtraction` (ticketing/index.ts) calls `getCommitSubjectsInWindow`
 * inside `collect`'s per-session loop with no memoization, and that function
 * uses a BLOCKING `execFileSync`. `backfill` resets checkpoints and re-collects
 * every session, so this fanned out to one blocking `git log` subprocess per
 * session file — almost all redundant when many sessions share a project and
 * land close together in time.
 *
 * Fix: `getCommitSubjectsInWindowCached` (recap/git.ts) coarsens the window to
 * a day-aligned UTC bucket, spawns at most one `git log` per (project, bucket),
 * and `runTicketExtraction` / `collect` thread one shared `CommitSubjectsCache`
 * through a whole run so sessions in the same project/day reuse it.
 *
 * This file proves the reduction by spying on `execFileSync` (wrapped so it
 * still calls through to the real git binary — real temp repos throughout,
 * same convention as recap/git.test.ts) and counting invocations.
 *
 * Design: doc/analysis/ticket-attribution/02-local-data-model.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import { runTicketExtraction } from "../ticketing/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function initRepoWithCommit(repoDir: string, message: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "a.txt"), "hello");
  execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repoDir });
}

/** Count only the `git log` invocations among every recorded execFileSync call
 *  — `git init`/`config`/`add`/`commit` calls (repo setup) don't count. */
async function countGitLogCalls(): Promise<number> {
  const cp = await import("node:child_process");
  const spy = vi.mocked(cp.execFileSync);
  return spy.mock.calls.filter(
    ([cmd, args]) => cmd === "git" && Array.isArray(args) && args.includes("log"),
  ).length;
}

describe("getCommitSubjectsInWindowCached (A3)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "claude-stats-ticket-cache-test-"));
    initRepoWithCommit(repoDir, "PROJ-9: land the cached fix");
    const cp = await import("node:child_process");
    vi.mocked(cp.execFileSync).mockClear();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("spawns ONE `git log` for two nearby windows in the same project sharing a cache, and a SECOND for a window days later", async () => {
    const { createCommitSubjectsCache, getCommitSubjectsInWindowCached } = await import("../recap/git.js");
    const cache = createCommitSubjectsCache();
    const now = Date.now();

    // Two "sessions" a few minutes apart — same project, same day bucket.
    const first = getCommitSubjectsInWindowCached(cache, repoDir, now - 5 * 60_000, now + 60_000);
    const second = getCommitSubjectsInWindowCached(cache, repoDir, now - 2 * 60_000, now + 90_000);
    expect(first).toContain("PROJ-9: land the cached fix");
    expect(second).toContain("PROJ-9: land the cached fix");
    expect(await countGitLogCalls()).toBe(1);

    // A third "session" three days later — a different day-aligned bucket —
    // must spawn a second `git log`, proving the cache isn't just "always hit".
    const laterMs = now + 3 * 24 * 60 * 60 * 1000;
    getCommitSubjectsInWindowCached(cache, repoDir, laterMs, laterMs + 60_000);
    expect(await countGitLogCalls()).toBe(2);
  });

  it("without a shared cache (a fresh one per call), the same two nearby windows spawn TWO `git log` calls", async () => {
    const { createCommitSubjectsCache, getCommitSubjectsInWindowCached } = await import("../recap/git.js");
    const now = Date.now();
    getCommitSubjectsInWindowCached(createCommitSubjectsCache(), repoDir, now - 5 * 60_000, now + 60_000);
    getCommitSubjectsInWindowCached(createCommitSubjectsCache(), repoDir, now - 2 * 60_000, now + 90_000);
    expect(await countGitLogCalls()).toBe(2);
  });

  it("returns exactly what the unmemoized `getCommitSubjectsInWindow` returns, for the same window (correctness, not just fewer calls)", async () => {
    const { getCommitSubjectsInWindow, createCommitSubjectsCache, getCommitSubjectsInWindowCached } =
      await import("../recap/git.js");
    const now = Date.now();
    const unmemoized = getCommitSubjectsInWindow(repoDir, now - 60_000, now + 60_000);
    const memoized = getCommitSubjectsInWindowCached(createCommitSubjectsCache(), repoDir, now - 60_000, now + 60_000);
    expect(memoized).toEqual(unmemoized);
  });
});

describe("runTicketExtraction threads a shared commitCache across sessions (A3 wiring)", () => {
  let dbPath: string;
  let store: Store;
  let repoDir: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-cache-wr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
    repoDir = mkdtempSync(join(tmpdir(), "claude-stats-ticket-cache-wiring-"));
    initRepoWithCommit(repoDir, "chore: unrelated");
    const cp = await import("node:child_process");
    vi.mocked(cp.execFileSync).mockClear();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  function seedSession(sessionId: string, firstTimestamp: number) {
    store.upsertSession({
      sessionId,
      projectPath: repoDir,
      sourceFile: `/tmp/${sessionId}.jsonl`,
      firstTimestamp,
      lastTimestamp: firstTimestamp + 60_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude-cli",
      gitBranch: null,
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

  it("two sessions in the same project, minutes apart, sharing one commitCache spawn ONE `git log` between them", async () => {
    const { createCommitSubjectsCache } = await import("../recap/git.js");
    const cache = createCommitSubjectsCache();

    seedSession("s1", FIXED_NOW);
    seedSession("s2", FIXED_NOW + 5 * 60_000);

    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"], commitCache: cache });
    runTicketExtraction(store, store.findSession("s2")!, { allowlist: ["PROJ"], commitCache: cache });

    expect(await countGitLogCalls()).toBe(1);
  });

  it("the same two sessions WITHOUT a shared cache spawn TWO `git log` calls (proves the cache — not something else — is doing the work)", async () => {
    seedSession("s1", FIXED_NOW);
    seedSession("s2", FIXED_NOW + 5 * 60_000);

    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"] });
    runTicketExtraction(store, store.findSession("s2")!, { allowlist: ["PROJ"] });

    expect(await countGitLogCalls()).toBe(2);
  });
});
