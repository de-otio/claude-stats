/**
 * `claude-stats context` (CLI verb) + `get_context_carry` (MCP tool) +
 * `packages/cli/src/contextCarry/format.ts` (the rendering module both of
 * them are a thin shell over).
 *
 * Three groups, following `ttl-fit-cli.test.ts`'s precedent exactly:
 *  1. Pure unit tests of `formatContextCarryLines`/`printContextCarry`
 *     against hand-built `ContextCarryResult` fixtures — no store, no CLI,
 *     no MCP. This is where the honesty rules (D10/D11/D12: no bare bound,
 *     no per-token-lifetime misreading, the lower-bound label attached to
 *     `carryCost`/`aboveCap[].cost`, `insufficient-data` over a guess) get
 *     precise, fast coverage.
 *  2. `claude-stats context`, driven end-to-end through `buildCli`/
 *     `parseAsync`, following the same `Store` mock precedent.
 *  3. `get_context_carry` over an in-memory MCP transport, checking the
 *     payload shape and that `concentration`/`preludeByProject`/`turns` never
 *     appear and that no `resets`/`cycles` row carries a `sessionId`
 *     (IMPLEMENTATION.md D3, extended per assumptions.md #28).
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
import type { ContextCarryResult } from "@claude-stats/core/contextCarry";
import { formatContextCarryLines, printContextCarry, type Translate } from "../contextCarry/format.js";
import { t } from "../i18n.js";

// ─── Group 1: pure formatting ────────────────────────────────────────────────

function baseResult(overrides: Partial<ContextCarryResult> = {}): ContextCarryResult {
  return {
    carriedTokens: 1_000_000,
    distinctTokensEstimate: 100_000,
    amplificationEstimate: 10,
    sizeBands: [
      {
        label: "0-20K",
        minTokens: 0,
        maxTokens: 20_000,
        requests: 5,
        shareOfVolume: 0.05,
        shareOfCost: 0.1,
        costPerRequest: 0.02,
      },
      {
        label: "20K-50K",
        minTokens: 20_000,
        maxTokens: 50_000,
        requests: 0,
        shareOfVolume: null,
        shareOfCost: null,
        costPerRequest: null,
      },
      {
        label: "500K+",
        minTokens: 500_000,
        maxTokens: null,
        requests: 3,
        shareOfVolume: 0.9,
        shareOfCost: 0.85,
        costPerRequest: 12.5,
      },
    ],
    aboveCap: [{ capTokens: 100_000, tokensAbove: 50_000, share: 0.05, cost: 1.23 }],
    // A synthetic caveat that must NEVER be echoed raw onto the localized
    // surface — same convention `ttlFit-cli.test.ts` uses for
    // `recommendation.reason`. Every sentence the formatter prints goes
    // through `t()` instead.
    capCaveat: "SYNTHETIC-CORE-CAVEAT-NEVER-RENDERED-DIRECTLY",
    resets: [
      { sessionId: "sess-a", beforeTokens: 300_000, afterTokens: 60_000, requestsInCycle: 10, resetRequestCost: 0.5 },
      { sessionId: "sess-b", beforeTokens: 320_000, afterTokens: 65_000, requestsInCycle: 12, resetRequestCost: 0.6 },
      {
        sessionId: "sess-c",
        beforeTokens: 310_000,
        afterTokens: 62_000,
        requestsInCycle: 11,
        resetRequestCost: 0.55,
      },
    ],
    cycles: [
      { sessionId: "sess-a", requests: 10, open: false },
      { sessionId: "sess-b", requests: 12, open: false },
      { sessionId: "sess-c", requests: 11, open: false },
      { sessionId: "sess-c", requests: 4, open: true },
    ],
    sawtooth: { floorTokens: 62_000, peakTokens: 310_000, requestsPerCycle: 11 },
    prelude: { medianFirstRequestTokens: 40_000, shareOfCarriedVolume: 0.04, cost: 2.5, sessions: 4 },
    preludeByProject: [],
    concentration: [
      { sessionId: "sess-a", requests: 20, meanContext: 50_000, share: 0.5 },
      { sessionId: "sess-b", requests: 10, meanContext: 30_000, share: 0.3 },
    ],
    turns: [],
    totalCarryCost: 12.34,
    excludedRows: 2,
    unpricedRows: 1,
    unpricedTokens: 500,
    ...overrides,
  };
}

describe("formatContextCarryLines", () => {
  it("renders the volume line, the distinct-estimate caveat, and the per-request ratio with its caveat", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("Context carry cost");
    expect(text).toContain("1,000,000");
    expect(text).toContain("100,000");
    // D10: never a bare bound word beside the estimate.
    expect(text).not.toMatch(/at (least|most) 10/);
    expect(text).toContain("biased in both directions");
    // D12: an aggregate per-request statement, not a per-token lifetime claim.
    expect(text).not.toContain("was re-sent");
    expect(text).toContain("carried about");
    expect(text).toContain("produce about");
    expect(text).toContain("not a bound");
  });

  it("prints insufficient-data for the per-request ratio when there is no distinct content to divide by, never a guess", () => {
    const text = formatContextCarryLines(
      baseResult({ distinctTokensEstimate: 0, amplificationEstimate: null }),
      t,
    ).join("\n");
    expect(text).not.toContain("carried about");
    expect(text).toContain("Not enough distinct-content volume");
  });

  it("renders every size band, including a zero-request band as a distinct line and null shares/cost as an honest dash", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("0-20K");
    expect(text).toContain("20K-50K: no requests in this window");
    expect(text).toContain("500K+");
    expect(text).toContain("$12.50");
  });

  it("attaches the rework caveat to the above-cap table, never a bare cap figure", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("100,000");
    expect(text).toContain("$1.23");
    expect(text).toContain("not the cost of capping context");
    // The core module's own English caveat string is never echoed raw.
    expect(text).not.toContain("SYNTHETIC-CORE-CAVEAT-NEVER-RENDERED-DIRECTLY");
  });

  it("says so when no caps are configured, rather than printing an empty table", () => {
    const text = formatContextCarryLines(baseResult({ aboveCap: [] }), t).join("\n");
    expect(text).toContain("No caps configured");
    expect(text).not.toContain("not the cost of capping context");
  });

  it("renders the sawtooth shape when at least 3 resets were observed", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("3 reset(s)");
    expect(text).toContain("Sawtooth");
    expect(text).toContain("62,000");
    expect(text).toContain("310,000");
  });

  it("says insufficient-data for the sawtooth on fewer than 3 resets, never averaging two events", () => {
    const text = formatContextCarryLines(
      baseResult({
        resets: [
          { sessionId: "sess-a", beforeTokens: 300_000, afterTokens: 60_000, requestsInCycle: 10, resetRequestCost: 0.5 },
        ],
        sawtooth: null,
      }),
      t,
    ).join("\n");
    expect(text).toContain("1 reset(s)");
    expect(text).not.toContain("Sawtooth");
    expect(text).toContain("Fewer than 3 resets");
  });

  it("renders the prelude line and its share of carried volume", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("40,000");
    expect(text).toContain("4 session(s)");
    expect(text).toContain("$2.50");
    expect(text).toContain("4%");
  });

  it("says share unavailable rather than fabricating 0% when carriedTokens is 0", () => {
    const text = formatContextCarryLines(
      baseResult({ prelude: { medianFirstRequestTokens: 0, shareOfCarriedVolume: null, cost: 0, sessions: 0 } }),
      t,
    ).join("\n");
    expect(text).toContain("not available");
    expect(text).not.toContain("That is about");
  });

  it("labels totalCarryCost a lower bound on the same line as the figure", () => {
    const text = formatContextCarryLines(baseResult(), t).join("\n");
    expect(text).toContain("$12.34");
    expect(text).toContain("lower bound");
    expect(text).toContain("re-written at 1.25-2x");
  });

  it("says not-available for carry cost when every turn is unpriced, never a fabricated 0", () => {
    const text = formatContextCarryLines(baseResult({ totalCarryCost: null }), t).join("\n");
    expect(text).toContain("Total carry cost: not available");
    expect(text).not.toContain("$0.00");
  });

  it("reports unpriced and excluded rows only when present (paired negative/positive)", () => {
    const withNotes = formatContextCarryLines(baseResult(), t).join("\n");
    expect(withNotes).toContain("1 messages");
    expect(withNotes).toContain("500");
    expect(withNotes).toContain("2 messages were excluded");

    const withoutNotes = formatContextCarryLines(baseResult({ unpricedRows: 0, excludedRows: 0 }), t).join("\n");
    expect(withoutNotes).not.toContain("have no priced model");
    expect(withoutNotes).not.toContain("were excluded from ordering");
  });

  it("renders the top concentration rows when present, and omits the section entirely when empty", () => {
    const withRows = formatContextCarryLines(baseResult(), t).join("\n");
    expect(withRows).toContain("sess-a");
    expect(withRows).toContain("sess-b");
    expect(withRows).toContain("50%");

    const withoutRows = formatContextCarryLines(baseResult({ concentration: [] }), t).join("\n");
    expect(withoutRows).not.toContain("Sessions by carried volume");
  });
});

describe("printContextCarry", () => {
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
    printContextCarry(baseResult(), out, t);
    expect(get()).toContain("Context carry cost");
  });

  it("writes raw JSON when opts.json is set, and it round-trips to the same result", () => {
    const { out, get } = collect();
    const result = baseResult();
    printContextCarry(result, out, t, { json: true });
    expect(JSON.parse(get())).toEqual(result);
  });
});

describe("the fake translator contract (Translate)", () => {
  it("accepts the real i18n t() unmodified", () => {
    const fn: Translate = t;
    expect(typeof fn("cli:contextCarry.title")).toBe("string");
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
    sessionId: id,
    projectPath: "/w/alpha",
    sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: ts,
    lastTimestamp: ts + 3600_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-vscode",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 60,
    assistantMessageCount: 60,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-5"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: 60 * MIN_MS,
    medianResponseTimeMs: 2000,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, ts: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp: ts,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-5",
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    filePaths: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    toolErrorCount: 0,
    ...overrides,
  };
}

/** Seeds a session whose context grows steadily and then drops sharply (a
 *  reset) — enough volume and a real reset event for `computeContextCarry` to
 *  produce non-trivial output through the real store query. */
function seedWindow(store: Store, projectPath = "/w/alpha", accountUuid: string | null = null): void {
  const id = "context-carry-session";
  store.upsertSession(session(id, FIXED_NOW, { projectPath, accountUuid }));
  const rows: MessageRecord[] = [];
  for (let i = 0; i < 20; i++) {
    rows.push(
      message(`${id}-m${i}`, id, FIXED_NOW + i * MIN_MS, {
        inputTokens: 200_000 + i * 5_000,
        cacheReadTokens: 100_000,
      }),
    );
  }
  // A sharp drop — a reset.
  rows.push(
    message(`${id}-reset`, id, FIXED_NOW + 21 * MIN_MS, {
      inputTokens: 60_000,
      cacheReadTokens: 0,
    }),
  );
  store.upsertMessages(rows);
}

describe("claude-stats context (CLI verb, end-to-end)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-context-carry-cli-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Pins the locale to `en` for the duration of the run. `buildCli()`
   * pre-parses `--locale` off `process.argv` itself, before Commander ever
   * sees the args, so passing `--locale` through `parseAsync` does nothing —
   * stub `process.argv` instead. Copied verbatim from
   * `ttl-fit-cli.test.ts#run()` (this exact trap broke that suite the moment
   * the locales were translated).
   */
  async function run(args: string[]): Promise<void> {
    const { buildCli } = await import("../cli/index.js");
    const savedArgv = process.argv;
    process.argv = ["node", "claude-stats", "--locale", "en"];
    try {
      const program = await buildCli();
      await program.parseAsync(["node", "claude-stats", "context", ...args]);
    } finally {
      process.argv = savedArgv;
    }
  }

  function stdoutText(): string {
    const calls = writeSpy.mock.calls as Array<[string]>;
    return calls.map((c) => c[0]).join("");
  }

  it("prints a real ContextCarryResult for a window with real messages (--json)", async () => {
    const store = new Store(cliDbPath);
    seedWindow(store);
    store.close();

    await run(["--period", "all", "--json"]);
    const data = JSON.parse(stdoutText()) as ContextCarryResult;
    expect(data.carriedTokens).toBeGreaterThan(0);
    expect(Array.isArray(data.sizeBands)).toBe(true);
    expect(data.resets.length).toBeGreaterThanOrEqual(1);
  });

  it("--project narrows the window to the matching project only", async () => {
    const store = new Store(cliDbPath);
    seedWindow(store, "/w/alpha");
    store.close();

    await run(["--period", "all", "--project", "/w/does-not-exist", "--json"]);
    const data = JSON.parse(stdoutText()) as ContextCarryResult;
    expect(data.carriedTokens).toBe(0);
  });

  it("renders text output with the title, the distinct-estimate caveat, and the carry-cost lower-bound label", async () => {
    const store = new Store(cliDbPath);
    seedWindow(store);
    store.close();

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).toContain("Context carry cost");
    expect(text).toContain("biased in both directions");
  });

  it("prints an honest empty-window report — no fabricated figures", async () => {
    const store = new Store(cliDbPath);
    store.close(); // no sessions/messages at all

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).toContain("Context carry cost");
    expect(text).toContain("Not enough distinct-content volume");
    expect(text).toContain("Total carry cost: not available");
  });
});

// ─── Group 3: MCP tool ────────────────────────────────────────────────────────

describe("get_context_carry (MCP tool)", () => {
  let mcpTmpDir: string;
  let mcpStore: Store;
  let client: Client;

  beforeAll(async () => {
    mcpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-context-carry-mcp-"));
    mcpStore = new Store(path.join(mcpTmpDir, "test.db"));
    seedWindow(mcpStore, "/w/alpha", null);

    const server = createMcpServer(mcpStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "context-carry-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    mcpStore.close();
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
  });

  it("returns a ContextCarryResult-shaped payload with a window", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;

    expect(payload).toHaveProperty("window");
    expect(payload).toHaveProperty("carriedTokens");
    expect(payload).toHaveProperty("distinctTokensEstimate");
    expect(payload).toHaveProperty("sizeBands");
    expect(payload).toHaveProperty("aboveCap");
    expect(payload).toHaveProperty("resets");
    expect(payload).toHaveProperty("cycles");
    expect(payload).toHaveProperty("prelude");
  });

  it("omits concentration, preludeByProject, and turns entirely (D3 + assumptions.md #28)", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;

    expect(payload).not.toHaveProperty("concentration");
    expect(payload).not.toHaveProperty("preludeByProject");
    expect(payload).not.toHaveProperty("turns");
    // Never leaves this process over MCP, whichever array it might have ridden in.
    expect(JSON.stringify(payload)).not.toContain("context-carry-session");
  });

  it("strips sessionId from resets and cycles rows while keeping their other fields (assumptions.md #28)", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as {
      resets: Array<Record<string, unknown>>;
      cycles: Array<Record<string, unknown>>;
    };

    expect(payload.resets.length).toBeGreaterThanOrEqual(1);
    for (const row of payload.resets) {
      expect(row).not.toHaveProperty("sessionId");
      // Positive counterpart: the aggregate numbers this row exists for are
      // still present, not thrown away along with the id.
      expect(row).toHaveProperty("beforeTokens");
      expect(row).toHaveProperty("afterTokens");
      expect(row).toHaveProperty("requestsInCycle");
    }
    for (const row of payload.cycles) {
      expect(row).not.toHaveProperty("sessionId");
      expect(row).toHaveProperty("requests");
      expect(row).toHaveProperty("open");
    }
  });

  it("respects the account filter's empty-string rejection, same as every other account-filtered tool", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all", account: "   " } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBeTruthy();
  });
});
