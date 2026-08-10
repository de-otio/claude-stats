/**
 * `claude-stats ttl-fit` (CLI verb) + `get_cache_ttl_fit` (MCP tool) +
 * `packages/cli/src/ttlFit/format.ts` (the rendering module both of them are
 * a thin shell over).
 *
 * Three groups:
 *  1. Pure unit tests of `formatTtlFitLines`/`printTtlFit`/`isProjection`
 *     against hand-built `TtlFitResult` fixtures — no store, no CLI, no MCP.
 *     This is where the honesty rules (margin beside every verdict, nothing
 *     verdict-like on insufficient-data, projection labelling in both
 *     directions) get precise, fast coverage.
 *  2. `claude-stats ttl-fit`, driven end-to-end through `buildCli`/
 *     `parseAsync` (not a re-implementation of its handler), following
 *     `constraint-impact-cli.test.ts`'s `Store` mock precedent.
 *  3. `get_cache_ttl_fit` over an in-memory MCP transport, following
 *     `mcp.test.ts`'s precedent — checks the payload shape and that it
 *     carries no session ids.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Writable } from "node:stream";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import type { TtlFitResult } from "@claude-stats/core/ttlFit";
import { formatTtlFitLines, printTtlFit, isProjection, type Translate } from "../ttlFit/format.js";
import { t } from "../i18n.js";

// ─── Group 1: pure formatting ────────────────────────────────────────────────

function baseResult(overrides: Partial<TtlFitResult> = {}): TtlFitResult {
  return {
    gapHistogram: [
      { label: "<4 min", minGapMs: 0, maxGapMs: 240_000, requests: 10, readTokens: 1_000, creationTokens: 0, pctRebuilt: 0 },
      { label: "4-5 min", minGapMs: 240_000, maxGapMs: 300_000, requests: 5, readTokens: 500, creationTokens: 0, pctRebuilt: 0 },
      { label: "5-60 min", minGapMs: 300_000, maxGapMs: 3_600_000, requests: 20, readTokens: 200_000, creationTokens: 50_000, pctRebuilt: 0.9 },
      { label: "60+ min", minGapMs: 3_600_000, maxGapMs: null, requests: 3, readTokens: 100, creationTokens: 500_000, pctRebuilt: 1 },
    ],
    writesByOrigin: [
      { origin: "session-start", creationTokens: 100_000, share: 0.1 },
      { origin: "mid-work", creationTokens: 800_000, share: 0.8 },
      { origin: "resume-short", creationTokens: 50_000, share: 0.05 },
      { origin: "resume-long", creationTokens: 50_000, share: 0.05 },
    ],
    byModel: [
      {
        model: "claude-sonnet-5",
        recoveredReadTokens: 200_000,
        writeTokens: 1_000_000,
        writeTokens1h: 900_000,
        extraCostAtShortTtl: 0.5,
        savedOnWritesAtShortTtl: 5.0,
        netCostOfShortTtl: -4.5,
        breakEvenRatio: 0.652,
      },
    ],
    totals: {
      recoveredReadTokens: 200_000,
      writeTokens: 1_000_000,
      writeTokens1h: 900_000,
      netCostOfShortTtl: -4.5,
    },
    windowCost: 100,
    nearBoundary: { requests: 5, readTokens: 500, windowMs: 60_000, impliedSwing: 0.01 },
    observedTtl: "1h",
    recommendation: { verdict: "prefer-5m", reason: "synthetic reason — never rendered" },
    excludedRows: 2,
    unpricedRows: 1,
    unpricedWriteTokens: 100,
    ...overrides,
  };
}

describe("isProjection", () => {
  it("is true when prefer-5m is recommended but the window was recorded at 1h", () => {
    expect(isProjection({ observedTtl: "1h", recommendation: { verdict: "prefer-5m", reason: "" } })).toBe(true);
  });
  it("is true when prefer-1h is recommended but the window was recorded at 5m", () => {
    expect(isProjection({ observedTtl: "5m", recommendation: { verdict: "prefer-1h", reason: "" } })).toBe(true);
  });
  it("is false when the recommended TTL matches the observed one (a measurement, not a projection)", () => {
    expect(isProjection({ observedTtl: "1h", recommendation: { verdict: "prefer-1h", reason: "" } })).toBe(false);
    expect(isProjection({ observedTtl: "5m", recommendation: { verdict: "prefer-5m", reason: "" } })).toBe(false);
  });
  it("is false for too-close-to-call and insufficient-data regardless of observedTtl", () => {
    expect(isProjection({ observedTtl: "1h", recommendation: { verdict: "too-close-to-call", reason: "" } })).toBe(false);
    expect(isProjection({ observedTtl: "unknown", recommendation: { verdict: "insufficient-data", reason: "" } })).toBe(false);
  });
});

describe("formatTtlFitLines", () => {
  it("renders a prefer-5m verdict with the margin beside it, and labels it a projection", () => {
    const lines = formatTtlFitLines(baseResult(), t);
    const text = lines.join("\n");
    expect(text).toContain("VERDICT");
    // The margin — windowCost, R, W, W1h, break-even — is present in the SAME
    // output as the verdict (spec §5.3: never a verdict without the margin).
    expect(text).toContain("$100.00");
    expect(text).toContain("200,000");
    expect(text).toContain("1,000,000");
    expect(text).toContain("900,000");
    expect(text).toContain("0.652");
    // The recommended TTL (5m) differs from observedTtl (1h) — a projection.
    expect(text).toContain("PROJECTION");
    expect(text).toContain("1-hour");
  });

  it("renders a prefer-1h verdict as a plain measurement (no projection label) when observedTtl matches", () => {
    const result = baseResult({
      observedTtl: "1h",
      recommendation: { verdict: "prefer-1h", reason: "synthetic" },
      totals: { recoveredReadTokens: 900_000, writeTokens: 1_000_000, writeTokens1h: 900_000, netCostOfShortTtl: 4.5 },
    });
    const text = formatTtlFitLines(result, t).join("\n");
    expect(text).toContain("VERDICT");
    expect(text).not.toContain("PROJECTION");
  });

  it("prints nothing verdict-like on insufficient-data, and says what is missing instead", () => {
    const result = baseResult({
      recommendation: {
        verdict: "insufficient-data",
        reason: "Only 10 of 40 messages carry a usable timestamp; at least 50 are needed.",
      },
    });
    const text = formatTtlFitLines(result, t).join("\n");
    expect(text).not.toContain("VERDICT");
    // The engine's own English reason string must NOT be echoed raw onto this
    // localized surface — every sentence here comes from a `t()` key instead.
    expect(text).not.toContain("Only 10 of 40 messages");
    expect(text).toContain("Not enough data");
  });

  it("uses the distinct no-TTL-columns message when observedTtl is unknown, not the generic insufficient-data one", () => {
    const result = baseResult({
      observedTtl: "unknown",
      byModel: [],
      totals: { recoveredReadTokens: 0, writeTokens: 0, writeTokens1h: 0, netCostOfShortTtl: null },
      recommendation: { verdict: "insufficient-data", reason: "no TTL columns" },
    });
    const text = formatTtlFitLines(result, t).join("\n");
    expect(text).not.toContain("VERDICT");
    expect(text).toContain("no cache-TTL breakdown");
  });

  it("renders a too-close-to-call verdict with its margin, never a prefer-* claim", () => {
    const result = baseResult({
      recommendation: { verdict: "too-close-to-call", reason: "synthetic" },
    });
    const text = formatTtlFitLines(result, t).join("\n");
    expect(text).toContain("VERDICT");
    expect(text).toContain("too close to call");
    expect(text).not.toContain("would have cost");
    expect(text).not.toContain("is worth");
  });

  it("renders a D10-guarded (unpriced) model row without a dollar figure, distinct from a priced row", () => {
    const result = baseResult({
      byModel: [
        {
          model: "claude-legacy-model",
          recoveredReadTokens: 0,
          writeTokens: 42_000,
          writeTokens1h: 0,
          extraCostAtShortTtl: null,
          savedOnWritesAtShortTtl: null,
          netCostOfShortTtl: null,
          breakEvenRatio: null,
        },
      ],
      totals: { recoveredReadTokens: 0, writeTokens: 42_000, writeTokens1h: 0, netCostOfShortTtl: null },
      recommendation: { verdict: "insufficient-data", reason: "no priced model" },
    });
    const text = formatTtlFitLines(result, t).join("\n");
    expect(text).toContain("claude-legacy-model");
    expect(text).toContain("42,000");
    expect(text).not.toContain("null");
  });

  it("reports unpriced rows separately from the priced per-model table", () => {
    const text = formatTtlFitLines(baseResult({ unpricedRows: 3, unpricedWriteTokens: 12_345 }), t).join("\n");
    expect(text).toContain("3");
    expect(text).toContain("12,345");
  });
});

describe("printTtlFit", () => {
  function collect(): { out: Writable; get: () => string } {
    let buf = "";
    const out = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString();
        cb();
      },
    });
    return { out, get: () => buf };
  }

  it("writes formatted lines by default", () => {
    const { out, get } = collect();
    printTtlFit(baseResult(), out, t);
    expect(get()).toContain("VERDICT");
  });

  it("writes raw JSON when opts.json is set, and it round-trips to the same result", () => {
    const { out, get } = collect();
    const result = baseResult();
    printTtlFit(result, out, t, { json: true });
    expect(JSON.parse(get())).toEqual(result);
  });
});

describe("the fake translator contract (Translate)", () => {
  it("accepts the real i18n t() unmodified", () => {
    const fn: Translate = t;
    expect(typeof fn("cli:ttlFit.title")).toBe("string");
  });
});

// ─── Group 2: CLI end-to-end ─────────────────────────────────────────────────

let tmpRoot: string;
let cliDbPath: string;

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  class CliTestStore extends actual.Store {
    constructor() {
      super(cliDbPath);
    }
  }
  return { ...actual, Store: CliTestStore };
});

const FIXED_NOW = 1_767_571_200_000; // 2026-01-05T00:00:00Z
const MIN_MS = 60_000;

function session(id: string, ts: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: ts, lastTimestamp: ts + 3600_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 60, assistantMessageCount: 60,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: 60 * MIN_MS, medianResponseTimeMs: 2000,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, ts: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: ts, claudeVersion: "2.1.70",
    model: "claude-sonnet-5", stopReason: "end_turn",
    inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

/** Seeds a session whose messages are ~1 minute apart (mid-work gaps) and
 *  whose cache creation is entirely at the 1-hour TTL — a large, real
 *  cache-write volume so `computeTtlFit` clears the insufficient-data floor
 *  (>=50 timestamped rows, >=5 MTok attributed write volume). */
function seedSufficientWindow(store: Store, projectPath = "/w/alpha", accountUuid: string | null = null): void {
  const id = "ttlfit-session";
  store.upsertSession(session(id, FIXED_NOW, { projectPath, accountUuid }));
  const rows: MessageRecord[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push(
      message(`${id}-m${i}`, id, FIXED_NOW + i * MIN_MS, {
        cacheCreationTokens: 100_000,
        ephemeral1hCacheTokens: 100_000,
        cacheReadTokens: 10_000,
      }),
    );
  }
  store.upsertMessages(rows);
}

describe("claude-stats ttl-fit (CLI verb, end-to-end)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ttl-fit-cli-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Pins the locale to `en` for the duration of the run.
   *
   * `setup.ts` calls `initCliI18n("en")` globally, but `buildCli()` RE-INITIALISES
   * i18n from `process.argv` — and it pre-parses `--locale` off `process.argv`
   * itself, before Commander ever sees the args, so passing `--locale` through
   * `parseAsync` does nothing. With no `--locale` on `process.argv`, `buildCli`
   * re-detects from the environment and a non-English host renders translated
   * strings, failing every English `toContain` below.
   *
   * Not hypothetical: this suite went green when the 9 locales were still
   * untranslated (i18next fell back to English) and broke the moment they were
   * filled in. It is the same host-locale dependence that has already cost this
   * repo one CI failure — assertions on user-visible text must pin the locale.
   */
  async function run(args: string[]): Promise<void> {
    const { buildCli } = await import("../cli/index.js");
    const savedArgv = process.argv;
    process.argv = ["node", "claude-stats", "--locale", "en"];
    try {
      const program = await buildCli();
      await program.parseAsync(["node", "claude-stats", "ttl-fit", ...args]);
    } finally {
      process.argv = savedArgv;
    }
  }

  function stdoutText(): string {
    const calls = writeSpy.mock.calls as Array<[string]>;
    return calls.map((c) => c[0]).join("");
  }

  it("prints a real verdict block for a sufficiently large 1h-heavy window (--json)", async () => {
    const store = new Store(cliDbPath);
    seedSufficientWindow(store);
    store.close();

    await run(["--period", "all", "--json"]);
    const data = JSON.parse(stdoutText()) as TtlFitResult;
    expect(data.observedTtl).toBe("1h");
    expect(data.totals.writeTokens1h).toBe(6_000_000);
    expect(["prefer-1h", "prefer-5m", "too-close-to-call"]).toContain(data.recommendation.verdict);
    // Session ids never leave this tool.
    expect(JSON.stringify(data)).not.toContain("ttlfit-session");
  });

  it("--project narrows the window to the matching project only", async () => {
    const store = new Store(cliDbPath);
    seedSufficientWindow(store, "/w/alpha");
    store.close();

    await run(["--period", "all", "--project", "/w/does-not-exist", "--json"]);
    const data = JSON.parse(stdoutText()) as TtlFitResult;
    expect(data.totals.writeTokens).toBe(0);
  });

  it("renders text output with the verdict beside its margin for a sufficient window", async () => {
    const store = new Store(cliDbPath);
    seedSufficientWindow(store);
    store.close();

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).toContain("Cache TTL fit");
    expect(text).toMatch(/VERDICT|Not enough data/);
    // Whatever the verdict, the margin numbers are printed in the same run.
    expect(text).toContain("Margin:");
  });

  it("prints no verdict-like text for an empty window — only what's missing", async () => {
    const store = new Store(cliDbPath);
    store.close(); // no sessions/messages at all

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).not.toContain("VERDICT");
    expect(text.toLowerCase()).toContain("not enough data");
  });
});

// ─── Group 3: MCP tool ────────────────────────────────────────────────────────

describe("get_cache_ttl_fit (MCP tool)", () => {
  let mcpTmpDir: string;
  let mcpStore: Store;
  let client: Client;

  beforeAll(async () => {
    mcpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ttl-fit-mcp-"));
    mcpStore = new Store(path.join(mcpTmpDir, "test.db"));
    seedSufficientWindow(mcpStore, "/w/alpha", null);

    const server = createMcpServer(mcpStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "ttl-fit-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    mcpStore.close();
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
  });

  it("returns a TtlFitResult-shaped payload with a window and no session ids", async () => {
    const result = await client.callTool({ name: "get_cache_ttl_fit", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;

    expect(payload).toHaveProperty("gapHistogram");
    expect(payload).toHaveProperty("byModel");
    expect(payload).toHaveProperty("recommendation");
    expect(payload).toHaveProperty("observedTtl");
    expect(payload).not.toHaveProperty("sessionIds");
    expect(JSON.stringify(payload)).not.toContain("ttlfit-session");
  });

  it("respects the account filter's empty-string rejection, same as every other account-filtered tool", async () => {
    const result = await client.callTool({ name: "get_cache_ttl_fit", arguments: { period: "all", account: "   " } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBeTruthy();
  });
});
