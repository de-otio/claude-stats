import { describe, it, expect } from "vitest";
import { decodeProjectPath, encodeProjectPath, paths } from "@claude-stats/core/paths";
import os from "os";
import path from "path";

describe("paths", () => {
  it("exports correct base paths relative to home", () => {
    const home = os.homedir();
    expect(paths.claudeDir).toBe(path.join(home, ".claude"));
    expect(paths.projectsDir).toBe(path.join(home, ".claude", "projects"));
    expect(paths.historyFile).toBe(path.join(home, ".claude", "history.jsonl"));
    expect(paths.statsDir).toBe(path.join(home, ".claude-stats"));
    expect(paths.statsDb).toBe(path.join(home, ".claude-stats", "stats.db"));
    expect(paths.quarantineDir).toBe(path.join(home, ".claude-stats", "quarantine"));
  });
});

describe("decodeProjectPath", () => {
  it("converts leading dash to slash", () => {
    expect(decodeProjectPath("-Users-alice-repos-myproject")).toBe(
      "/Users/alice/repos/myproject"
    );
  });

  it("handles deeply nested paths", () => {
    expect(decodeProjectPath("-home-user-a-b-c")).toBe("/home/user/a/b/c");
  });

  it("handles a single segment", () => {
    expect(decodeProjectPath("-tmp")).toBe("/tmp");
  });

  it("round-trips with encodeProjectPath for paths without dashes", () => {
    // encode/decode is lossy for paths containing dashes (dashes in directory
    // names are indistinguishable from path separators after encoding)
    const original = "/Users/alice/repos/myproject";
    expect(decodeProjectPath(encodeProjectPath(original))).toBe(original);
  });
});

describe("encodeProjectPath", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/alice/repos/proj")).toBe(
      "-Users-alice-repos-proj"
    );
  });

  it("produces empty string from empty string", () => {
    expect(encodeProjectPath("")).toBe("");
  });
});
