/**
 * The domain views' local filters, against a real store
 * (doc/analysis/gui-redesign/02 §2.5, 03 §3.2 phase 4).
 *
 * The one rule that matters here is the filter-symmetry contract: `ticket` and
 * `taskClass` each narrow the SESSION set, and both halves of the dashboard —
 * `getSessions` (session-scoped aggregates) and `buildMessageFilter`
 * (message-scoped tokens and cost) — must apply them. Narrowing one half only is
 * how you get "12 sessions" printed beside a cost covering forty; it is exactly
 * the failure mode this build shipped before, and it is invisible to any test
 * that checks a single number.
 *
 * So every assertion below checks BOTH halves at once: a session-scoped figure
 * (summary.sessions, byProject) and a message-scoped figure (estimatedCost,
 * tokens) for the same filter. A one-sided implementation fails at least one of
 * them no matter which side was forgotten.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

// Frozen clock: every timestamp below is derived from it, so the window this
// test builds is identical on every run and in every timezone.
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

function session(over: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    projectPath: "/repos/project-x",
    sourceFile: `/home/dev/.claude/projects/p/${over.sessionId}.jsonl`,
    firstTimestamp: T0,
    lastTimestamp: T0 + 3_600_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
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
    models: ["claude-sonnet-4-5"],
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
    ...over,
  };
}

function message(sessionId: string, uuid: string, outputTokens: number): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp: T0 + 60_000,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4-5",
    stopReason: "end_turn",
    inputTokens: 1000,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    isTurnStart: 1,
  } as unknown as MessageRecord;
}

describe("local filters narrow both halves of the store filter", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    // A mkdtemp SUBDIRECTORY, never os.tmpdir() itself — a test that cleans up
    // the shared temp root deletes other processes' work.
    dir = mkdtempSync(join(tmpdir(), "cs-local-filters-"));
    store = new Store(join(dir, "store.db"));

    // Three sessions in two projects. s-a is linked to PROJ-1 and classified
    // "debug"; s-b is linked to PROJ-2 and classified "explore"; s-c carries
    // neither, so it must fall out of BOTH narrowings.
    store.upsertSession(session({ sessionId: "s-a", projectPath: "/repos/project-x" }));
    store.upsertSession(session({ sessionId: "s-b", projectPath: "/repos/project-y" }));
    store.upsertSession(session({ sessionId: "s-c", projectPath: "/repos/project-y" }));

    // Distinct output-token counts per session, so a cost that failed to narrow
    // is arithmetically distinguishable from one that did — equal figures would
    // let a one-sided filter pass by coincidence.
    store.upsertMessages([message("s-a", "m-a", 10_000)]);
    store.upsertMessages([message("s-b", "m-b", 20_000)]);
    store.upsertMessages([message("s-c", "m-c", 40_000)]);

    store.addTicketLink({ sessionId: "s-a", ticketKey: "PROJ-1", source: "branch", confidence: "high" });
    store.addTicketLink({ sessionId: "s-b", ticketKey: "PROJ-2", source: "branch", confidence: "high" });

    store.setTaskClass({
      sessionId: "s-a", taskClass: "debug", coarseClass: "diagnose",
      confidence: "high", rule: "test", classifierVersion: 2, classifiedAt: T0,
    });
    store.setTaskClass({
      sessionId: "s-b", taskClass: "explore", coarseClass: "support",
      confidence: "high", rule: "test", classifierVersion: 2, classifiedAt: T0,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = { timezone: "UTC" } as const;

  it("unfiltered, the dashboard sees all three sessions and all their output", () => {
    const all = buildDashboard(store, opts);
    expect(all.summary.sessions).toBe(3);
    expect(all.summary.outputTokens).toBe(70_000);
    expect(all.appliedFilters).toEqual({ projectPath: null, ticket: null, taskClass: null });
  });

  it("a ticket filter narrows the session set AND the token/cost totals", () => {
    const one = buildDashboard(store, { ...opts, ticket: "PROJ-1" });
    // Session half.
    expect(one.summary.sessions).toBe(1);
    expect(one.byProject.map((p) => p.projectPath)).toEqual(["/repos/project-x"]);
    // Message half — the assertion a one-sided implementation fails. With the
    // message filter missing this stays 70,000 while the count above says 1.
    expect(one.summary.outputTokens).toBe(10_000);
    expect(one.appliedFilters).toEqual({ projectPath: null, ticket: "PROJ-1", taskClass: null });
  });

  it("a task-class filter narrows the session set AND the token/cost totals", () => {
    const explore = buildDashboard(store, { ...opts, taskClass: "explore" });
    expect(explore.summary.sessions).toBe(1);
    expect(explore.byProject.map((p) => p.projectPath)).toEqual(["/repos/project-y"]);
    expect(explore.summary.outputTokens).toBe(20_000);
    // The unclassified session is excluded rather than folded in — folding it
    // into a class would fabricate attribution.
    expect(explore.summary.outputTokens).not.toBe(60_000);
  });

  it("Σ byProject reconciles with the headline under every filter — the symmetry invariant", () => {
    for (const filter of [
      {},
      { ticket: "PROJ-1" },
      { taskClass: "debug" },
      { projectPath: "/repos/project-y" },
      { ticket: "PROJ-2", taskClass: "explore" },
    ]) {
      const d = buildDashboard(store, { ...opts, ...filter });
      const summed = d.byProject.reduce((n, p) => n + p.outputTokens, 0);
      expect(summed, `byProject does not sum to the headline under ${JSON.stringify(filter)}`).toBe(
        d.summary.outputTokens,
      );
      expect(d.byProject.length).toBeLessThanOrEqual(d.summary.sessions);
    }
  });

  it("filters compose — ticket AND task class both apply", () => {
    // s-a is PROJ-1 + debug; asking for PROJ-1 + explore must match nothing
    // rather than falling back to either dimension alone.
    const contradiction = buildDashboard(store, { ...opts, ticket: "PROJ-1", taskClass: "explore" });
    expect(contradiction.summary.sessions).toBe(0);
    expect(contradiction.summary.outputTokens).toBe(0);

    const agreeing = buildDashboard(store, { ...opts, ticket: "PROJ-1", taskClass: "debug" });
    expect(agreeing.summary.sessions).toBe(1);
    expect(agreeing.summary.outputTokens).toBe(10_000);
  });

  it("a user's negation wins over the automatic link, on both halves", () => {
    store.addTicketLink({
      sessionId: "s-a", ticketKey: "PROJ-1", source: "user", confidence: "high", negated: true,
    });
    const gone = buildDashboard(store, { ...opts, ticket: "PROJ-1" });
    expect(gone.summary.sessions).toBe(0);
    expect(gone.summary.outputTokens).toBe(0);
  });

  it("echoes the filters it actually applied, so a narrowed figure can state its scope", () => {
    const d = buildDashboard(store, {
      ...opts,
      projectPath: "/repos/project-y",
      ticket: "PROJ-2",
      taskClass: "explore",
    });
    expect(d.appliedFilters).toEqual({
      projectPath: "/repos/project-y",
      ticket: "PROJ-2",
      taskClass: "explore",
    });
    expect(d.summary.sessions).toBe(1);
    expect(d.summary.outputTokens).toBe(20_000);
  });
});
