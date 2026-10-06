/**
 * `parseSubagentMeta` (core, pure): reads exactly `agentType`, `spawnDepth`
 * and `toolUseId` from a subagent's `.meta.json` bytes, validates each, binds
 * nothing else and never throws. Fixture names are synthetic.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseSubagentMeta, EMPTY_SUBAGENT_META } from "@claude-stats/core/subagentMeta";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (v: unknown): Uint8Array => enc(JSON.stringify(v));

const FULL = {
  agentType: "my-reviewer",
  spawnDepth: 2,
  toolUseId: "toolu_01AbCdEf_xyz",
};

describe("parseSubagentMeta", () => {
  it("reads the three fields from a well-formed meta file", () => {
    expect(parseSubagentMeta(json(FULL))).toEqual({
      agentType: "my-reviewer",
      spawnDepth: 2,
      spawnToolUseId: "toolu_01AbCdEf_xyz",
    });
  });

  it("accepts Bedrock/Vertex tool-use ids and namespaced agent types", () => {
    const r = parseSubagentMeta(json({ agentType: "plugin:acme-critic", spawnDepth: 1, toolUseId: "toolu_bdrk_01X" }));
    expect(r).toEqual({ agentType: "plugin:acme-critic", spawnDepth: 1, spawnToolUseId: "toolu_bdrk_01X" });
  });

  it("returns exactly the three keys — description, prompt and other keys never surface", () => {
    const r = parseSubagentMeta(
      json({
        ...FULL,
        description: "review the example-skill change",
        prompt: "secret prompt text",
        worktreePath: "/home/someone/wt",
        branch: "feature/x",
      })
    );
    expect(Object.keys(r).sort()).toEqual(["agentType", "spawnDepth", "spawnToolUseId"]);
    expect(JSON.stringify(r)).not.toContain("secret prompt text");
    expect(JSON.stringify(r)).not.toContain("example-skill");
    expect(r.agentType).toBe("my-reviewer");
  });

  it("keeps valid fields when others fail validation", () => {
    expect(parseSubagentMeta(json({ agentType: "../etc/passwd", spawnDepth: 3, toolUseId: "toolu_ok" }))).toEqual({
      agentType: null,
      spawnDepth: 3,
      spawnToolUseId: "toolu_ok",
    });
    expect(parseSubagentMeta(json({ agentType: "example-skill", spawnDepth: 0, toolUseId: "nope" }))).toEqual({
      agentType: "example-skill",
      spawnDepth: null,
      spawnToolUseId: null,
    });
  });

  it.each([
    ["path-like", "/etc/x"],
    ["traversal", "a/../b"],
    ["double slash", "a//b"],
    ["formula =", "=cmd"],
    ["formula +", "+1"],
    ["formula -", "-x"],
    ["leading @", "@scope/agent"],
    ["space", "my reviewer"],
    ["oversized", "a".repeat(129)],
    ["empty", ""],
    ["number", 42],
    ["object", { name: "my-reviewer" }],
    ["array", ["my-reviewer"]],
    ["null", null],
  ])("agentType failing shape (%s) → null", (_label, agentType) => {
    expect(parseSubagentMeta(json({ agentType })).agentType).toBeNull();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["too deep", 17],
    ["fraction", 1.5],
    ["string", "2"],
    ["huge", 1e300],
  ])("spawnDepth failing shape (%s) → null", (_label, spawnDepth) => {
    expect(parseSubagentMeta(json({ spawnDepth })).spawnDepth).toBeNull();
  });

  it("accepts the spawn-depth bounds 1 and 16", () => {
    expect(parseSubagentMeta(json({ spawnDepth: 1 })).spawnDepth).toBe(1);
    expect(parseSubagentMeta(json({ spawnDepth: 16 })).spawnDepth).toBe(16);
  });

  it.each([
    ["malformed JSON", "{agentType: my-reviewer"],
    ["truncated JSON", '{"agentType":"my-reviewer"'],
    ["empty input", ""],
    ["array root", '["my-reviewer"]'],
    ["array of objects root", JSON.stringify([FULL])],
    ["string root", '"my-reviewer"'],
    ["number root", "7"],
    ["boolean root", "true"],
    ["null root", "null"],
    ["control characters", "\u0000\u0001�"],
  ])("%s → all-null", (_label, text) => {
    expect(parseSubagentMeta(enc(text))).toEqual(EMPTY_SUBAGENT_META);
  });

  it("raw invalid UTF-8 bytes → all-null, no throw", () => {
    expect(parseSubagentMeta(new Uint8Array([0xff, 0xfe, 0x7b, 0x80, 0x7d]))).toEqual(EMPTY_SUBAGENT_META);
  });

  it("a __proto__ key does not pollute Object.prototype and is not read through", () => {
    const text = '{"__proto__":{"agentType":"my-reviewer","polluted":true},"spawnDepth":1}';
    const r = parseSubagentMeta(enc(text));
    expect(r).toEqual({ agentType: null, spawnDepth: 1, spawnToolUseId: null });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).agentType).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("never reads inherited fields (only own keys)", () => {
    const text = '{"constructor":{"agentType":"my-reviewer"}}';
    expect(parseSubagentMeta(enc(text))).toEqual(EMPTY_SUBAGENT_META);
  });

  it("accepts prototype-like names as plain identifier values", () => {
    expect(parseSubagentMeta(json({ agentType: "__proto__" })).agentType).toBe("__proto__");
  });

  it("returns a frozen result", () => {
    expect(Object.isFrozen(parseSubagentMeta(json(FULL)))).toBe(true);
    expect(Object.isFrozen(parseSubagentMeta(enc("nope")))).toBe(true);
  });

  // ── properties ──────────────────────────────────────────────────────────────

  const SEED = 0x5ab_a6e7;

  function assertShape(r: ReturnType<typeof parseSubagentMeta>): void {
    expect(Object.keys(r).sort()).toEqual(["agentType", "spawnDepth", "spawnToolUseId"]);
    expect(r.agentType === null || typeof r.agentType === "string").toBe(true);
    expect(r.spawnDepth === null || Number.isSafeInteger(r.spawnDepth)).toBe(true);
    expect(r.spawnToolUseId === null || /^toolu_/.test(r.spawnToolUseId)).toBe(true);
  }

  it("property: never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        assertShape(parseSubagentMeta(bytes));
      }),
      { seed: SEED, numRuns: 500 }
    );
  });

  it("property: never throws on arbitrary JSON values and binds only the three keys", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        assertShape(parseSubagentMeta(enc(JSON.stringify(v) ?? "")));
      }),
      { seed: SEED, numRuns: 500 }
    );
  });

  it("property: arbitrary objects with the three keys set to anything", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.jsonValue(),
        fc.jsonValue(),
        fc.jsonValue(),
        (extra, agentType, spawnDepth, toolUseId) => {
          const obj = { ...extra, agentType, spawnDepth, toolUseId };
          const r = parseSubagentMeta(enc(JSON.stringify(obj)));
          assertShape(r);
          // A non-null value is always exactly the input value (never transformed).
          if (r.agentType !== null) expect(r.agentType).toBe(agentType);
          if (r.spawnDepth !== null) expect(r.spawnDepth).toBe(spawnDepth);
          if (r.spawnToolUseId !== null) expect(r.spawnToolUseId).toBe(toolUseId);
        }
      ),
      { seed: SEED, numRuns: 300 }
    );
  });
});
