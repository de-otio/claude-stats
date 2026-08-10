/**
 * Regression: the MCP server must initialize i18n ITSELF, because the process
 * that runs it never goes through `buildCli()`.
 *
 * `initCliI18n()` used to be called in exactly one place — inside `buildCli()`
 * — while `startMcpServer()` set up the pricing cache, the Store and the
 * collector and then connected the transport without touching i18n. Both real
 * ways into the MCP server skip `buildCli()` entirely:
 *
 *   - `claude-stats mcp`: `src/index.ts` short-circuits on `argv[2] === "mcp"`
 *     and calls `startMcpServer()` directly, so that nothing writes to stdout
 *     before the JSON-RPC channel opens.
 *   - the VS Code extension: `extension/mcp-register.ts` registers
 *     `node -e 'require("<ext>/dist/mcp.js").startMcpServer()'`, an esbuild
 *     bundle whose entry point is `mcp/index.ts`. There is no CLI in that
 *     process at all.
 *
 * The result shipped in 0.19.0: `get_calibration` returned
 * `{ isError: true, text: "i18n not initialized — call initCliI18n() first" }`
 * on every call, and `get_cost_per_ticket` / `get_efficiency_hints` /
 * `generate_justification_pack` did the same on their zero-cost branches.
 *
 * WHY THIS TEST SPAWNS THE REAL BINARY instead of calling `createMcpServer`
 * over an in-memory transport like every other MCP test in this suite:
 *
 *   1. `setup.ts` runs `await initCliI18n("en")` before any test body, so in
 *      THIS process i18n is always initialized. An in-process test therefore
 *      cannot observe the bug — it would pass against the broken code.
 *   2. `createMcpServer(store)` is the half that does not own initialization.
 *      The defect is in `startMcpServer()`, the half nothing exercised.
 *   3. `mcp-calibration-i18n.test.ts` — the one existing test about
 *      `get_calibration` and i18n — `vi.mock`s `../i18n.js` with an identity
 *      translator, i.e. it replaces the very module that was failing.
 *
 * A child process has neither `setup.ts` nor the mock, so it is the only place
 * the real initialization order is observable. `i18n-core.test.ts` already
 * spawns `packages/cli/dist/index.js` for the same class of reason (a
 * module-global latched before any test body runs), including the same
 * empty-HOME isolation — this follows that precedent.
 *
 * TRADE-OFF, stated plainly: this runs against `dist/`, so it verifies the
 * LAST BUILD, not the working tree. `npm run build` must precede `npm test`
 * for it to be meaningful (the `existsSync` assertion catches "never built",
 * not "stale"). The alternative — an in-process test on a fresh module graph —
 * cannot reproduce the failure, because the failure IS the process-level
 * initialization order. The cheap in-process guard below covers the predicate
 * `startMcpServer` relies on; the spawn covers the wiring.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = path.resolve(__dirname, "../../dist/index.js");

describe("`claude-stats mcp` initializes i18n before serving tool calls", () => {
  /**
   * An empty HOME keeps the collector off the developer's real session data:
   * the server starts against an empty store, which is enough — the bug is in
   * process startup, not in anything data-dependent. `get_calibration` reaches
   * its unconditional `t("common:insight.calibration.minimumSampleRationale")`
   * whether or not there is data to calibrate.
   */
  async function callGetCalibration(): Promise<{ isError: boolean; text: string }> {
    const home = mkdtempSync(path.join(tmpdir(), "cs-mcp-entrypoint-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: { ...process.env, HOME: home, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
      stderr: "pipe",
    });
    const client = new Client({ name: "mcp-entrypoint-i18n-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "get_calibration", arguments: {} });
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      return { isError: (result as { isError?: boolean }).isError === true, text: content[0]!.text };
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("get_calibration returns its report, not 'i18n not initialized'", async () => {
    expect(existsSync(CLI)).toBe(true);
    const { isError, text } = await callGetCalibration();

    // Asserted as its own expectation (rather than only via the JSON parse
    // below) so a regression reports the actual failure string instead of a
    // bare "Unexpected token i in JSON".
    expect(text).not.toContain("i18n not initialized");
    expect(isError).toBe(false);

    const payload = JSON.parse(text) as Record<string, unknown>;
    // The two fields that go through `t()` unconditionally — the exact call
    // sites (mcp/index.ts) that threw. Non-empty prose, not a raw key.
    expect(typeof payload.minimumSampleRationale).toBe("string");
    expect(payload.minimumSampleRationale as string).not.toHaveLength(0);
  }, 180_000);
});

describe("isCliI18nInitialized() reports the real state of the singleton", () => {
  /**
   * The predicate `startMcpServer()` guards on. It has to be observed on a
   * FRESH module graph: `setup.ts` initialized the copy of `../i18n.js` this
   * file's own imports would resolve to, so a plain `import` here always sees
   * `true` and would prove nothing. `vi.resetModules()` clears vitest's module
   * registry, so the dynamic import below re-evaluates `i18n.ts` with `_t`
   * unset — the state a freshly spawned MCP server process starts in.
   *
   * Not shared with the suite above: that one deliberately owns no module
   * state, and resetting modules around a child-process test would be noise.
   */
  it("is false on a fresh module graph and true once initCliI18n() has run", async () => {
    vi.resetModules();
    const fresh = await import("../i18n.js");

    expect(fresh.isCliI18nInitialized()).toBe(false);
    expect(() => fresh.t("cli:commands.programDescription")).toThrow(/i18n not initialized/);

    await fresh.initCliI18n("en");

    expect(fresh.isCliI18nInitialized()).toBe(true);
    expect(fresh.t("cli:commands.programDescription")).toBe(
      "Collect and analyse Claude Code usage statistics",
    );

    // Restore the shared registry so later files in this worker resolve back to
    // the module `setup.ts` initialized, rather than to this file's fresh —
    // and, if the assertions above threw early, possibly uninitialized — copy.
    vi.resetModules();
  });
});
