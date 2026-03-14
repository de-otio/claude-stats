import { describe, it, expect } from "vitest";
import { displayNameToApiPrefix, parsePricingTable } from "../pricing-cache.js";

describe("displayNameToApiPrefix", () => {
  it("converts modern model names (4.x+)", () => {
    expect(displayNameToApiPrefix("Claude Opus 4.6")).toBe("claude-opus-4-6");
    expect(displayNameToApiPrefix("Claude Sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(displayNameToApiPrefix("Claude Opus 4.5")).toBe("claude-opus-4-5");
    expect(displayNameToApiPrefix("Claude Opus 4.1")).toBe("claude-opus-4-1");
    expect(displayNameToApiPrefix("Claude Opus 4")).toBe("claude-opus-4");
    expect(displayNameToApiPrefix("Claude Haiku 4.5")).toBe("claude-haiku-4-5");
  });

  it("converts legacy model names (3.x)", () => {
    expect(displayNameToApiPrefix("Claude Haiku 3.5")).toBe("claude-3-5-haiku");
    expect(displayNameToApiPrefix("Claude Haiku 3")).toBe("claude-3-haiku");
    expect(displayNameToApiPrefix("Claude Opus 3")).toBe("claude-3-opus");
    expect(displayNameToApiPrefix("Claude Sonnet 3.7")).toBe("claude-3-7-sonnet");
  });

  it("strips (deprecated) annotation", () => {
    expect(displayNameToApiPrefix("Claude Opus 3 (deprecated)")).toBe("claude-3-opus");
    expect(displayNameToApiPrefix("Claude Sonnet 3.7 (deprecated)")).toBe("claude-3-7-sonnet");
  });

  it("handles names without standard format", () => {
    expect(displayNameToApiPrefix("SomeModel")).toBe("somemodel");
  });
});

describe("parsePricingTable", () => {
  const sampleHtml = `
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Base Input Tokens</th>
          <th>5m Cache Writes</th>
          <th>1h Cache Writes</th>
          <th>Cache Hits &amp; Refreshes</th>
          <th>Output Tokens</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Claude Opus 4.6</td>
          <td>$5 / MTok</td>
          <td>$6.25 / MTok</td>
          <td>$10 / MTok</td>
          <td>$0.50 / MTok</td>
          <td>$25 / MTok</td>
        </tr>
        <tr>
          <td>Claude Sonnet 4.6</td>
          <td>$3 / MTok</td>
          <td>$3.75 / MTok</td>
          <td>$6 / MTok</td>
          <td>$0.30 / MTok</td>
          <td>$15 / MTok</td>
        </tr>
        <tr>
          <td>Claude Haiku 3.5</td>
          <td>$0.80 / MTok</td>
          <td>$1 / MTok</td>
          <td>$1.6 / MTok</td>
          <td>$0.08 / MTok</td>
          <td>$4 / MTok</td>
        </tr>
      </tbody>
    </table>
  `;

  it("parses a well-formed pricing table", () => {
    const models = parsePricingTable(sampleHtml);
    expect(Object.keys(models)).toHaveLength(3);

    const opus = models["claude-opus-4-6"];
    expect(opus).toBeDefined();
    expect(opus!.inputPerMillion).toBe(5);
    expect(opus!.outputPerMillion).toBe(25);
    expect(opus!.cacheReadPerMillion).toBe(0.5);
    expect(opus!.cacheWritePerMillion).toBe(6.25);

    const sonnet = models["claude-sonnet-4-6"];
    expect(sonnet).toBeDefined();
    expect(sonnet!.inputPerMillion).toBe(3);

    const haiku = models["claude-3-5-haiku"];
    expect(haiku).toBeDefined();
    expect(haiku!.inputPerMillion).toBe(0.8);
    expect(haiku!.outputPerMillion).toBe(4);
  });

  it("returns empty for HTML without pricing table", () => {
    const models = parsePricingTable("<html><body>No tables here</body></html>");
    expect(Object.keys(models)).toHaveLength(0);
  });

  it("returns empty for tables without matching headers", () => {
    const html = `<table><thead><tr><th>Feature</th><th>Description</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>`;
    const models = parsePricingTable(html);
    expect(Object.keys(models)).toHaveLength(0);
  });

  it("skips non-pricing tables and finds the right one", () => {
    const html = `
      <table><tr><th>Feature</th><th>Description</th></tr><tr><td>X</td><td>Y</td></tr></table>
      ${sampleHtml}
    `;
    const models = parsePricingTable(html);
    expect(Object.keys(models).length).toBeGreaterThan(0);
  });

  it("handles deprecated model annotations", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>Cache Hits</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Opus 3 <a href="/deprecated">(deprecated)</a></td>
            <td>$15 / MTok</td>
            <td>$18.75 / MTok</td>
            <td>$1.50 / MTok</td>
            <td>$75 / MTok</td>
          </tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["claude-3-opus"]).toBeDefined();
    expect(models["claude-3-opus"]!.inputPerMillion).toBe(15);
  });

  it("falls back to computed cache prices when cache columns are missing", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    const opus = models["claude-opus-4-6"];
    expect(opus).toBeDefined();
    expect(opus!.cacheReadPerMillion).toBeCloseTo(0.5);   // 0.1x base input
    expect(opus!.cacheWritePerMillion).toBeCloseTo(6.25);  // 1.25x base input
  });

  it("skips rows with non-Claude model names", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>GPT-4</td><td>$30 / MTok</td><td>$60 / MTok</td></tr>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["gpt-4"]).toBeUndefined();
    expect(models["claude-opus-4-6"]).toBeDefined();
  });

  it("skips rows with unparseable dollar amounts", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>N/A</td><td>$25 / MTok</td></tr>
          <tr><td>Claude Sonnet 4.6</td><td>$3 / MTok</td><td>$15 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["claude-opus-4-6"]).toBeUndefined();
    expect(models["claude-sonnet-4-6"]).toBeDefined();
  });
});
