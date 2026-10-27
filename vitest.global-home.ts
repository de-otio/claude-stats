/**
 * Vitest globalSetup shared by every vitest project in the repo.
 *
 * Points HOME / USERPROFILE / CLAUDE_STATS_DB at a fresh temp directory BEFORE
 * any worker starts, so `os.homedir()` (and therefore `paths` in
 * @claude-stats/core/paths, which is computed at import time, plus every
 * `path.join(os.homedir(), ".claude-stats", ...)` in the CLI) resolves inside
 * the temp dir. Workers inherit process.env from this process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stats-test-home-"));
  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-stats"), { recursive: true });

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_STATS_DB = path.join(home, ".claude-stats", "stats.db");
  process.env.CLAUDE_STATS_TEST_HOME = home;

  return () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };
}
