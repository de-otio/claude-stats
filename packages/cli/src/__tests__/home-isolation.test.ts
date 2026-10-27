/**
 * Guard: the suite must never resolve (or write) the developer's real
 * ~/.claude-stats or ~/.claude. Global isolation is installed by the
 * repo-root `vitest.global-home.ts` (globalSetup), which points HOME at a
 * temp dir before any worker imports a module that computes paths.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "@claude-stats/core/paths";
import { saveConfig, loadConfig } from "../config.js";
import { createFileCache } from "../recap/cache.js";
import type { DailyDigest } from "../recap/types.js";

// userInfo() reads the passwd database and ignores $HOME, so it is the real home.
const realHome = os.userInfo().homedir;

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

describe("test home isolation", () => {
  const testHome = process.env.CLAUDE_STATS_TEST_HOME ?? "";

  it("globalSetup provided an isolated home distinct from the real one", () => {
    expect(testHome).not.toBe("");
    expect(isUnder(testHome, realHome)).toBe(false);
    expect(os.homedir()).toBe(testHome);
  });

  it.each(Object.entries(paths))("paths.%s is inside the test home, not the real home", (_k, p) => {
    expect(isUnder(p, realHome)).toBe(false);
    expect(isUnder(p, testHome)).toBe(true);
  });

  it("the default config.json write lands in the test home", () => {
    saveConfig({ plan: { type: "pro", monthly_fee: 20 } } as never);
    expect(isUnder(paths.configFile, testHome)).toBe(true);
    expect(fs.existsSync(paths.configFile)).toBe(true);
    expect(loadConfig()).toMatchObject({ plan: { type: "pro" } });
  });

  it("the default recap cache write lands in the test home", () => {
    const hash = "isolation-guard-hash";
    createFileCache().write(hash, {} as DailyDigest);
    expect(fs.existsSync(path.join(paths.statsDir, "recap-cache", `${hash}.json`))).toBe(true);
  });
});
