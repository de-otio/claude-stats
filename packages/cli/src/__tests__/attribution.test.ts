/**
 * Attribution engine tests (Phase 2 A) — Unit A.
 *
 * Covers the PURE interval + assignment functions and the clock-injected
 * writer / reattribute orchestrator. Determinism: every timestamp comes from a
 * FIXED clock; no `Date.now()` anywhere. Confidentiality: all account/session
 * shapes come from `__tests__/fixtures/accounts.ts` (00000000- UUIDs,
 * @example.com), never real `~/.claude*` values.
 *
 * Property tests use a small seeded deterministic generator (a self-contained
 * LCG) instead of fast-check, which is not a project dependency (ASSUMPTIONS
 * #29). The generator is seeded so failures reproduce exactly.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { buildCliIntervals, intervalAt } from "../attribution/intervals.js";
import { assignAccounts } from "../attribution/assign.js";
import type { ExternalAccountInfo } from "../attribution/assign.js";
import { writeObservation, hashEmail } from "../attribution/observer.js";
import { reattribute } from "../attribution/reattribute.js";
import { Store } from "../store/index.js";
import type { SessionRow } from "../store/index.js";
import type { AccountObservation } from "@claude-stats/core/types";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  makeSessionRow,
} from "./fixtures/accounts.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** A fixed clock factory: returns the same epoch-ms on every call. */
function fixedClock(ms: number): () => number {
  return () => ms;
}

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function obs(
  accountUuid: string,
  observedAt: number,
  surface: string | null = "cli",
): AccountObservation {
  return {
    accountUuid,
    observedAt,
    source: "collect",
    surface,
    rateLimitTier: null,
    billingType: null,
  };
}

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `cs-attr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Insert a minimal message row (uuid, session, timestamp) for store tests. */
function insertMessage(
  store: Store,
  uuid: string,
  sessionId: string,
  timestamp: number | null,
): void {
  store.upsertMessages([
    {
      uuid, sessionId, timestamp,
      claudeVersion: null, model: null, stopReason: null,
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
      tools: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
      ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null,
    },
  ]);
}

/** uuid → account_uuid map for a session's messages. */
function messageAccounts(store: Store, sessionId: string): Map<string, string | null> {
  return new Map(
    store.getSessionMessages(sessionId).map((r) => [r.uuid, r.account_uuid ?? null]),
  );
}

// ── intervals: disjoint cover ─────────────────────────────────────────────────

describe("buildCliIntervals", () => {
  it("returns [] for no CLI observations", () => {
    expect(buildCliIntervals([])).toEqual([]);
    // non-CLI surfaces are filtered out → still empty
    expect(
      buildCliIntervals([obs(ACCOUNT_A_UUID, T0, "claude-vscode")]),
    ).toEqual([]);
  });

  it("produces disjoint, time-sorted, gap-free intervals with final end=Infinity", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0 + 5 * HOUR),
    ]);
    expect(ivs).toEqual([
      { start: T0, end: T0 + 2 * HOUR, accountUuid: ACCOUNT_A_UUID },
      { start: T0 + 2 * HOUR, end: T0 + 5 * HOUR, accountUuid: ACCOUNT_B_UUID },
      { start: T0 + 5 * HOUR, end: Infinity, accountUuid: ACCOUNT_A_UUID },
    ]);
    // disjoint + contiguous: each interval's end == next interval's start
    for (let i = 0; i < ivs.length - 1; i++) {
      expect(ivs[i]!.end).toBe(ivs[i + 1]!.start);
      expect(ivs[i]!.start).toBeLessThan(ivs[i]!.end);
    }
  });

  it("dedupes consecutive same-account observations into one interval", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_A_UUID, T0 + HOUR),
      obs(ACCOUNT_A_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_B_UUID, T0 + 3 * HOUR),
    ]);
    expect(ivs).toEqual([
      { start: T0, end: T0 + 3 * HOUR, accountUuid: ACCOUNT_A_UUID },
      { start: T0 + 3 * HOUR, end: Infinity, accountUuid: ACCOUNT_B_UUID },
    ]);
  });

  it("only considers CLI surfaces (cli, claude); ignores others", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0, "claude"),
      obs(ACCOUNT_B_UUID, T0 + HOUR, "claude-vscode"), // ignored
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR, "vscode"), // ignored
    ]);
    expect(ivs).toEqual([
      { start: T0, end: Infinity, accountUuid: ACCOUNT_A_UUID },
    ]);
  });

  it("sorts unsorted observations before building", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0),
    ]);
    expect(ivs[0]!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(ivs[1]!.accountUuid).toBe(ACCOUNT_B_UUID);
  });
});

describe("intervalAt", () => {
  const ivs = buildCliIntervals([
    obs(ACCOUNT_A_UUID, T0),
    obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
  ]);

  it("finds the covering interval (start inclusive, end exclusive)", () => {
    expect(intervalAt(ivs, T0)!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(intervalAt(ivs, T0 + HOUR)!.accountUuid).toBe(ACCOUNT_A_UUID);
    // boundary is exclusive on the left interval, inclusive on the right
    expect(intervalAt(ivs, T0 + 2 * HOUR)!.accountUuid).toBe(ACCOUNT_B_UUID);
    expect(intervalAt(ivs, T0 + 100 * HOUR)!.accountUuid).toBe(ACCOUNT_B_UUID);
  });

  it("returns null before the first interval", () => {
    expect(intervalAt(ivs, T0 - 1)).toBeNull();
  });
});

// ── assign: precedence ────────────────────────────────────────────────────────

describe("assignAccounts — precedence", () => {
  const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);

  function tel(accountUuid: string): Map<string, ExternalAccountInfo> {
    return new Map([
      ["s1", { accountUuid, organizationUuid: null, subscriptionType: "team_standard" }],
    ]);
  }
  function otel(accountUuid: string): Map<string, ExternalAccountInfo> {
    return new Map([
      ["s1", { accountUuid, organizationUuid: ORG_A_UUID, subscriptionType: "team_premium" }],
    ]);
  }

  it("otel beats telemetry beats observation", () => {
    const cli = makeSessionRow({ session_id: "s1", entrypoint: "cli", first_timestamp: T0 + HOUR });

    // observation only
    let r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("s1")).toMatchObject({ source: "observation", confidence: "high", accountUuid: ACCOUNT_A_UUID });

    // telemetry beats observation
    r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: tel(ACCOUNT_B_UUID) });
    expect(r.assignments.get("s1")).toMatchObject({ source: "telemetry", confidence: "high", accountUuid: ACCOUNT_B_UUID });

    // otel beats telemetry
    r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: tel(ACCOUNT_B_UUID), otelMap: otel(ACCOUNT_A_UUID) });
    expect(r.assignments.get("s1")).toMatchObject({ source: "otel", confidence: "authoritative", accountUuid: ACCOUNT_A_UUID });
  });
});

// ── assign: SURFACE ALLOWLIST ─────────────────────────────────────────────────

describe("assignAccounts — surface allowlist", () => {
  const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);

  it("CLI surfaces (cli, claude) get the interval (observation/high)", () => {
    for (const entrypoint of ["cli", "claude"]) {
      const s = makeSessionRow({ session_id: "x", entrypoint, first_timestamp: T0 + HOUR });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({
        source: "observation",
        confidence: "high",
        accountUuid: ACCOUNT_A_UUID,
      });
    }
  });

  it("non-CLI surfaces NEVER get the interval → unknown/none", () => {
    for (const entrypoint of ["claude-vscode", "vscode", "claude-desktop", "some-unknown-entry"]) {
      const s = makeSessionRow({ session_id: "x", entrypoint, first_timestamp: T0 + HOUR });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({
        source: "unknown",
        confidence: "none",
        accountUuid: "",
      });
    }
  });

  it("non-CLI surface still gets otel/telemetry when present", () => {
    const s = makeSessionRow({ session_id: "x", entrypoint: "claude-vscode", first_timestamp: T0 + HOUR });
    const tmap = new Map<string, ExternalAccountInfo>([
      ["x", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null }],
    ]);
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: tmap });
    expect(r.assignments.get("x")).toMatchObject({ source: "telemetry", accountUuid: ACCOUNT_B_UUID });
  });

  it("null entrypoint → unknown", () => {
    const s = makeSessionRow({ session_id: "x", entrypoint: null, first_timestamp: T0 + HOUR });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("x")).toMatchObject({ source: "unknown", confidence: "none" });
  });

  it("CLI surface but session precedes first interval → backfill (single account observed)", () => {
    // ivs has exactly one observed account, so the single-account fast-path
    // backfills a pre-observation CLI session (medium). See the dedicated
    // "assignAccounts — backfill" describe for the multi-account → unknown case.
    const s = makeSessionRow({ session_id: "x", entrypoint: "cli", first_timestamp: T0 - HOUR });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("x")).toMatchObject({ source: "backfill", confidence: "medium", accountUuid: ACCOUNT_A_UUID });
  });
});

// ── assign: straddle ──────────────────────────────────────────────────────────

describe("assignAccounts — straddle", () => {
  // A active [T0, T0+2h), B active [T0+2h, ∞)
  const ivs = buildCliIntervals([
    obs(ACCOUNT_A_UUID, T0),
    obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
  ]);

  it("attributes the session to the interval covering first_timestamp", () => {
    const s = makeSessionRow({
      session_id: "straddle",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR, // in A's interval
      last_timestamp: T0 + 3 * HOUR, // extends into B's interval
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("straddle")).toMatchObject({
      source: "observation",
      confidence: "high",
      accountUuid: ACCOUNT_A_UUID,
    });
  });

  it("emits a per-message override for the crossed boundary", () => {
    const s = makeSessionRow({
      session_id: "straddle",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR,
      last_timestamp: T0 + 3 * HOUR,
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    // B is the open final interval [T0+2h, ∞).
    expect(r.messageOverrides).toEqual([
      { sessionId: "straddle", boundaryFrom: T0 + 2 * HOUR, boundaryTo: Infinity, accountUuid: ACCOUNT_B_UUID },
    ]);
  });

  it("no override when the session stays within one interval", () => {
    const s = makeSessionRow({
      session_id: "single",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR,
      last_timestamp: T0 + 90 * 60 * 1000, // still < T0+2h
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.messageOverrides).toEqual([]);
  });

  it("no override when straddle re-enters the SAME account", () => {
    // A [T0,T0+2h), B [T0+2h,T0+4h), A [T0+4h,∞)
    const ivs2 = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0 + 4 * HOUR),
    ]);
    const s = makeSessionRow({
      session_id: "x",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR, // A
      last_timestamp: T0 + 5 * HOUR, // crosses into B then back to A
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs2, telemetryMap: new Map() });
    // boundary into B is a different account → one BOUNDED override spanning B's
    // interval [T0+2h, T0+4h); the later A boundary matches the start account so
    // it is not emitted (those messages keep the session-level account A).
    expect(r.messageOverrides).toEqual([
      { sessionId: "x", boundaryFrom: T0 + 2 * HOUR, boundaryTo: T0 + 4 * HOUR, accountUuid: ACCOUNT_B_UUID },
    ]);
  });
});

// ── backfill: single-account fast-path for pre-observation CLI sessions ────────

describe("assignAccounts — backfill (single-account fast-path)", () => {
  const oneAccount = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]); // [T0, ∞) → A
  const twoAccounts = buildCliIntervals([
    obs(ACCOUNT_A_UUID, T0),
    obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
  ]);

  /** A CLI session whose whole span PREDATES the first observation. */
  function preObsSession(id: string, entrypoint = "cli"): SessionRow {
    return makeSessionRow({
      session_id: id,
      entrypoint,
      first_timestamp: T0 - 10 * HOUR,
      last_timestamp: T0 - 9 * HOUR,
    });
  }

  it("backfills a pre-observation CLI session to the only account (medium)", () => {
    const r = assignAccounts({ sessions: [preObsSession("old")], intervals: oneAccount, telemetryMap: new Map() });
    expect(r.assignments.get("old")).toMatchObject({
      source: "backfill",
      confidence: "medium",
      accountUuid: ACCOUNT_A_UUID,
    });
  });

  it("does NOT backfill when two accounts have been observed (→ unknown)", () => {
    const r = assignAccounts({ sessions: [preObsSession("old")], intervals: twoAccounts, telemetryMap: new Map() });
    expect(r.assignments.get("old")).toMatchObject({ source: "unknown", confidence: "none" });
  });

  it("does NOT backfill a non-CLI surface (→ unknown)", () => {
    const r = assignAccounts({ sessions: [preObsSession("vs", "claude-vscode")], intervals: oneAccount, telemetryMap: new Map() });
    expect(r.assignments.get("vs")).toMatchObject({ source: "unknown", confidence: "none" });
  });

  it("does NOT backfill when there are no observations at all (→ unknown)", () => {
    const r = assignAccounts({ sessions: [preObsSession("orphan")], intervals: [], telemetryMap: new Map() });
    expect(r.assignments.get("orphan")).toMatchObject({ source: "unknown", confidence: "none" });
  });

  it("prefers the covering interval over backfill for in-range sessions", () => {
    const s = makeSessionRow({ session_id: "recent", entrypoint: "cli", first_timestamp: T0 + HOUR, last_timestamp: T0 + 2 * HOUR });
    const r = assignAccounts({ sessions: [s], intervals: oneAccount, telemetryMap: new Map() });
    expect(r.assignments.get("recent")).toMatchObject({ source: "observation", confidence: "high" });
  });

  it("telemetry still outranks backfill for a pre-observation session", () => {
    const tel = new Map([["old", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null }]]);
    const r = assignAccounts({ sessions: [preObsSession("old")], intervals: oneAccount, telemetryMap: tel });
    expect(r.assignments.get("old")).toMatchObject({ source: "telemetry", accountUuid: ACCOUNT_B_UUID });
  });
});

// ── monotonic: re-apply never lowers/overwrites strong sources ────────────────

describe("applyAttribution monotonicity (store guard)", () => {
  function freshStore(): { store: Store; dbPath: string } {
    const dbPath = tmpDbPath();
    return { store: new Store(dbPath), dbPath };
  }

  function insertSession(store: Store, row: Partial<SessionRow>): void {
    // Use the public upsertSession path via a minimal SessionRecord-shaped obj.
    const r = makeSessionRow(row);
    store.upsertSession({
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
    });
  }

  it("does not overwrite an otel-attributed row with a weaker observation", () => {
    const { store, dbPath } = freshStore();
    try {
      insertSession(store, { session_id: "s1", entrypoint: "cli", first_timestamp: T0 });

      // First: otel/authoritative for ACCOUNT_B
      store.applyAttribution(
        new Map([
          ["s1", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      // Then: weaker observation for ACCOUNT_A — must NOT overwrite
      const changed = store.applyAttribution(
        new Map([
          ["s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
        ]),
        fixedClock(T0 + HOUR),
      );
      expect(changed).toBe(0);

      const row = store.getSessions({ includeCI: true, includeDeleted: true })
        .find((s) => s.session_id === "s1")!;
      expect(row.account_uuid).toBe(ACCOUNT_B_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("re-applying the same observation is idempotent (no further change)", () => {
    const { store, dbPath } = freshStore();
    try {
      insertSession(store, { session_id: "s1", entrypoint: "cli", first_timestamp: T0 });
      const m = new Map([
        ["s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
      ]);
      expect(store.applyAttribution(m, fixedClock(T0))).toBe(1);
      // high-confidence observation is no longer in the (low|medium) updatable
      // set, so a re-apply changes nothing.
      expect(store.applyAttribution(m, fixedClock(T0 + HOUR))).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── reset predicate ───────────────────────────────────────────────────────────

describe("resetAttributableSessions predicate", () => {
  it("resets NULL-source + weak rows, preserves strong sources", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      const mk = (id: string, ep: string): void => {
        const r = makeSessionRow({ session_id: id, entrypoint: ep, first_timestamp: T0 });
        store.upsertSession({
          sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
          firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
          claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
          permissionMode: null, isInteractive: true, promptCount: 0, assistantMessageCount: 0,
          inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
          webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
          accountUuid: null, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
          parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
          activeDurationMs: null, medianResponseTimeMs: null,
        });
      };
      mk("nullsrc", "cli"); // account_source NULL → reset-eligible
      mk("obs", "cli");
      mk("otel", "cli");

      // Strong: otel — preserved. Weak: observation high — also reset-eligible
      // per the predicate (source NOT IN strong set).
      store.applyAttribution(new Map([
        ["otel", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ["obs", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
      ]), fixedClock(T0));

      const reset = store.resetAttributableSessions();
      // nullsrc (1) + obs (1) reset; otel preserved.
      expect(reset).toBe(2);

      const rows = store.getSessions({ includeCI: true, includeDeleted: true });
      const otel = rows.find((s) => s.session_id === "otel")!;
      const obsRow = rows.find((s) => s.session_id === "obs")!;
      expect(otel.account_uuid).toBe(ACCOUNT_B_UUID);
      expect(obsRow.account_uuid).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── writeObservation ──────────────────────────────────────────────────────────

describe("writeObservation", () => {
  const account = {
    accountUuid: ACCOUNT_A_UUID,
    emailAddress: "a@example.com",
    organizationUuid: ORG_A_UUID,
    organizationType: "team",
    organizationRateLimitTier: "default_team",
    userRateLimitTier: "default_team",
    seatTier: "team_premium",
    billingType: "team",
    hasExtraUsageEnabled: false,
  };

  it("no-ops on null account", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(writeObservation(store, null, fixedClock(T0))).toBe(false);
      expect(store.getAccountObservations("cli")).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("records on first sighting and dedupes unchanged account", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(writeObservation(store, account, fixedClock(T0))).toBe(true);
      let obsRows = store.getAccountObservations("cli");
      expect(obsRows).toHaveLength(1);
      expect(obsRows[0]).toMatchObject({ accountUuid: ACCOUNT_A_UUID, surface: "cli", observedAt: T0 });

      // same account again → deduped, no new observation row
      expect(writeObservation(store, account, fixedClock(T0 + HOUR))).toBe(false);
      obsRows = store.getAccountObservations("cli");
      expect(obsRows).toHaveLength(1);

      // accounts metadata row exists with email hashed (not raw)
      const known = store.listAccountsFull();
      expect(known).toHaveLength(1);
      expect(known[0]!.emailHash).toBe(hashEmail("a@example.com"));
      expect(known[0]!.emailLabel).toBe("a@example.com");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("records a new observation when the account changes", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      writeObservation(store, account, fixedClock(T0));
      const accountB = { ...account, accountUuid: ACCOUNT_B_UUID, emailAddress: "b@example.com" };
      expect(writeObservation(store, accountB, fixedClock(T0 + HOUR))).toBe(true);
      const obsRows = store.getAccountObservations("cli");
      expect(obsRows.map((o) => o.accountUuid)).toEqual([ACCOUNT_A_UUID, ACCOUNT_B_UUID]);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("hashEmail", () => {
  it("is case/whitespace-insensitive and stable", () => {
    expect(hashEmail("A@Example.com")).toBe(hashEmail("  a@example.com "));
    expect(hashEmail("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── reattribute (dry-run vs real) ─────────────────────────────────────────────

describe("reattribute", () => {
  function seedSession(store: Store, id: string, ep: string, ts: number): void {
    const r = makeSessionRow({ session_id: id, entrypoint: ep, first_timestamp: ts, last_timestamp: ts + 1000 });
    store.upsertSession({
      sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
      firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
      claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
      permissionMode: null, isInteractive: true, promptCount: 1, assistantMessageCount: 1,
      inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0,
      webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
      accountUuid: null, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
      parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
      activeDurationMs: null, medianResponseTimeMs: null,
    });
  }

  it("dry-run computes counts WITHOUT writing or backing up", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, "c1", "cli", T0 + HOUR);
      seedSession(store, "v1", "claude-vscode", T0 + HOUR);
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));

      const summary = reattribute(store, { dryRun: true, dbPath }, fixedClock(T0 + 2 * HOUR));
      expect(summary.dryRun).toBe(true);
      expect(summary.backupPath).toBeNull();
      expect(summary.resetCount).toBe(0); // not executed
      // cli session → observation; vscode → unknown (not applied)
      expect(summary.bySource.observation).toBe(1);
      expect(summary.bySource.unknown).toBe(1);
      expect(summary.changed).toBe(1);

      // nothing written
      const c1 = store.getSessions({ includeCI: true, includeDeleted: true }).find((s) => s.session_id === "c1")!;
      expect(c1.account_uuid).toBeNull();

      // no backup file created
      expect(fs.existsSync(`${dbPath}.pre-reattribute-${T0 + 2 * HOUR}`)).toBe(false);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("real run backs up, applies, and recomputes windows", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const backupTs = T0 + 5 * HOUR;
    try {
      seedSession(store, "c1", "cli", T0 + HOUR);
      seedSession(store, "v1", "claude-vscode", T0 + HOUR);
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));

      const summary = reattribute(store, { dryRun: false, dbPath }, fixedClock(backupTs));
      expect(summary.dryRun).toBe(false);
      expect(summary.backupPath).toBe(`${dbPath}.pre-reattribute-${backupTs}`);
      expect(fs.existsSync(summary.backupPath!)).toBe(true);
      expect(summary.changed).toBe(1); // only the cli session

      const rows = store.getSessions({ includeCI: true, includeDeleted: true });
      expect(rows.find((s) => s.session_id === "c1")!.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(rows.find((s) => s.session_id === "v1")!.account_uuid).toBeNull();

      // backup cleanup
      fs.rmSync(summary.backupPath!, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("backfills a pre-observation CLI session end-to-end (single account)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const backupTs = T0 + HOUR;
    try {
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));
      seedSession(store, "old", "cli", T0 - 10 * HOUR); // predates the observation
      seedSession(store, "new", "cli", T0 + HOUR);       // covered by the interval

      const summary = reattribute(store, { dryRun: false, dbPath }, fixedClock(backupTs));
      expect(summary.bySource.backfill).toBe(1);    // the pre-observation session
      expect(summary.bySource.observation).toBe(1); // the in-range session

      const rows = store.getSessions({ includeCI: true, includeDeleted: true });
      expect(rows.find((s) => s.session_id === "old")!.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(rows.find((s) => s.session_id === "new")!.account_uuid).toBe(ACCOUNT_A_UUID);

      if (summary.backupPath) fs.rmSync(summary.backupPath, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("refuses a real run that would wipe attribution with nothing to reassign; --force overrides", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const refusedTs = T0 + 9 * HOUR;
    try {
      // Two CLI sessions already attributed (account_uuid set, source NULL — the
      // pre-V13 fallback state) and NO observations recorded.
      for (const id of ["c1", "c2"]) {
        const r = makeSessionRow({ session_id: id, entrypoint: "cli", first_timestamp: T0 + HOUR, last_timestamp: T0 + HOUR + 1000 });
        store.upsertSession({
          sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
          firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
          claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
          permissionMode: null, isInteractive: true, promptCount: 1, assistantMessageCount: 1,
          inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0,
          webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
          accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
          parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
          activeDurationMs: null, medianResponseTimeMs: null,
        });
      }

      // Real run, no force → refused: no backup, no writes, attribution intact.
      const refused = reattribute(store, { dryRun: false, dbPath }, fixedClock(refusedTs));
      expect(refused.refused).toBe(true);
      expect(refused.attributedBefore).toBe(2);
      expect(refused.changed).toBe(0);
      expect(refused.backupPath).toBeNull();
      expect(fs.existsSync(`${dbPath}.pre-reattribute-${refusedTs}`)).toBe(false);
      expect(store.getSessions({ includeCI: true, includeDeleted: true }).every((s) => s.account_uuid === ACCOUNT_A_UUID)).toBe(true);

      // Dry-run reports a real run WOULD be refused.
      expect(reattribute(store, { dryRun: true, dbPath }, fixedClock(refusedTs)).refused).toBe(true);

      // --force overrides → proceeds; resets the inferred rows (nothing to reassign → unknown).
      const forced = reattribute(store, { dryRun: false, force: true, dbPath }, fixedClock(refusedTs));
      expect(forced.refused).toBe(false);
      expect(forced.resetCount).toBe(2);
      expect(store.getSessions({ includeCI: true, includeDeleted: true }).every((s) => s.account_uuid === null)).toBe(true);
      if (forced.backupPath) fs.rmSync(forced.backupPath, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── per-message straddle persistence (store writers) ──────────────────────────

describe("applyMessageOverrides / resetMessageAttribution (store)", () => {
  function freshStore(): { store: Store; dbPath: string } {
    const dbPath = tmpDbPath();
    return { store: new Store(dbPath), dbPath };
  }

  it("stamps only messages inside [from, to); leaves earlier ones null", () => {
    const { store, dbPath } = freshStore();
    try {
      insertMessage(store, "m0", "s", T0 + HOUR);     // before boundary → null
      insertMessage(store, "m1", "s", T0 + 2 * HOUR); // at boundary → B
      insertMessage(store, "m2", "s", T0 + 3 * HOUR); // after → B
      const n = store.applyMessageOverrides([
        { sessionId: "s", boundaryFrom: T0 + 2 * HOUR, boundaryTo: Infinity, accountUuid: ACCOUNT_B_UUID },
      ]);
      expect(n).toBe(2); // exact distinct count
      const by = messageAccounts(store, "s");
      expect(by.get("m0")).toBeNull();
      expect(by.get("m1")).toBe(ACCOUNT_B_UUID);
      expect(by.get("m2")).toBe(ACCOUNT_B_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("A→B→A: a bounded override does NOT bleed past the re-entry to A", () => {
    // The bug guard: an open-ended `>= boundary` override would wrongly leave
    // post-re-entry messages stamped B. Bounded [2h,4h) keeps them on A.
    const { store, dbPath } = freshStore();
    try {
      insertMessage(store, "a1", "s", T0 + HOUR);     // A span → null (session account)
      insertMessage(store, "b1", "s", T0 + 3 * HOUR); // B span [2h,4h) → B
      insertMessage(store, "a2", "s", T0 + 5 * HOUR); // back in A → null, NOT B
      const n = store.applyMessageOverrides([
        { sessionId: "s", boundaryFrom: T0 + 2 * HOUR, boundaryTo: T0 + 4 * HOUR, accountUuid: ACCOUNT_B_UUID },
      ]);
      expect(n).toBe(1);
      const by = messageAccounts(store, "s");
      expect(by.get("a1")).toBeNull();
      expect(by.get("b1")).toBe(ACCOUNT_B_UUID);
      expect(by.get("a2")).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("never stamps null-timestamp messages", () => {
    const { store, dbPath } = freshStore();
    try {
      insertMessage(store, "nt", "s", null);
      const n = store.applyMessageOverrides([
        { sessionId: "s", boundaryFrom: T0, boundaryTo: Infinity, accountUuid: ACCOUNT_B_UUID },
      ]);
      expect(n).toBe(0);
      expect(messageAccounts(store, "s").get("nt")).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("scopes by session — other sessions are untouched", () => {
    const { store, dbPath } = freshStore();
    try {
      insertMessage(store, "x", "s1", T0 + 3 * HOUR);
      insertMessage(store, "y", "s2", T0 + 3 * HOUR);
      store.applyMessageOverrides([
        { sessionId: "s1", boundaryFrom: T0 + 2 * HOUR, boundaryTo: Infinity, accountUuid: ACCOUNT_B_UUID },
      ]);
      expect(messageAccounts(store, "s1").get("x")).toBe(ACCOUNT_B_UUID);
      expect(messageAccounts(store, "s2").get("y")).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("is idempotent, and resetMessageAttribution clears the stamps", () => {
    const { store, dbPath } = freshStore();
    try {
      insertMessage(store, "m1", "s", T0 + 3 * HOUR);
      const ov = [{ sessionId: "s", boundaryFrom: T0 + 2 * HOUR, boundaryTo: Infinity, accountUuid: ACCOUNT_B_UUID }];
      store.applyMessageOverrides(ov);
      store.applyMessageOverrides(ov); // re-apply → same end state
      expect(messageAccounts(store, "s").get("m1")).toBe(ACCOUNT_B_UUID);
      expect(store.resetMessageAttribution()).toBe(1);
      expect(messageAccounts(store, "s").get("m1")).toBeNull();
      expect(store.resetMessageAttribution()).toBe(0); // nothing left to clear
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("empty overrides → no writes", () => {
    const { store, dbPath } = freshStore();
    try {
      expect(store.applyMessageOverrides([])).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── reattribute end-to-end: per-message straddle persistence ──────────────────

describe("reattribute — per-message straddle persistence", () => {
  function seedSession(store: Store, id: string, first: number, last: number): void {
    const r = makeSessionRow({ session_id: id, entrypoint: "cli", first_timestamp: first, last_timestamp: last });
    store.upsertSession({
      sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
      firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
      claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
      permissionMode: null, isInteractive: true, promptCount: 1, assistantMessageCount: 1,
      inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0,
      webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
      accountUuid: null, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
      parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
      activeDurationMs: null, medianResponseTimeMs: null,
    });
  }

  it("attributes the session to the first account and splits later messages", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));
      store.recordAccountObservation(obs(ACCOUNT_B_UUID, T0 + 2 * HOUR));
      seedSession(store, "sx", T0 + HOUR, T0 + 3 * HOUR); // straddles A→B
      insertMessage(store, "m_a", "sx", T0 + HOUR);     // in A's span
      insertMessage(store, "m_b", "sx", T0 + 3 * HOUR); // in B's span

      const summary = reattribute(store, { dryRun: false, dbPath }, fixedClock(T0 + 9 * HOUR));
      expect(summary.messageOverrides).toBe(1);
      expect(summary.messagesStamped).toBe(1);

      // Session → A (covers first_timestamp); later message → B.
      const s = store.getSessions({ includeCI: true, includeDeleted: true }).find((x) => x.session_id === "sx")!;
      expect(s.account_uuid).toBe(ACCOUNT_A_UUID);
      const by = messageAccounts(store, "sx");
      expect(by.get("m_a")).toBeNull();
      expect(by.get("m_b")).toBe(ACCOUNT_B_UUID);

      if (summary.backupPath) fs.rmSync(summary.backupPath, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("dry-run reports overrides but stamps nothing", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));
      store.recordAccountObservation(obs(ACCOUNT_B_UUID, T0 + 2 * HOUR));
      seedSession(store, "sx", T0 + HOUR, T0 + 3 * HOUR);
      insertMessage(store, "m_b", "sx", T0 + 3 * HOUR);

      const summary = reattribute(store, { dryRun: true, dbPath }, fixedClock(T0 + 9 * HOUR));
      expect(summary.messageOverrides).toBe(1);
      expect(summary.messagesStamped).toBe(0);
      expect(messageAccounts(store, "sx").get("m_b")).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("a second reattribute clears stale stamps then re-derives (no drift)", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));
      store.recordAccountObservation(obs(ACCOUNT_B_UUID, T0 + 2 * HOUR));
      seedSession(store, "sx", T0 + HOUR, T0 + 3 * HOUR);
      insertMessage(store, "m_b", "sx", T0 + 3 * HOUR);

      const s1 = reattribute(store, { dryRun: false, dbPath }, fixedClock(T0 + 9 * HOUR));
      if (s1.backupPath) fs.rmSync(s1.backupPath, { force: true });
      const s2 = reattribute(store, { dryRun: false, dbPath }, fixedClock(T0 + 10 * HOUR));
      expect(s2.messagesStamped).toBe(1);
      expect(messageAccounts(store, "sx").get("m_b")).toBe(ACCOUNT_B_UUID);
      if (s2.backupPath) fs.rmSync(s2.backupPath, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── property tests (seeded deterministic generator; no fast-check) ────────────

/** Tiny seeded LCG → deterministic pseudo-random in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("property: disjoint cover", () => {
  it("intervals are sorted, non-overlapping, contiguous, final end=Infinity", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const n = 1 + Math.floor(rng() * 8);
      const observations: AccountObservation[] = [];
      let t = T0;
      for (let i = 0; i < n; i++) {
        t += Math.floor(rng() * 5 * HOUR);
        const acct = rng() < 0.5 ? ACCOUNT_A_UUID : ACCOUNT_B_UUID;
        observations.push(obs(acct, t));
      }
      const ivs = buildCliIntervals(observations);
      if (ivs.length === 0) continue;
      for (let i = 0; i < ivs.length; i++) {
        expect(ivs[i]!.start).toBeLessThan(ivs[i]!.end);
        if (i < ivs.length - 1) {
          expect(ivs[i]!.end).toBe(ivs[i + 1]!.start);
          // consecutive intervals are different accounts (deduped)
          expect(ivs[i]!.accountUuid).not.toBe(ivs[i + 1]!.accountUuid);
        } else {
          expect(ivs[i]!.end).toBe(Infinity);
        }
      }
    }
  });
});

describe("property: idempotent assignment", () => {
  it("assignAccounts is a pure function of its inputs", () => {
    const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0), obs(ACCOUNT_B_UUID, T0 + 2 * HOUR)]);
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const surfaces = ["cli", "claude", "claude-vscode", "vscode", "claude-desktop", "weird"];
      const sessions: SessionRow[] = [];
      const n = 1 + Math.floor(rng() * 6);
      for (let i = 0; i < n; i++) {
        sessions.push(makeSessionRow({
          session_id: `p${seed}-${i}`,
          entrypoint: surfaces[Math.floor(rng() * surfaces.length)]!,
          first_timestamp: T0 + Math.floor(rng() * 5 * HOUR),
        }));
      }
      const r1 = assignAccounts({ sessions, intervals: ivs, telemetryMap: new Map() });
      const r2 = assignAccounts({ sessions, intervals: ivs, telemetryMap: new Map() });
      expect([...r2.assignments.entries()]).toEqual([...r1.assignments.entries()]);
    }
  });
});

describe("property: surface-invariance (non-CLI always unknown without otel/telemetry)", () => {
  it("any non-CLI surface yields unknown when no external map matches", () => {
    const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);
    const nonCli = ["claude-vscode", "vscode", "claude-desktop", "x", "y-z", ""];
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const entrypoint = nonCli[Math.floor(rng() * nonCli.length)]!;
      const s = makeSessionRow({
        session_id: "x",
        entrypoint,
        first_timestamp: T0 + Math.floor(rng() * 10 * HOUR),
      });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({ source: "unknown", confidence: "none" });
    }
  });
});
