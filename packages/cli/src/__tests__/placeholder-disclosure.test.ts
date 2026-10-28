/**
 * Placeholder-output disclosure (R1 / plan A4): the SQL predicate agrees with
 * the TS `isPlaceholderOutput`, and `placeholderOutputShare` is computed from a
 * separate raw read without moving any total. In-memory stores and synthetic
 * fixtures only; no real paths, projects or session ids.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { isPlaceholderOutput } from "@claude-stats/core/hygiene";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { Store } from "../store/index.js";
import { placeholderOutputSql } from "../store/placeholder-sql.js";
import { buildPlaceholderOutputShare, PLACEHOLDER_OUTPUT_NOTE } from "../dashboard/placeholder-share.js";
import { buildDashboard } from "../dashboard/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

// ─── SQL twin agrees with the TS predicate ───────────────────────────────────

const VERSIONS: Array<string | null> = [
  "2.1.99", "2.1.306", "2.1.307", "2.1.308", "2.1.310", "2.1.1000", "2.1.30", "2.1.3070",
  "2.0.9999", "1.9.9", "3.0.0", "2.2.0", "10.0.0",
  null, "", "   ", "garbage", "2.1", "2.1.", "2.1.3.4", ".2.1.300", "2.1..300", "2.1.x", "-2.1.300",
  "v2.1.300", "v2.1.307", "vv2.1.300", " 2.1.300 ", "02.01.0306",
  "2.1.306-beta", "2.1.307-beta.1", "2.1.308-beta", "2.1.307-", "2.1.307-a+b-c", "2.1.307+build",
  "2.1.306+build-x", "2.1.307+", "2.1.306-rc.1+meta", "2.1.300-b!ad", "２.1.300",
];
const SUBAGENT: Array<number | null> = [1, 0, null];
const STOPS: Array<string | null> = [null, "", "end_turn", "tool_use"];

describe("placeholderOutputSql agrees with isPlaceholderOutput", () => {
  const db = new DatabaseSync(":memory:");
  const expr = placeholderOutputSql({ isSubagent: "sub", claudeVersion: "ver", stopReason: "stop" });
  const stmt = db.prepare(`SELECT ${expr} AS f FROM (SELECT ? AS sub, ? AS ver, ? AS stop)`);

  it("matches over versions x subagent x stop reason", () => {
    const disagreements: string[] = [];
    let flagged = 0;
    for (const ver of VERSIONS) {
      for (const sub of SUBAGENT) {
        for (const stop of STOPS) {
          const sql = (stmt.get(sub, ver, stop) as { f: number }).f === 1;
          const ts = isPlaceholderOutput({ isSubagent: sub === 1, claudeVersion: ver, stopReason: stop });
          if (ts) flagged++;
          if (sql !== ts) disagreements.push(`${JSON.stringify({ ver, sub, stop })} sql=${sql} ts=${ts}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
    expect(flagged).toBeGreaterThan(20); // the table is not vacuously all-false
  });

  it("pins the named boundary cases explicitly (numeric, not lexical)", () => {
    const sql = (ver: string | null) => (stmt.get(1, ver, null) as { f: number }).f === 1;
    expect(sql("2.1.99")).toBe(true); // '2.1.99' > '2.1.307' as strings; 99 < 307 numerically
    expect(sql("2.1.306")).toBe(true);
    expect(sql("2.1.307")).toBe(false);
    expect(sql("2.1.1000")).toBe(false);
    expect(sql(null)).toBe(false);
    expect(sql("2.1.306-beta")).toBe(true);
    expect(sql("2.1.307-beta.1")).toBe(true); // a prerelease sorts below its own release
  });
});

// ─── The share, from a synthetic store ───────────────────────────────────────

function session(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 600_000, claudeVersion: "2.1.300",
    entrypoint: "cli", gitBranch: "main", permissionMode: "default",
    isInteractive: false, promptCount: 1, assistantMessageCount: 2,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: true, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...over,
  };
}

function message(uuid: string, sessionId: string, i: number, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: FIXED_NOW + i * 60_000, claudeVersion: "2.1.300",
    model: "claude-sonnet-5", stopReason: null,
    inputTokens: 1_000, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...over,
  };
}

function seed(store: Store, id: string, version: string, opts: { subagent: boolean; stop: string | null; n: number; input?: number }): void {
  store.upsertSession(session(id, { claudeVersion: version, isSubagent: opts.subagent }));
  store.upsertMessages(
    Array.from({ length: opts.n }, (_, i) =>
      message(`${id}-m${i}`, id, i, { claudeVersion: version, stopReason: opts.stop, inputTokens: opts.input ?? 1_000 })),
  );
}

describe("placeholderOutputShare", () => {
  it("is null when the window has no flagged rows", () => {
    const store = new Store(":memory:");
    try {
      seed(store, "s-new", "2.1.307", { subagent: true, stop: "end_turn", n: 3 });
      seed(store, "s-main", "2.1.300", { subagent: false, stop: null, n: 3 });
      expect(buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({}))).toBeNull();
      expect(buildDashboard(store, { period: "all" }).summary.placeholderOutputShare).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports the row share and cost share of flagged rows, with the fixed sentence", () => {
    const store = new Store(":memory:");
    try {
      // 2 flagged rows @ 1000 input tokens, 6 other rows @ 1000 input tokens -> same price per row.
      seed(store, "s-old", "2.1.300", { subagent: true, stop: null, n: 2 });
      seed(store, "s-new", "2.1.307", { subagent: true, stop: "end_turn", n: 2 });
      seed(store, "s-main", "2.1.300", { subagent: false, stop: null, n: 2 });
      seed(store, "s-stop", "2.1.300", { subagent: true, stop: "end_turn", n: 2 });
      const share = buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({}));
      expect(share).not.toBeNull();
      expect(share!.rowShare).toBe(0.25);
      expect(share!.costShare).toBeGreaterThan(0.2);
      expect(share!.costShare).toBeLessThan(0.3);
      expect(share!.note).toBe(PLACEHOLDER_OUTPUT_NOTE);
    } finally {
      store.close();
    }
  });

  it("costShare weights by price, not by row count", () => {
    const store = new Store(":memory:");
    try {
      seed(store, "s-old", "2.1.300", { subagent: true, stop: "", n: 1, input: 1_000 });
      seed(store, "s-big", "2.1.307", { subagent: true, stop: "end_turn", n: 1, input: 9_000 });
      const share = buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({}))!;
      expect(share.rowShare).toBe(0.5);
      expect(share.costShare).toBeCloseTo(0.1, 1);
    } finally {
      store.close();
    }
  });

  it("costShare prices a long-context request at its tier (C2)", () => {
    const store = new Store(":memory:");
    try {
      // Same token total on each side: one flagged Haiku 5.5 request over the
      // 100K threshold (5x tier) vs two unflagged requests under it. Tiered:
      // 5/(5+1). Without the tier both sides price alike: 1/2.
      const haiku = "claude-haiku-5-5";
      store.upsertSession(session("s-old", { isSubagent: true, models: [haiku] }));
      store.upsertMessages([message("s-old-m0", "s-old", 0, { model: haiku, inputTokens: 120_000, outputTokens: 0 })]);
      store.upsertSession(session("s-new", { claudeVersion: "2.1.307", isSubagent: true, models: [haiku] }));
      store.upsertMessages([0, 1].map((i) =>
        message(`s-new-m${i}`, "s-new", i, { claudeVersion: "2.1.307", stopReason: "end_turn", model: haiku, inputTokens: 60_000, outputTokens: 0 })));
      const share = buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({}))!;
      expect(share.rowShare).toBeCloseTo(1 / 3, 4);
      expect(share.costShare).toBeCloseTo(5 / 6, 4);
    } finally {
      store.close();
    }
  });

  it("is scoped to the query window and carries nothing but numbers and the fixed sentence", () => {
    const store = new Store(":memory:");
    try {
      seed(store, "s-secret-id", "2.1.300", { subagent: true, stop: null, n: 2 });
      seed(store, "s-main", "2.1.300", { subagent: false, stop: null, n: 2 });
      const inWindow = buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({ since: FIXED_NOW - 1, until: FIXED_NOW + 3_600_000 }))!;
      expect(inWindow.rowShare).toBe(0.5);
      // A window that ends before the first message holds no rows, so no flagged rows.
      expect(buildPlaceholderOutputShare(store.getPlaceholderOutputTotals({ until: FIXED_NOW - 1_000 }))).toBeNull();
      expect(Object.keys(inWindow).sort()).toEqual(["costShare", "note", "rowShare"]);
      const json = JSON.stringify(inWindow);
      expect(json).not.toContain("secret-id");
      expect(json).not.toContain("/w/alpha");
    } finally {
      store.close();
    }
  });

  it("is a disclosure: the headline totals are identical with and without flagged rows being read", () => {
    const store = new Store(":memory:");
    try {
      seed(store, "s-old", "2.1.300", { subagent: true, stop: null, n: 2 });
      seed(store, "s-main", "2.1.300", { subagent: false, stop: null, n: 2 });
      const before = JSON.stringify(store.getMessageTotals({}));
      const data = buildDashboard(store, { period: "all" });
      expect(JSON.stringify(store.getMessageTotals({}))).toBe(before);
      // Same cost as pricing the unflagged totals directly: the share changed nothing.
      const sumCost = data.byModel.reduce((a, m) => a + m.estimatedCost, 0);
      expect(data.summary.estimatedCost).toBeCloseTo(sumCost, 2);
      expect(data.summary.placeholderOutputShare?.rowShare).toBe(0.5);
    } finally {
      store.close();
    }
  });
});
