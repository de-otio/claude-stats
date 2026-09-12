/**
 * Cost-basis disclosure and the unpriced-model surface (schema V23).
 *
 * Two facts must qualify every cost total: whether the window contains
 * `pre-dedupe` rows (counted once per content block, ~2x inflated), and
 * whether any model id in it resolved to no rate (priced at $0). The tests
 * here go from the pure helpers up through the real surfaces — the CLI
 * reporter, `buildDashboard`, the HTML template and the MCP tools — against
 * a store seeded with one repaired and one unrepaired session.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";
import { initI18n } from "@claude-stats/core/i18n";
import { Store } from "../store/index.js";
import type { SpendingMessageRow } from "../store/index.js";
import {
  summarizeCostBasis,
  countCostBasisRows,
  countCostBasis,
  costBasisFor,
  costBasisLabel,
  collectPricingDrift,
  hasPricingDrift,
  unpricedCaveat,
  renderPricingDriftLines,
} from "../reporter/cost-basis.js";
import { printSummary, printStatus, printHealthDiagnostics, printSessionDetail, printSessionList, readStatusHealth, formatTokens } from "../reporter/index.js";
import { buildDashboard, isHighThinking } from "../dashboard/index.js";
import { renderDashboard, type TranslateFn } from "../server/template.js";
import { createMcpServer } from "../mcp/index.js";
import { t } from "../i18n.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** 2026-03-10T12:00Z — every timestamp below is relative to it. */
const T0 = Date.UTC(2026, 2, 10, 12);

function session(overrides: Partial<SessionRecord> & { sessionId: string; projectPath: string }): SessionRecord {
  return {
    sourceFile: `/nonexistent/${overrides.sessionId}.jsonl`,
    firstTimestamp: T0,
    lastTimestamp: T0 + 60_000,
    claudeVersion: "2.1.72",
    entrypoint: "cli",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-opus-5"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(overrides: Partial<MessageRecord> & { uuid: string; sessionId: string }): MessageRecord {
  return {
    timestamp: T0,
    claudeVersion: "2.1.72",
    model: "claude-opus-5",
    stopReason: "end_turn",
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_000,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    isTurnStart: true,
    ...overrides,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-basis-"));
let store: Store;

beforeAll(() => {
  store = new Store(path.join(tmp, "stats.db"));
  store.transaction(() => {
    // An unrepaired session: three rows, all counted, all pre-dedupe.
    store.upsertSession(session({ sessionId: "old-1", projectPath: "/p/old" }));
    store.upsertMessages([
      message({ uuid: "o1", sessionId: "old-1", costBasis: "pre-dedupe" }),
      message({ uuid: "o2", sessionId: "old-1", costBasis: "pre-dedupe", timestamp: T0 + 1_000 }),
      message({ uuid: "o3", sessionId: "old-1", costBasis: "pre-dedupe", timestamp: T0 + 2_000 }),
    ]);
    // A repaired session, one day later: two responses of two entries each.
    store.upsertSession(session({ sessionId: "new-1", projectPath: "/p/new", firstTimestamp: T0 + DAY, lastTimestamp: T0 + DAY + 60_000 }));
    store.upsertMessages([
      message({ uuid: "n1a", sessionId: "new-1", messageId: "msg_a", usageCounted: true, costBasis: "per-response", timestamp: T0 + DAY }),
      message({ uuid: "n1b", sessionId: "new-1", messageId: "msg_a", usageCounted: false, costBasis: "per-response", timestamp: T0 + DAY + 1_000, tools: ["Read"] }),
      message({ uuid: "n2a", sessionId: "new-1", messageId: "msg_b", usageCounted: true, costBasis: "per-response", timestamp: T0 + DAY + 2_000 }),
      message({ uuid: "n2b", sessionId: "new-1", messageId: "msg_b", usageCounted: false, costBasis: "per-response", timestamp: T0 + DAY + 3_000, tools: ["Edit"] }),
    ]);
    // A session on a model id the rate table REFUSES (a point release of a
    // known row), two days later. Its cost is $0 everywhere and must be named.
    store.upsertSession(session({ sessionId: "drift-1", projectPath: "/p/drift", models: ["claude-opus-5-1"], firstTimestamp: T0 + 2 * DAY, lastTimestamp: T0 + 2 * DAY + 60_000 }));
    store.upsertMessages([
      message({ uuid: "d1", sessionId: "drift-1", model: "claude-opus-5-1", messageId: "msg_d", costBasis: "per-response", timestamp: T0 + 2 * DAY, outputTokens: 5_000 }),
    ]);
    store.recomputeSessionAggregates();
  });
  store.recomputeMessageHourly();
});

afterAll(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("summarizeCostBasis", () => {
  it("names the four states and the share", () => {
    expect(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 0 })).toMatchObject({ basis: "empty", preDedupeShare: 0 });
    expect(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 7 })).toMatchObject({ basis: "per-response", preDedupeShare: 0 });
    expect(summarizeCostBasis({ preDedupeRows: 7, perResponseRows: 0 })).toMatchObject({ basis: "pre-dedupe", preDedupeShare: 1 });
    expect(summarizeCostBasis({ preDedupeRows: 1, perResponseRows: 3 })).toMatchObject({ basis: "mixed", preDedupeShare: 0.25 });
  });
});

describe("countCostBasisRows", () => {
  it("counts carriers only, treats any label but per-response as pre-dedupe, and applies the timestamp range like SQL", () => {
    const rows = [
      { cost_basis: "per-response", usage_counted: 1, timestamp: 10 },
      { cost_basis: "per-response", usage_counted: 0, timestamp: 10 }, // non-carrier: contributes nothing
      { cost_basis: "pre-dedupe", usage_counted: 1, timestamp: 20 },
      { cost_basis: "something-else", usage_counted: 1, timestamp: 20 }, // unknown label → don't trust
      { usage_counted: 1, timestamp: 30 }, // absent label → don't trust
      { cost_basis: "per-response", usage_counted: 1, timestamp: null }, // NULL fails any bound
    ];
    expect(countCostBasisRows(rows)).toEqual({ preDedupeRows: 3, perResponseRows: 2 });
    expect(countCostBasisRows(rows, { since: 20 })).toEqual({ preDedupeRows: 3, perResponseRows: 0 });
    expect(countCostBasisRows(rows, { until: 20 })).toEqual({ preDedupeRows: 0, perResponseRows: 1 });
    expect(countCostBasisRows(rows, { since: 20, until: 30 })).toEqual({ preDedupeRows: 2, perResponseRows: 0 });
  });
});

describe("costBasisLabel", () => {
  it("is silent on a clean or empty window and speaks otherwise", () => {
    expect(costBasisLabel(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 5 }), t)).toBeNull();
    expect(costBasisLabel(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 0 }), t)).toBeNull();
    const all = costBasisLabel(summarizeCostBasis({ preDedupeRows: 12, perResponseRows: 0 }), t)!;
    expect(all).toContain("12");
    expect(all).toContain("pre-dedupe");
    expect(all).toContain("repair dedupe");
    const mixed = costBasisLabel(summarizeCostBasis({ preDedupeRows: 3, perResponseRows: 9 }), t)!;
    expect(mixed).toContain("3 of 12");
    expect(mixed).toContain("25%");
  });
});

// ── against the store ────────────────────────────────────────────────────────

describe("countCostBasis over a filtered window", () => {
  it("counts the whole store, then narrows by project and by time exactly as the message reads do", () => {
    expect(countCostBasis(store)).toEqual({ preDedupeRows: 3, perResponseRows: 3 });
    expect(countCostBasis(store, { projectPath: "/p/old" })).toEqual({ preDedupeRows: 3, perResponseRows: 0 });
    expect(countCostBasis(store, { projectPath: "/p/new" })).toEqual({ preDedupeRows: 0, perResponseRows: 2 });
    // Day two only: the repaired session, carriers only.
    expect(countCostBasis(store, { since: T0 + DAY, until: T0 + 2 * DAY })).toEqual({ preDedupeRows: 0, perResponseRows: 2 });
    expect(costBasisFor(store, { since: T0 + DAY, until: T0 + 2 * DAY }).basis).toBe("per-response");
    expect(costBasisFor(store).basis).toBe("mixed");
  });
});

describe("collectPricingDrift", () => {
  it("names the refused model id, its token volume and the row it was refused", () => {
    const report = collectPricingDrift(store.getMessageTotals());
    expect(hasPricingDrift(report)).toBe(true);
    expect(report.unpricedModels).toEqual([{ model: "claude-opus-5-1", tokens: 100 + 5_000 + 1_000 }]);
    expect(report.unpricedTokens).toBe(6_100);
    expect(report.findings).toEqual([
      { kind: "unpriced-model-variant", modelId: "claude-opus-5-1", matchedKey: "claude-opus-5", reason: "point-release-suffix", table: "built-in" },
    ]);
    const caveat = unpricedCaveat(report, t, formatTokens)!;
    expect(caveat).toContain("1 model ids");
    expect(caveat).toContain("claude-opus-5-1");
    const lines = renderPricingDriftLines(report, t);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("point-release-suffix");
    expect(lines[1]).toContain("built-in");
  });

  it("is empty — and prints nothing — for a window with no refused id", () => {
    const report = collectPricingDrift(store.getMessageTotals({ until: T0 + 2 * DAY }));
    expect(hasPricingDrift(report)).toBe(false);
    expect(unpricedCaveat(report, t, formatTokens)).toBeNull();
    expect(renderPricingDriftLines(report, t)).toEqual([]);
  });

  it("belongs to the pass that called it, not to whatever was priced before", () => {
    collectPricingDrift(store.getMessageTotals()); // leaves a finding behind
    const clean = collectPricingDrift(store.getMessageTotals({ until: T0 + 2 * DAY }));
    expect(clean.findings).toEqual([]);
  });
});

// ── the surfaces ─────────────────────────────────────────────────────────────

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join("\n");
}

describe("CLI reporter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("printSummary over a mixed range prints the basis line and names the unpriced id", () => {
    const out = captureLog(() => printSummary(store, { period: "all", includeCI: true }));
    expect(out).toContain("Basis");
    expect(out).toContain("3 of 6");
    expect(out).toContain("claude-opus-5-1");
    expect(out).toContain("1 model ids unpriced");
  });

  it("printSummary over a clean range prints neither", () => {
    const out = captureLog(() =>
      printSummary(store, { since: "2026-03-11", until: "2026-03-11", timezone: "UTC", includeCI: true }),
    );
    expect(out).not.toContain("Basis");
    expect(out).not.toContain("unpriced");
  });

  it("printSessionDetail says when a session is pre-dedupe, and stays quiet when it is not", () => {
    expect(captureLog(() => printSessionDetail(store, "old-1"))).toContain("pre-dedupe");
    expect(captureLog(() => printSessionDetail(store, "new-1"))).not.toContain("pre-dedupe");
  });

  it("printSessionList discloses the basis over the listed sessions", () => {
    const out = captureLog(() => printSessionList(store, { period: "all", includeCI: true }));
    expect(out).toContain("3 of 6");
    expect(out).toContain("claude-opus-5-1");
  });

  it("status and diagnose render the health facts", () => {
    const health = readStatusHealth(store);
    expect(health.costBasis.basis).toBe("mixed");
    const status = captureLog(() => printStatus(store.getStatus(), health));
    expect(status).toContain("3 rows per-response, 3 rows pre-dedupe");
    expect(status).toContain("claude-opus-5-1");
    expect(status).toContain("point-release-suffix");
    const diag = captureLog(() => printHealthDiagnostics(health));
    expect(diag).toContain("Cost basis:");
    expect(diag).toContain("Pricing drift:");
    expect(diag).toContain("refused the rate of claude-opus-5");
  });
});

describe("dashboard payload and template", () => {
  const require = createRequire(import.meta.url);
  const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;
  let tt: TranslateFn;
  beforeAll(async () => {
    const inst = await initI18n({ lng: "en", ns: ["dashboard"], resources: { en: { dashboard: enDashboard as unknown as object } } });
    tt = (key, opts) => inst.t(key, opts as never) as unknown as string;
  });

  it("summary carries costBasis and unpricedModels for the period, and get_stats inherits them", () => {
    const all = buildDashboard(store, { period: "all", timezone: "UTC" });
    expect(all.summary.costBasis).toMatchObject({ basis: "mixed", preDedupeRows: 3, perResponseRows: 3 });
    expect(all.summary.unpricedModels).toEqual([{ model: "claude-opus-5-1", tokens: 6_100 }]);

    const day2 = buildDashboard(store, { since: "2026-03-11", until: "2026-03-11", timezone: "UTC" });
    expect(day2.summary.costBasis).toMatchObject({ basis: "per-response", preDedupeRows: 0, perResponseRows: 2 });
    expect(day2.summary.unpricedModels).toEqual([]);
  });

  it("renders the two banners on a mixed period and neither on a clean one", () => {
    const mixed = renderDashboard(buildDashboard(store, { period: "all", timezone: "UTC" }), tt);
    expect(mixed).toContain('data-cost-basis="mixed"');
    expect(mixed).toContain("3 of 6 counted messages");
    expect(mixed).toContain("unpriced-banner");
    expect(mixed).toContain("claude-opus-5-1");

    const clean = renderDashboard(buildDashboard(store, { since: "2026-03-11", until: "2026-03-11", timezone: "UTC" }), tt);
    expect(clean).not.toContain("cost-basis-banner");
    expect(clean).not.toContain("unpriced-banner");
  });
});

describe("HIGH_THINKING", () => {
  const base: SpendingMessageRow = {
    uuid: "x", session_id: "s", model: "m", input_tokens: 0, output_tokens: 1_000,
    cache_read_tokens: 0, cache_creation_tokens: 0, thinking_blocks: 3, tools: "[]",
    prompt_text: null, timestamp: null, stop_reason: null,
    thinking_tokens: null, usage_counted: 1,
  };
  it("fires only above half the output, on carriers, and never on an unreported count", () => {
    // The old predicate (`thinking_blocks > 0`) would fire on every one of these.
    expect(isHighThinking({ ...base, thinking_tokens: null })).toBe(false); // pre-August row: unreported, never fabricated
    expect(isHighThinking({ ...base, thinking_tokens: 500 })).toBe(false); // exactly half is not "more than"
    expect(isHighThinking({ ...base, thinking_tokens: 501 })).toBe(true);
    expect(isHighThinking({ ...base, thinking_tokens: 900, usage_counted: 0 })).toBe(false);
    expect(isHighThinking({ ...base, thinking_tokens: 900, usage_counted: 1 })).toBe(true);
    expect(isHighThinking({ ...base, thinking_tokens: 0, output_tokens: 0 })).toBe(false);
  });
});

describe("MCP tools", () => {
  let client: Client;
  beforeAll(async () => {
    const server = createMcpServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "basis-test", version: "0.0.0" });
    await client.connect(ct);
  });
  afterAll(async () => { await client.close(); });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("get_stats carries the basis summary and the unpriced ids, and its description explains them", async () => {
    const tools = await client.listTools();
    const stats = tools.tools.find((x) => x.name === "get_stats")!;
    expect(stats.description).toContain("COST-BASIS NOTE");
    expect(stats.description).toContain("pre-dedupe");
    const r = await call("get_stats", { period: "all" });
    expect(r["costBasis"]).toMatchObject({ basis: "mixed", preDedupeRows: 3, perResponseRows: 3 });
    expect(r["unpricedModels"]).toEqual([{ model: "claude-opus-5-1", tokens: 6_100 }]);
  });

  it("get_session_detail exposes cost_basis and NOTHING ELSE from the V23 columns", async () => {
    const r = await call("get_session_detail", { sessionId: "new-1" });
    expect((r["session"] as Record<string, unknown>)["costBasis"]).toEqual({ basis: "per-response", preDedupeRows: 0, perResponseRows: 2 });
    const msgs = r["messages"] as Array<Record<string, unknown>>;
    expect(msgs.every((m) => m["costBasis"] === "per-response")).toBe(true);
    for (const m of msgs) {
      for (const forbidden of ["messageId", "message_id", "usageCounted", "usage_counted", "effort", "speed", "thinkingTokens", "thinking_tokens"]) {
        expect(m).not.toHaveProperty(forbidden);
      }
    }
    const old = await call("get_session_detail", { sessionId: "old-1" });
    expect((old["session"] as Record<string, unknown>)["costBasis"]).toMatchObject({ basis: "pre-dedupe" });
  });

  it("list_sessions labels each session with its basis token", async () => {
    const r = (await client.callTool({ name: "list_sessions", arguments: { period: "all", limit: 10 } }));
    const rows = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((s) => [s["sessionId"], s["costBasis"]]));
    expect(byId.get("old-1")).toBe("pre-dedupe");
    expect(byId.get("new-1")).toBe("per-response");
    // …and a session on a refused model id no longer claims `known: true`
    // beside its $0.
    const cost = new Map(rows.map((s) => [s["sessionId"], s["estimatedCost"] as { cost: number; known: boolean }]));
    expect(cost.get("drift-1")).toEqual({ cost: 0, known: false });
    expect(cost.get("new-1")!.known).toBe(true);
    expect(cost.get("new-1")!.cost).toBeGreaterThan(0);
  });

  it("get_status renders the drift findings and the whole-store basis", async () => {
    const r = await call("get_status");
    expect(r["costBasis"]).toMatchObject({ basis: "mixed", preDedupeRows: 3, perResponseRows: 3 });
    const drift = r["pricingDrift"] as Record<string, unknown>;
    expect(drift["unpricedModels"]).toEqual([{ model: "claude-opus-5-1", tokens: 6_100 }]);
    expect(drift["findings"]).toEqual([
      { modelId: "claude-opus-5-1", matchedKey: "claude-opus-5", reason: "point-release-suffix", table: "built-in" },
    ]);
  });

  it("the windowed cost tools carry costBasis for their own window", async () => {
    const hints = await call("get_efficiency_hints", { since: "2026-03-10", until: "2026-03-10" });
    expect(hints["costBasis"]).toMatchObject({ basis: "pre-dedupe" });
    const ttl = await call("get_cache_ttl_fit", { since: "2026-03-11", until: "2026-03-11" });
    expect(ttl["costBasis"]).toMatchObject({ basis: "per-response" });
  });
});
