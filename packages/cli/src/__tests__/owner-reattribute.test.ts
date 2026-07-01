/**
 * Unit F — owner rule wiring tests.
 *
 * Covers:
 *   1. Account-target rule → reattribute → matching sessions become
 *      account_source='override', even if previously 'otel' (override outranks).
 *   2. Split-target rule → matching sessions keep their measured source (no
 *      override written).
 *   3. Clear flow: after an account rule made sessions override,
 *      store.clearOverridesForRule then reattribute → those sessions revert to
 *      their measured/inferred source (not stuck at override).
 *   4. Collect seam: a fresh session under an owned path receives an override
 *      immediately via the store methods that the aggregator applies, without
 *      a full reattribute.
 *
 * CONFIDENTIALITY (public repo): all account UUIDs use the 00000000- prefix;
 * all emails use @example.com; all paths use /home/user/…; no real values from
 * ~/.claude* appear anywhere in this file.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { Store } from "../store/index.js";
import type { SessionRecord } from "@claude-stats/core/types";
import { reattribute } from "../attribution/reattribute.js";
import { resolveOwner } from "../attribution/ownership.js";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  ORG_B_UUID,
  WORK_PATH_GLOB,
  makeSessionRow,
  makeOwnerRule,
} from "./fixtures/accounts.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns a fresh temp DB path for each test. */
function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `cs-owner-rattr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Fixed-clock factory: always returns the same epoch-ms. */
function fixedClock(ms: number): () => number {
  return () => ms;
}

const T0 = 1_700_000_000_000;

/**
 * Upsert a minimal session into the store via the public SessionRecord path.
 * Mirrors the pattern used by owner-store.test.ts and attribution.test.ts.
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

/**
 * Seed an AccountRecord so createOwnerRule's existence check passes and
 * applyOwnerOverride's COALESCE can fill organization_uuid.
 */
function seedAccount(
  store: Store,
  accountUuid: string,
  organizationUuid: string | null,
  emailLabel: string,
): void {
  store.upsertAccount({
    accountUuid,
    organizationUuid,
    emailHash: null,
    emailLabel,
    organizationType: null,
    rateLimitTier: null,
    userRateLimitTier: null,
    seatTier: null,
    billingType: null,
    subscriptionType: null,
    firstObservedAt: T0,
    lastObservedAt: T0,
  });
}

// ── 1. Account-target rule → reattribute stamps override ──────────────────────

describe("reattribute: account-target owner rule", () => {
  it("stamps matching sessions as account_source=override after a real run", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");

      // Two sessions: one matching WORK_PATH_GLOB, one not.
      seedSession(store, {
        session_id: "work-s1",
        project_path: "/home/user/work/project-alpha",
        first_timestamp: T0,
      });
      seedSession(store, {
        session_id: "personal-s1",
        project_path: "/home/user/personal/project-beta",
        first_timestamp: T0 + 1000,
      });

      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0),
      );

      const summary = reattribute(store, { force: true }, fixedClock(T0 + 5000));

      expect(summary.dryRun).toBe(false);
      expect(summary.refused).toBe(false);
      expect(summary.ownerOverrides).toBe(1);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const work = sessions.find((s) => s.session_id === "work-s1")!;
      const personal = sessions.find((s) => s.session_id === "personal-s1")!;

      expect(work.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(work.account_source).toBe("override");
      expect(work.account_confidence).toBe("authoritative");
      // organization_uuid COALESCE'd from the account record
      expect(work.organization_uuid).toBe(ORG_A_UUID);

      // Personal session is unmatched → no override (keeps inferred/null)
      expect(personal.account_source).not.toBe("override");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("override outranks a pre-existing otel source (unconditional)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");
      seedAccount(store, ACCOUNT_B_UUID, ORG_B_UUID, "b@example.com");

      seedSession(store, {
        session_id: "otel-work-s1",
        project_path: "/home/user/work/otel-project",
        first_timestamp: T0,
      });

      // Pre-attribute with otel/authoritative for ACCOUNT_B
      store.applyAttribution(
        new Map([
          ["otel-work-s1", { accountUuid: ACCOUNT_B_UUID, organizationUuid: ORG_B_UUID, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      // Confirm otel is set
      let rows = store.getSessions({ includeCI: true, includeDeleted: true });
      expect(rows.find((s) => s.session_id === "otel-work-s1")!.account_source).toBe("otel");

      // Create rule targeting ACCOUNT_A for /home/user/work/**
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0 + 1000),
      );

      const summary = reattribute(store, { force: true }, fixedClock(T0 + 5000));

      expect(summary.ownerOverrides).toBe(1);

      rows = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = rows.find((s) => s.session_id === "otel-work-s1")!;

      // override outranks otel
      expect(row.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(row.account_source).toBe("override");
      expect(row.account_confidence).toBe("authoritative");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("dry-run reports would-be ownerOverrides count without writing", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");

      seedSession(store, {
        session_id: "work-dry-s1",
        project_path: "/home/user/work/dry-project",
        first_timestamp: T0,
      });

      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0),
      );

      const summary = reattribute(store, { dryRun: true }, fixedClock(T0 + 5000));

      expect(summary.dryRun).toBe(true);
      // Would match 1 session
      expect(summary.ownerOverrides).toBe(1);

      // Verify nothing was actually written
      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "work-dry-s1")!;
      expect(row.account_source).not.toBe("override");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── 2. Split-target rule → no override written ────────────────────────────────

describe("reattribute: split-target owner rule", () => {
  it("leaves matching sessions on their measured source (no override)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_B_UUID, ORG_B_UUID, "b@example.com");

      seedSession(store, {
        session_id: "split-work-s1",
        project_path: "/home/user/work/split-project",
        first_timestamp: T0,
      });

      // Pre-attribute with observation for ACCOUNT_B
      store.applyAttribution(
        new Map([
          ["split-work-s1", { accountUuid: ACCOUNT_B_UUID, organizationUuid: ORG_B_UUID, subscriptionType: null, source: "observation", confidence: "high" }],
        ]),
        fixedClock(T0),
      );

      // Split rule for the work path
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0 + 1000),
      );

      const summary = reattribute(store, { force: true }, fixedClock(T0 + 5000));

      // Split target → no overrides applied
      expect(summary.ownerOverrides).toBe(0);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "split-work-s1")!;

      // Must NOT be override — keeps whatever inference assigned
      expect(row.account_source).not.toBe("override");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("unmatched session gets no override (split leaves it on inference)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, {
        session_id: "unmatched-s1",
        project_path: "/home/user/personal/unmatched-project",
        first_timestamp: T0,
      });

      // Split rule that does NOT match /home/user/personal/**
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0),
      );

      const summary = reattribute(store, { force: true }, fixedClock(T0 + 5000));

      expect(summary.ownerOverrides).toBe(0);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "unmatched-s1")!;
      expect(row.account_source ?? null).not.toBe("override");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── 3. Clear flow: clearOverridesForRule then reattribute reverts ─────────────

describe("reattribute: clear flow reverts to measured source", () => {
  it("cleared sessions revert to measured/inferred source, not stuck at override", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");
      seedAccount(store, ACCOUNT_B_UUID, ORG_B_UUID, "b@example.com");

      // Session under /home/user/work/** — will be matched by the rule
      seedSession(store, {
        session_id: "clear-work-s1",
        project_path: "/home/user/work/clear-project",
        first_timestamp: T0,
      });

      // Add an observation for ACCOUNT_B so inference can assign it
      store.recordAccountObservation({
        accountUuid: ACCOUNT_B_UUID,
        observedAt: T0 - 1000,
        source: "observation",
        surface: "cli",
        rateLimitTier: null,
        billingType: null,
      });

      // Create account rule targeting ACCOUNT_A
      const rule = store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0 + 1000),
      );

      // First reattribute: session gets overridden to ACCOUNT_A
      reattribute(store, { force: true }, fixedClock(T0 + 5000));

      let sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      let row = sessions.find((s) => s.session_id === "clear-work-s1")!;
      expect(row.account_source).toBe("override");
      expect(row.account_uuid).toBe(ACCOUNT_A_UUID);

      // Clear the override for this rule's matched sessions
      const cleared = store.clearOverridesForRule(["clear-work-s1"]);
      expect(cleared).toBe(1);

      // Verify cleared — session is now NULL source (reset)
      sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      row = sessions.find((s) => s.session_id === "clear-work-s1")!;
      expect(row.account_source ?? null).toBeNull();
      expect(row.account_uuid).toBeNull();

      // Delete the rule so reattribute doesn't re-apply it
      store.deleteOwnerRule(rule.id);

      // Second reattribute: inference runs, assigns via observation (if any
      // intervals exist). The important assertion is: NOT stuck at override.
      reattribute(store, { force: true }, fixedClock(T0 + 10000));

      sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      row = sessions.find((s) => s.session_id === "clear-work-s1")!;
      // Must never be 'override' after the rule was deleted + cleared
      expect(row.account_source ?? null).not.toBe("override");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("clearOverridesForRule does not touch non-override sessions (otel stays otel)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");
      seedAccount(store, ACCOUNT_B_UUID, ORG_B_UUID, "b@example.com");

      seedSession(store, {
        session_id: "otel-keep-s1",
        project_path: "/home/user/work/otel-keep",
        first_timestamp: T0,
      });
      seedSession(store, {
        session_id: "override-s1",
        project_path: "/home/user/work/override-proj",
        first_timestamp: T0 + 100,
      });

      // Stamp otel-keep-s1 with otel
      store.applyAttribution(
        new Map([
          ["otel-keep-s1", { accountUuid: ACCOUNT_B_UUID, organizationUuid: ORG_B_UUID, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      // Stamp override-s1 with override
      store.applyOwnerOverride(
        new Map([["override-s1", ACCOUNT_A_UUID]]),
        fixedClock(T0 + 500),
      );

      // Clear both session IDs
      const cleared = store.clearOverridesForRule(["otel-keep-s1", "override-s1"]);

      // Only the override row is cleared
      expect(cleared).toBe(1);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const otelRow = sessions.find((s) => s.session_id === "otel-keep-s1")!;
      const overrideRow = sessions.find((s) => s.session_id === "override-s1")!;

      // otel preserved
      expect(otelRow.account_source).toBe("otel");
      expect(otelRow.account_uuid).toBe(ACCOUNT_B_UUID);

      // override cleared
      expect(overrideRow.account_source ?? null).toBeNull();
      expect(overrideRow.account_uuid).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── 4. Collect seam: fresh session under owned path gets override immediately ──

describe("collect seam: owner override applied to fresh session", () => {
  it("fresh session under owned path is stamped override via store methods (no full reattribute)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");

      // Simulate what the aggregator's seam 2 does: upsert a new session, then
      // resolve owner rules and call applyOwnerOverride.
      seedSession(store, {
        session_id: "collect-new-s1",
        project_path: "/home/user/work/new-collect-project",
        first_timestamp: T0,
      });

      // Create owner rule (as would exist before the collect run)
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0),
      );

      // Simulate the aggregator's seam 2 logic directly:
      const allSessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const runSessions = allSessions.filter((s) => s.session_id === "collect-new-s1");
      const ownerRules = store.listOwnerRules();

      const ownerOverrideMap = new Map<string, string>();
      for (const s of runSessions) {
        const target = resolveOwner(
          { projectPath: s.project_path, repoUrl: s.repo_url ?? null },
          ownerRules,
        );
        if (target !== null && target.kind === "account") {
          ownerOverrideMap.set(s.session_id, target.accountUuid);
        }
      }

      expect(ownerOverrideMap.size).toBe(1);
      expect(ownerOverrideMap.get("collect-new-s1")).toBe(ACCOUNT_A_UUID);

      const overridesApplied = store.applyOwnerOverride(ownerOverrideMap, fixedClock(T0 + 1000));
      expect(overridesApplied).toBe(1);

      // Verify via the store: session now has override attribution
      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "collect-new-s1")!;
      expect(row.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(row.account_source).toBe("override");
      expect(row.account_confidence).toBe("authoritative");
      expect(row.organization_uuid).toBe(ORG_A_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("fresh session under split-target path is NOT overridden (keeps inferred/null)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, {
        session_id: "collect-split-s1",
        project_path: "/home/user/work/split-collect-project",
        first_timestamp: T0,
      });

      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "split" } },
        fixedClock(T0),
      );

      // Simulate aggregator seam 2 with split rule
      const allSessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const runSessions = allSessions.filter((s) => s.session_id === "collect-split-s1");
      const ownerRules = store.listOwnerRules();

      const ownerOverrideMap = new Map<string, string>();
      for (const s of runSessions) {
        const target = resolveOwner(
          { projectPath: s.project_path, repoUrl: s.repo_url ?? null },
          ownerRules,
        );
        if (target !== null && target.kind === "account") {
          ownerOverrideMap.set(s.session_id, target.accountUuid);
        }
        // split target → not added to map
      }

      // No account-target matches for split → map is empty
      expect(ownerOverrideMap.size).toBe(0);

      // Session remains unattributed
      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "collect-split-s1")!;
      expect(row.account_source ?? null).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("fresh session under unowned path is not overridden (no matching rule)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");

      seedSession(store, {
        session_id: "collect-unowned-s1",
        project_path: "/home/user/personal/unowned-project",
        first_timestamp: T0,
      });

      // Rule only covers /home/user/work/**
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0),
      );

      const allSessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const runSessions = allSessions.filter((s) => s.session_id === "collect-unowned-s1");
      const ownerRules = store.listOwnerRules();

      const ownerOverrideMap = new Map<string, string>();
      for (const s of runSessions) {
        const target = resolveOwner(
          { projectPath: s.project_path, repoUrl: s.repo_url ?? null },
          ownerRules,
        );
        if (target !== null && target.kind === "account") {
          ownerOverrideMap.set(s.session_id, target.accountUuid);
        }
      }

      // Unowned path → no match → map empty
      expect(ownerOverrideMap.size).toBe(0);

      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const row = sessions.find((s) => s.session_id === "collect-unowned-s1")!;
      expect(row.account_source ?? null).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── reattribute ownerOverrides = 0 when no rules exist ───────────────────────

describe("reattribute: ownerOverrides = 0 when no owner rules", () => {
  it("summary.ownerOverrides is 0 when owner rules table is empty", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, {
        session_id: "no-rules-s1",
        project_path: "/home/user/work/no-rules-project",
        first_timestamp: T0,
      });

      const summary = reattribute(store, { force: true }, fixedClock(T0 + 5000));

      expect(summary.ownerOverrides).toBe(0);
      expect(store.listOwnerRules()).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("refused run returns ownerOverrides = 0", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedAccount(store, ACCOUNT_A_UUID, ORG_A_UUID, "a@example.com");

      seedSession(store, {
        session_id: "refused-s1",
        project_path: "/home/user/work/refused-project",
        first_timestamp: T0,
        account_uuid: ACCOUNT_A_UUID,
      });

      // Pre-attribute so attributedBefore > 0 (triggers refused guard with
      // empty applyMap and no force)
      store.applyAttribution(
        new Map([
          ["refused-s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: ORG_A_UUID, subscriptionType: null, source: "observation", confidence: "high" }],
        ]),
        fixedClock(T0),
      );

      // Create a rule; even with a rule, a refused run writes nothing.
      store.createOwnerRule(
        { pathGlob: WORK_PATH_GLOB, remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } },
        fixedClock(T0 + 1000),
      );

      const summary = reattribute(store, { dryRun: false, force: false }, fixedClock(T0 + 5000));

      expect(summary.refused).toBe(true);
      expect(summary.ownerOverrides).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── makeOwnerRule fixture round-trip (sanity) ─────────────────────────────────

describe("makeOwnerRule fixture", () => {
  it("has the expected default shape", () => {
    const rule = makeOwnerRule();
    expect(rule.id).toBe(1);
    expect(rule.target).toEqual({ kind: "account", accountUuid: ACCOUNT_A_UUID });
    expect(rule.pathGlob).toContain("/home/user/");
    expect(rule.remoteGlob).toBeNull();
  });

  it("can be overridden to a split target", () => {
    const rule = makeOwnerRule({ target: { kind: "split" }, pathGlob: WORK_PATH_GLOB });
    expect(rule.target).toEqual({ kind: "split" });
    expect(rule.pathGlob).toBe(WORK_PATH_GLOB);
  });
});
