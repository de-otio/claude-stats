/**
 * Classify end-to-end integration — exercises the exact sequence the extension's
 * applyClassification handler runs (clear all overrides → planApply CRUD →
 * reattribute) against a real temp Store, plus the getClusters composition
 * (clusterProjects → enrichClusters). panel.ts itself is coverage-excluded and
 * imports `vscode`, so this reproduces its host logic through the same primitives.
 *
 * The work cluster is REMOTE, so this also regression-guards the suggested-matcher
 * fix: before it, a remote rule built from the suggestion (`owner + "/*"`) matched
 * nothing and no override was written; the assign assertions below would fail.
 *
 * CONFIDENTIALITY (public repo): account UUIDs use the 00000000- prefix, emails
 * use @example.com, paths use /home/user/…, remotes use gitlab.example.com. No
 * real values from ~/.claude* appear here.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { Store } from "../store/index.js";
import type { SessionRecord } from "@claude-stats/core/types";
import { clusterProjects, enrichClusters, planApply, reattribute } from "../attribution/index.js";
import type { ClassifyAssignment } from "../attribution/classify.js";
import { ACCOUNT_A_UUID, ACCOUNT_B_UUID, ORG_B_UUID, makeSessionRow } from "./fixtures/accounts.js";

const T0 = 1_700_000_000_000;
const clock = (): number => T0;

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `cs-classify-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function seedAccount(store: Store, accountUuid: string, organizationUuid: string | null, email: string): void {
  store.upsertAccount({
    accountUuid, organizationUuid, emailHash: null, emailLabel: email,
    organizationType: null, rateLimitTier: null, userRateLimitTier: null,
    seatTier: null, billingType: null, subscriptionType: null,
    firstObservedAt: T0, lastObservedAt: T0,
  });
}

function seedSession(
  store: Store,
  o: Partial<ReturnType<typeof makeSessionRow>> & { session_id: string },
): void {
  const r = makeSessionRow(o);
  const rec: SessionRecord = {
    sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
    firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp, claudeVersion: r.claude_version,
    entrypoint: r.entrypoint, gitBranch: r.git_branch, permissionMode: null,
    isInteractive: r.is_interactive === 1, promptCount: r.prompt_count,
    assistantMessageCount: r.assistant_message_count, inputTokens: r.input_tokens,
    outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens, webSearchRequests: r.web_search_requests,
    webFetchRequests: r.web_fetch_requests, toolUseCounts: [], models: [], repoUrl: r.repo_url,
    accountUuid: r.account_uuid, organizationUuid: r.organization_uuid, subscriptionType: r.subscription_type,
    thinkingBlocks: r.thinking_blocks, parentSessionId: r.parent_session_id,
    isSubagent: r.is_subagent === 1, sourceDeleted: r.source_deleted === 1,
    throttleEvents: r.throttle_events, activeDurationMs: r.active_duration_ms,
    medianResponseTimeMs: r.median_response_time_ms,
  };
  store.upsertSession(rec);
}

function seedMessage(store: Store, uuid: string, sessionId: string, outputTokens: number): void {
  store.upsertMessages([{
    uuid, sessionId, timestamp: T0, claudeVersion: null, model: "claude-sonnet-4",
    stopReason: null, inputTokens: 1000, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null,
  }]);
}

/** Mirrors panel.ts DashboardPanel.applyClassification's core sequence. */
function applyClassificationCore(store: Store, assignments: ClassifyAssignment[]): void {
  const rules = store.listOwnerRules();
  const plan = planApply(assignments, rules);
  store.clearAllOwnerOverrides();
  for (const id of plan.toDelete) store.deleteOwnerRule(id);
  for (const c of plan.toCreate) {
    store.createOwnerRule({ pathGlob: c.pathGlob, remoteGlob: c.remoteGlob, target: c.target }, clock);
  }
  // dbPath points nowhere so reattribute skips the file backup (temp-litter-free).
  reattribute(store, { force: true, dbPath: `${tmpDbPath()}.nope` }, clock);
}

/** Mirrors getClusters: ranked clusters enriched with current owner + own-rule. */
function loadClusters(store: Store) {
  const sessions = store.getSessions({ includeCI: false });
  const cost = store.getCostBySession(sessions.map((s) => s.session_id));
  const clusters = clusterProjects(
    sessions.map((s) => ({ sessionId: s.session_id, projectPath: s.project_path, repoUrl: s.repo_url ?? null })),
    cost,
  );
  return enrichClusters(clusters, store.listOwnerRules());
}

const WORK_REMOTE = "git@gitlab.example.com:example-group/app.git";
const WORK_OWNER = "gitlab.example.com/example-group";

function setup(store: Store): void {
  seedAccount(store, ACCOUNT_A_UUID, null, "personal@example.com");
  seedAccount(store, ACCOUNT_B_UUID, ORG_B_UUID, "work@example.com");
  // Personal path cluster (cheap), work remote cluster (2 sessions, dearer).
  seedSession(store, { session_id: "personal-1", project_path: "/home/user/personal/notes", repo_url: null, entrypoint: "cli", first_timestamp: T0 + 3_600_000 });
  seedSession(store, { session_id: "work-cli", project_path: "/home/user/work/app", repo_url: WORK_REMOTE, entrypoint: "cli", first_timestamp: T0 + 7_200_000 });
  seedSession(store, { session_id: "work-vscode", project_path: "/home/user/work/app", repo_url: WORK_REMOTE, entrypoint: "claude-vscode", first_timestamp: T0 + 10_800_000 });
  seedMessage(store, "m-personal", "personal-1", 2000);
  seedMessage(store, "m-work-cli", "work-cli", 8000);
  seedMessage(store, "m-work-vscode", "work-vscode", 9000);
}

function bySession(store: Store): Map<string, { account_uuid: string | null; account_source: string | null }> {
  const m = new Map<string, { account_uuid: string | null; account_source: string | null }>();
  for (const s of store.getSessions({ includeCI: true, includeDeleted: true })) {
    m.set(s.session_id, { account_uuid: s.account_uuid ?? null, account_source: s.account_source ?? null });
  }
  return m;
}

describe("classify integration (mirrors panel.ts applyClassification/getClusters)", () => {
  it("ranks clusters by cost and starts unclassified", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      setup(store);
      const clusters = loadClusters(store);
      // work remote cluster (17k out tok) outranks personal (2k).
      expect(clusters[0]!.key).toBe(WORK_OWNER);
      expect(clusters[0]!.kind).toBe("remote");
      expect(clusters[0]!.sessionCount).toBe(2);
      expect(clusters[0]!.suggestedMatcher).toEqual({ remoteGlob: WORK_OWNER });
      expect(clusters.every((c) => c.currentTarget === null)).toBe(true);
      expect(clusters.every((c) => c.ownRuleId === null)).toBe(true);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("assigning a remote cluster to an account overrides BOTH its sessions (cli + vscode)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      setup(store);
      const clusters = loadClusters(store);
      const work = clusters.find((c) => c.key === WORK_OWNER)!;

      applyClassificationCore(store, [
        { suggestedMatcher: work.suggestedMatcher, target: { kind: "account", accountUuid: ACCOUNT_B_UUID } },
      ]);

      const rows = bySession(store);
      // Both work sessions billed to B via override — including the vscode
      // session that CLI-timeline inference could never attribute.
      expect(rows.get("work-cli")).toEqual({ account_uuid: ACCOUNT_B_UUID, account_source: "override" });
      expect(rows.get("work-vscode")).toEqual({ account_uuid: ACCOUNT_B_UUID, account_source: "override" });
      // Personal untouched by the work rule.
      expect(rows.get("personal-1")!.account_source).not.toBe("override");

      // getClusters now reflects the assignment.
      const after = loadClusters(store);
      const workAfter = after.find((c) => c.key === WORK_OWNER)!;
      expect(workAfter.currentTarget).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
      expect(workAfter.ownRuleId).not.toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("reassigning account → split clears the stale override (revert works)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      setup(store);
      const work = loadClusters(store).find((c) => c.key === WORK_OWNER)!;
      applyClassificationCore(store, [
        { suggestedMatcher: work.suggestedMatcher, target: { kind: "account", accountUuid: ACCOUNT_B_UUID } },
      ]);
      expect(bySession(store).get("work-cli")!.account_source).toBe("override");

      // Switch to split — must drop the override, not leave it stuck at B.
      applyClassificationCore(store, [
        { suggestedMatcher: work.suggestedMatcher, target: { kind: "split" } },
      ]);

      const rows = bySession(store);
      expect(rows.get("work-cli")!.account_source).not.toBe("override");
      expect(rows.get("work-vscode")!.account_source).not.toBe("override");
      // A split rule exists; getClusters shows split as the current target.
      const workAfter = loadClusters(store).find((c) => c.key === WORK_OWNER)!;
      expect(workAfter.currentTarget).toEqual({ kind: "split" });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("unassigning removes the rule and clears the override", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      setup(store);
      const work = loadClusters(store).find((c) => c.key === WORK_OWNER)!;
      applyClassificationCore(store, [
        { suggestedMatcher: work.suggestedMatcher, target: { kind: "account", accountUuid: ACCOUNT_B_UUID } },
      ]);
      applyClassificationCore(store, [
        { suggestedMatcher: work.suggestedMatcher, target: null },
      ]);

      expect(store.listOwnerRules()).toHaveLength(0);
      const rows = bySession(store);
      expect(rows.get("work-cli")!.account_source).not.toBe("override");
      expect(rows.get("work-vscode")!.account_source).not.toBe("override");
      const workAfter = loadClusters(store).find((c) => c.key === WORK_OWNER)!;
      expect(workAfter.currentTarget).toBeNull();
      expect(workAfter.ownRuleId).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});
