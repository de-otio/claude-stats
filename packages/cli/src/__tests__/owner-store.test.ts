/**
 * Tests for cost-ownership store methods (Unit C, Phase 2).
 *
 * Covers: createOwnerRule, listOwnerRules, deleteOwnerRule,
 * applyOwnerOverride, clearOverridesForRule, getCostBySession.
 *
 * CONFIDENTIALITY (public repo): all account UUIDs use the 00000000- prefix;
 * all emails use @example.com; all paths use /home/user/…; git remotes use
 * github.com/example-org or gitlab.example.com. No real values appear.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { Store } from "../store/index.js";
import type { SessionRecord } from "@claude-stats/core/types";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  PERSONAL_PATH_GLOB,
  WORK_PATH_GLOB,
  PERSONAL_REMOTE_GLOB,
  WORK_REMOTE_GLOB,
  makeOwnerRule,
  makeSessionRow,
} from "./fixtures/accounts.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns a fresh temp DB path for each test. */
function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `cs-owner-store-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Fixed-clock factory: always returns the same epoch-ms. */
function fixedClock(ms: number): () => number {
  return () => ms;
}

const T0 = 1_700_000_000_000;

/**
 * Insert a minimal session row via upsertSession. Uses makeSessionRow for
 * defaults; extra fields can be overridden.
 */
function seedSession(
  store: Store,
  overrides: Partial<ReturnType<typeof makeSessionRow>> & { session_id: string },
): void {
  const r = makeSessionRow(overrides);
  const rec: SessionRecord = {
    sessionId: r.session_id,
    projectPath: r.project_path,
    sourceFile: r.source_file,
    firstTimestamp: r.first_timestamp,
    lastTimestamp: r.last_timestamp,
    claudeVersion: r.claude_version,
    entrypoint: r.entrypoint,
    gitBranch: r.git_branch,
    permissionMode: null,
    isInteractive: r.is_interactive === 1,
    promptCount: r.prompt_count,
    assistantMessageCount: r.assistant_message_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    webSearchRequests: r.web_search_requests,
    webFetchRequests: r.web_fetch_requests,
    toolUseCounts: [],
    models: [],
    repoUrl: r.repo_url,
    accountUuid: r.account_uuid,
    organizationUuid: r.organization_uuid,
    subscriptionType: r.subscription_type,
    thinkingBlocks: r.thinking_blocks,
    parentSessionId: r.parent_session_id,
    isSubagent: r.is_subagent === 1,
    sourceDeleted: r.source_deleted === 1,
    throttleEvents: r.throttle_events,
    activeDurationMs: r.active_duration_ms,
    medianResponseTimeMs: r.median_response_time_ms,
  };
  store.upsertSession(rec);
}

/** Insert a message with a known model and token counts (for getCostBySession). */
function seedMessage(
  store: Store,
  uuid: string,
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  store.upsertMessages([
    {
      uuid,
      sessionId,
      timestamp: T0,
      claudeVersion: null,
      model,
      stopReason: null,
      inputTokens,
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
    },
  ]);
}

// ── createOwnerRule / listOwnerRules / deleteOwnerRule ────────────────────────

describe("createOwnerRule + listOwnerRules + deleteOwnerRule", () => {
  it("roundtrip: create with path glob, list, delete", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Seed the target account so the existence check passes
      store.upsertAccount({
        accountUuid: ACCOUNT_A_UUID,
        organizationUuid: ORG_A_UUID,
        emailHash: null,
        emailLabel: "a@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      expect(store.listOwnerRules()).toHaveLength(0);

      const rule = store.createOwnerRule(
        { pathGlob: PERSONAL_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0),
      );

      expect(rule.id).toBeGreaterThan(0);
      expect(rule.pathGlob).toBe(PERSONAL_PATH_GLOB);
      expect(rule.remoteGlob).toBeNull();
      expect(rule.target).toEqual({ kind: "account", accountUuid: ACCOUNT_A_UUID });
      expect(rule.createdAt).toBe(T0);

      const listed = store.listOwnerRules();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(rule);

      store.deleteOwnerRule(rule.id);
      expect(store.listOwnerRules()).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("roundtrip: create with remote glob and split target", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      const rule = store.createOwnerRule(
        { pathGlob: null, remoteGlob: PERSONAL_REMOTE_GLOB, target: { kind: "split" } },
        fixedClock(T0),
      );

      expect(rule.remoteGlob).toBe(PERSONAL_REMOTE_GLOB);
      expect(rule.pathGlob).toBeNull();
      expect(rule.target).toEqual({ kind: "split" });

      const listed = store.listOwnerRules();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.target).toEqual({ kind: "split" });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("roundtrip: create with both path and remote globs", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      const rule = store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: WORK_REMOTE_GLOB, target: { kind: "split" } },
        fixedClock(T0 + 1000),
      );

      expect(rule.pathGlob).toBe(WORK_PATH_GLOB);
      expect(rule.remoteGlob).toBe(WORK_REMOTE_GLOB);
      expect(rule.createdAt).toBe(T0 + 1000);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("listOwnerRules returns rules in created_at ASC order", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0 + 2000),
      );
      store.createOwnerRule(
        { pathGlob: PERSONAL_PATH_GLOB, remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0 + 1000),
      );

      const rules = store.listOwnerRules();
      expect(rules).toHaveLength(2);
      // Earlier createdAt comes first
      expect(rules[0]!.createdAt).toBe(T0 + 1000);
      expect(rules[1]!.createdAt).toBe(T0 + 2000);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("deleteOwnerRule is a no-op for a non-existent id", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Should not throw
      store.deleteOwnerRule(9999);
      expect(store.listOwnerRules()).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── createOwnerRule validation ────────────────────────────────────────────────

describe("createOwnerRule validation", () => {
  it("rejects when both pathGlob and remoteGlob are null", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(() =>
        store.createOwnerRule(
          { pathGlob: null, remoteGlob: null, target: { kind: "split" } },
          fixedClock(T0),
        ),
      ).toThrow(/at least one/i);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("rejects an all-wildcard pathGlob (only * and /)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      for (const glob of ["*", "**", "**/**", "/**/**", "/*"]) {
        expect(() =>
          store.createOwnerRule(
            { pathGlob: glob, remoteGlob: null, target: { kind: "split" } },
            fixedClock(T0),
          ),
        ).toThrow(/pathGlob.*too broad|only wildcards/i);
      }
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("rejects an all-wildcard remoteGlob", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(() =>
        store.createOwnerRule(
          { pathGlob: null, remoteGlob: "**/**", target: { kind: "split" } },
          fixedClock(T0),
        ),
      ).toThrow(/remoteGlob.*too broad|only wildcards/i);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("accepts a glob that has non-wildcard chars alongside wildcards", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // These should NOT be rejected: they have actual path segments
      const rule = store.createOwnerRule(
        { pathGlob: "/home/user/**", remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0),
      );
      expect(rule.pathGlob).toBe("/home/user/**");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("rejects an account target with a bad UUID format", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(() =>
        store.createOwnerRule(
          {
            pathGlob: PERSONAL_PATH_GLOB,
            remoteGlob: null,
            target: { kind: "account", accountUuid: "not-a-valid-uuid!!!" },
          },
          fixedClock(T0),
        ),
      ).toThrow(/accountUuid.*format|UUID format/i);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("rejects an account target whose UUID does not exist in the accounts table", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // ACCOUNT_A_UUID is a valid format but NOT seeded into accounts
      expect(() =>
        store.createOwnerRule(
          {
            pathGlob: PERSONAL_PATH_GLOB,
            remoteGlob: null,
            target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
          },
          fixedClock(T0),
        ),
      ).toThrow(/does not exist in the accounts table/i);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("enforces the 200-rule cap", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Insert 200 rules with split target (no account needed)
      for (let i = 0; i < 200; i++) {
        store.createOwnerRule(
          { pathGlob: `/home/user/project-${i}/**`, remoteGlob: null, target: { kind: "split" } },
          fixedClock(T0 + i),
        );
      }
      // The 201st should be rejected
      expect(() =>
        store.createOwnerRule(
          { pathGlob: "/home/user/project-extra/**", remoteGlob: null, target: { kind: "split" } },
          fixedClock(T0 + 200),
        ),
      ).toThrow(/limit of 200|cap/i);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── applyOwnerOverride ────────────────────────────────────────────────────────

describe("applyOwnerOverride", () => {
  it("writes override UNCONDITIONALLY over a pre-existing otel-source row", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Seed account B with an org so COALESCE can fill it
      store.upsertAccount({
        accountUuid: ACCOUNT_B_UUID,
        organizationUuid: ORG_A_UUID,
        emailHash: null,
        emailLabel: "b@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      seedSession(store, {
        session_id: "s1",
        entrypoint: "cli",
        first_timestamp: T0,
        project_path: "/home/user/work/proj",
      });

      // Pre-attribute with otel/authoritative
      store.applyAttribution(
        new Map([
          ["s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      let rows = store.getSessions({ includeCI: true, includeDeleted: true });
      expect(rows.find((s) => s.session_id === "s1")!.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(rows.find((s) => s.session_id === "s1")!.account_source).toBe("otel");

      // applyOwnerOverride is unconditional — overrides otel
      const changed = store.applyOwnerOverride(
        new Map([["s1", ACCOUNT_B_UUID]]),
        fixedClock(T0 + 1000),
      );
      expect(changed).toBe(1);

      rows = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = rows.find((s) => s.session_id === "s1")!;
      expect(row.account_uuid).toBe(ACCOUNT_B_UUID);
      expect(row.account_source).toBe("override");
      expect(row.account_confidence).toBe("authoritative");
      // COALESCE should fill organization_uuid from ACCOUNT_B's account row
      expect(row.organization_uuid).toBe(ORG_A_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("COALESCEs organization_uuid from accounts (never nulls an existing org)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Seed ACCOUNT_A with org
      store.upsertAccount({
        accountUuid: ACCOUNT_A_UUID,
        organizationUuid: ORG_A_UUID,
        emailHash: null,
        emailLabel: "a@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      seedSession(store, {
        session_id: "s2",
        entrypoint: "cli",
        first_timestamp: T0,
        project_path: "/home/user/personal/proj",
      });

      store.applyOwnerOverride(
        new Map([["s2", ACCOUNT_A_UUID]]),
        fixedClock(T0),
      );

      const row = store.getSessions({ includeCI: true, includeDeleted: true })
        .find((s) => s.session_id === "s2")!;
      expect(row.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(row.organization_uuid).toBe(ORG_A_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("returns 0 for an empty mapping", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(store.applyOwnerOverride(new Map(), fixedClock(T0))).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("handles a session that does not exist (no rows changed, no error)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      const changed = store.applyOwnerOverride(
        new Map([["nonexistent-session-id", ACCOUNT_A_UUID]]),
        fixedClock(T0),
      );
      expect(changed).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("applies override atomically (multiple sessions in one transaction)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.upsertAccount({
        accountUuid: ACCOUNT_B_UUID,
        organizationUuid: null,
        emailHash: null,
        emailLabel: "b@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      seedSession(store, { session_id: "sa", first_timestamp: T0, project_path: "/home/user/work/a" });
      seedSession(store, { session_id: "sb", first_timestamp: T0 + 100, project_path: "/home/user/work/b" });

      const changed = store.applyOwnerOverride(
        new Map([["sa", ACCOUNT_B_UUID], ["sb", ACCOUNT_B_UUID]]),
        fixedClock(T0 + 500),
      );
      expect(changed).toBe(2);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      for (const id of ["sa", "sb"]) {
        const r = sessions.find((s) => s.session_id === id)!;
        expect(r.account_uuid).toBe(ACCOUNT_B_UUID);
        expect(r.account_source).toBe("override");
      }
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── clearOverridesForRule ─────────────────────────────────────────────────────

describe("clearOverridesForRule", () => {
  it("clears ONLY override rows, not otel-source rows", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.upsertAccount({
        accountUuid: ACCOUNT_A_UUID,
        organizationUuid: null,
        emailHash: null,
        emailLabel: "a@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      seedSession(store, { session_id: "override-sess", first_timestamp: T0, project_path: "/home/user/work/x" });
      seedSession(store, { session_id: "otel-sess", first_timestamp: T0 + 100, project_path: "/home/user/work/y" });

      // Apply override to one session
      store.applyOwnerOverride(
        new Map([["override-sess", ACCOUNT_A_UUID]]),
        fixedClock(T0),
      );

      // Apply otel to the other via applyAttribution
      store.applyAttribution(
        new Map([
          ["otel-sess", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      // Clear overrides for both sessions
      const cleared = store.clearOverridesForRule(["override-sess", "otel-sess"]);

      // Only the override row is cleared; otel stays
      expect(cleared).toBe(1);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const overrideRow = sessions.find((s) => s.session_id === "override-sess")!;
      const otelRow = sessions.find((s) => s.session_id === "otel-sess")!;

      expect(overrideRow.account_uuid).toBeNull();
      expect(overrideRow.account_source).toBeNull();

      expect(otelRow.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(otelRow.account_source).toBe("otel");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("returns 0 for an empty sessionIds array", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(store.clearOverridesForRule([])).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("returns 0 when none of the sessions have account_source=override", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, { session_id: "plain-sess", first_timestamp: T0, project_path: "/home/user/proj" });

      const cleared = store.clearOverridesForRule(["plain-sess"]);
      expect(cleared).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("clears multiple override sessions at once", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.upsertAccount({
        accountUuid: ACCOUNT_B_UUID,
        organizationUuid: null,
        emailHash: null,
        emailLabel: "b@example.com",
        organizationType: null,
        rateLimitTier: null,
        userRateLimitTier: null,
        seatTier: null,
        billingType: null,
        subscriptionType: null,
        firstObservedAt: T0,
        lastObservedAt: T0,
      });

      for (const id of ["s1", "s2", "s3"]) {
        seedSession(store, { session_id: id, first_timestamp: T0, project_path: "/home/user/work/proj" });
      }

      store.applyOwnerOverride(
        new Map([["s1", ACCOUNT_B_UUID], ["s2", ACCOUNT_B_UUID], ["s3", ACCOUNT_B_UUID]]),
        fixedClock(T0),
      );

      const cleared = store.clearOverridesForRule(["s1", "s2", "s3"]);
      expect(cleared).toBe(3);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      for (const id of ["s1", "s2", "s3"]) {
        const r = sessions.find((s) => s.session_id === id)!;
        expect(r.account_uuid).toBeNull();
        expect(r.account_source).toBeNull();
      }
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── getCostBySession ──────────────────────────────────────────────────────────

describe("getCostBySession", () => {
  it("returns an empty map when no sessions/messages exist", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(store.getCostBySession()).toEqual(new Map());
      expect(store.getCostBySession([])).toEqual(new Map());
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("sums cost per session using estimateCost", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, { session_id: "sess-a", first_timestamp: T0, project_path: "/home/user/proj-a" });
      seedSession(store, { session_id: "sess-b", first_timestamp: T0 + 100, project_path: "/home/user/proj-b" });

      // Use a known model (claude-3-5-sonnet) for predictable pricing
      seedMessage(store, "msg-a1", "sess-a", "claude-3-5-sonnet-20241022", 1000, 500);
      seedMessage(store, "msg-a2", "sess-a", "claude-3-5-sonnet-20241022", 2000, 1000);
      seedMessage(store, "msg-b1", "sess-b", "claude-3-5-sonnet-20241022", 500, 250);

      const costs = store.getCostBySession();
      expect(costs.size).toBe(2);
      expect(costs.get("sess-a")).toBeGreaterThan(0);
      expect(costs.get("sess-b")).toBeGreaterThan(0);
      // sess-a has more tokens → higher cost
      expect(costs.get("sess-a")!).toBeGreaterThan(costs.get("sess-b")!);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("restricts to provided sessionIds", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, { session_id: "sess-x", first_timestamp: T0, project_path: "/home/user/proj-x" });
      seedSession(store, { session_id: "sess-y", first_timestamp: T0 + 100, project_path: "/home/user/proj-y" });

      seedMessage(store, "msg-x", "sess-x", "claude-3-5-sonnet-20241022", 1000, 500);
      seedMessage(store, "msg-y", "sess-y", "claude-3-5-sonnet-20241022", 1000, 500);

      const costs = store.getCostBySession(["sess-x"]);
      expect(costs.has("sess-x")).toBe(true);
      expect(costs.has("sess-y")).toBe(false);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("sessions with unknown model contribute zero cost but are included", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, { session_id: "sess-unknown-model", first_timestamp: T0, project_path: "/home/user/proj-z" });
      // Model name not in pricing table → estimateCost returns {cost:0, known:false}
      seedMessage(store, "msg-unknown", "sess-unknown-model", "some-unknown-model-x", 1000, 500);

      const costs = store.getCostBySession(["sess-unknown-model"]);
      // The session appears but cost is 0
      expect(costs.get("sess-unknown-model")).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("aggregates multiple models correctly within one session", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, { session_id: "sess-multi", first_timestamp: T0, project_path: "/home/user/proj-multi" });
      seedMessage(store, "msg-1", "sess-multi", "claude-3-5-sonnet-20241022", 100, 50);
      seedMessage(store, "msg-2", "sess-multi", "claude-3-opus-20240229", 100, 50);

      const costs = store.getCostBySession(["sess-multi"]);
      expect(costs.get("sess-multi")).toBeGreaterThan(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});
