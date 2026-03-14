import { describe, it, expect } from "vitest";
import { searchHistory } from "../history/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeTempHistory(lines: unknown[]): string {
  const filePath = path.join(os.tmpdir(), `cs-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const entries = [
  { display: "migrate from terraform to cdk", timestamp: 1000, project: "/proj/alpha", sessionId: "aaaaaa-1111" },
  { display: "fix the login bug", timestamp: 3000, project: "/proj/beta", sessionId: "bbbbbb-2222" },
  { display: "add Terraform module for VPC", timestamp: 2000, project: "/proj/alpha", sessionId: "cccccc-3333" },
  { display: "refactor database queries", timestamp: 4000, project: "/proj/beta", sessionId: "dddddd-4444" },
  { display: "deploy to staging", timestamp: 5000, project: "/proj/alpha", sessionId: "eeeeee-5555" },
];

describe("searchHistory", () => {
  it("finds matches with case-insensitive substring search", () => {
    const fp = makeTempHistory(entries);
    try {
      const results = searchHistory({ query: "terraform", historyPath: fp });
      expect(results).toHaveLength(2);
      expect(results[0]!.entry.display).toContain("Terraform");
      expect(results[1]!.entry.display).toContain("terraform");
    } finally {
      fs.unlinkSync(fp);
    }
  });

  it("returns results sorted most-recent-first", () => {
    const fp = makeTempHistory(entries);
    try {
      const results = searchHistory({ query: "terraform", historyPath: fp });
      expect(results[0]!.entry.timestamp).toBeGreaterThan(results[1]!.entry.timestamp);
    } finally {
      fs.unlinkSync(fp);
    }
  });

  it("filters by project", () => {
    const fp = makeTempHistory(entries);
    try {
      const results = searchHistory({ query: "terraform", historyPath: fp, project: "/proj/alpha" });
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.entry.project).toBe("/proj/alpha");
      }
    } finally {
      fs.unlinkSync(fp);
    }
  });

  it("enforces limit", () => {
    const fp = makeTempHistory(entries);
    try {
      // All 5 entries match "a" (they all contain "a" somewhere)
      const results = searchHistory({ query: "a", historyPath: fp, limit: 2 });
      expect(results).toHaveLength(2);
    } finally {
      fs.unlinkSync(fp);
    }
  });

  it("returns empty array when file does not exist", () => {
    const results = searchHistory({ query: "anything", historyPath: "/tmp/does-not-exist-9999.jsonl" });
    expect(results).toEqual([]);
  });

  it("skips malformed lines gracefully", () => {
    const filePath = path.join(os.tmpdir(), `cs-history-malformed-${Date.now()}.jsonl`);
    const content = [
      "this is not json",
      JSON.stringify({ display: "valid terraform prompt", timestamp: 1000, project: "/p", sessionId: "aa" }),
      "{ broken json",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, content, "utf-8");

    try {
      const results = searchHistory({ query: "terraform", historyPath: filePath });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.display).toBe("valid terraform prompt");
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it("sets matchIndex to the position of the match", () => {
    const fp = makeTempHistory(entries);
    try {
      const results = searchHistory({ query: "login", historyPath: fp });
      expect(results).toHaveLength(1);
      expect(results[0]!.matchIndex).toBe("fix the ".length);
    } finally {
      fs.unlinkSync(fp);
    }
  });

  it("defaults limit to 20", () => {
    const manyEntries = Array.from({ length: 30 }, (_, i) => ({
      display: `prompt number ${i}`,
      timestamp: i,
      project: "/p",
      sessionId: `sid-${i}`,
    }));
    const fp = makeTempHistory(manyEntries);
    try {
      const results = searchHistory({ query: "prompt", historyPath: fp });
      expect(results).toHaveLength(20);
    } finally {
      fs.unlinkSync(fp);
    }
  });
});
