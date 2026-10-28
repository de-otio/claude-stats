/**
 * Store path for `high-effort-low-output` (#125 PR 3): effort, writer version
 * and the subagent flag must survive `getMessagesForHygiene` and the mapper.
 * Synthetic fixtures only.
 */
import { describe, it, expect } from "vitest";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { Store } from "../store/index.js";
import { buildHygieneReport } from "../hygiene/index.js";

const T0 = 1_767_571_200_000;

function session(id: string, isSubagent: boolean, version: string): SessionRecord {
  return {
    sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: T0, lastTimestamp: T0 + 3_600_000, claudeVersion: version,
    entrypoint: "cli", gitBranch: "main", permissionMode: "default",
    isInteractive: false, promptCount: 1, assistantMessageCount: 25,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-5"],
    repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
    thinkingBlocks: 0, parentSessionId: null, isSubagent, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
  };
}

function messages(id: string, version: string, effort: string | null): MessageRecord[] {
  return Array.from({ length: 25 }, (_, i) => ({
    uuid: `${id}-m${i}`, sessionId: id, timestamp: T0 + i * 60_000, claudeVersion: version,
    model: "claude-sonnet-5", stopReason: "tool_use",
    inputTokens: 1_000, outputTokens: 80, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: ["Bash"], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    ...(effort !== null ? { effort } : {}),
  }));
}

function seeded(id: string, o: { subagent: boolean; version: string; effort: string | null }): Store {
  const store = new Store(":memory:");
  store.upsertSession(session(id, o.subagent, o.version));
  store.upsertMessages(messages(id, o.version, o.effort));
  return store;
}

const findingsFor = (store: Store) =>
  buildHygieneReport(store, {}).digest.active.find((d) => d.detectorId === "high-effort-low-output")?.findings ?? [];

describe("store-backed high-effort-low-output", () => {
  it("fires for an xhigh main-conversation polling session", () => {
    const store = seeded("s-a", { subagent: false, version: "2.1.300", effort: "xhigh" });
    try {
      const f = findingsFor(store);
      expect(f).toHaveLength(1);
      expect(f[0]!.sessionIds).toEqual(["s-a"]);
    } finally { store.close(); }
  });

  it("is silent when effort was not reported", () => {
    const store = seeded("s-b", { subagent: false, version: "2.1.311", effort: null });
    try { expect(findingsFor(store)).toHaveLength(0); } finally { store.close(); }
  });

  it("is silent for a 2.1.306 subagent and fires for the same session on 2.1.307", () => {
    const old = seeded("s-c", { subagent: true, version: "2.1.306", effort: "xhigh" });
    const fixed = seeded("s-d", { subagent: true, version: "2.1.307", effort: "xhigh" });
    try {
      expect(findingsFor(old)).toHaveLength(0);
      expect(findingsFor(fixed)).toHaveLength(1);
    } finally { old.close(); fixed.close(); }
  });

  it("getMessagesForHygiene exposes effort, writer version and subagent flag", () => {
    const store = seeded("s-e", { subagent: true, version: "2.1.309", effort: "high" });
    try {
      const r = store.getMessagesForHygiene({})[0]!;
      expect(r.effort).toBe("high");
      expect(r.claude_version).toBe("2.1.309");
      expect(r.is_subagent).toBe(true);
    } finally { store.close(); }
  });
});
