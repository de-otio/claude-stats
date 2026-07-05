/**
 * Regression tests for the project-path repair backfill (bug: sessions
 * collected before parser/session.ts preferred the session's own `cwd`
 * stayed stuck on decodeProjectPath's lossy directory-name guess forever,
 * since Store#upsertSession excludes project_path from its ON CONFLICT
 * clause). Mirrors attribution/reattribute.ts's dry-run + backup + atomic
 * conventions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import type { SessionRecord } from "@claude-stats/core/types";
import { repairProjectPaths } from "../repair/project-paths.js";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `cs-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function tmpSourceDir(): string {
  const dir = path.join(os.tmpdir(), `cs-repair-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fixedClock(ms: number): () => number {
  return () => ms;
}

function makeSession(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    projectPath: "/wrong/decoded/path",
    sourceFile: "/nonexistent.jsonl",
    firstTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_100_000,
    claudeVersion: "2.1.186",
    entrypoint: "cli",
    gitBranch: "main",
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
    models: ["claude-opus-4-6"],
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
  };
}

describe("repairProjectPaths", () => {
  let store: Store;
  let dbPath: string;
  let srcDir: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new Store(dbPath);
    srcDir = tmpSourceDir();
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    const dbDir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dbDir)) {
      if (f.startsWith(path.basename(dbPath) + ".pre-repair-project-paths-")) {
        try { fs.unlinkSync(path.join(dbDir, f)); } catch { /* ok */ }
      }
    }
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("corrects project_path and repo_url from the session's own cwd, backing up the DB first", async () => {
    const realProjectDir = path.join(srcDir, "my-project");
    fs.mkdirSync(path.join(realProjectDir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(realProjectDir, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:example/my-project.git\n'
    );

    const sourceFile = path.join(srcDir, "sess-1.jsonl");
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({ type: "user", sessionId: "sess-1", cwd: realProjectDir, timestamp: 1_700_000_000_000, uuid: "u-1" }) + "\n"
    );

    store.upsertSession(makeSession({
      sessionId: "sess-1",
      projectPath: "/wrong/decoded/my/project",
      sourceFile,
    }));

    const summary = await repairProjectPaths(store, { dryRun: false }, fixedClock(1_700_000_500_000));

    expect(summary.changed).toBe(1);
    expect(summary.unfixable).toBe(0);
    expect(summary.backupPath).not.toBeNull();
    expect(fs.existsSync(summary.backupPath!)).toBe(true);

    const session = store.getSessions({ includeCI: true }).find((s) => s.session_id === "sess-1");
    expect(session!.project_path).toBe(realProjectDir);
    expect(session!.repo_url).toBe("git@github.com:example/my-project.git");
  });

  it("dry-run reports the count but writes nothing", async () => {
    const realProjectDir = path.join(srcDir, "my-project");
    fs.mkdirSync(realProjectDir, { recursive: true });
    const sourceFile = path.join(srcDir, "sess-2.jsonl");
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({ type: "user", sessionId: "sess-2", cwd: realProjectDir, timestamp: 1_700_000_000_000, uuid: "u-2" }) + "\n"
    );

    store.upsertSession(makeSession({
      sessionId: "sess-2",
      projectPath: "/wrong/decoded/my/project",
      sourceFile,
    }));

    const summary = await repairProjectPaths(store, { dryRun: true }, fixedClock(1_700_000_500_000));

    expect(summary.dryRun).toBe(true);
    expect(summary.changed).toBe(1);
    expect(summary.backupPath).toBeNull();

    const session = store.getSessions({ includeCI: true }).find((s) => s.session_id === "sess-2");
    expect(session!.project_path).toBe("/wrong/decoded/my/project");
  });

  it("counts a session with a missing source file as unfixable and leaves it untouched", async () => {
    store.upsertSession(makeSession({
      sessionId: "sess-3",
      projectPath: "/wrong/decoded/gone",
      sourceFile: path.join(srcDir, "does-not-exist.jsonl"),
    }));

    const summary = await repairProjectPaths(store, { dryRun: false }, fixedClock(1_700_000_500_000));

    expect(summary.changed).toBe(0);
    expect(summary.unfixable).toBe(1);
    expect(summary.backupPath).toBeNull();

    const session = store.getSessions({ includeCI: true }).find((s) => s.session_id === "sess-3");
    expect(session!.project_path).toBe("/wrong/decoded/gone");
  });

  it("leaves a session alone when the stored project_path is already correct", async () => {
    const realProjectDir = path.join(srcDir, "already-right");
    fs.mkdirSync(realProjectDir, { recursive: true });
    const sourceFile = path.join(srcDir, "sess-4.jsonl");
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({ type: "user", sessionId: "sess-4", cwd: realProjectDir, timestamp: 1_700_000_000_000, uuid: "u-4" }) + "\n"
    );

    store.upsertSession(makeSession({
      sessionId: "sess-4",
      projectPath: realProjectDir,
      sourceFile,
    }));

    const summary = await repairProjectPaths(store, { dryRun: false }, fixedClock(1_700_000_500_000));

    expect(summary.changed).toBe(0);
    expect(summary.backupPath).toBeNull();
  });
});
