import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseSessionFile } from "@claude-stats/core/parser/session";
import os from "os";
import path from "path";
import fs from "fs";

let filePath: string;
beforeEach(() => {
  filePath = path.join(os.tmpdir(), `cs-attr-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});
afterEach(() => { try { fs.unlinkSync(filePath); } catch { /* ok */ } });

let n = 0;
function assistant(extra: Record<string, unknown> = {}) {
  n++;
  return {
    type: "assistant",
    sessionId: "sess-attr",
    version: "2.1.70",
    timestamp: 1_001_000 + n,
    uuid: `a-${n}`,
    message: {
      id: `msg_${n}`,
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 },
    },
    ...extra,
  };
}

async function parse(lines: object[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return parseSessionFile(filePath, "/proj");
}

describe("attributionSkill capture", () => {
  it("stores a valid skill per message", async () => {
    const r = await parse([
      assistant({ attributionSkill: "example-skill" }),
      assistant({ attributionSkill: "acme-critic" }),
      assistant(),
    ]);
    expect(r.messages.map(m => m.skill)).toEqual(["example-skill", "acme-critic", null]);
  });

  const bad: Array<[string, unknown]> = [
    ["invalid shape", "has space"],
    ["oversized", "a".repeat(129)],
    ["path-like dotdot", "../x"],
    ["path-like absolute", "/etc/x"],
    ["formula =", "=1"],
    ["formula @", "@x"],
    ["formula -", "-x"],
    ["formula +", "+x"],
    ["number", 42],
    ["object", { a: 1 }],
    ["empty", ""],
  ];
  it.each(bad)("rejects %s as null", async (_label, value) => {
    const r = await parse([assistant({ attributionSkill: value })]);
    expect(r.messages[0]!.skill).toBeNull();
  });

  it("accepts a 128-char value (boundary) without truncation", async () => {
    const v = "a".repeat(128);
    const r = await parse([assistant({ attributionSkill: v })]);
    expect(r.messages[0]!.skill).toBe(v);
  });
});

describe("attributionAgent capture", () => {
  it("first valid wins", async () => {
    const r = await parse([
      assistant({ attributionAgent: "my-reviewer" }),
      assistant({ attributionAgent: "acme-critic" }),
    ]);
    expect(r.session!.agentType).toBe("my-reviewer");
    expect(r.session!.spawnDepth).toBeNull();
    expect(r.session!.spawnToolUseId).toBeNull();
  });

  it("invalid then valid yields the valid one", async () => {
    const r = await parse([
      assistant({ attributionAgent: "../x" }),
      assistant({ attributionAgent: 7 }),
      assistant({ attributionAgent: "acme-critic" }),
    ]);
    expect(r.session!.agentType).toBe("acme-critic");
  });

  it("only invalid values yield null", async () => {
    const r = await parse([assistant({ attributionAgent: "=1" })]);
    expect(r.session!.agentType).toBeNull();
  });

  it("entry without the fields yields null", async () => {
    const r = await parse([assistant()]);
    expect(r.session!.agentType).toBeNull();
    expect(r.messages[0]!.skill).toBeNull();
  });
});

describe("cost neutrality", () => {
  it("other fields are identical with and without the new keys", async () => {
    const plain = await parse([assistant({ effort: "high" })]);
    n -= 1; // reuse the same message id / uuid for a byte-comparable record
    const withKeys = await parse([
      assistant({ effort: "high", attributionAgent: "my-reviewer", attributionSkill: "example-skill" }),
    ]);
    const { skill: _s, ...a } = withKeys.messages[0]!;
    const { skill: _p, ...b } = plain.messages[0]!;
    expect(a).toEqual(b);
    const { agentType: _x, ...sa } = withKeys.session!;
    const { agentType: _y, ...sb } = plain.session!;
    expect(sa).toEqual(sb);
    expect(withKeys.session!.inputTokens).toBe(100);
    expect(withKeys.session!.cacheReadTokens).toBe(80);
  });
});
