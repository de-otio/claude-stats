import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "../paths.js";
import * as accountMod from "../account.js";
import os from "os";
import path from "path";
import fs from "fs";

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `cs-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-agg-1",
    version: "2.1.70",
    timestamp: 1_700_000_000_000,
    uuid: `msg-${Math.random()}`,
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    message: {
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
      },
    },
    ...overrides,
  });
}

function makeUserLine(sessionId = "sess-agg-1"): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    version: "2.1.70",
    timestamp: 1_699_999_000_000,
    uuid: `usr-${Math.random()}`,
    isMeta: false,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("collect", () => {
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    projectsDir = tmpDir();
    dbPath = path.join(os.tmpdir(), `cs-agg-db-${Date.now()}.db`);
    store = new Store(dbPath);

    // Redirect scanner to temp projects dir
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      projectsDir,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("returns zeros for empty projects directory", async () => {
    const result = await collect(store);
    expect(result.filesProcessed).toBe(0);
    expect(result.filesSkipped).toBe(0);
    expect(result.sessionsUpserted).toBe(0);
  });

  it("processes a new session file end-to-end", async () => {
    const projDir = path.join(projectsDir, "-proj-test");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess-agg-1.jsonl");
    fs.writeFileSync(sessFile, [makeUserLine(), makeSessionLine()].join("\n") + "\n");

    const result = await collect(store);
    expect(result.filesProcessed).toBe(1);
    expect(result.sessionsUpserted).toBe(1);
    expect(result.messagesUpserted).toBe(1);

    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe("sess-agg-1");
    expect(sessions[0]!.prompt_count).toBe(1);
    expect(sessions[0]!.input_tokens).toBe(100);
  });

  it("skips unchanged files on second run", async () => {
    const projDir = path.join(projectsDir, "-proj-skip");
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, "sess.jsonl"), makeSessionLine() + "\n");

    await collect(store);
    const result2 = await collect(store);
    expect(result2.filesSkipped).toBe(1);
    expect(result2.filesProcessed).toBe(0);
  });

  it("processes only new lines when file is appended", async () => {
    const projDir = path.join(projectsDir, "-proj-append");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess.jsonl");

    // Write one line and collect
    fs.writeFileSync(sessFile, makeSessionLine() + "\n");
    await collect(store);

    // Append a second line and collect again
    fs.appendFileSync(sessFile, makeSessionLine({ uuid: "msg-second" }) + "\n");
    // Force mtime to change by touching the file stat (already changed by write)
    const result2 = await collect(store);
    expect(result2.filesProcessed).toBe(1);
    // The second message is in a different session record aggregate, messages count increments
    expect(result2.messagesUpserted).toBe(1);
  });

  it("records parse errors in quarantine", async () => {
    const projDir = path.join(projectsDir, "-proj-err");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess.jsonl");
    // A valid line, then a bad mid-line, then another valid line
    fs.writeFileSync(sessFile,
      makeSessionLine() + "\n" +
      "NOT VALID JSON {\n" +
      makeSessionLine({ uuid: "msg-3" }) + "\n"
    );

    const result = await collect(store);
    expect(result.parseErrors).toBe(1);
    expect(store.getStatus().quarantineCount).toBe(1);
  });

  it("marks file as source_deleted when file disappears", async () => {
    const projDir = path.join(projectsDir, "-proj-del");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "vanish.jsonl");
    fs.writeFileSync(sessFile, makeSessionLine() + "\n");

    await collect(store);

    // Now delete the file and collect again — the scanner will discover it
    // then getFileStats returns null
    fs.unlinkSync(sessFile);
    const result2 = await collect(store);
    expect(result2.filesDeleted).toBe(1);
  });

  it("stamps account from ~/.claude.json when telemetry has no match", async () => {
    vi.spyOn(accountMod, "readClaudeAccount").mockReturnValue({
      accountUuid: "acct-from-config",
      emailAddress: "me@example.com",
      organizationUuid: "org-123",
    });

    const projDir = path.join(projectsDir, "-proj-acct");
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, "sess-agg-1.jsonl"),
      [makeUserLine(), makeSessionLine()].join("\n") + "\n",
    );

    await collect(store);
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.account_uuid).toBe("acct-from-config");
  });

  it("does not overwrite existing account_uuid on reparse", async () => {
    // First parse: stamp with account A
    vi.spyOn(accountMod, "readClaudeAccount").mockReturnValue({
      accountUuid: "acct-A",
      emailAddress: "a@example.com",
      organizationUuid: null,
    });

    const projDir = path.join(projectsDir, "-proj-reparse");
    fs.mkdirSync(projDir);
    const sessFile = path.join(projDir, "sess-agg-1.jsonl");
    fs.writeFileSync(sessFile, [makeUserLine(), makeSessionLine()].join("\n") + "\n");

    await collect(store);
    let sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(sessions[0]!.account_uuid).toBe("acct-A");

    // Simulate switching to account B and reparsing (file rewrite triggers full reparse)
    vi.spyOn(accountMod, "readClaudeAccount").mockReturnValue({
      accountUuid: "acct-B",
      emailAddress: "b@example.com",
      organizationUuid: null,
    });

    // Force reparse by rewriting the file with different first-KB hash
    fs.writeFileSync(sessFile, [makeUserLine(), makeSessionLine({ uuid: "msg-rewrite" })].join("\n") + "\n");

    await collect(store);
    sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    expect(sessions).toHaveLength(1);
    // Account A should be preserved — COALESCE(sessions.account_uuid, excluded.account_uuid)
    expect(sessions[0]!.account_uuid).toBe("acct-A");
  });
});
