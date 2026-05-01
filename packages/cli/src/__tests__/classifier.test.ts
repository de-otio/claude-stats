import { describe, it, expect } from "vitest";
import { scoreComplexity, scoreToTier, tierToModel } from "../classifier.js";

describe("scoreComplexity", () => {
  it("returns 0 for minimal input", () => {
    const score = scoreComplexity({
      outputTokens: 0,
      inputTokens: 0,
      tools: [],
      thinkingBlocks: 0,
      promptText: null,
    });
    expect(score).toBe(0);
  });

  it("scores output token ranges correctly", () => {
    const base = { inputTokens: 0, tools: [] as string[], thinkingBlocks: 0, promptText: null };
    expect(scoreComplexity({ ...base, outputTokens: 100 })).toBe(0);
    expect(scoreComplexity({ ...base, outputTokens: 250 })).toBe(3);
    expect(scoreComplexity({ ...base, outputTokens: 600 })).toBe(7);
    expect(scoreComplexity({ ...base, outputTokens: 1200 })).toBe(12);
    expect(scoreComplexity({ ...base, outputTokens: 2500 })).toBe(18);
    expect(scoreComplexity({ ...base, outputTokens: 5000 })).toBe(25);
  });

  it("scores thinking blocks correctly", () => {
    const base = { outputTokens: 0, inputTokens: 0, tools: [] as string[], promptText: null };
    expect(scoreComplexity({ ...base, thinkingBlocks: 0 })).toBe(0);
    expect(scoreComplexity({ ...base, thinkingBlocks: 1 })).toBe(14);
    expect(scoreComplexity({ ...base, thinkingBlocks: 2 })).toBe(22);
    expect(scoreComplexity({ ...base, thinkingBlocks: 3 })).toBe(30);
    expect(scoreComplexity({ ...base, thinkingBlocks: 5 })).toBe(30);
  });

  it("scores complex tools (Agent, Write)", () => {
    const base = { outputTokens: 0, inputTokens: 0, thinkingBlocks: 0, promptText: null };
    expect(scoreComplexity({ ...base, tools: ["Agent"] })).toBe(22);
    expect(scoreComplexity({ ...base, tools: ["Write"] })).toBe(22);
    expect(scoreComplexity({ ...base, tools: ["NotebookEdit"] })).toBe(22);
  });

  it("scores moderate tools (Edit, Bash)", () => {
    const base = { outputTokens: 0, inputTokens: 0, thinkingBlocks: 0, promptText: null };
    expect(scoreComplexity({ ...base, tools: ["Edit"] })).toBe(10);
    expect(scoreComplexity({ ...base, tools: ["Bash"] })).toBe(10);
  });

  it("scores moderate tools with many tool uses", () => {
    const base = { outputTokens: 0, inputTokens: 0, thinkingBlocks: 0, promptText: null };
    // 3+ moderate tools gets 16
    expect(scoreComplexity({ ...base, tools: ["Edit", "Bash", "WebSearch"] })).toBe(16);
  });

  it("adds bonus for 5+ tools", () => {
    const base = { outputTokens: 0, inputTokens: 0, thinkingBlocks: 0, promptText: null };
    // 5 simple tools = 4 (some tool) + 3 (5+ tools) = 7
    expect(scoreComplexity({ ...base, tools: ["Read", "Glob", "Grep", "Read", "Glob"] })).toBe(7);
  });

  it("scores prompt text length", () => {
    const base = { outputTokens: 0, inputTokens: 0, tools: [] as string[], thinkingBlocks: 0 };
    expect(scoreComplexity({ ...base, promptText: "hi" })).toBe(0); // < 50
    expect(scoreComplexity({ ...base, promptText: "a".repeat(60) })).toBe(2); // > 50
    expect(scoreComplexity({ ...base, promptText: "a".repeat(250) })).toBe(4); // > 200
    expect(scoreComplexity({ ...base, promptText: "a".repeat(600) })).toBe(7); // > 500
  });

  it("adds points for complex keywords", () => {
    const base = { outputTokens: 0, inputTokens: 0, tools: [] as string[], thinkingBlocks: 0 };
    // "please refactor the code" = 24 chars, < 50, so just 8 for keyword
    expect(scoreComplexity({ ...base, promptText: "please refactor the code" })).toBe(8);
    expect(scoreComplexity({ ...base, promptText: "refactor" })).toBe(8);
  });

  it("subtracts points for simple keywords", () => {
    const base = { outputTokens: 0, inputTokens: 0, tools: [] as string[], thinkingBlocks: 0 };
    // "fix typo" is simple, score = -6, clamped to 0
    expect(scoreComplexity({ ...base, promptText: "fix typo" })).toBe(0);
  });

  it("adds points for multi-sentence prompts", () => {
    const base = { outputTokens: 0, inputTokens: 0, tools: [] as string[], thinkingBlocks: 0 };
    // Need length > 0 and 4+ sentences for the bonus. "check" matches SIMPLE_KEYWORDS (-6).
    // Use text without simple keywords to isolate multi-sentence scoring
    const text = "First do alpha. Then do beta. Next do gamma. After that do delta.";
    // 64 chars > 50 = +2, 4 sentences = +5 => 7
    expect(scoreComplexity({ ...base, promptText: text })).toBe(7);
  });

  it("clamps score between 0 and 100", () => {
    const base = { inputTokens: 0, promptText: null };
    // Max everything
    const score = scoreComplexity({
      ...base,
      outputTokens: 10000,
      tools: ["Agent", "Write", "Edit", "Bash", "Read"],
      thinkingBlocks: 5,
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreToTier", () => {
  it("returns haiku for scores < 15", () => {
    expect(scoreToTier(0)).toBe("haiku");
    expect(scoreToTier(14)).toBe("haiku");
  });

  it("returns sonnet for scores 15-39", () => {
    expect(scoreToTier(15)).toBe("sonnet");
    expect(scoreToTier(39)).toBe("sonnet");
  });

  it("returns opus for scores >= 40", () => {
    expect(scoreToTier(40)).toBe("opus");
    expect(scoreToTier(100)).toBe("opus");
  });
});

describe("tierToModel", () => {
  it("maps tiers to canonical model names", () => {
    expect(tierToModel("haiku")).toBe("claude-haiku-4");
    expect(tierToModel("sonnet")).toBe("claude-sonnet-4");
    expect(tierToModel("opus")).toBe("claude-opus-4");
  });
});
