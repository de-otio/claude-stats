/**
 * Archive purge — removes archive + bundle dirs and (optionally) the stats DB,
 * calls the injected unregister hook, is path-guarded and idempotent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { purgeAllData } from "../../archive/purge.js";
import { unregisterMcpServerFromClaudeJson, MCP_KEY } from "../../archive/unregister.js";
import { assertSafeToDelete, assertSafeSegment, ArchivePathError } from "../../archive/paths.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-archive-purge-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedTree() {
  const archiveRoot = path.join(tmp, "archive");
  const bundleRoot = path.join(tmp, "bundles");
  const dbPath = path.join(tmp, "stats.db");
  fs.mkdirSync(path.join(archiveRoot, "-proj"), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, "-proj", "s.jsonl"), "{}\n");
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "b.age"), "x");
  fs.writeFileSync(dbPath, "db");
  fs.writeFileSync(dbPath + "-wal", "wal");
  fs.writeFileSync(dbPath + "-shm", "shm");
  return { archiveRoot, bundleRoot, dbPath };
}

describe("purgeAllData", () => {
  it("removes archive + bundle + db (+ sidecars) and calls unregister", () => {
    const { archiveRoot, bundleRoot, dbPath } = seedTree();
    const unregister = vi.fn();

    const res = purgeAllData({ archiveRoot, bundleRoot, dbPath, deleteDb: true, unregister });

    expect(res.ok).toBe(true);
    expect(res.unregistered).toBe(true);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(archiveRoot)).toBe(false);
    expect(fs.existsSync(bundleRoot)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    expect(fs.existsSync(dbPath + "-shm")).toBe(false);
  });

  it("keeps the DB when deleteDb is false", () => {
    const { archiveRoot, bundleRoot, dbPath } = seedTree();
    const res = purgeAllData({ archiveRoot, bundleRoot, dbPath, deleteDb: false, unregister: false });
    expect(res.ok).toBe(true);
    expect(res.unregistered).toBe(false);
    expect(fs.existsSync(archiveRoot)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true); // DB preserved
  });

  it("is idempotent — a second purge on an already-clean tree still succeeds", () => {
    const { archiveRoot, bundleRoot, dbPath } = seedTree();
    purgeAllData({ archiveRoot, bundleRoot, dbPath, deleteDb: true, unregister: false });
    const res2 = purgeAllData({ archiveRoot, bundleRoot, dbPath, deleteDb: true, unregister: false });
    expect(res2.ok).toBe(true);
    for (const o of res2.outcomes) {
      expect(o.deleted).toBe(true);
      expect(o.existed).toBe(false);
    }
  });

  it("a failing unregister hook is non-fatal — data is still purged", () => {
    const { archiveRoot, bundleRoot, dbPath } = seedTree();
    const res = purgeAllData({
      archiveRoot,
      bundleRoot,
      dbPath,
      deleteDb: true,
      unregister: () => { throw new Error("boom"); },
    });
    expect(res.ok).toBe(true);
    expect(res.unregistered).toBe(false);
    expect(fs.existsSync(archiveRoot)).toBe(false);
  });

  it("refuses a dangerous (shallow) target and records an error instead of deleting", () => {
    const { bundleRoot, dbPath } = seedTree();
    // A shallow archiveRoot must be rejected by the guard.
    const res = purgeAllData({ archiveRoot: "/tmp", bundleRoot, dbPath, deleteDb: false, unregister: false });
    expect(res.ok).toBe(false);
    const archiveOutcome = res.outcomes[0]!;
    expect(archiveOutcome.deleted).toBe(false);
    expect(archiveOutcome.error).toBeDefined();
    expect(fs.existsSync("/tmp")).toBe(true); // untouched
  });
});

describe("assertSafeToDelete — guard", () => {
  it("rejects filesystem root, home, ancestors of home, and shallow paths", () => {
    expect(() => assertSafeToDelete("/")).toThrow(ArchivePathError);
    expect(() => assertSafeToDelete(os.homedir())).toThrow(ArchivePathError);
    // An ancestor of home (the home's parent) must be rejected.
    expect(() => assertSafeToDelete(path.dirname(os.homedir()))).toThrow(ArchivePathError);
    expect(() => assertSafeToDelete("/tmp")).toThrow(ArchivePathError);
    expect(() => assertSafeToDelete("")).toThrow(ArchivePathError);
  });

  it("accepts a deep data dir", () => {
    const p = path.join(os.homedir(), ".claude-stats", "archive");
    expect(assertSafeToDelete(p)).toBe(path.resolve(p));
  });
});

describe("assertSafeSegment — traversal guard", () => {
  it("rejects traversal and separators", () => {
    for (const bad of ["..", ".", "a/b", "a\\b", "../etc", "", "a\0b"]) {
      expect(() => assertSafeSegment(bad, "seg")).toThrow(ArchivePathError);
    }
  });
  it("accepts encoded project dirs and UUID session ids", () => {
    expect(assertSafeSegment("-Users-alice-repos-example", "seg")).toBe("-Users-alice-repos-example");
    expect(assertSafeSegment("11111111-2222-4333-8444-555555555555", "seg")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
  });
});

describe("unregisterMcpServerFromClaudeJson", () => {
  it("removes only the claude-stats key, preserving other servers and keys", () => {
    const cj = path.join(tmp, ".claude.json");
    fs.writeFileSync(
      cj,
      JSON.stringify({
        mcpServers: { [MCP_KEY]: { command: "node" }, other: { command: "x" } },
        someOtherKey: 42,
      }),
    );
    const removed = unregisterMcpServerFromClaudeJson(cj);
    expect(removed).toBe(true);
    const after = JSON.parse(fs.readFileSync(cj, "utf-8")) as {
      mcpServers: Record<string, unknown>;
      someOtherKey: number;
    };
    expect(after.mcpServers[MCP_KEY]).toBeUndefined();
    expect(after.mcpServers.other).toBeDefined();
    expect(after.someOtherKey).toBe(42);
  });

  it("is a no-op when the key or file is absent, and never throws on bad JSON", () => {
    expect(unregisterMcpServerFromClaudeJson(path.join(tmp, "absent.json"))).toBe(false);

    const noKey = path.join(tmp, "nokey.json");
    fs.writeFileSync(noKey, JSON.stringify({ mcpServers: { other: {} } }));
    expect(unregisterMcpServerFromClaudeJson(noKey)).toBe(false);

    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(unregisterMcpServerFromClaudeJson(bad)).toBe(false);
    // The unparseable file must be left intact (never clobbered).
    expect(fs.readFileSync(bad, "utf-8")).toBe("{not json");
  });
});
