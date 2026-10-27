/**
 * Placeholder-output flag (R1 / plan item A2): the pure predicate, the
 * detectors that skip flagged rows, and the store path that fills the flag.
 * Fixtures are synthetic; no real paths, projects or session ids.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  isPlaceholderOutput,
  runHygieneDetectors,
  type HygieneMessageRow,
  type PlaceholderOutputInput,
} from "@claude-stats/core/hygiene";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { Store } from "../store/index.js";
import { buildHygieneReport } from "../hygiene/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

const base: PlaceholderOutputInput = { isSubagent: true, claudeVersion: "2.1.300", stopReason: null };

describe("isPlaceholderOutput", () => {
  it("flags a pre-2.1.307 subagent row with no stop reason", () => {
    expect(isPlaceholderOutput(base)).toBe(true);
    expect(isPlaceholderOutput({ ...base, stopReason: "" })).toBe(true);
    expect(isPlaceholderOutput({ ...base, stopReason: undefined })).toBe(true);
  });

  it("version boundary: 2.1.306 flagged; 2.1.307 and 2.1.310 not", () => {
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.306" })).toBe(true);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.307" })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.310" })).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.99" })).toBe(true); // 99 < 307
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.1000" })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.0.9999" })).toBe(true);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "3.0.0" })).toBe(false);
  });

  it("a prerelease of 2.1.307 sorts below it", () => {
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1.307-beta.1" })).toBe(true);
  });

  it("missing or unparseable version is never flagged", () => {
    expect(isPlaceholderOutput({ ...base, claudeVersion: null })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: undefined })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "" })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "banana" })).toBe(false);
    expect(isPlaceholderOutput({ ...base, claudeVersion: "2.1" })).toBe(false);
  });

  it("a row with a real stop reason is not flagged, whatever the version", () => {
    expect(isPlaceholderOutput({ ...base, stopReason: "end_turn" })).toBe(false);
    expect(isPlaceholderOutput({ ...base, stopReason: "tool_use" })).toBe(false);
  });

  it("a non-subagent session is not flagged", () => {
    expect(isPlaceholderOutput({ ...base, isSubagent: false })).toBe(false);
  });
});

// ─── Detector skip (pure) ───────────────────────────────────────────────────

const T0 = 1_767_571_200_000;

function row(sessionId: string, i: number, totalContext: number, outputPlaceholder: boolean): HygieneMessageRow {
  return {
    sessionId, projectPath: "/w/alpha", uuid: `${sessionId}-m${i}`, timestamp: T0 + i * 60_000,
    model: "claude-sonnet-5", inputTokens: totalContext, outputTokens: 3,
    cacheReadTokens: 0, cacheCreationTokens: 0, ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    toolErrorCount: 0, tools: [], outputPlaceholder, effort: null, isSubagent: false, claudeVersion: null,
  };
}

/** Three +30K growth increments: context-bloat's canonical firing shape. */
const growth = (sessionId: string, flagged: boolean) =>
  [10_000, 40_000, 70_000, 100_000].map((c, i) => row(sessionId, i, c, flagged));

const bloatFindings = (rows: HygieneMessageRow[]) =>
  runHygieneDetectors(rows, {}).find((r) => r.detectorId === "context-bloat")!.findings;

describe("context-bloat ignores the placeholder flag (it reads input/cache only)", () => {
  it("output is IDENTICAL with and without the flag on the same fixture", () => {
    const plain = bloatFindings(growth("s-a", false));
    expect(plain).toHaveLength(1);
    expect(bloatFindings(growth("s-a", true))).toEqual(plain);
  });

  it("a mixed flagged/unflagged session does not merge increments across flagged rows", () => {
    // +15K steps with every other row flagged. Filtering the flagged rows out
    // would turn two 15K steps into one 30K step and fire falsely.
    const rows = [10_000, 25_000, 40_000, 55_000, 70_000, 85_000, 100_000].map((c, i) => row("s-mix", i, c, i % 2 === 1));
    expect(bloatFindings(rows)).toHaveLength(0);
    expect(bloatFindings(rows)).toEqual(bloatFindings(rows.map((r) => ({ ...r, outputPlaceholder: false }))));
  });
});

// ─── Store path (fills the flag; stop-reason distribution) ──────────────────

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-placeholder-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 600_000, claudeVersion: "2.1.300",
    entrypoint: "cli", gitBranch: "main", permissionMode: "default",
    isInteractive: false, promptCount: 1, assistantMessageCount: 4,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: true, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, i: number, context: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: FIXED_NOW + i * 60_000, claudeVersion: "2.1.300",
    model: "claude-sonnet-5", stopReason: null,
    inputTokens: context, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...overrides,
  };
}

const CONTEXTS = [10_000, 40_000, 70_000, 100_000];

function seed(store: Store, id: string, version: string, opts: { subagent?: boolean; stopReason?: string | null } = {}): void {
  store.upsertSession(session(id, { claudeVersion: version, isSubagent: opts.subagent ?? true }));
  store.upsertMessages(
    CONTEXTS.map((c, i) => message(`${id}-m${i}`, id, i, c, { claudeVersion: version, stopReason: opts.stopReason ?? null })),
  );
}

const hasBloat = (store: Store) =>
  buildHygieneReport(store, {}).digest.active.some((d) => d.detectorId === "context-bloat" && d.findings.length > 0);

describe("store-backed placeholder flag", () => {
  let dbPath: string;
  let store: Store;
  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("getMessagesForHygiene fills output_placeholder from version, stop reason and subagent status", () => {
    seed(store, "s-old", "2.1.300");
    seed(store, "s-new", "2.1.307");
    seed(store, "s-main", "2.1.300", { subagent: false });
    seed(store, "s-stop", "2.1.300", { stopReason: "end_turn" });
    const by = new Map<string, boolean>();
    for (const r of store.getMessagesForHygiene({})) by.set(r.session_id, r.output_placeholder);
    expect(by.get("s-old")).toBe(true);
    expect(by.get("s-new")).toBe(false);
    expect(by.get("s-main")).toBe(false);
    expect(by.get("s-stop")).toBe(false);
  });

  it("a flagged 2.1.300 subagent session is still measured by context-bloat", () => {
    seed(store, "s-old", "2.1.300");
    expect(hasBloat(store)).toBe(true);
  });

  it("the same fixture written by 2.1.307 gives the same context-bloat result", () => {
    seed(store, "s-new", "2.1.307");
    expect(hasBloat(store)).toBe(true);
  });

  it("stop-reason distribution still counts a message whose session row is absent", () => {
    store.upsertMessages([message("orphan-m0", "s-orphan", 0, 1_000, { stopReason: "end_turn" })]);
    expect(store.getStopReasonCounts(["s-orphan"]).get("end_turn")).toBe(1);
  });

  it("stop-reason distribution excludes placeholder rows with an empty-string stop reason", () => {
    seed(store, "s-old", "2.1.300", { stopReason: "" });
    seed(store, "s-new", "2.1.307", { stopReason: "end_turn" });
    seed(store, "s-main", "2.1.300", { subagent: false, stopReason: "" });
    const counts = store.getStopReasonCounts(["s-old", "s-new", "s-main"]);
    expect(counts.get("end_turn")).toBe(4);
    // Only the non-subagent session's empty-stop rows survive.
    expect(counts.get("")).toBe(4);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(8);
  });
});

describe("output magnitude is not a condition (V5)", () => {
  it("a 50-output-token empty-stop pre-2.1.307 subagent row is flagged in the store path", () => {
    const store = new Store(":memory:");
    try {
      store.upsertSession(session("s-v5"));
      store.upsertMessages(CONTEXTS.map((c, i) => message(`s-v5-m${i}`, "s-v5", i, c, { outputTokens: 50 })));
      expect(store.getMessagesForHygiene({}).every((r) => r.output_placeholder && r.output_tokens === 50)).toBe(true);
    } finally {
      store.close();
    }
  });
});
