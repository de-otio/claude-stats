import { describe, it, expect } from "vitest";
import { getGitRemoteUrl } from "../git.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("getGitRemoteUrl", () => {
  it("returns null for non-existent directory", () => {
    expect(getGitRemoteUrl("/tmp/nonexistent-dir-999")).toBeNull();
  });

  it("returns null for directory without .git/config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-git-test-"));
    try {
      expect(getGitRemoteUrl(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("returns null when config has no origin remote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-git-test-"));
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
    try {
      expect(getGitRemoteUrl(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("returns null when origin section exists but has no url line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-git-test-"));
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"),
      '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    try {
      expect(getGitRemoteUrl(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("extracts origin URL from valid config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-git-test-"));
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/org/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    try {
      expect(getGitRemoteUrl(dir)).toBe("https://github.com/org/repo.git");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
