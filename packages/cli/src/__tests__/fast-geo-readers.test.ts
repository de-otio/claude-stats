/**
 * End to end, through the real parser and a real store: fast-mode and US-geo
 * rows reach EVERY per-message reader that prices them (plan P1, section 3.2).
 *
 * Why this exists: the per-message readers each have their own SELECT list, and
 * a SELECT that drops `speed` / `inference_geo` still type-checks, because the
 * columns are plain optional-looking data once they leave SQLite. Replacing those
 * columns with NULL in the hygiene query (which feeds hygiene, cache-TTL fit,
 * context carry and constraint impact) and in the spending and MCP queries
 * passed the whole suite before this file. Each assertion below is a
 * hand-computed dollar figure that is WRONG if its reader prices a fast or US
 * row at the standard rate.
 *
 * Fixtures are synthetic (the local store holds no `fast` or `us` rows).
 *
 * Fable 5.2 rates per MTok: 8 in / 40 out / 0.20 read / 10 5m write / 16 1h
 * write. Fast mode x2, US geo x1.1, both x2.2.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import { Store } from "../store/index.js";
import { computeTtlFitForWindow } from "../ttlFit/index.js";
import { computeContextCarryForWindow } from "../contextCarry/index.js";
import { buildHygieneReport } from "../hygiene/index.js";
import { buildDashboard } from "../dashboard/index.js";
import { aggregateMcpServerUsage, attributeToolCosts } from "../spending.js";

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(os.tmpdir(), `cs-fgr-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  tmpPaths.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
  }
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const FABLE = "claude-fable-5-2";
const WINDOW = { period: "all", since: "2023-01-01", until: "2099-01-01" } as const;

interface Msg {
  /** Minutes after T0. */
  at: number;
  input: number;
  output: number;
  read?: number;
  create1h?: number;
  speed: "standard" | "fast";
  geo: "global" | "us";
  tools?: string[];
}

function entry(sessionId: string, idx: number, m: Msg): Record<string, unknown> {
  return {
    type: "assistant",
    sessionId,
    version: "2.1.311",
    timestamp: T0 + m.at * MIN,
    uuid: `${sessionId}-${idx}`,
    message: {
      id: `msg_${sessionId}_${idx}`,
      model: FABLE,
      stop_reason: "end_turn",
      content: (m.tools ?? []).map((name, i) => ({ type: "tool_use", id: `toolu_${sessionId}_${idx}_${i}`, name, input: {} })),
      usage: {
        input_tokens: m.input,
        output_tokens: m.output,
        cache_creation_input_tokens: m.create1h ?? 0,
        cache_read_input_tokens: m.read ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: m.create1h ?? 0 },
        speed: m.speed,
        inference_geo: m.geo,
      },
    },
  };
}

async function seedSession(store: Store, sessionId: string, msgs: readonly Msg[]): Promise<void> {
  const file = tmp(".jsonl");
  // A queue-operation line marks the session interactive, which the spending and
  // MCP readers (and the dashboard's spending section) require.
  const queue = { type: "queue-operation", operation: "enqueue", sessionId, timestamp: T0 };
  fs.writeFileSync(file, [queue, ...msgs.map((m, i) => entry(sessionId, i, m))].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const parsed = await parseSessionFile(file, `/proj-${sessionId}`);
  store.upsertSession(parsed.session!);
  store.upsertMessages(parsed.messages);
}

// ─── hygiene-fed readers: hygiene, cache-TTL fit, context carry ──────────────

/** Three sessions of 12 requests, 10 minutes apart, each 1h-TTL cache writes. */
const SESSIONS: ReadonlyArray<{ id: string; speed: "standard" | "fast"; geo: "global" | "us"; mult: number }> = [
  { id: "std", speed: "standard", geo: "global", mult: 1 },
  { id: "fast", speed: "fast", geo: "global", mult: 2 },
  { id: "us", speed: "standard", geo: "us", mult: 1.1 },
];
const ROWS = 12;
const ROW = { input: 1_000, output: 200, read: 50_000, create1h: 5_000 };
const turns = (s: (typeof SESSIONS)[number]): Msg[] =>
  Array.from({ length: ROWS }, (_, i) => ({ at: i * 10, ...ROW, speed: s.speed, geo: s.geo }));
const MULT_SUM = SESSIONS.reduce((n, s) => n + s.mult, 0); // 4.1

describe("hygiene-fed readers price fast and US rows (getMessagesForHygiene SELECT)", () => {
  let store: Store;
  beforeEach(async () => {
    store = new Store(tmp(".db"));
    for (const s of SESSIONS) await seedSession(store, s.id, turns(s));
  });
  afterEach(() => store.close());

  it("the rows carry speed and inference_geo to the glue (every hygiene-fed mapper reads this query)", () => {
    const rows = store.getMessagesForHygiene({});
    expect(rows).toHaveLength(SESSIONS.length * ROWS);
    for (const s of SESSIONS) {
      const mine = rows.filter((r) => r.session_id === s.id);
      expect(mine).toHaveLength(ROWS);
      expect(new Set(mine.map((r) => r.speed))).toEqual(new Set([s.speed]));
      expect(new Set(mine.map((r) => r.inference_geo))).toEqual(new Set([s.geo]));
    }
  });

  it("hygiene: totalCost is the hand figure, not the standard-rate figure", () => {
    // One row: 1000 x 8 + 200 x 40 + 50000 x 0.20 + 5000 x 16 (1h) = $0.106.
    const perRow = (1_000 * 8 + 200 * 40 + 50_000 * 0.2 + 5_000 * 16) / 1e6;
    expect(perRow).toBeCloseTo(0.106, 12);
    const report = buildHygieneReport(store, {});
    expect(report.totalCost).toBeCloseTo(ROWS * perRow * MULT_SUM, 9); // 5.2152
    expect(report.totalCost).not.toBeCloseTo(ROWS * perRow * SESSIONS.length, 3); // standard-rate figure: 3.816
  });

  it("cache-TTL fit: the model's premiums are the sum over its rate groups", () => {
    const fit = computeTtlFitForWindow(store, {});
    expect(fit.byModel).toHaveLength(1);
    const m = fit.byModel[0]!;
    // saved = W1h x (write1h - write5m) = 60,000 x 6 per session, x the multiplier.
    expect(m.savedOnWritesAtShortTtl!).toBeCloseTo(((ROWS * 5_000 * 6) / 1e6) * MULT_SUM, 12); // 1.476
    // extra = recovered reads x (write5m - read) = 11 x 50,000 x 9.8 per session, x the multiplier.
    expect(m.extraCostAtShortTtl!).toBeCloseTo(((11 * 50_000 * 9.8) / 1e6) * MULT_SUM, 12); // 22.099
  });

  it("context carry: each turn is carried at the cache-read rate its request was billed at", () => {
    const carry = computeContextCarryForWindow(store, {});
    // Per session the context is flat at 56,000, so the first turn carries it for all 12 requests.
    const first = (id: string) => carry.turns.find((t) => t.sessionId === id && t.increment === 56_000)!;
    expect(first("std").carryCost).toBeCloseTo((56_000 * 12 * 0.2) / 1e6, 12);
    expect(first("fast").carryCost).toBeCloseTo((56_000 * 12 * 0.4) / 1e6, 12);
    expect(first("us").carryCost).toBeCloseTo((56_000 * 12 * 0.22) / 1e6, 12);
    expect(first("std")).not.toHaveProperty("adjustedCacheReadRate");
    expect(first("fast").adjustedCacheReadRate).toBe(0.4);
    expect(first("us").adjustedCacheReadRate).toBeCloseTo(0.22, 12);
  });
});

// ─── spending / MCP readers ──────────────────────────────────────────────────

describe("spending and MCP readers price fast and US rows (spending and MCP SELECTs)", () => {
  let store: Store;
  /**
   * Three mid-size messages, one per modifier, each calling its own MCP tool;
   * one 1M/1M fast+US message (the outlier the top-prompt list reports); ten
   * tiny messages that keep the outlier an outlier.
   */
  const mid = (tool: string, speed: Msg["speed"], geo: Msg["geo"], at: number): Msg => ({
    at, input: 100_000, output: 100_000, speed, geo, tools: [tool],
  });
  beforeEach(async () => {
    store = new Store(tmp(".db"));
    await seedSession(store, "sp", [
      mid("mcp__std__x", "standard", "global", 0),
      mid("mcp__fast__x", "fast", "global", 1),
      mid("mcp__us__x", "standard", "us", 2),
      { at: 3, input: 1_000_000, output: 1_000_000, speed: "fast", geo: "us", tools: ["mcp__both__x"] },
      ...Array.from({ length: 10 }, (_, i): Msg => ({ at: 10 + i, input: 100, output: 10, speed: "standard", geo: "global" })),
    ]);
  });
  afterEach(() => store.close());

  // 100K in + 100K out on Fable 5.2: 0.8 + 4 = $4.80 at standard.
  const MID = (100_000 * 8 + 100_000 * 40) / 1e6;
  // 1M in + 1M out: 8 + 40 = $48 at standard.
  const BIG = 48;

  it("attributeToolCosts prices each tool's message at its own speed and geo", () => {
    const tools = new Map(attributeToolCosts(store.getSpendingReport({}).topMessages).map((t) => [t.tool, t.estimatedCost]));
    expect(tools.get("mcp__std__x")).toBeCloseTo(MID, 9);
    expect(tools.get("mcp__fast__x")).toBeCloseTo(MID * 2, 9);
    expect(tools.get("mcp__us__x")).toBeCloseTo(MID * 1.1, 9);
    expect(tools.get("mcp__both__x")).toBeCloseTo(BIG * 2.2, 9); // 105.6
  });

  it("aggregateMcpServerUsage (the MCP message SELECT) prices each server's messages likewise", () => {
    const servers = new Map(aggregateMcpServerUsage(store.getMcpMessages({})).map((s) => [s.server, s.estimatedCost]));
    expect(servers.get("std")).toBeCloseTo(MID, 9);
    expect(servers.get("fast")).toBeCloseTo(MID * 2, 9);
    expect(servers.get("us")).toBeCloseTo(MID * 1.1, 9);
    expect(servers.get("both")).toBeCloseTo(BIG * 2.2, 9);
  });

  it("the top-prompt list (spending top messages) prices the outlier at fast x US", () => {
    const d = buildDashboard(store, WINDOW);
    const top = d.spending!.expensivePrompts;
    expect(top).toHaveLength(1);
    expect(top[0]!.totalTokens).toBe(2_000_000);
    expect(top[0]!.estimatedCost).toBeCloseTo(105.6, 2);
  });
});
