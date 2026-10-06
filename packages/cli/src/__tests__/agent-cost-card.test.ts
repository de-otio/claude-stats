/**
 * "Agents & skills" dashboard card (agent-attribution D2).
 *
 * Two halves:
 *  - rendering over a SEEDED report (`renderAgentCostCard` and the full
 *    `renderDashboard`): coverage line first, built-in marker, the
 *    "(unrecorded)" bucket, the empty state, escaping of every agent/skill
 *    name (seeded directly — the identifier validator would reject these at
 *    capture; this proves the escaping, not the validator), no ranking words;
 *  - `attachInsights` populates `data.agentCost` from a real store, over the
 *    same window as the headline, and the totals reconcile.
 *
 * Fixture names: my-reviewer, acme-critic, example-skill (and the built-in
 * `Explore`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { Store } from "../store/index.js";
import { buildDashboard, attachInsights } from "../dashboard/index.js";
import type { DashboardData } from "../dashboard/index.js";
import { renderAgentCostCard } from "../server/agentCostCard.js";
import { renderDashboard, type TranslateFn } from "../server/template.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import type { AgentCostReport } from "@claude-stats/core/agentCost";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { initI18n } from "@claude-stats/core/i18n";

const require = createRequire(import.meta.url);
// Relative into this checkout's own source (see domain-views.test.ts).
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;
const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;

const XSS_TEXT = "<img src=x onerror=alert(1)>";
const XSS_ATTR = '" onmouseover="x';

function report(over: Partial<AgentCostReport> = {}): AgentCostReport {
  return {
    coverage: {
      totalCost: 10,
      mainCost: 6,
      subagentCost: 4,
      mainShare: 0.6,
      subagentShare: 0.4,
      messages: 10,
      mainMessages: 6,
      subagentMessages: 4,
      unpricedMessages: 0,
      knownTypeCost: 3,
      knownTypeShare: 0.75,
      periodGranularity: "day",
      byPeriod: [],
      undatedSubagentCost: 0,
    },
    byAgentType: [
      { agentType: "my-reviewer", builtIn: false, cost: 2, share: 0.5, messages: 2 },
      { agentType: "Explore", builtIn: true, cost: 1, share: 0.25, messages: 1 },
      { agentType: null, builtIn: false, cost: 1, share: 0.25, messages: 1 },
    ],
    bySkill: [{ skill: "example-skill", costDuringRun: 1.5, share: 0.15, messages: 3 }],
    bySpawnDepth: [
      { depth: 1, cost: 3, share: 0.75, messages: 3 },
      { depth: null, cost: 1, share: 0.25, messages: 1 },
    ],
    other: { byAgentType: null, bySkill: null, bySpawnDepth: null },
    ...over,
  };
}

const RANKING_WORDS = /\b(top|waste|wasted|worst|offender|offenders|best|culprit)\b/i;

describe("renderAgentCostCard", () => {
  it("renders nothing for a null/undefined report", () => {
    expect(renderAgentCostCard(null, t, "USD")).toBe("");
    expect(renderAgentCostCard(undefined, t, "USD")).toBe("");
  });

  it("puts the coverage lines before every list", () => {
    const html = renderAgentCostCard(report(), t, "USD");
    const coverageAt = html.indexOf("Subagents account for 40.0% of spend");
    const knownAt = html.indexOf("75.0% of subagent spend has a recorded agent type");
    const typeListAt = html.indexOf("Spend by agent type");
    const skillListAt = html.indexOf("During a skill&#39;s run");
    const depthListAt = html.indexOf("Spend by spawn depth");
    expect(coverageAt).toBeGreaterThan(-1);
    expect(knownAt).toBeGreaterThan(coverageAt);
    for (const listAt of [typeListAt, skillListAt, depthListAt]) {
      expect(listAt).toBeGreaterThan(knownAt);
    }
    expect(html).toContain("$4.00 of $10.00");
  });

  it("marks built-in vs user-named agent types and labels the null bucket (unrecorded)", () => {
    const html = renderAgentCostCard(report(), t, "USD");
    expect(html).toContain("my-reviewer");
    expect(html).toMatch(/Explore<\/td>\s*<td[^>]*>built-in<\/td>/);
    expect(html).toMatch(/my-reviewer<\/td>\s*<td[^>]*>user-named<\/td>/);
    expect(html).toMatch(/\(unrecorded\)<\/td>\s*<td[^>]*>—<\/td>/);
    // Depth list: recorded depth and unrecorded depth.
    expect(html).toContain(">1</td>");
    // Agent-type row (text + title=) and the depth row.
    expect(html.match(/\(unrecorded\)/g)!.length).toBe(3);
  });

  it("lists spend during a skill's run, with the carry caveat", () => {
    const html = renderAgentCostCard(report(), t, "USD");
    expect(html).toContain("example-skill");
    expect(html).toContain("$1.50");
    expect(html).toContain("is not included");
  });

  it("discloses unpriced messages only when there are some", () => {
    const clean = renderAgentCostCard(report(), t, "USD");
    expect(clean).not.toContain("no known rate");

    const r = report();
    const withUnpriced = renderAgentCostCard(
      { ...r, coverage: { ...r.coverage, unpricedMessages: 1234 } },
      t,
      "USD",
    );
    expect(withUnpriced).toContain("1,234 messages use a model with no known rate");
  });

  it("renders the folded remainder rows", () => {
    const html = renderAgentCostCard(
      report({
        other: {
          byAgentType: { buckets: 3, cost: 0.4, share: 0.1, messages: 2 },
          bySkill: { buckets: 2, costDuringRun: 0.2, share: 0.02, messages: 1 },
          bySpawnDepth: { buckets: 1, cost: 0.1, share: 0.025, messages: 1 },
        },
      }),
      t,
      "USD",
    );
    expect(html).toContain("3 more agent types (combined)");
    expect(html).toContain("2 more skills (combined)");
    expect(html).toContain("1 more depths (combined)");
  });

  it("shows an empty state, not the lists, when the period has no subagent spend or skill runs", () => {
    const r = report();
    const html = renderAgentCostCard(
      {
        coverage: { ...r.coverage, subagentCost: 0, subagentShare: 0, subagentMessages: 0, knownTypeCost: 0, knownTypeShare: 0 },
        byAgentType: [],
        bySkill: [],
        bySpawnDepth: [],
        other: { byAgentType: null, bySkill: null, bySpawnDepth: null },
      },
      t,
      "USD",
    );
    expect(html).toContain("Agents &amp; skills");
    expect(html).toContain("No subagent spend or skill runs were recorded in this period.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Subagents account for");
  });

  it("escapes every agent and skill name — text nodes and title attributes", () => {
    const html = renderAgentCostCard(
      report({
        byAgentType: [
          { agentType: XSS_TEXT, builtIn: false, cost: 2, share: 0.5, messages: 2 },
          { agentType: XSS_ATTR, builtIn: false, cost: 1, share: 0.25, messages: 1 },
        ],
        bySkill: [
          { skill: XSS_TEXT, costDuringRun: 1, share: 0.1, messages: 1 },
          { skill: XSS_ATTR, costDuringRun: 1, share: 0.1, messages: 1 },
        ],
      }),
      t,
      "USD",
    );
    expect(html).not.toContain(XSS_TEXT);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(XSS_ATTR);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot; onmouseover=&quot;x");
    // The title= attribute carries the escaped form too.
    expect(html).toContain('title="&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('title="&quot; onmouseover=&quot;x"');
  });

  it("describes without ranking or judging (no ranking words, no good/bad colours)", () => {
    const r = report();
    const html = renderAgentCostCard(
      {
        ...r,
        coverage: { ...r.coverage, unpricedMessages: 2 },
        other: {
          byAgentType: { buckets: 1, cost: 0.1, share: 0.01, messages: 1 },
          bySkill: { buckets: 1, costDuringRun: 0.1, share: 0.01, messages: 1 },
          bySpawnDepth: null,
        },
      },
      t,
      "USD",
    );
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(RANKING_WORDS);
    // The shipped copy itself, not just the rendered sample.
    const strings = JSON.stringify((enDashboard as { agentCost: unknown }).agentCost);
    expect(strings).not.toMatch(RANKING_WORDS);
    // No red/green semantic colouring.
    expect(html).not.toMatch(/#(e15759|59a14f|ff0000|00ff00|c0392b|27ae60)/i);
  });
});

describe("renderDashboard — Agents & skills card placement", () => {
  const withSpending = (over: Partial<DashboardData>): DashboardData => ({ ...goldenDashboard, ...over });

  it("renders in the spending section when data.agentCost is set, and escapes names there too", () => {
    const data = withSpending({
      agentCost: report({
        byAgentType: [{ agentType: XSS_TEXT, builtIn: false, cost: 2, share: 0.5, messages: 2 }],
        bySkill: [{ skill: XSS_ATTR, costDuringRun: 1, share: 0.1, messages: 1 }],
      }),
    });
    expect(data.spending).toBeTruthy();
    const html = renderDashboard(data, t);
    expect(html).toContain("Agents &amp; skills");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(XSS_ATTR);
    // The embedded JSON payload neutralises `<`; the raw tag never appears.
    expect(html).not.toContain(XSS_TEXT);
  });

  it("renders no card when data.agentCost is null or absent (golden payload unchanged)", () => {
    expect(renderDashboard(withSpending({ agentCost: null }), t)).not.toContain("Agents &amp; skills");
    expect(renderDashboard(goldenDashboard, t)).not.toContain("Agents &amp; skills");
  });
});

// ─── attachInsights populates the field from a real store ───────────────────

const T0 = 1_767_571_200_000; // 2026-01-05T00:00:00Z
const MIN = 60_000;
const MODEL = "claude-sonnet-4-6"; // $3/M input, $15/M output
const COST_PER_MESSAGE = 0.1 * 3 + 0.02 * 15; // 100k in + 20k out

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-agentcard-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: T0, lastTimestamp: T0 + 60 * MIN, claudeVersion: "2.1.70",
    entrypoint: "claude", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [MODEL],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: T0, claudeVersion: "2.1.70",
    model: MODEL, stopReason: "end_turn",
    inputTokens: 100_000, outputTokens: 20_000, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

describe("attachInsights — data.agentCost", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(session("main-1"));
    store.upsertSession(session("sub-1", { isSubagent: true, parentSessionId: "main-1", agentType: "my-reviewer", spawnDepth: 1 }));
    store.upsertSession(session("sub-2", { isSubagent: true, parentSessionId: "main-1", agentType: "acme-critic", spawnDepth: 2 }));
    store.upsertMessages([
      message("m1", "main-1", { timestamp: T0 + MIN, skill: "example-skill" }),
      message("m2", "main-1", { timestamp: T0 + 2 * MIN }),
      message("s1", "sub-1", { timestamp: T0 + 3 * MIN }),
      message("s2", "sub-2", { timestamp: T0 + 4 * MIN }),
    ]);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  const opts = { since: "2026-01-01", until: "2026-01-31" };

  it("is populated for the dashboard's own window and its total equals the headline cost", () => {
    const data = attachInsights(store, buildDashboard(store, opts), opts, {} as Config);
    expect(data.agentCost).toBeTruthy();
    const r = data.agentCost!;
    expect(r.coverage.messages).toBe(4);
    expect(r.coverage.subagentMessages).toBe(2);
    expect(r.coverage.subagentCost).toBeCloseTo(2 * COST_PER_MESSAGE, 9);
    expect(r.coverage.totalCost).toBeCloseTo(4 * COST_PER_MESSAGE, 9);
    // Reconciles with the headline for the same period (per-message pricing
    // is linear, so the sums agree up to floating-point rounding).
    expect(r.coverage.totalCost).toBeCloseTo(data.summary.estimatedCost, 6);
    expect(r.byAgentType.map((x) => x.agentType).sort()).toEqual(["acme-critic", "my-reviewer"]);
    expect(r.bySkill.map((x) => x.skill)).toEqual(["example-skill"]);
  });

  it("follows the dashboard's window: a period with no messages gives an empty report", () => {
    const empty = { since: "2025-01-01", until: "2025-01-31" };
    const data = attachInsights(store, buildDashboard(store, empty), empty, {} as Config);
    expect(data.agentCost).toBeTruthy();
    expect(data.agentCost!.coverage.messages).toBe(0);
    expect(data.agentCost!.coverage.totalCost).toBe(0);
    expect(data.summary.estimatedCost).toBe(0);
    const html = renderAgentCostCard(data.agentCost, t, "USD");
    expect(html).toContain("No subagent spend or skill runs were recorded in this period.");
  });

  it("carries no session id or path", () => {
    const data = attachInsights(store, buildDashboard(store, opts), opts, {} as Config);
    const json = JSON.stringify(data.agentCost);
    for (const s of ["main-1", "sub-1", "sub-2", "/w/alpha", "/transcripts"]) {
      expect(json).not.toContain(s);
    }
  });
});
