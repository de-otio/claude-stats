import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { discoverSessionFiles, getFileStats } from "../scanner/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import os from "os";
import path from "path";
import fs from "fs";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpProjectsDir(): string {
  const dir = path.join(os.tmpdir(), `cs-scanner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── getFileStats ──────────────────────────────────────────────────────────────

describe("getFileStats", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `cs-stats-${Date.now()}.jsonl`);
    fs.writeFileSync(filePath, "hello");
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  });

  it("returns mtime and size for an existing file", () => {
    const stats = getFileStats(filePath);
    expect(stats).not.toBeNull();
    expect(stats!.size).toBeGreaterThan(0);
    expect(stats!.mtime).toBeGreaterThan(0);
  });

  it("returns null for a non-existent file", () => {
    expect(getFileStats("/does/not/exist/ever.jsonl")).toBeNull();
  });
});

// ── discoverSessionFiles ──────────────────────────────────────────────────────

describe("discoverSessionFiles", () => {
  let projectsDir: string;
  let restorePaths: () => void;

  beforeEach(() => {
    projectsDir = makeTmpProjectsDir();
    // Point the scanner at our temp directory
    const original = { ...pathsMod.paths };
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      projectsDir,
    });
    restorePaths = () => vi.restoreAllMocks();
  });

  afterEach(() => {
    restorePaths();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("returns empty array when projects dir does not exist", () => {
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...pathsMod.paths,
      projectsDir: "/totally/missing/dir",
    });
    expect(discoverSessionFiles()).toEqual([]);
  });

  it("returns empty array for an empty projects dir", () => {
    expect(discoverSessionFiles()).toEqual([]);
  });

  it("discovers JSONL files in a project directory", () => {
    const projDir = path.join(projectsDir, "-Users-alice-repos-proj");
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, "session-1.jsonl"), "{}");
    fs.writeFileSync(path.join(projDir, "session-2.jsonl"), "{}");
    fs.writeFileSync(path.join(projDir, "not-a-jsonl.txt"), "");

    const files = discoverSessionFiles();
    expect(files).toHaveLength(2);
    expect(files.every(f => f.filePath.endsWith(".jsonl"))).toBe(true);
  });

  it("decodes project path correctly", () => {
    const projDir = path.join(projectsDir, "-Users-alice-repos-myproject");
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, "sess.jsonl"), "{}");

    const files = discoverSessionFiles();
    expect(files[0]!.projectPath).toBe("/Users/alice/repos/myproject");
  });

  it("marks top-level files as isSubagent=false", () => {
    const projDir = path.join(projectsDir, "-Users-alice-proj");
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, "main.jsonl"), "{}");

    const files = discoverSessionFiles();
    expect(files[0]!.isSubagent).toBe(false);
  });

  it("discovers subagent JSONL files and marks them isSubagent=true", () => {
    const projDir = path.join(projectsDir, "-Users-alice-proj");
    const subagentsDir = path.join(projDir, "subagents");
    fs.mkdirSync(projDir);
    fs.mkdirSync(subagentsDir);
    fs.writeFileSync(path.join(subagentsDir, "agent-sess.jsonl"), "{}");

    const files = discoverSessionFiles();
    const subagent = files.find(f => f.isSubagent);
    expect(subagent).toBeDefined();
    expect(subagent!.filePath).toContain("subagents");
  });

  it("skips non-directory entries in the projects dir", () => {
    const notADir = path.join(projectsDir, "some-file.txt");
    fs.writeFileSync(notADir, "data");
    expect(discoverSessionFiles()).toEqual([]);
  });

  it("handles multiple projects with overlapping structure", () => {
    for (const name of ["-proj-a", "-proj-b", "-proj-c"]) {
      const d = path.join(projectsDir, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "sess.jsonl"), "{}");
    }
    const files = discoverSessionFiles();
    expect(files).toHaveLength(3);
  });

  it("does not follow symlinks pointing outside the projects dir", () => {
    // Real project + real jsonl — this one should appear.
    const realProjDir = path.join(projectsDir, "-Users-alice-real");
    fs.mkdirSync(realProjDir);
    const realJsonl = path.join(realProjDir, "real.jsonl");
    fs.writeFileSync(realJsonl, "{}");

    // Out-of-tree target that a symlink will point at.
    const outsideDir = path.join(
      os.tmpdir(),
      `cs-scanner-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "secret.jsonl");
    fs.writeFileSync(outsideFile, "SHOULD_NOT_BE_READ");

    try {
      // Case 1: symlinked .jsonl at top level of a project dir.
      const linkedJsonl = path.join(realProjDir, "linked.jsonl");
      fs.symlinkSync(outsideFile, linkedJsonl);

      // Case 2: symlinked project directory at the root of projects dir.
      const linkedProj = path.join(projectsDir, "-linked-project");
      fs.symlinkSync(outsideDir, linkedProj);

      // Case 3: symlinked subagents/ dir inside a real project.
      const subagentHost = path.join(projectsDir, "-Users-alice-withsub");
      fs.mkdirSync(subagentHost);
      fs.symlinkSync(outsideDir, path.join(subagentHost, "subagents"));

      const files = discoverSessionFiles();
      const paths = files.map((f) => f.filePath);

      // The real, non-symlinked jsonl is discovered.
      expect(paths).toContain(realJsonl);
      // None of the symlinked paths leak through.
      expect(paths).not.toContain(linkedJsonl);
      expect(paths.some((p) => p.startsWith(outsideDir))).toBe(false);
      expect(paths.some((p) => p.startsWith(linkedProj))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
