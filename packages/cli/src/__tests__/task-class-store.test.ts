/**
 * Schema V21 storage seam and the classify pass.
 *
 * The properties under test are the ones a rule change depends on: that the
 * migration is idempotent and lands on an existing V20 database without a
 * re-parse, that the version stamp really does drive invalidation, and that the
 * pass is resumable. If invalidation is broken, a rule change silently leaves
 * half the corpus classified by the old rules — which would show up in a
 * before/after report as a workload shift, the exact confound the per-class
 * design exists to remove.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store/index.js";
import { runTaskClassPass } from "../task-class/index.js";
import { TASK_CLASS_VERSION } from "@claude-stats/core/taskClass";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { FIXED_NOW, frozenClock } from "./fixtures/synthetic.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-taskclass-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 60_000, claudeVersion: "2.1.70",
    entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-opus-4-6"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
  };
}

function message(
  uuid: string, sessionId: string, tools: string[], filePaths: string[], toolErrorCount = 0,
): MessageRecord {
  return {
    uuid, sessionId, timestamp: FIXED_NOW, claudeVersion: "2.1.70",
    model: "claude-opus-4-6", stopReason: "end_turn",
    inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools, filePaths, thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount,
  };
}

describe("schema V21 migration", () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpDb(); });
  afterEach(() => { try { fs.unlinkSync(dbPath); } catch { /* best effort */ } });

  it("creates the table on a fresh database and reports version 21", () => {
    const store = new Store(dbPath);
    store.close();
    const raw = new DatabaseSync(dbPath);
    const { value } = raw.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value: string };
    expect(value).toBe("21");
    const tbl = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_task_class'").get();
    expect(tbl).toBeDefined();
    raw.close();
  });

  it("upgrades an existing V20 database without touching its rows", () => {
    const store = new Store(dbPath);
    store.upsertSession(session("s1"));
    store.upsertMessages([message("s1-m0", "s1", ["Read"], [])]);
    store.close();

    // Rewind to V20 and re-open: the ladder must run V21 only.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE metadata SET value='20' WHERE key='schema_version'").run();
    raw.exec("DROP TABLE session_task_class");
    raw.close();

    const upgraded = new Store(dbPath);
    expect(upgraded.getSessions({ includeCI: true, includeDeleted: true })).toHaveLength(1);
    expect(upgraded.getSessionMessages("s1")).toHaveLength(1);
    expect(upgraded.getTaskClassCounts().unclassified).toBe(1);
    upgraded.close();
  });

  it("is idempotent — re-opening twice does not throw or duplicate", () => {
    const a = new Store(dbPath); a.close();
    const b = new Store(dbPath); b.close();
    const c = new Store(dbPath);
    expect(c.getTaskClassVersions()).toEqual([]);
    c.close();
  });
});

describe("task-class storage seam", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(session("s1"));
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("round-trips a classification", () => {
    store.setTaskClass({
      sessionId: "s1", taskClass: "debug", coarseClass: "diagnose", confidence: "high",
      rule: "diagnosis", abstainReason: null, classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    const row = store.getTaskClass("s1");
    expect(row).toMatchObject({
      task_class: "debug", coarse_class: "diagnose", confidence: "high",
      rule: "diagnosis", abstain_reason: null, classifier_version: 1,
    });
  });

  it("re-classification overwrites rather than duplicating", () => {
    store.setTaskClass({
      sessionId: "s1", taskClass: "explore", coarseClass: "support", confidence: "medium",
      rule: "non-mutating", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    store.setTaskClass({
      sessionId: "s1", taskClass: "debug", coarseClass: "diagnose", confidence: "high",
      rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW + 1,
    });
    expect(store.getTaskClass("s1")!.task_class).toBe("debug");
    expect(store.getTaskClassVersions()).toEqual([{ classifier_version: 2, n: 1 }]);
  });

  it("returns null for a session that was never classified", () => {
    expect(store.getTaskClass("s1")).toBeNull();
  });

  it("selects stale rows for reclassification when the version moves", () => {
    store.setTaskClass({
      sessionId: "s1", taskClass: "explore", coarseClass: "support", confidence: "medium",
      rule: "non-mutating", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    expect(store.getSessionIdsNeedingTaskClass(1)).toEqual([]);
    // A rule change bumps the version — the row is now stale.
    expect(store.getSessionIdsNeedingTaskClass(2)).toEqual(["s1"]);
  });

  it("reports a mixed-version store, so a report can refuse to quote a delta", () => {
    store.upsertSession(session("s2"));
    store.setTaskClass({
      sessionId: "s1", taskClass: "explore", coarseClass: "support", confidence: "medium",
      rule: "non-mutating", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    store.setTaskClass({
      sessionId: "s2", taskClass: "debug", coarseClass: "diagnose", confidence: "medium",
      rule: "diagnosis", classifierVersion: 2, classifiedAt: FIXED_NOW,
    });
    expect(store.getTaskClassVersions()).toEqual([
      { classifier_version: 1, n: 1 },
      { classifier_version: 2, n: 1 },
    ]);
  });

  it("counts classes at both grains and publishes the unclassified denominator", () => {
    store.upsertSession(session("s2"));
    store.upsertSession(session("s3"));
    store.setTaskClass({
      sessionId: "s1", taskClass: "debug", coarseClass: "diagnose", confidence: "medium",
      rule: "diagnosis", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    store.setTaskClass({
      sessionId: "s2", taskClass: "unknown", coarseClass: "build", confidence: "low",
      rule: "below-threshold", abstainReason: "below-threshold", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    const counts = store.getTaskClassCounts();
    expect(counts.fine).toEqual([
      { task_class: "debug", n: 1 },
      { task_class: "unknown", n: 1 },
    ]);
    expect(counts.coarse).toEqual([
      { coarse_class: "build", n: 1 },
      { coarse_class: "diagnose", n: 1 },
    ]);
    expect(counts.abstain).toEqual([{ abstain_reason: "below-threshold", n: 1 }]);
    // s3 was never classified — the denominator must say so.
    expect(counts.unclassified).toBe(1);
  });

  it("carries the confidence tier through the seam, not just the class count", () => {
    // Spec §5.7 gives every classification a tier and §5.10 forbids quoting a
    // per-class figure without one. A seam returning only class totals left
    // every downstream surface unable to show the tier even if it wanted to.
    store.upsertSession(session("s2"));
    store.upsertSession(session("s3"));
    store.setTaskClass({
      sessionId: "s1", taskClass: "debug", coarseClass: "diagnose", confidence: "high",
      rule: "diagnosis", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    store.setTaskClass({
      sessionId: "s2", taskClass: "debug", coarseClass: "diagnose", confidence: "medium",
      rule: "diagnosis", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    store.setTaskClass({
      sessionId: "s3", taskClass: "unknown", coarseClass: "build", confidence: "low",
      rule: "below-threshold", abstainReason: "below-threshold", classifierVersion: 1, classifiedAt: FIXED_NOW,
    });
    expect(store.getTaskClassCounts().byConfidence).toEqual([
      { task_class: "debug", confidence: "high", n: 1 },
      { task_class: "debug", confidence: "medium", n: 1 },
      { task_class: "unknown", confidence: "low", n: 1 },
    ]);
  });
});

describe("the classify pass", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    // A read-only session, a write-heavy one, and one with no messages at all.
    store.upsertSession(session("s-explore"));
    store.upsertMessages([
      message("e0", "s-explore", ["Read", "Read"], ["/w/alpha/a.ts", "/w/alpha/b.ts"]),
      message("e1", "s-explore", ["Grep", "Read"], ["/w/alpha/c.ts"]),
    ]);
    store.upsertSession(session("s-greenfield"));
    store.upsertMessages([
      message("g0", "s-greenfield", ["Write", "Write"], ["/w/alpha/n1.ts", "/w/alpha/n2.ts"]),
      message("g1", "s-greenfield", ["Write", "Bash"], ["/w/alpha/n3.ts"]),
    ]);
    store.upsertSession(session("s-empty"));
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("classifies every session, including one with no messages", () => {
    const r = runTaskClassPass(store, { now: frozenClock() });
    expect(r.classified).toBe(3);
    expect(r.remaining).toBe(0);
    expect(r.version).toBe(TASK_CLASS_VERSION);
    expect(store.getTaskClass("s-explore")!.task_class).toBe("explore");
    expect(store.getTaskClass("s-greenfield")!.task_class).toBe("greenfield");
    // Absent, not omitted: "unclassified" must mean one thing only.
    expect(store.getTaskClass("s-empty")).toMatchObject({
      task_class: "unknown", abstain_reason: "sparse",
    });
    expect(store.getTaskClassCounts().unclassified).toBe(0);
  });

  it("is idempotent — a second run at the same version does no work", () => {
    runTaskClassPass(store, { now: frozenClock() });
    const second = runTaskClassPass(store, { now: frozenClock() });
    expect(second.classified).toBe(0);
    expect(second.alreadyCurrent).toBe(3);
  });

  it("is resumable — a bounded run leaves the rest for the next one", () => {
    const first = runTaskClassPass(store, { now: frozenClock(), limit: 2 });
    expect(first.classified).toBe(2);
    expect(first.remaining).toBe(1);
    const second = runTaskClassPass(store, { now: frozenClock() });
    expect(second.classified).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it("uses the injected clock — never the wall clock", () => {
    runTaskClassPass(store, { now: frozenClock() });
    expect(store.getTaskClass("s-explore")!.classified_at).toBe(FIXED_NOW);
  });

  it("reclassifies exactly the stale rows after a version bump", () => {
    runTaskClassPass(store, { now: frozenClock() });
    // Simulate a rule change by ageing one row.
    store.setTaskClass({
      sessionId: "s-explore", taskClass: "explore", coarseClass: "support", confidence: "medium",
      rule: "non-mutating", classifierVersion: TASK_CLASS_VERSION - 1, classifiedAt: FIXED_NOW,
    });
    const r = runTaskClassPass(store, { now: frozenClock(FIXED_NOW + 5) });
    expect(r.classified).toBe(1);
    expect(store.getTaskClass("s-explore")!.classifier_version).toBe(TASK_CLASS_VERSION);
    expect(store.getTaskClass("s-explore")!.classified_at).toBe(FIXED_NOW + 5);
    // The already-current rows were not rewritten.
    expect(store.getTaskClass("s-greenfield")!.classified_at).toBe(FIXED_NOW);
  });

  it("survives a corrupt tools column instead of aborting the whole pass", () => {
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE messages SET tools = '{not json' WHERE session_id = 's-explore'").run();
    raw.close();
    const reopened = new Store(dbPath);
    try {
      expect(() => runTaskClassPass(reopened, { now: frozenClock() })).not.toThrow();
      // No tool evidence → sparse, which is the honest answer, not a crash.
      expect(reopened.getTaskClass("s-explore")!.abstain_reason).toBe("sparse");
      expect(reopened.getTaskClass("s-greenfield")!.task_class).toBe("greenfield");
    } finally {
      reopened.close();
    }
  });

  // `messages.tools` is NOT NULL, so a SQL NULL is not a reachable state — the
  // `!raw` guard in the parser is a type-level defence only. These are the
  // corruption shapes that ARE reachable.
  it.each([
    ["valid JSON that is not an array", '{"tool":"Read"}'],
    ["an array of non-strings", "[1, 2, {}]"],
    ["an empty string", ""],
  ])("treats %s in the tools column as no tool evidence", (_label, value) => {
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE messages SET tools = ? WHERE session_id = 's-explore'").run(value);
    raw.close();
    const reopened = new Store(dbPath);
    try {
      expect(() => runTaskClassPass(reopened, { now: frozenClock() })).not.toThrow();
      expect(reopened.getTaskClass("s-explore")!.abstain_reason).toBe("sparse");
    } finally {
      reopened.close();
    }
  });

  it("defaults to the wall clock when no clock is injected", () => {
    // The pass must still work in production, where nothing injects a clock;
    // the frozen-clock tests above would pass even if the default were broken.
    const t0 = Date.now();
    runTaskClassPass(store);
    const at = store.getTaskClass("s-explore")!.classified_at;
    expect(at).toBeGreaterThanOrEqual(t0);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("ignores a non-positive limit rather than classifying nothing", () => {
    // `--limit 0` reaching the pass must not silently become "do no work" —
    // a resumable command that quietly no-ops is worse than one that errors.
    const r = runTaskClassPass(store, { now: frozenClock(), limit: 0 });
    expect(r.classified).toBe(3);
  });
});

/**
 * The `messages.file_paths` round-trip.
 *
 * The three sessions above are all classified by tool-name evidence alone —
 * `explore` needs no paths, `greenfield` keys only on `Write` counts, `sparse`
 * has no messages. So every assertion above would still pass if the path column
 * never reached the classifier at all, and the two classes that depend entirely
 * on it (`config-chore` via the §5.6 path rule, `refactor-multi-file` via the
 * distinct edited-file count) would silently collapse to
 * `unknown` / `below-threshold` with nothing failing.
 *
 * These two pin the column end to end: JSON-encoded on the way in, parsed back
 * on the way out, and reduced to `editedFiles` / `configFiles` by the pass.
 */
describe("the classify pass — file_paths must survive the store", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    // Config dominance: 3 of 3 edited paths are config by the path rule.
    store.upsertSession(session("s-config"));
    store.upsertMessages([
      message("c0", "s-config", ["Read", "Edit"], ["/w/alpha/package.json"]),
      message("c1", "s-config", ["Edit"], ["/w/alpha/tsconfig.json"]),
      message("c2", "s-config", ["Edit"], ["/w/alpha/.github/workflows/ci.yml"]),
      message("c3", "s-config", ["Bash"], []),
    ]);
    // A broad sweep: 5 distinct edited code paths, 6 edit calls.
    store.upsertSession(session("s-sweep"));
    store.upsertMessages([
      message("r0", "s-sweep", ["Edit", "Edit"], ["/w/alpha/a.ts", "/w/alpha/b.ts"]),
      message("r1", "s-sweep", ["Edit", "Edit"], ["/w/alpha/c.ts", "/w/alpha/d.ts"]),
      message("r2", "s-sweep", ["Edit", "Edit"], ["/w/alpha/e.ts", "/w/alpha/a.ts"]),
    ]);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it("recovers a config chore whose class depends only on the path column", () => {
    runTaskClassPass(store, { now: frozenClock() });
    expect(store.getTaskClass("s-config")).toMatchObject({
      task_class: "config-chore",
      coarse_class: "build",
      rule: "config-dominant",
      abstain_reason: null,
    });
  });

  it("recovers a multi-file sweep whose class depends on the DISTINCT path count", () => {
    runTaskClassPass(store, { now: frozenClock() });
    expect(store.getTaskClass("s-sweep")).toMatchObject({
      task_class: "refactor-multi-file",
      coarse_class: "build",
      rule: "multi-file-sweep",
      abstain_reason: null,
    });
  });

  it("a Bash cwd stored in file_paths never becomes an edited file", () => {
    // The parser writes the Bash tool's `input.cwd` into the SAME column as
    // real file arguments, so this has to hold after the JSON round-trip too:
    // three edited files plus a repeated cwd was four, which crossed
    // REFACTOR_MIN_FILES and reported a focused change as a sweep.
    store.upsertSession(session("s-cwd"));
    store.upsertMessages([
      message("w0", "s-cwd", ["Edit", "Bash"], ["/w/alpha/src/x.ts", "/w/alpha"]),
      message("w1", "s-cwd", ["Edit", "Bash"], ["/w/alpha/src/y.ts", "/w/alpha"]),
      message("w2", "s-cwd", ["Edit", "Edit", "Bash"], ["/w/alpha/src/z.ts", "/w/alpha"]),
      message("w3", "s-cwd", ["Edit"], ["/w/alpha/src/x.ts"]),
    ]);
    runTaskClassPass(store, { now: frozenClock() });
    expect(store.getTaskClass("s-cwd")).toMatchObject({
      task_class: "unknown",
      abstain_reason: "below-threshold",
      coarse_class: "build",
    });
  });

  it("re-editing one file through the store is not a sweep", () => {
    // The distinct-path reduction has to happen after the JSON round-trip too,
    // not only on hand-built message objects.
    store.upsertSession(session("s-narrow"));
    store.upsertMessages([
      message("n0", "s-narrow", ["Edit", "Edit"], ["/w/alpha/a.ts"]),
      message("n1", "s-narrow", ["Edit", "Edit"], ["/w/alpha/a.ts"]),
      message("n2", "s-narrow", ["Edit", "Edit"], ["/w/alpha/a.ts"]),
    ]);
    runTaskClassPass(store, { now: frozenClock() });
    expect(store.getTaskClass("s-narrow")).toMatchObject({
      task_class: "unknown",
      abstain_reason: "below-threshold",
      coarse_class: "build",
    });
  });
});
