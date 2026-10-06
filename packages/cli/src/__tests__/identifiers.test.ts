import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  BUILT_IN_AGENT_TYPES,
  BUILT_IN_TOOL_NAMES,
  bucketToolName,
  isBuiltInAgentType,
  isBuiltInToolName,
  validIdentifier,
  validSpawnDepth,
  validToolUseId,
} from "@claude-stats/core/identifiers";

describe("validIdentifier", () => {
  it.each(["my-reviewer", "acme-critic", "example-skill", "plugin:skill", "@scope/agent".slice(1), "team.reviewer", "a", "x".repeat(128), "__proto__", "constructor", "Explore"])(
    "accepts %s",
    (v) => {
      expect(validIdentifier(v)).toBe(v);
    },
  );

  it.each([
    ["empty", ""],
    ["too long (never truncated)", "x".repeat(129)],
    ["space", "my reviewer"],
    ["html", "<img src=x onerror=alert(1)>"],
    ["parent path", "../x"],
    ["embedded parent path", "a/../b"],
    ["absolute path", "/etc/x"],
    ["double slash", "a//b"],
    ["formula @", "@SUM(A1)"],
    ["formula -", "-1"],
    ["formula +", "+1"],
    ["formula =", "=1"],
    ["newline", "a\nb"],
    ["non-ascii", "rëviewer"],
  ])("rejects %s", (_label, v) => {
    expect(validIdentifier(v)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["a"], true])("rejects non-string %p", (v) => {
    expect(validIdentifier(v)).toBeNull();
  });

  it("returns its input unchanged or null — never a different string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const r = validIdentifier(s);
        expect(r === null || r === s).toBe(true);
        if (r !== null) {
          expect(r.includes("..")).toBe(false);
          expect(r.startsWith("/")).toBe(false);
          expect(/^[@+=-]/.test(r)).toBe(false);
        }
      }),
      { seed: 25, numRuns: 500 },
    );
  });

  it("runs in time linear in the input (no catastrophic backtracking)", () => {
    const time = (n: number): number => {
      const s = "a".repeat(n) + "!";
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 200; i++) validIdentifier(s);
      return Number(process.hrtime.bigint() - t0);
    };
    time(1000); // warm up
    const small = time(1_000);
    const large = time(100_000);
    // 100x the input may cost at most ~100x (with generous slack), never the
    // exponential blow-up a backtracking pattern would show.
    expect(large / Math.max(small, 1)).toBeLessThan(1_000);
  });
});

describe("validToolUseId", () => {
  it.each(["toolu_01ABCdef", "toolu_bdrk_01abc", "toolu_vrtx_01abc"])("accepts %s", (v) => {
    expect(validToolUseId(v)).toBe(v);
  });
  it.each(["", "toolu_", "tool_01", "toolu_01-abc", `toolu_${"a".repeat(81)}`, 7, null])("rejects %p", (v) => {
    expect(validToolUseId(v)).toBeNull();
  });
});

describe("validSpawnDepth", () => {
  it.each([1, 2, 3, 16])("accepts %d", (v) => {
    expect(validSpawnDepth(v)).toBe(v);
  });
  it.each([0, -1, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])("rejects %p", (v) => {
    expect(validSpawnDepth(v)).toBeNull();
  });
});

describe("built-in lists", () => {
  it("knows the built-in agent types and nothing else", () => {
    for (const t of BUILT_IN_AGENT_TYPES) expect(isBuiltInAgentType(t)).toBe(true);
    expect(isBuiltInAgentType("my-reviewer")).toBe(false);
    expect(isBuiltInAgentType("__proto__")).toBe(false);
  });

  it("has no duplicate or MCP-shaped tool names", () => {
    expect(new Set(BUILT_IN_TOOL_NAMES).size).toBe(BUILT_IN_TOOL_NAMES.length);
    for (const n of BUILT_IN_TOOL_NAMES) expect(n.startsWith("mcp__")).toBe(false);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(BUILT_IN_TOOL_NAMES)).toBe(true);
    expect(Object.isFrozen(BUILT_IN_AGENT_TYPES)).toBe(true);
  });
});

describe("bucketToolName", () => {
  it("keeps built-in names, buckets MCP and everything else", () => {
    expect(bucketToolName("Bash")).toBe("Bash");
    expect(bucketToolName("Read")).toBe("Read");
    expect(bucketToolName("mcp__acme-internal__search")).toBe("mcp");
    expect(bucketToolName("AcmeCorpTool")).toBe("custom");
    expect(bucketToolName("__proto__")).toBe("custom");
    expect(bucketToolName("constructor")).toBe("custom");
    expect(bucketToolName("")).toBe("custom");
  });

  it("only ever emits a built-in name, 'mcp' or 'custom'", () => {
    const allowed = new Set([...BUILT_IN_TOOL_NAMES, "mcp", "custom"]);
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constantFrom(...BUILT_IN_TOOL_NAMES), fc.string().map((s) => `mcp__${s}`)), (name) => {
        expect(allowed.has(bucketToolName(name))).toBe(true);
        expect(isBuiltInToolName(bucketToolName(name)) || ["mcp", "custom"].includes(bucketToolName(name))).toBe(true);
      }),
      { seed: 25, numRuns: 500 },
    );
  });
});
