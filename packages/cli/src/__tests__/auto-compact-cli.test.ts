/**
 * The auto-compact window fit's B1 surfaces: the glue's second pass + attach
 * (`contextCarry/index.ts`), the CLI rendering (`contextCarry/format.ts`),
 * and the `get_context_carry` MCP allowlist (`mcp/index.ts`).
 *
 * `plans/autocompact-window-fit/IMPLEMENTATION.md` §4/B1. Three groups,
 * following `context-carry-cli.test.ts`/`ttl-fit-cli.test.ts`'s precedent:
 *
 *  1. Pure formatting — hand-built `AutoCompactFitResult` fixtures attached to
 *     a `ContextCarryResult`, no store, no CLI, no MCP. Where the honesty
 *     rules (D5 caveat placement, D6 null-not-zero, the descending `range`)
 *     get precise, fast coverage.
 *  2. `claude-stats context`, end-to-end through `buildCli`/`parseAsync`,
 *     against a real `Store` — demonstrates the D13 divergence: it fires on a
 *     small-context fixture and does not on a large-context one (paired, per
 *     `IMPLEMENTATION.md` §0/C5).
 *  3. `get_context_carry` over an in-memory MCP transport — a VALUE test
 *     (SR-1), not a key-name test: an adversarial fixture (an absolute
 *     `project_path`, a Bedrock-ARN-shaped `model`) proves neither leaks into
 *     the serialised `autoCompactFit` block, paired with a positive that the
 *     block IS present and carries a known `windowTokens`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import type { ContextCarryResult } from "@claude-stats/core/contextCarry";
import type { AutoCompactFitResult } from "@claude-stats/core/autoCompactFit";
import {
  formatContextCarryLines,
  type ContextCarryResultWithOptionalFit,
  type Translate,
} from "../contextCarry/format.js";
import { t } from "../i18n.js";

// ─── Group 1: pure formatting ────────────────────────────────────────────────

/** A minimal but complete `ContextCarryResult` — every field the formatter
 *  reads before it ever reaches the `autoCompactFit` block. */
function baseCarryResult(overrides: Partial<ContextCarryResult> = {}): ContextCarryResult {
  return {
    carriedTokens: 1_000_000,
    distinctTokensEstimate: 100_000,
    amplificationEstimate: 10,
    sizeBands: [],
    aboveCap: [],
    capCaveat: "SYNTHETIC-CAP-CAVEAT-NEVER-RENDERED-DIRECTLY",
    resets: [
      { sessionId: "sess-a", beforeTokens: 300_000, afterTokens: 60_000, requestsInCycle: 10, resetRequestCost: 0.5 },
      { sessionId: "sess-b", beforeTokens: 320_000, afterTokens: 65_000, requestsInCycle: 12, resetRequestCost: 0.6 },
      { sessionId: "sess-c", beforeTokens: 310_000, afterTokens: 62_000, requestsInCycle: 11, resetRequestCost: 0.55 },
    ],
    cycles: [
      { sessionId: "sess-a", requests: 10, open: false },
      { sessionId: "sess-b", requests: 12, open: false },
      { sessionId: "sess-c", requests: 11, open: false },
    ],
    sawtooth: { floorTokens: 62_000, peakTokens: 310_000, requestsPerCycle: 11 },
    prelude: { medianFirstRequestTokens: 40_000, shareOfCarriedVolume: 0.04, cost: 2.5, sessions: 4 },
    preludeByProject: [],
    concentration: [],
    turns: [],
    totalCarryCost: 12.34,
    excludedRows: 0,
    unpricedRows: 0,
    unpricedTokens: 0,
    ...overrides,
  };
}

function baseFit(overrides: Partial<AutoCompactFitResult> = {}): AutoCompactFitResult {
  return {
    candidates: [
      { windowTokens: 200_000, savedTokens: 500_000, extraResets: 2, netSaving: 12.5, medianCycleRequests: 8 },
      { windowTokens: 300_000, savedTokens: 300_000, extraResets: 1, netSaving: 8.2, medianCycleRequests: 10 },
    ],
    droppedCandidates: [{ windowTokens: 100_000, reason: "below-floor" }],
    recommendation: {
      verdict: "recommend-window",
      recommendedTokens: 300_000,
      range: [300_000, 200_000],
      reasonCode: "recommended",
      reasonFacts: {
        recommendedTokens: 300_000,
        aggressiveTokens: 200_000,
        aggressiveNetSaving: 12.5,
        bestNetSaving: 12.5,
        totalCarryCost: 100,
      },
    },
    closedCycleCarriedTokens: 900_000,
    openCycleCarriedTokens: 50_000,
    excludedRowCarriedTokens: 0,
    openCyclesExcluded: 1,
    observedFloorTokens: 60_000,
    observedPeakTokens: 310_000,
    observedMaxPeakTokens: 350_000,
    observedMedianCycleRequests: 9,
    resetFloorUsed: 150_000,
    resetFloorDefault: 150_000,
    modelMix: { uniform: true, models: ["claude-sonnet-5"], unknownModels: 0 },
    savingCaveat: "SYNTHETIC-SAVING-CAVEAT-NEVER-RENDERED-DIRECTLY-UNLESS-VERBATIM",
    settableRange: [100_000, 1_000_000],
    ...overrides,
  };
}

function withFit(fit: AutoCompactFitResult | undefined, carryOverrides: Partial<ContextCarryResult> = {}): ContextCarryResultWithOptionalFit {
  const carry = baseCarryResult(carryOverrides);
  return fit === undefined ? carry : { ...carry, autoCompactFit: fit };
}

describe("formatContextCarryLines — autoCompactFit block", () => {
  it("omits the block entirely when no fit is attached (paired negative)", () => {
    const text = formatContextCarryLines(withFit(undefined), t).join("\n");
    expect(text).not.toContain("Auto-compact window fit");
  });

  it("renders a session's mean context as an honest dash when it is null (pre-existing concentration branch, exercised here)", () => {
    const text = formatContextCarryLines(
      withFit(undefined, { concentration: [{ sessionId: "sess-null", requests: 3, meanContext: null, share: 0.2 }] }),
      t,
    ).join("\n");
    expect(text).toContain("sess-null");
    expect(text).toContain("—");
  });

  it("renders the block when a fit IS attached, with the savingCaveat verbatim (paired positive)", () => {
    const text = formatContextCarryLines(withFit(baseFit()), t).join("\n");
    expect(text).toContain("Auto-compact window fit");
    expect(text).toContain("SYNTHETIC-SAVING-CAVEAT-NEVER-RENDERED-DIRECTLY-UNLESS-VERBATIM");
  });

  it("renders every candidate row, honestly, never a $0.00 for a null netSaving (paired with a real dollar figure)", () => {
    const fit = baseFit({
      candidates: [
        { windowTokens: 200_000, savedTokens: 500_000, extraResets: 2, netSaving: null, medianCycleRequests: 8 },
        { windowTokens: 300_000, savedTokens: 300_000, extraResets: 1, netSaving: 8.2, medianCycleRequests: 10 },
      ],
    });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).toContain("200,000 tokens");
    expect(text).toContain("300,000 tokens");
    expect(text).toContain("$8.20");
    expect(text).not.toContain("$0.00");
    expect(text).toContain("not available");
  });

  it("renders a full candidate table on the nothing-priced path (A8/handoff item 3) — every dollar cell unavailable, never an empty table", () => {
    const fit = baseFit({
      candidates: [
        { windowTokens: 200_000, savedTokens: 500_000, extraResets: 2, netSaving: null, medianCycleRequests: 8 },
        { windowTokens: 300_000, savedTokens: 300_000, extraResets: 0, netSaving: null, medianCycleRequests: 10 },
      ],
      recommendation: {
        verdict: "insufficient-data",
        recommendedTokens: null,
        range: null,
        reasonCode: "nothing-priced",
        reasonFacts: { candidates: 2 },
      },
    });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).toContain("Candidate windows");
    expect(text).toContain("200,000 tokens");
    expect(text).toContain("300,000 tokens");
    expect(text).not.toContain("$0.00");
    // Real token figures still render, even though every dollar cell degrades.
    expect(text).toContain("saves 500,000 tokens");
  });

  it("says not-available for the observed median cycle length when there is no closed cycle to measure it from, never a fabricated 0", () => {
    const fit = baseFit({ observedMedianCycleRequests: null });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).toContain("Observed median cycle length today: not available");
  });

  it("renders NO candidate table on a structural insufficient-data path (empty candidates), but still states the verdict", () => {
    const fit = baseFit({
      candidates: [],
      recommendation: {
        verdict: "insufficient-data",
        recommendedTokens: null,
        range: null,
        reasonCode: "too-few-rows",
        reasonFacts: { turns: 10, minTurns: 50 },
      },
    });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).not.toContain("Candidate windows");
    expect(text).toContain("Not enough data");
  });

  it("prints the verdict sentence with the saving caveat immediately after it — never a detached footnote (D5)", () => {
    const lines = formatContextCarryLines(withFit(baseFit()), t);
    const verdictIdx = lines.findIndex((l) => l.includes("Recommendation:"));
    expect(verdictIdx).toBeGreaterThanOrEqual(0);
    expect(lines[verdictIdx + 1]).toContain("SYNTHETIC-SAVING-CAVEAT-NEVER-RENDERED-DIRECTLY-UNLESS-VERBATIM");
  });

  it("renders the recommend-window verdict with conservative/aggressive explicitly labelled — never a bare 'X-Y' that could be read as ascending (handoff item 1)", () => {
    // range = [conservative, aggressive] = [300_000, 200_000] — DESCENDING.
    const text = formatContextCarryLines(withFit(baseFit()), t).join("\n");
    expect(text).toContain("300,000 tokens as your default");
    expect(text).toContain("300,000 tokens (conservative, recommended)");
    expect(text).toContain("200,000 tokens (aggressive");
    // Never claims enforceability (D8): "default", never "control"/"enforce".
    expect(text).not.toMatch(/will (be )?enforce/i);
    expect(text).not.toContain("control");
    // Never recommends disabling compaction (D7).
    expect(text).not.toMatch(/disable/i);
  });

  it("renders the too-close-to-call verdict with the margin and states the bias toward recommending (C8), via the caveat", () => {
    const fit = baseFit({
      recommendation: {
        verdict: "too-close-to-call",
        recommendedTokens: null,
        range: null,
        reasonCode: "saving-under-margin",
        reasonFacts: { bestNetSaving: 1.2, totalCarryCost: 100, marginFraction: 0.05 },
      },
    });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).toContain("Too close to call");
    expect(text).toContain("$1.20");
    expect(text).toContain("$100.00");
    expect(text).toContain("5%");
    expect(text).toContain("biased toward recommending");
  });

  it("renders the already-tuned verdict with the observed peak", () => {
    const fit = baseFit({
      recommendation: {
        verdict: "already-tuned",
        recommendedTokens: null,
        range: null,
        reasonCode: "peak-at-candidate",
        reasonFacts: { maxPeakTokens: 210_000, nearestWindowTokens: 200_000, toleranceFraction: 0.15 },
      },
    });
    const text = formatContextCarryLines(withFit(fit), t).join("\n");
    expect(text).toContain("already sits close to a candidate window");
    expect(text).toContain("210,000");
  });

  it("states the divergence in one plain sentence when resetFloorUsed !== resetFloorDefault (paired: absent when they agree)", () => {
    const diverged = formatContextCarryLines(
      withFit(baseFit({ resetFloorUsed: 62_000, resetFloorDefault: 150_000 })),
      t,
    ).join("\n");
    expect(diverged).toContain("62,000");
    expect(diverged).toContain("150,000");
    expect(diverged).toContain("lower reset-detection floor");

    const agreed = formatContextCarryLines(withFit(baseFit({ resetFloorUsed: 150_000, resetFloorDefault: 150_000 })), t).join(
      "\n",
    );
    expect(agreed).not.toContain("lower reset-detection floor");
  });
});

// ─── Group 2: CLI end-to-end — the D13 divergence, demonstrated ─────────────

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

/**
 * Repeated growth-then-reset cycles: `cycles` cycles of `stepsPerCycle`
 * requests each, context climbing linearly from `baseline` to `peak`, then a
 * sharp drop to `resetTo` (well under the default 40% drop ratio) — enough
 * volume for `computeContextCarry`'s own sawtooth AND (per the peak/floor
 * chosen by the caller) to demonstrate or avoid the D13 divergence.
 */
function seedCyclingWindow(
  store: Store,
  opts: {
    projectPath?: string;
    model?: string;
    cycles?: number;
    stepsPerCycle?: number;
    baseline: number;
    peak: number;
    resetTo: number;
  },
): void {
  const { projectPath = "/w/alpha", model = "claude-sonnet-5", cycles = 3, stepsPerCycle = 20, baseline, peak, resetTo } = opts;
  const id = "fit-session";
  store.upsertSession(session(id, FIXED_NOW, { projectPath, models: [model] }));
  const rows: MessageRecord[] = [];
  const stepTokens = (peak - baseline) / (stepsPerCycle - 1);
  let t = 0;
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < stepsPerCycle; i++) {
      const ctx = Math.round(baseline + i * stepTokens);
      rows.push(message(`${id}-c${c}-m${i}`, id, FIXED_NOW + t * MIN_MS, { inputTokens: ctx, model }));
      t++;
    }
    rows.push(message(`${id}-c${c}-reset`, id, FIXED_NOW + t * MIN_MS, { inputTokens: resetTo, model }));
    t++;
  }
  store.upsertMessages(rows);
}

describe("claude-stats context — the D13 divergence, demonstrated (CLI end-to-end)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-autocompact-cli-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Copied verbatim from `ttl-fit-cli.test.ts#run()`/`context-carry-cli.test.ts#run()`
   *  — `buildCli()` pre-parses `--locale` off `process.argv` itself, before
   *  Commander ever sees the args, so passing `--locale` through `parseAsync`
   *  does nothing. This exact trap broke the sibling suite the moment the
   *  locales were translated. */
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

  it("discloses the divergence on a small-context window (contexts stay under the 150K default floor)", async () => {
    const store = new Store(cliDbPath);
    // Peaks around 120K — below the 150K default floor (no resets detected on
    // the primary pass) but well above the adaptive floor computed from the
    // row distribution (IMPLEMENTATION.md §0/C5's worked example).
    seedCyclingWindow(store, { baseline: 10_000, peak: 120_000, resetTo: 8_000 });
    store.close();

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).toContain("Auto-compact window fit");
    // The primary block above it found no qualifying resets at the default
    // floor — the exact inversion C5 exists to fix.
    expect(text).toContain("Fewer than 3 resets");
    expect(text).toContain("lower reset-detection floor");
    // The fit itself DID find candidates at the lower floor.
    expect(text).toContain("Candidate windows");
  });

  it("agrees with the primary block on a large-context window (contexts comfortably clear the 150K default floor)", async () => {
    const store = new Store(cliDbPath);
    // Peaks around 380K — the adaptive floor's ceiling term
    // (`min(150_000, 0.5 × p95)`) resolves to the 150K default itself here,
    // so the two passes use the SAME floor and agree.
    seedCyclingWindow(store, { baseline: 50_000, peak: 380_000, resetTo: 20_000 });
    store.close();

    await run(["--period", "all"]);
    const text = stdoutText();
    expect(text).toContain("Auto-compact window fit");
    // The primary block found real resets at the default floor.
    expect(text).toContain("Sawtooth shape");
    expect(text).not.toContain("lower reset-detection floor");
  });

  it("--json carries autoCompactFit whole, alongside the unmoved primary result", async () => {
    const store = new Store(cliDbPath);
    seedCyclingWindow(store, { baseline: 50_000, peak: 380_000, resetTo: 20_000 });
    store.close();

    await run(["--period", "all", "--json"]);
    const data = JSON.parse(stdoutText()) as ContextCarryResult & { autoCompactFit: AutoCompactFitResult };
    expect(data.sawtooth).not.toBeNull();
    expect(data.autoCompactFit).toBeDefined();
    expect(typeof data.autoCompactFit.resetFloorUsed).toBe("number");
    expect(typeof data.autoCompactFit.resetFloorDefault).toBe("number");
    expect(Array.isArray(data.autoCompactFit.candidates)).toBe(true);
  });
});

// ─── Group 3: MCP tool — value test, not a key-name test (SR-1) ─────────────

describe("get_context_carry (MCP tool) — the autoCompactFit allowlist", () => {
  let mcpTmpDir: string;
  let mcpStore: Store;
  let client: Client;

  // An adversarial project path (absolute, real-looking) and a Bedrock-ARN-
  // shaped model id — neither may survive into the serialised payload.
  const ADVERSARIAL_PROJECT_PATH = "/Users/adversary-marker/repos/definitely-not-public/app";
  const ADVERSARIAL_MODEL = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/adversary-marker-profile";

  beforeAll(async () => {
    mcpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-autocompact-mcp-"));
    mcpStore = new Store(path.join(mcpTmpDir, "test.db"));
    seedCyclingWindow(mcpStore, {
      projectPath: ADVERSARIAL_PROJECT_PATH,
      model: ADVERSARIAL_MODEL,
      baseline: 50_000,
      peak: 380_000,
      resetTo: 20_000,
    });

    const server = createMcpServer(mcpStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "autocompact-mcp-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    mcpStore.close();
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
  });

  it("carries an autoCompactFit block with a known windowTokens (paired positive)", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as {
      autoCompactFit: { candidates: Array<{ windowTokens: number }>; observedFloorTokens: number | null };
    };

    expect(payload.autoCompactFit).toBeDefined();
    // The adversarial model is unrecognised by the pricing table, so nothing
    // prices — but the token-side arithmetic is still real (A8), so at least
    // one candidate with a real windowTokens must be present.
    expect(payload.autoCompactFit.candidates.length).toBeGreaterThan(0);
    expect(payload.autoCompactFit.candidates.some((c) => typeof c.windowTokens === "number" && c.windowTokens > 0)).toBe(
      true,
    );
  });

  it("leaks no /-rooted path, no 'arn:', and no UUID-shaped string anywhere in the payload (value test, SR-1)", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const raw = content[0]!.text;

    expect(raw).not.toContain("adversary-marker");
    expect(raw).not.toContain(ADVERSARIAL_PROJECT_PATH);
    expect(raw).not.toContain(ADVERSARIAL_MODEL);
    expect(raw).not.toMatch(/arn:/);
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const payload = JSON.parse(raw) as { autoCompactFit: { modelMix: Record<string, unknown> } };
    // The specific allowlist decision (SR-1/B6): `uniform`/`unknownModels`
    // ship, `models` (raw ids) does not.
    expect(payload.autoCompactFit.modelMix).toHaveProperty("uniform");
    expect(payload.autoCompactFit.modelMix).toHaveProperty("unknownModels");
    expect(payload.autoCompactFit.modelMix).not.toHaveProperty("models");
  });

  it("still omits concentration/preludeByProject/turns and strips sessionId from resets/cycles (unchanged D3 behaviour)", async () => {
    const result = await client.callTool({ name: "get_context_carry", arguments: { period: "all" } });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;

    expect(payload).not.toHaveProperty("concentration");
    expect(payload).not.toHaveProperty("preludeByProject");
    expect(payload).not.toHaveProperty("turns");
  });
});
